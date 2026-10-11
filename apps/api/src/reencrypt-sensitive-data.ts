import 'dotenv/config';
import { DataSource } from 'typeorm';
import { SupportTicket } from './domain/entities';
import { usesEmbeddedDatabase } from './runtime-config';
import { SensitiveDataService } from './sensitive-data.service';

const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} 必须在 1 至 ${maximum} 之间`);
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL || usesEmbeddedDatabase()) throw new Error('敏感数据重加密只能连接真实 PostgreSQL 数据库');
  if (!String(process.env.DATA_ENCRYPTION_KEY || '').trim() || !String(process.env.DATA_ENCRYPTION_KEY_ID || '').trim()) {
    throw new Error('敏感数据重加密必须显式配置 DATA_ENCRYPTION_KEY 和 DATA_ENCRYPTION_KEY_ID');
  }

  const apply = process.env.SENSITIVE_DATA_REENCRYPT_APPLY === 'true';
  const maxRows = positiveInteger('SENSITIVE_DATA_REENCRYPT_MAX_ROWS', DEFAULT_MAX_ROWS, 1_000_000);
  const batchSize = positiveInteger('SENSITIVE_DATA_REENCRYPT_BATCH_SIZE', DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const sensitiveData = new SensitiveDataService();
  sensitiveData.assertConfigured();
  const dataSource = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL, entities: [SupportTicket], synchronize: false, migrationsRun: false, logging: false });
  const activePrefix = `v2.${escapeLike(sensitiveData.activeKeyId)}.%`;
  let inspected = 0;
  let reencrypted = 0;
  let concurrentChanges = 0;

  try {
    await dataSource.initialize();
    const tickets = dataSource.getRepository(SupportTicket);
    do {
      const take = Math.min(batchSize, maxRows - inspected);
      const candidates = await tickets.createQueryBuilder('ticket')
        .where('ticket.contactPhone <> :empty', { empty: '' })
        .andWhere("ticket.contactPhone NOT LIKE :activePrefix ESCAPE '\\'", { activePrefix })
        .orderBy('ticket.id', 'ASC')
        .take(take)
        .getMany();
      if (!candidates.length) break;

      for (const ticket of candidates) {
        inspected += 1;
        const plaintext = sensitiveData.decrypt(ticket.contactPhone);
        if (!sensitiveData.needsReencryption(ticket.contactPhone)) continue;
        if (!apply) continue;
        const result = await tickets.createQueryBuilder()
          .update(SupportTicket)
          .set({ contactPhone: sensitiveData.encrypt(plaintext) })
          .where('id = :id AND contactPhone = :previousCiphertext', { id: ticket.id, previousCiphertext: ticket.contactPhone })
          .execute();
        if (result.affected === 1) reencrypted += 1;
        else concurrentChanges += 1;
      }

      if (!apply || inspected >= maxRows) break;
    } while (inspected < maxRows);

    const mode = apply ? '已执行写入' : '预检完成，未写入';
    console.log(`${mode}：检查 ${inspected} 条，重加密 ${reencrypted} 条，并发变更跳过 ${concurrentChanges} 条。`);
    if (!apply) console.log('如需写入，请在已验证备份和退役密钥双读后设置 SENSITIVE_DATA_REENCRYPT_APPLY=true。');
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

void run();
