import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum WechatAuthorizerStatus {
  AUTHORIZED = 'AUTHORIZED',
  REVOKED = 'REVOKED',
}

export enum WechatIcpVerifyTaskStatus {
  PENDING = 'PENDING',
  FAILED = 'FAILED',
  SUCCEEDED = 'SUCCEEDED',
}

export enum WechatMiniprogramReleaseStatus {
  DRAFT = 'DRAFT',
  COMMITTED = 'COMMITTED',
  AUDIT_SUBMITTED = 'AUDIT_SUBMITTED',
  AUDIT_APPROVED = 'AUDIT_APPROVED',
  AUDIT_REJECTED = 'AUDIT_REJECTED',
  RELEASED = 'RELEASED',
  FAILED = 'FAILED',
}

export enum WechatMiniprogramReleaseJobType {
  COMMIT = 'COMMIT',
  TRIAL_QR = 'TRIAL_QR',
  SUBMIT_AUDIT = 'SUBMIT_AUDIT',
  QUERY_AUDIT = 'QUERY_AUDIT',
  RELEASE = 'RELEASE',
  SPEEDUP_AUDIT = 'SPEEDUP_AUDIT',
}

export enum WechatMiniprogramReleaseJobStatus {
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export enum WechatOnboardingStepKey {
  MATERIALS = 'materials',
  REGISTRATION = 'registration',
  AUTHORIZATION = 'authorization',
  BASIC_INFO = 'basicInfo',
  CATEGORIES = 'categories',
  FILING = 'filing',
  PUBLISHABLE = 'publishable',
}

export enum WechatOnboardingBusinessStatus {
  ACTION_REQUIRED = 'ACTION_REQUIRED',
  PROCESSING = 'PROCESSING',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED',
}

export enum WechatOnboardingSyncStatus {
  UNKNOWN = 'UNKNOWN',
  HEALTHY = 'HEALTHY',
  PENDING = 'PENDING',
  STALE = 'STALE',
  ERROR = 'ERROR',
}

export enum WechatCallbackEventStatus {
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

export enum WechatSyncTaskStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

@Entity('wechat_onboardings')
export class WechatOnboarding {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', default: WechatOnboardingBusinessStatus.ACTION_REQUIRED }) status: WechatOnboardingBusinessStatus;
  @Column({ type: 'varchar', default: WechatOnboardingSyncStatus.UNKNOWN }) syncStatus: WechatOnboardingSyncStatus;
  @Column({ type: 'timestamptz', nullable: true }) evidenceUpdatedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) lastSyncAt: Date | null;
  @Column({ type: 'text', default: '' }) lastSyncError: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_onboarding_steps')
@Index('UQ_wechat_onboarding_steps_merchant_key', ['merchantId', 'key'], { unique: true })
export class WechatOnboardingStep {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 32 }) key: WechatOnboardingStepKey;
  @Column({ type: 'varchar', default: WechatOnboardingBusinessStatus.ACTION_REQUIRED }) status: WechatOnboardingBusinessStatus;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) evidence: Record<string, unknown>;
  @Column({ type: 'timestamptz', nullable: true }) evidenceUpdatedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_callback_events')
export class WechatCallbackEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 64 }) fingerprint: string;
  @Index() @Column({ type: 'uuid', nullable: true }) merchantId: string | null;
  @Index() @Column({ type: 'varchar', length: 64, nullable: true }) authorizerAppId: string | null;
  @Column({ type: 'varchar', length: 64 }) eventType: string;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload: Record<string, unknown>;
  @Column({ type: 'varchar', default: WechatCallbackEventStatus.RECEIVED }) status: WechatCallbackEventStatus;
  @Column({ type: 'timestamptz', nullable: true }) processedAt: Date | null;
  @Column({ type: 'text', default: '' }) errorMessage: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('wechat_sync_tasks')
