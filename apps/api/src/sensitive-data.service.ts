import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { dataEncryptionKeyring, DataEncryptionKey } from './runtime-config';

@Injectable()
export class SensitiveDataService {
  private static readonly legacyVersion = 'v1';
  private static readonly currentVersion = 'v2';
  private static readonly ivBytes = 12;
  private static readonly authTagBytes = 16;
  private readonly keyring = dataEncryptionKeyring();

  assertConfigured(): void {
    void this.keyring.active;
  }

  get activeKeyId(): string {
    return this.keyring.active.id;
  }

  encrypt(value: string): string {
    if (!value) return '';
    const iv = randomBytes(SensitiveDataService.ivBytes);
    const cipher = createCipheriv('aes-256-gcm', this.keyring.active.key, iv, { authTagLength: SensitiveDataService.authTagBytes });
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [SensitiveDataService.currentVersion, this.keyring.active.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  decrypt(value: string): string {
    if (!value || (!value.startsWith(`${SensitiveDataService.legacyVersion}.`) && !value.startsWith(`${SensitiveDataService.currentVersion}.`))) return value;
    if (value.startsWith(`${SensitiveDataService.currentVersion}.`)) return this.decryptCurrent(value);
    return this.decryptLegacy(value);
  }

  needsReencryption(value: string): boolean {
    if (!value) return false;
    return !value.startsWith(`${SensitiveDataService.currentVersion}.${this.keyring.active.id}.`);
  }

  private decryptCurrent(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 5) throw new InternalServerErrorException('敏感数据密文格式错误');
    const [, keyId, iv, authTag, encrypted] = parts;
    const key = keyId === this.keyring.active.id ? this.keyring.active.key : this.keyring.previous.get(keyId);
    if (!key) throw new InternalServerErrorException('敏感数据密钥标识未知');
    return this.decryptEnvelope(key, iv, authTag, encrypted);
  }

  private decryptLegacy(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 4) throw new InternalServerErrorException('敏感数据密文格式错误');
    const [, iv, authTag, encrypted] = parts;
    const keys = [this.keyring.active, ...[...this.keyring.previous.entries()].map(([id, key]) => ({ id, key }))];
    for (const key of keys) {
      try {
        return this.decryptEnvelope(key, iv, authTag, encrypted);
      } catch {
        // v1 does not carry a key id, so legacy envelopes need controlled key fallback.
      }
    }
    throw new InternalServerErrorException('敏感数据无法解密');
  }

  private decryptEnvelope(key: Buffer | DataEncryptionKey, iv: string, authTag: string, encrypted: string): string {
    try {
      const ivBuffer = Buffer.from(iv, 'base64url');
      const authTagBuffer = Buffer.from(authTag, 'base64url');
      if (ivBuffer.length !== SensitiveDataService.ivBytes || authTagBuffer.length !== SensitiveDataService.authTagBytes) throw new Error('invalid authenticated envelope');
      const decipher = createDecipheriv('aes-256-gcm', Buffer.isBuffer(key) ? key : key.key, ivBuffer, { authTagLength: SensitiveDataService.authTagBytes });
      decipher.setAuthTag(authTagBuffer);
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('敏感数据无法解密');
    }
  }
}
