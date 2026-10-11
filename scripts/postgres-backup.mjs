import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createBackupManifest, encryptBackupFile, decodeBackupKey } from './postgres-backup-format.mjs';

function requireValue(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function databaseEnvironment(databaseUrl) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL 格式无效'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') throw new Error('DATABASE_URL 必须是有效的 PostgreSQL 连接地址');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('数据库名称格式无效');
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
}

function execute(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once('error', () => reject(new Error(`${command} 无法启动；请安装 PostgreSQL 客户端或配置对应可执行文件`)));
    child.once('exit', (code) => code === 0 ? resolvePromise(undefined) : reject(new Error(`${command} 执行失败${stderr ? '；请检查数据库访问与客户端日志' : ''}`)));
  });
}

function safeTimestamp(date = new Date()) { return date.toISOString().replace(/[:.]/g, '-'); }

function retentionDays() {
  const value = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  if (!Number.isInteger(value) || value < 7 || value > 3650) throw new Error('BACKUP_RETENTION_DAYS 必须为 7 至 3650 天');
  return value;
}

async function prune(outputDirectory, prefix, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const files = await readdir(outputDirectory, { withFileTypes: true });
  const candidates = files.filter((file) => file.isFile() && file.name.startsWith(prefix) && (file.name.endsWith('.dump.enc') || file.name.endsWith('.manifest.json')));
  await Promise.all(candidates.map(async (file) => {
    const path = join(outputDirectory, file.name);
    if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
  }));
}

async function main() {
  const databaseUrl = requireValue('DATABASE_URL');
  const backupKey = decodeBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const keyId = requireValue('BACKUP_ENCRYPTION_KEY_ID');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error('BACKUP_ENCRYPTION_KEY_ID 格式无效');
  const outputDirectory = resolve(process.env.PG_BACKUP_OUTPUT_DIR || 'backups');
  const prefix = 'local-deals-postgres-';
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const timestamp = safeTimestamp();
  const base = `${prefix}${timestamp}`;
  const dumpTemporary = join(outputDirectory, `.${base}.dump.tmp`);
  const encryptedTemporary = join(outputDirectory, `.${base}.dump.enc.tmp`);
  const encryptedFinal = join(outputDirectory, `${base}.dump.enc`);
  const manifestTemporary = join(outputDirectory, `.${base}.manifest.json.tmp`);
  const manifestFinal = join(outputDirectory, `${base}.manifest.json`);
  try {
    await execute(process.env.PG_DUMP_BIN || 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpTemporary], databaseEnvironment(databaseUrl));
    const encrypted = await encryptBackupFile(dumpTemporary, encryptedTemporary, backupKey, keyId);
    await rename(encryptedTemporary, encryptedFinal);
    const manifest = createBackupManifest({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      artifact: basename(encryptedFinal),
      backupFormat: 'postgresql-custom',
      encryption: { algorithm: 'aes-256-gcm', keyId },
      ciphertextBytes: encrypted.ciphertextBytes,
      ciphertextSha256: encrypted.ciphertextSha256,
    }, backupKey);
    await writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(manifestTemporary, manifestFinal);
    await prune(outputDirectory, prefix, retentionDays());
    console.log(`备份完成：${basename(encryptedFinal)}；密文 ${encrypted.ciphertextBytes} 字节；SHA-256 ${encrypted.ciphertextSha256}`);
  } finally {
    await Promise.all([rm(dumpTemporary, { force: true }), rm(encryptedTemporary, { force: true }), rm(manifestTemporary, { force: true })]);
  }
}

main().catch((error) => {
  console.error(`备份失败：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
});