@Index('UQ_wechat_sync_tasks_event_type', ['callbackEventId', 'type'], { unique: true })
export class WechatSyncTask {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid', nullable: true }) merchantId: string | null;
  @Index() @Column({ type: 'uuid' }) callbackEventId: string;
  @Column({ type: 'varchar', length: 64 }) type: string;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload: Record<string, unknown>;
  @Column({ type: 'varchar', default: WechatSyncTaskStatus.PENDING }) status: WechatSyncTaskStatus;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) availableAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date | null;
  @Column({ type: 'text', default: '' }) lastError: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_component_state')
export class WechatComponentState {
  @PrimaryColumn({ type: 'varchar', length: 32 }) id: string;
  @Column({ type: 'text', select: false }) verifyTicketCiphertext: string;
  @Column({ type: 'timestamptz', nullable: true }) ticketUpdatedAt: Date | null;
  @Column({ type: 'text', default: '', select: false }) accessTokenCiphertext: string;
  @Column({ type: 'timestamptz', nullable: true }) accessTokenExpiresAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_authorization_attempts')
export class WechatAuthorizationAttempt {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 64, select: false }) stateHash: string;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) consumedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('wechat_authorizers')
export class WechatAuthorizer {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) merchantId: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 64 }) authorizerAppId: string;
  @Column({ type: 'text', select: false }) refreshTokenCiphertext: string;
  @Column({ type: 'text', default: '', select: false }) accessTokenCiphertext: string;
  @Column({ type: 'timestamptz', nullable: true }) accessTokenExpiresAt: Date | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) permissionIds: number[];
  @Column({ type: 'varchar', default: WechatAuthorizerStatus.AUTHORIZED }) status: WechatAuthorizerStatus;
  @Column({ type: 'timestamptz' }) authorizedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_icp_verify_tasks')
export class WechatIcpVerifyTask {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) requestedBy: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 128 }) taskId: string;
  @Column({ type: 'boolean', default: false }) alongWithAuth: boolean;
  @Column({ type: 'text', default: '' }) verifyUrl: string;
  @Column({ type: 'varchar', default: WechatIcpVerifyTaskStatus.PENDING }) status: WechatIcpVerifyTaskStatus;
  @Column({ type: 'boolean', default: false }) isFinish: boolean;
  @Column({ type: 'integer', nullable: true }) faceStatus: number | null;
  @Column({ type: 'integer', nullable: true }) alongWithAuthResult: number | null;
  @Column({ type: 'text', default: '' }) lastMessage: string;
  @Column({ type: 'timestamptz', nullable: true }) lastCheckedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_miniprogram_releases')
export class WechatMiniprogramRelease {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'varchar', length: 64 }) authorizerAppId: string;
  @Column({ type: 'integer' }) templateId: number;
  @Column({ type: 'varchar', length: 64 }) userVersion: string;
  @Column({ type: 'varchar', length: 240, default: '' }) userDesc: string;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) extJson: Record<string, unknown>;
  @Index() @Column({ type: 'varchar', default: WechatMiniprogramReleaseStatus.DRAFT }) status: WechatMiniprogramReleaseStatus;
  @Column({ type: 'integer', nullable: true }) auditId: number | null;
  @Column({ type: 'text', default: '' }) trialQrUrl: string;
  @Column({ type: 'text', default: '' }) errorMessage: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wechat_miniprogram_release_jobs')
export class WechatMiniprogramReleaseJob {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) releaseId: string;
  @Column({ type: 'varchar' }) type: WechatMiniprogramReleaseJobType;
  @Column({ type: 'varchar' }) status: WechatMiniprogramReleaseJobStatus;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload: Record<string, unknown>;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) result: Record<string, unknown>;
  @Column({ type: 'text', default: '' }) errorMessage: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

export const wechatPlatformEntities = [
  WechatOnboarding,
  WechatOnboardingStep,
  WechatCallbackEvent,
  WechatSyncTask,
  WechatComponentState,
  WechatAuthorizationAttempt,
  WechatAuthorizer,
  WechatIcpVerifyTask,
  WechatMiniprogramRelease,
  WechatMiniprogramReleaseJob,
];
