import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

const MAGIC = Buffer.from('LOCAL_DEALS_PG_BACKUP_V1\n', 'ascii');
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_HEADER_BYTES = 4096;
const MANIFEST_HMAC_PREFIX = 'local-deals-backup-manifest-v1\n';

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

function copyThroughCipher(source, cipher, destination) {
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    source.once('error', fail);
    cipher.once('error', fail);
    destination.once('error', fail);
    cipher.once('end', resolve);
    source.pipe(cipher).pipe(destination, { end: false });
  });
}

export function decodeBackupKey(value, label = 'BACKUP_ENCRYPTION_KEY') {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} 未配置`);
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32) throw new Error(`${label} 必须是 32 字节 Base64 密钥`);
  return key;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const source = createReadStream(path);
  for await (const chunk of source) hash.update(chunk);
  return hash.digest('hex');
}

function normalizedBackupManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.backupFormat !== 'postgresql-custom') throw new Error('备份清单版本或格式无效');
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('备份清单创建时间无效');
  if (typeof manifest.artifact !== 'string' || !manifest.artifact) throw new Error('备份清单产物名称无效');
  if (manifest.encryption?.algorithm !== 'aes-256-gcm' || !/^[A-Za-z0-9_-]{1,64}$/.test(String(manifest.encryption?.keyId || ''))) throw new Error('备份清单加密信息无效');
  if (!Number.isSafeInteger(manifest.ciphertextBytes) || manifest.ciphertextBytes <= 0) throw new Error('备份清单密文大小无效');
  if (!/^[a-f0-9]{64}$/.test(String(manifest.ciphertextSha256 || ''))) throw new Error('备份清单密文摘要无效');
  return {
    schemaVersion: 1,
    createdAt: manifest.createdAt,
    artifact: manifest.artifact,
    backupFormat: 'postgresql-custom',
    encryption: { algorithm: 'aes-256-gcm', keyId: manifest.encryption.keyId },
    ciphertextBytes: manifest.ciphertextBytes,
    ciphertextSha256: manifest.ciphertextSha256,
  };
}

function manifestHmac(manifest, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('备份清单认证密钥必须为 32 字节');
  return createHmac('sha256', key).update(MANIFEST_HMAC_PREFIX).update(JSON.stringify(normalizedBackupManifest(manifest))).digest('hex');
}

export function createBackupManifest(details, key) {
  const manifest = normalizedBackupManifest(details);
  return { ...manifest, manifestHmacSha256: manifestHmac(manifest, key) };
}

export function verifyBackupManifest(manifest, key) {
  const normalized = normalizedBackupManifest(manifest);
  const actualHex = String(manifest.manifestHmacSha256 || '');
  if (!/^[a-f0-9]{64}$/.test(actualHex)) throw new Error('备份清单缺少有效认证码');
  const expected = Buffer.from(manifestHmac(normalized, key), 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (!timingSafeEqual(expected, actual)) throw new Error('备份清单认证失败，内容可能已被篡改');
  return normalized;
}

export async function encryptBackupFile(inputPath, outputPath, key, keyId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(keyId || ''))) throw new Error('备份密钥标识格式无效');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('备份加密密钥必须为 32 字节');
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.from(JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', keyId, nonce: nonce.toString('base64') }), 'utf8');
  if (header.length > MAX_HEADER_BYTES) throw new Error('备份加密头过大');
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  try {
    await writeChunk(output, MAGIC);
    await writeChunk(output, headerLength);
    await writeChunk(output, header);
    await copyThroughCipher(createReadStream(inputPath), cipher, output);
    await writeChunk(output, cipher.getAuthTag());
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
  return { keyId, ciphertextSha256: await sha256File(outputPath), ciphertextBytes: (await stat(outputPath)).size };
}

export async function readBackupHeader(path) {
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(MAGIC.length + 4);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('备份文件格式或版本无效');
    const headerSize = prefix.readUInt32BE(MAGIC.length);
    if (headerSize < 20 || headerSize > MAX_HEADER_BYTES) throw new Error('备份文件头无效');
    const headerBytes = Buffer.alloc(headerSize);
    const readHeader = await handle.read(headerBytes, 0, headerSize, MAGIC.length + 4);
    if (readHeader.bytesRead !== headerSize) throw new Error('备份文件头不完整');
    let header;
    try { header = JSON.parse(headerBytes.toString('utf8')); } catch { throw new Error('备份文件头不是有效 JSON'); }
    if (!header || header.version !== 1 || header.algorithm !== 'aes-256-gcm' || !/^[A-Za-z0-9_-]{1,64}$/.test(header.keyId || '') || typeof header.nonce !== 'string') throw new Error('备份文件头字段无效');
    const nonce = Buffer.from(header.nonce, 'base64');
    if (nonce.length !== NONCE_BYTES) throw new Error('备份文件随机数无效');
    const details = await handle.stat();
    const cipherStart = MAGIC.length + 4 + headerSize;
    if (details.size <= cipherStart + TAG_BYTES) throw new Error('备份文件缺少密文或认证标签');
    return { header: { keyId: header.keyId, nonce }, cipherStart, size: details.size };
  } finally {
    await handle.close();
  }
}

export async function decryptBackupFile(inputPath, outputPath, key, expectedKeyId) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('备份解密密钥必须为 32 字节');
  const { header, cipherStart, size } = await readBackupHeader(inputPath);
  if (expectedKeyId && header.keyId !== expectedKeyId) throw new Error('备份密钥标识与当前配置不匹配');
  const handle = await open(inputPath, 'r');
  let tag;
  try {
    tag = Buffer.alloc(TAG_BYTES);
    const { bytesRead } = await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    if (bytesRead !== TAG_BYTES) throw new Error('备份文件认证标签不完整');
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, header.nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const source = createReadStream(inputPath, { start: cipherStart, end: size - TAG_BYTES - 1 });
      source.once('error', reject);
      decipher.once('error', reject);
      output.once('error', reject);
      output.once('finish', resolve);
      source.pipe(decipher).pipe(output);
    });
  } catch (error) {
    output.destroy();
    throw new Error(`备份解密或完整性校验失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
  return { keyId: header.keyId, plaintextBytes: (await stat(outputPath)).size };
}
