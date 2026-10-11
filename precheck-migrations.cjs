'use strict';
// 只读迁移预检：连接目标 PostgreSQL，仅调用 showMigrations() 检查"数组内尚未落库"的迁移，不执行任何迁移。
// 用法：NODE_ENV=production DATABASE_URL=... node precheck-migrations.cjs <distRoot>
require('reflect-metadata');
const path = require('path');
const { DataSource } = require('typeorm');

const distRoot = process.argv[2];
if (!distRoot) {
  console.error('usage: node precheck-migrations.cjs <distRoot>');
  process.exit(2);
}

const { entities } = require(path.join(distRoot, 'domain', 'entities.js'));
const { migrations } = require(path.join(distRoot, 'migrations', 'index.js'));

(async () => {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities,
    migrations,
    synchronize: false,
    migrationsRun: false,
  });
  try {
    await ds.initialize();
    const pending = await ds.showMigrations();
    // TypeORM 0.3.x 的 showMigrations() 返回 boolean：true = 存在待执行迁移。
    const hasPending = typeof pending === 'boolean' ? pending : (Array.isArray(pending) ? pending.length > 0 : Boolean(pending));
    console.log('ARRAY_COUNT=' + migrations.length);
    console.log('HAS_PENDING=' + hasPending);
    console.log('RAW=' + JSON.stringify(pending));
    console.log(hasPending ? 'RESULT=UNSAFE' : 'RESULT=SAFE');
    process.exitCode = hasPending ? 3 : 0;
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
})().catch((e) => {
  console.error('ERROR', e && e.message ? e.message : e);
  process.exit(1);
});
