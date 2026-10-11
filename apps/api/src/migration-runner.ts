import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { entities } from './domain/entities';
import { migrations } from './migrations';
import { usesEmbeddedDatabase } from './runtime-config';

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL || usesEmbeddedDatabase()) throw new Error('迁移只能连接真实 PostgreSQL 数据库');
  if (process.env.RUN_MIGRATIONS_ON_STARTUP === 'true') throw new Error('迁移任务禁止复用应用启动迁移开关；请将 RUN_MIGRATIONS_ON_STARTUP 保持为 false');
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities,
    migrations,
    synchronize: false,
    migrationsRun: false,
    logging: false,
  });
  try {
    await dataSource.initialize();
    // One migration per transaction keeps expand-only schema changes
    // recoverable, and lets a future explicitly marked online-index migration
    // opt out of a transaction for CREATE INDEX CONCURRENTLY.
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    console.log(applied.length ? `已应用 ${applied.length} 个数据库迁移` : '数据库迁移已是最新状态');
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

void run();
