import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { WechatPlatformService } from './wechat-platform.service';

describe('WechatPlatformService callback handling', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
    jest.restoreAllMocks();
  });

  it('verifies, decrypts, and persists a component verify ticket', async () => {
    const componentAppId = 'wxB3C17A05D7787655';
    const token = 'callback-token';
    const key = randomBytes(32);
    const encodingAesKey = key.toString('base64').replace(/=$/, '');
    process.env.WECHAT_COMPONENT_APP_ID = componentAppId;
    process.env.WECHAT_COMPONENT_TOKEN = token;
    process.env.WECHAT_COMPONENT_ENCODING_AES_KEY = encodingAesKey;

    const save = jest.fn().mockResolvedValue(undefined);
    const queryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const repository = { createQueryBuilder: jest.fn(() => queryBuilder), save };
    const sensitiveData = { encrypt: jest.fn((value: string) => `encrypted:${value}`) };
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: { findOne: jest.Mock; save: jest.Mock }) => Promise<void>) => callback({
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockImplementation(async (_entity: unknown, value: Record<string, unknown>) => ({ id: value.id || 'callback-id', ...value })),
      })),
    };
    const service = new WechatPlatformService(
      {} as never, {} as never, sensitiveData as never, dataSource as never, {} as never, {} as never,
      repository as never, {} as never, { findOne: jest.fn().mockResolvedValue(null) } as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    const ticket = 'ticket-value-from-wechat-123456';
    const encrypted = encryptWechatMessage(key, componentAppId, `<xml><InfoType><![CDATA[component_verify_ticket]]></InfoType><ComponentVerifyTicket><![CDATA[${ticket}]]></ComponentVerifyTicket></xml>`);
    const timestamp = '1785436800';
    const nonce = 'nonce123';
    const signature = createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
    const rawBody = Buffer.from(`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`);

    await service.receiveCallback(rawBody, signature, timestamp, nonce);

    expect(sensitiveData.encrypt).toHaveBeenCalledWith(ticket);
    expect(save).not.toHaveBeenCalled();
    expect(dataSource.transaction).toHaveBeenCalled();
    const transactionManager = dataSource.transaction.mock.calls[0][0];
    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (_entity: unknown, value: Record<string, unknown>) => ({ id: value.id || 'callback-id', ...value })),
    };
    await transactionManager(manager);
    expect(manager.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'component_verify_ticket', payload: expect.objectContaining({ ticketCiphertext: `encrypted:${ticket}` }),
    }));
  });

  it('rejects a callback with an invalid signature', async () => {
    process.env.WECHAT_COMPONENT_APP_ID = 'wxB3C17A05D7787655';
    process.env.WECHAT_COMPONENT_TOKEN = 'callback-token';
    process.env.WECHAT_COMPONENT_ENCODING_AES_KEY = randomBytes(32).toString('base64').replace(/=$/, '');
    const service = new WechatPlatformService(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    const rawBody = Buffer.from('<xml><Encrypt><![CDATA[not-encrypted]]></Encrypt></xml>');

    await expect(service.receiveCallback(rawBody, '0'.repeat(40), '1785436800', 'nonce123')).rejects.toBeInstanceOf(BadRequestException);
  });
});

function encryptWechatMessage(key: Buffer, receiveId: string, message: string): string {
  const messageBuffer = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBuffer.length);
  const plain = Buffer.concat([randomBytes(16), length, messageBuffer, Buffer.from(receiveId)]);
  const paddingLength = 32 - (plain.length % 32 || 32);
  const effectivePaddingLength = paddingLength || 32;
  const padded = Buffer.concat([plain, Buffer.alloc(effectivePaddingLength, effectivePaddingLength)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}
