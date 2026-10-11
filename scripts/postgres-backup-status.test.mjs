import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { createBackupManifest, encryptBackupFile } from './postgres-backup-format.mjs';
import { checkBackupStatus } from './postgres-backup-status.mjs';

async function backupFixture(createdAt = new Date('2026-07-20T08:00:00.000Z')) {
  const directory = await mkdtemp(join(tmpdir(), 'local-deals-backup-status-test-'));
  const source = join(directory, 'source.dump');
  const artifact = join(directory, 'local-deals-postgres-test.dump.enc');
  const manifestPath = join(directory, 'local-deals-postgres-test.manifest.json');
  const key = randomBytes(32);
  await writeFile(source, Buffer.concat([Buffer.from('PGDMP'), randomBytes(4096)]));
  const encrypted = await encryptBackupFile(source, artifact, key, 'backup-status-key');
  const manifest = createBackupManifest({
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    artifact: basename(artifact),
    backupFormat: 'postgresql-custom',
    encryption: { algorithm: 'aes-256-gcm', keyId: 'backup-status-key' },
    ciphertextBytes: encrypted.ciphertextBytes,
    ciphertextSha256: encrypted.ciphertextSha256,
  }, key);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, key, manifest, manifestPath };
}

function environment(directory, key) {
  return { PG_BACKUP_OUTPUT_DIR: directory, BACKUP_ENCRYPTION_KEY: key.toString('base64'), BACKUP_MAX_RPO_HOURS: '24' };
}

test('accepts a recent authenticated backup with a valid encrypted file header', async () => {
  const createdAt = new Date('2026-07-20T08:00:00.000Z');
  const fixture = await backupFixture(createdAt);
  try {
    const status = await checkBackupStatus(environment(fixture.directory, fixture.key), new Date('2026-07-20T09:00:00.000Z'));
    assert.equal(status.latest.encryption.keyId, 'backup-status-key');
    assert.equal(status.ageHours, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects a manifest whose authenticated timestamp was moved into the future', async () => {
  const fixture = await backupFixture(new Date('2099-01-01T00:00:00.000Z'));
  try {
    await assert.rejects(() => checkBackupStatus(environment(fixture.directory, fixture.key), new Date('2026-07-20T09:00:00.000Z')), /位于未来/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects an arbitrary file even when its size, hash and manifest HMAC match', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-deals-backup-status-invalid-'));
  const key = randomBytes(32);
  const artifact = 'local-deals-postgres-invalid.dump.enc';
  const bytes = Buffer.from('not-a-valid-encrypted-backup');
  try {
    await writeFile(join(directory, artifact), bytes);
    const manifest = createBackupManifest({
      schemaVersion: 1,
      createdAt: '2026-07-20T08:00:00.000Z',
      artifact,
      backupFormat: 'postgresql-custom',
      encryption: { algorithm: 'aes-256-gcm', keyId: 'backup-status-key' },
      ciphertextBytes: bytes.length,
      ciphertextSha256: createHash('sha256').update(bytes).digest('hex'),
    }, key);
    await writeFile(join(directory, 'local-deals-postgres-invalid.manifest.json'), JSON.stringify(manifest));
    await assert.rejects(() => checkBackupStatus(environment(directory, key), new Date('2026-07-20T09:00:00.000Z')), /格式或版本无效/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a tampered manifest before trusting its timestamp', async () => {
  const fixture = await backupFixture(new Date('2026-07-20T08:00:00.000Z'));
  try {
    await writeFile(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, createdAt: '2099-01-01T00:00:00.000Z' }));
    await assert.rejects(() => checkBackupStatus(environment(fixture.directory, fixture.key), new Date('2026-07-20T09:00:00.000Z')), /认证失败/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
