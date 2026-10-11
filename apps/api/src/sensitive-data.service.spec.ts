import { SensitiveDataService } from './sensitive-data.service';
import { createCipheriv, randomBytes } from 'crypto';

function legacyV1(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

describe('SensitiveDataService', () => {
  const originalKey = process.env.DATA_ENCRYPTION_KEY;
  const originalKeyId = process.env.DATA_ENCRYPTION_KEY_ID;
  const originalPreviousKeys = process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = originalKey;
    if (originalKeyId === undefined) delete process.env.DATA_ENCRYPTION_KEY_ID;
    else process.env.DATA_ENCRYPTION_KEY_ID = originalKeyId;
    if (originalPreviousKeys === undefined) delete process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
    else process.env.DATA_ENCRYPTION_PREVIOUS_KEYS = originalPreviousKeys;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('encrypts with a versioned authenticated envelope and decrypts the original value', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY_ID;
    delete process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
    process.env.NODE_ENV = 'test';
    const service = new SensitiveDataService();
    const encrypted = service.encrypt('13800000000');
    expect(encrypted).toMatch(/^v2\.local-demo\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain('13800000000');
    expect(service.decrypt(encrypted)).toBe('13800000000');
    expect(service.needsReencryption(encrypted)).toBe(false);
  });

  it('requires an encryption key in every shared environment', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY_ID;
    delete process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
    process.env.NODE_ENV = 'staging';
    expect(() => new SensitiveDataService().assertConfigured()).toThrow('非本地环境缺少 DATA_ENCRYPTION_KEY');
  });

  it('reads legacy v1 ciphertext with a configured retired key and marks it for re-encryption', () => {
    const oldKey = Buffer.alloc(32, 4);
    process.env.NODE_ENV = 'staging';
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
    process.env.DATA_ENCRYPTION_KEY_ID = 'data-2026-07';
    process.env.DATA_ENCRYPTION_PREVIOUS_KEYS = `data-2026-06:${oldKey.toString('base64')}`;
    const service = new SensitiveDataService();
    const legacy = legacyV1('13900000000', oldKey);
    expect(service.decrypt(legacy)).toBe('13900000000');
    expect(service.needsReencryption(legacy)).toBe(true);
  });

  it('reads a retired v2 key by id and writes only with the active key', () => {
    const oldKey = Buffer.alloc(32, 6);
    const newKey = Buffer.alloc(32, 7);
    process.env.NODE_ENV = 'staging';
    process.env.DATA_ENCRYPTION_KEY = oldKey.toString('base64');
    process.env.DATA_ENCRYPTION_KEY_ID = 'data-2026-06';
    delete process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
    const oldService = new SensitiveDataService();
    const retiredEnvelope = oldService.encrypt('13700000000');

    process.env.DATA_ENCRYPTION_KEY = newKey.toString('base64');
    process.env.DATA_ENCRYPTION_KEY_ID = 'data-2026-07';
    process.env.DATA_ENCRYPTION_PREVIOUS_KEYS = `data-2026-06:${oldKey.toString('base64')}`;
    const rotatedService = new SensitiveDataService();
    expect(rotatedService.decrypt(retiredEnvelope)).toBe('13700000000');
    expect(rotatedService.needsReencryption(retiredEnvelope)).toBe(true);
    expect(rotatedService.encrypt('13700000000')).toMatch(/^v2\.data-2026-07\./);
  });

  it('fails closed for an unknown v2 key id and invalid rotation configuration', () => {
    process.env.NODE_ENV = 'staging';
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
    process.env.DATA_ENCRYPTION_KEY_ID = 'data-old';
    delete process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
    const oldEnvelope = new SensitiveDataService().encrypt('13600000000');

    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.DATA_ENCRYPTION_KEY_ID = 'data-new';
    expect(() => new SensitiveDataService().decrypt(oldEnvelope)).toThrow('敏感数据密钥标识未知');
    process.env.DATA_ENCRYPTION_KEY_ID = 'invalid key id';
    expect(() => new SensitiveDataService()).toThrow('DATA_ENCRYPTION_KEY_ID 只能包含');
  });

  it('rejects shortened GCM authentication tags instead of accepting a downgraded envelope', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY_ID;
    delete process.env.DATA_ENCRYPTION_PREVIOUS_KEYS;
    process.env.NODE_ENV = 'test';
    const service = new SensitiveDataService();
    const parts = service.encrypt('13500000000').split('.');
    parts[3] = Buffer.from(parts[3], 'base64url').subarray(0, 4).toString('base64url');
    expect(() => service.decrypt(parts.join('.'))).toThrow('敏感数据无法解密');
  });
});
