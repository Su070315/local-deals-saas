import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBackupKey, readBackupHeader, sha256File, verifyBackupManifest } from './postgres-backup-format.mjs';

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;

function maxRpoHours(env) {
  const value = Number(env.BACKUP_MAX_RPO_HOURS || 24);
  if (!Number.isFinite(value) || value <= 0 || value > 24 * 31) throw new Error('BACKUP_MAX_RPO_HOURS 必须介于 0 和 744 之间');
  return value;
}

export async function checkBackupStatus(env = process.env, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('备份状态检查时间无效');
  const directory = resolve(env.PG_BACKUP_OUTPUT_DIR || 'backups');
  const backupKey = decodeBackupKey(env.BACKUP_ENCRYPTION_KEY);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error && typeof error === 'object' && error.code === 'ENOENT')) throw new Error('备份目录不存在，尚未执行首次加密备份');
    throw error;
  }
  const manifests = entries.filter((entry) => entry.isFile() && entry.name.startsWith('local-deals-postgres-') && entry.name.endsWith('.manifest.json'));
  if (!manifests.length) throw new Error('未找到 PostgreSQL 备份清单');
  const records = await Promise.all(manifests.map(async (entry) => {
    let parsed;
    try { parsed = JSON.parse(await readFile(join(directory, entry.name), 'utf8')); } catch { throw new Error(`备份清单不是有效 JSON：${entry.name}`); }
    try { return verifyBackupManifest(parsed, backupKey); } catch (error) { throw new Error(`备份清单无效：${entry.name}；${error instanceof Error ? error.message : '未知错误'}`); }
  }));
  const latest = records.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (basename(latest.artifact) !== latest.artifact || !/^local-deals-postgres-[A-Za-z0-9._-]+\.dump\.enc$/.test(latest.artifact)) throw new Error('最新备份清单中的产物名称无效');
  const artifactPath = join(directory, latest.artifact);
  const [artifactDetails, header, digest] = await Promise.all([stat(artifactPath), readBackupHeader(artifactPath), sha256File(artifactPath)]);
  if (artifactDetails.size !== latest.ciphertextBytes || header.size !== latest.ciphertextBytes) throw new Error('最新备份密文大小与清单不匹配');
  if (header.header.keyId !== latest.encryption.keyId) throw new Error('最新备份密钥标识与清单不匹配');
  if (digest !== latest.ciphertextSha256) throw new Error('最新备份密文摘要不匹配');
  const ageMs = nowMs - Date.parse(latest.createdAt);
  if (ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) throw new Error('最新备份创建时间位于未来，拒绝将其判定为健康');
  const ageHours = Math.max(0, ageMs) / 3_600_000;
  const threshold = maxRpoHours(env);
  if (ageHours > threshold) throw new Error(`最近备份已超过 RPO：${ageHours.toFixed(1)} 小时，阈值 ${threshold} 小时`);
  return { latest, ageHours };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkBackupStatus().then(({ latest, ageHours }) => {
    console.log(`备份 RPO 检查通过：最新备份 ${latest.createdAt}，已过 ${ageHours.toFixed(1)} 小时，产物 ${latest.artifact}`);
  }).catch((error) => {
    console.error(`备份 RPO 检查失败：${error instanceof Error ? error.message : '未知错误'}`);
    process.exitCode = 1;
  });
}
