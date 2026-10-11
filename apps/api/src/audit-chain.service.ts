import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AuditChainState, AuditLog } from './domain/entities';
import { auditChainVerifyBatchSize, auditLogSigningKey, isLocalOrTestEnvironment } from './runtime-config';

const CHAIN_ID = 'global';
const CHAIN_VERSION = 1;
const GENESIS_HASH = '0'.repeat(64);

const OUTBOX_VERSION = 1;
export type AuditAppendInput = Pick<AuditLog, 'actorId' | 'merchantId' | 'action' | 'resourceType' | 'resourceId' | 'before' | 'after' | 'requestId' | 'actorRole' | 'ipAddress' | 'userAgent'> & { createdAt?: Date };
export type AuditChainIntegrity = {
  valid: boolean;
  checked: number;
  firstInvalidSequence: string | null;
  reason: string | null;
  lastSequence: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestMatches(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  return expectedBuffer.length === actualBuffer.length && expectedBuffer.length === 32 && timingSafeEqual(expectedBuffer, actualBuffer);
}

@Injectable()
export class AuditChainService {
  private readonly signingKey = auditLogSigningKey();
  // pg-mem cannot faithfully serialize the state-row lock across parallel
  // transaction callbacks. This is a local/test-only compatibility shim;
  // shared deployments use the transactional outbox and PostgreSQL row lock.
  private localAppendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataSource: DataSource) {}

  async append(manager: EntityManager, input: AuditAppendInput): Promise<AuditLog> {
    if (!isLocalOrTestEnvironment()) return this.appendLocked(manager, input);
    const predecessor = this.localAppendQueue;
    let release: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    this.localAppendQueue = predecessor.catch(() => undefined).then(() => completed);
    await predecessor.catch(() => undefined);
    try {
      return await this.appendLocked(manager, input);
    } finally {
      release();
    }
  }

  private async appendLocked(manager: EntityManager, input: AuditAppendInput): Promise<AuditLog> {
    const state = await this.lockState(manager);
    const sequence = (BigInt(String(state.lastSequence)) + 1n).toString();
    const createdAt = input.createdAt || new Date();
    const previousHash = state.lastHash || GENESIS_HASH;
    const recordHash = this.recordHash({ ...input, createdAt, chainSequence: sequence, previousHash });
    const record = await manager.save(AuditLog, manager.create(AuditLog, {
      ...input,
      chainVersion: CHAIN_VERSION,
      chainSequence: sequence,
      previousHash,
      recordHash,
      createdAt,
    }));
    state.lastSequence = sequence;
    state.lastHash = recordHash;
    await manager.save(AuditChainState, state);
    return record;
  }

  outboxPayloadHash(input: AuditAppendInput & { createdAt: Date }): string {
    return createHmac('sha256', this.signingKey).update(`audit-outbox:${canonicalJson({
      version: OUTBOX_VERSION,
      actorId: input.actorId,
      merchantId: input.merchantId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: input.before,
      after: input.after,
      requestId: input.requestId,
      actorRole: input.actorRole,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      createdAt: input.createdAt,
    })}`).digest('hex');
  }

  outboxPayloadMatches(input: AuditAppendInput & { createdAt: Date }, expectedHash: string): boolean {
    return digestMatches(this.outboxPayloadHash(input), expectedHash);
  }

  async verify(): Promise<AuditChainIntegrity> {
    const state = await this.dataSource.getRepository(AuditChainState).findOneBy({ id: CHAIN_ID });
    if (!state) return { valid: false, checked: 0, firstInvalidSequence: null, reason: '审计链状态不存在', lastSequence: '0' };
    const auditLogs = this.dataSource.getRepository(AuditLog);
    if (await auditLogs.exists({ where: { chainVersion: CHAIN_VERSION, chainSequence: IsNull() } })) {
      return { valid: false, checked: 0, firstInvalidSequence: null, reason: '审计链序号为空', lastSequence: String(state.lastSequence) };
    }
    let previousHash = GENESIS_HASH;
    let expectedSequence = 1n;
    let checked = 0;
    let cursor: string | null = null;
    const batchSize = auditChainVerifyBatchSize();
    for (;;) {
      const query = auditLogs.createQueryBuilder('audit')
        .where('audit.chainVersion = :chainVersion', { chainVersion: CHAIN_VERSION })
        .andWhere('audit.chainSequence <= :lastSequence', { lastSequence: String(state.lastSequence) })
        .orderBy('audit.chainSequence', 'ASC')
        .take(batchSize);
      if (cursor !== null) query.andWhere('audit.chainSequence > :cursor', { cursor });
      const records = await query.getMany();
      if (!records.length) break;
      for (const record of records) {
        const sequence = String(record.chainSequence);
        checked += 1;
        if (sequence !== expectedSequence.toString()) return this.invalid(checked, sequence, '审计链顺序不连续', state);
        if (!digestMatches(previousHash, record.previousHash)) return this.invalid(checked, sequence, '审计链前序摘要不匹配', state);
        const expectedHash = this.recordHash({ ...record, chainSequence: sequence, previousHash: record.previousHash, createdAt: record.createdAt });
        if (!digestMatches(expectedHash, record.recordHash)) return this.invalid(checked, sequence, '审计记录签名不匹配', state);
        previousHash = record.recordHash;
        expectedSequence += 1n;
        cursor = sequence;
      }
      if (records.length < batchSize) break;
    }
    const lastSequence = (expectedSequence - 1n).toString();
    if (String(state.lastSequence) !== lastSequence || !digestMatches(previousHash, state.lastHash)) {
      return { valid: false, checked, firstInvalidSequence: null, reason: '审计链状态与记录不一致', lastSequence: String(state.lastSequence) };
    }
    return { valid: true, checked, firstInvalidSequence: null, reason: null, lastSequence };
  }

  private async lockState(manager: EntityManager): Promise<AuditChainState> {
    let state = await manager.findOne(AuditChainState, { where: { id: CHAIN_ID }, lock: { mode: 'pessimistic_write' } });
    if (state) return state;
    state = manager.create(AuditChainState, { id: CHAIN_ID, lastSequence: '0', lastHash: GENESIS_HASH });
    return manager.save(AuditChainState, state);
  }

  private recordHash(record: AuditAppendInput & { createdAt: Date; chainSequence: string; previousHash: string }): string {
    const payload = {
      version: CHAIN_VERSION,
      sequence: record.chainSequence,
      previousHash: record.previousHash,
      actorId: record.actorId,
      merchantId: record.merchantId,
      action: record.action,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      before: record.before,
      after: record.after,
      requestId: record.requestId,
      actorRole: record.actorRole,
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      createdAt: record.createdAt.toISOString(),
    };
    return createHmac('sha256', this.signingKey).update(canonicalJson(payload)).digest('hex');
  }

  private invalid(checked: number, firstInvalidSequence: string, reason: string, state: AuditChainState): AuditChainIntegrity {
    return { valid: false, checked, firstInvalidSequence, reason, lastSequence: String(state.lastSequence) };
  }
}
