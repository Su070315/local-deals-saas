import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import { LessThan, Repository } from 'typeorm';
import { RequestThrottle } from './domain/entities';
import { throttleKeySecret } from './runtime-config';

@Injectable()
export class RequestThrottleService {
  constructor(@InjectRepository(RequestThrottle) private readonly throttles: Repository<RequestThrottle>) {}

  private key(scope: string, identity: string): string {
    return createHmac('sha256', throttleKeySecret()).update(`${scope}:${identity.slice(0, 512)}`).digest('hex');
  }

  async consume(scope: string, identity: string, limit: number, windowMs: number): Promise<void> {
    const now = new Date();
    const throttleKey = this.key(scope, identity || 'unknown');
    const resetAt = new Date(now.getTime() + windowMs);
    const records = await this.throttles.query(`
      INSERT INTO "request_throttles" ("throttleKey", "hitCount", "resetAt")
      VALUES ($1, 1, $2)
      ON CONFLICT ("throttleKey") DO UPDATE
      SET "hitCount" = CASE WHEN "request_throttles"."resetAt" <= $3 THEN 1 ELSE "request_throttles"."hitCount" + 1 END,
          "resetAt" = CASE WHEN "request_throttles"."resetAt" <= $3 THEN EXCLUDED."resetAt" ELSE "request_throttles"."resetAt" END,
          "updatedAt" = $3
      RETURNING "hitCount", "resetAt"
    `, [throttleKey, resetAt, now]) as Array<{ hitCount: number; resetAt: Date | string }>;
    const record = records[0]!;
    if (record.hitCount > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(record.resetAt).getTime() - now.getTime()) / 1000));
      throw new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message: '请求过于频繁，请稍后再试', retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async purgeExpired(retentionMs = 24 * 60 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - retentionMs);
    const candidates = await this.throttles.find({
      where: { resetAt: LessThan(cutoff) }, select: { throttleKey: true }, order: { resetAt: 'ASC' }, take: 1_000,
    });
    if (!candidates.length) return 0;
    const result = await this.throttles.delete(candidates.map((candidate) => candidate.throttleKey));
    return result.affected || 0;
  }
}
