import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { merchantOperationsEntities } from './merchant-operations.entities';
import { wechatPlatformEntities } from './wechat-platform.entities';
import { wechatOnboardingEntitlementEntities } from './wechat-onboarding-entitlement.entities';
import { appConfigEntities } from './app-config.entities';
import { customerProfileEntities } from './customer-profile.entities';

const bigintNumberTransformer: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => {
    if (value === null) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error('数据库金额超出 JavaScript 安全整数范围');
    return parsed;
  },
};

export enum UserRole {
  PLATFORM_ADMIN = 'PLATFORM_ADMIN',
  AGENCY_ADMIN = 'AGENCY_ADMIN',
  MERCHANT_ADMIN = 'MERCHANT_ADMIN',
  STORE_STAFF = 'STORE_STAFF',
}

/**
 * Platform accounts deliberately retain the stable PLATFORM_ADMIN login role
 * while their day-to-day authority is narrowed by this access profile. This
 * lets a production rollout migrate existing break-glass administrators
 * without reinterpreting historic roles or silently locking out operations.
 */
export enum PlatformAccessProfile {
  SYSTEM_ADMIN = 'SYSTEM_ADMIN',
  OPERATIONS = 'OPERATIONS',
  FINANCE = 'FINANCE',
  COMPLIANCE = 'COMPLIANCE',
  SECURITY = 'SECURITY',
}

export enum PlatformRuntimeControlStatus {
  ENABLED = 'ENABLED',
  PAUSED = 'PAUSED',
  RESUME_PENDING = 'RESUME_PENDING',
}

export enum MerchantStatus {
  ACTIVE = 'ACTIVE',
  SALES_SUSPENDED = 'SALES_SUSPENDED',
  EXITING = 'EXITING',
  CLOSED = 'CLOSED',
}

/** A durable, non-destructive case for winding down a merchant workspace. */
export enum MerchantExitCaseStatus {
  EXIT_REQUESTED = 'EXIT_REQUESTED',
  SALE_PAUSED = 'SALE_PAUSED',
  FULFILLING = 'FULFILLING',
  EXPORT_READY = 'EXPORT_READY',
  CLOSED = 'CLOSED',
  PURGE_ELIGIBLE = 'PURGE_ELIGIBLE',
}

export enum RateChangeRequestStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum PackageStatus {
  DRAFT = 'DRAFT',
  ON_SALE = 'ON_SALE',
  OFF_SALE = 'OFF_SALE',
}

export enum BatchOperationKind {
  PACKAGE_STATUS = 'PACKAGE_STATUS',
  STAFF_STORE_ACCESS = 'STAFF_STORE_ACCESS',
  VOUCHER_STORE_TRANSFER = 'VOUCHER_STORE_TRANSFER',
  VOUCHER_COMPENSATION_REFUND = 'VOUCHER_COMPENSATION_REFUND',
}

export enum BatchOperationStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  CLOSED = 'CLOSED',
  REFUNDED = 'REFUNDED',
}

export enum PaymentOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  COMPLETED = 'COMPLETED',
  RETRY = 'RETRY',
  CANCELLED = 'CANCELLED',
}

export enum DelayedSettlementTransactionStatus {
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  CONFIRMED = 'CONFIRMED',
  REFUNDED = 'REFUNDED',
}

export enum DelayedSettlementOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY = 'RETRY',
  CONFIRMED = 'CONFIRMED',
  REFUNDED = 'REFUNDED',
}

export enum PaymentEventType {
  PAYMENT_SUCCEEDED = 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  PAYMENT_CLOSED = 'PAYMENT_CLOSED',
  FUND_CONTROL_UPDATED = 'FUND_CONTROL_UPDATED',
  /** 汇付 resp_data 确认通知；只记录渠道事实，不进入普通支付入账链路。 */
  DELAYED_SETTLEMENT_UPDATED = 'DELAYED_SETTLEMENT_UPDATED',
}

export enum PaymentEventStatus {
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  NEEDS_RECONCILIATION = 'NEEDS_RECONCILIATION',
}

export enum MerchantPaymentProfileStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

export enum VoucherStatus {
  UNUSED = 'UNUSED',
  USED = 'USED',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
  EXPIRED = 'EXPIRED',
}

export enum BillStatus {
  DRAFT = 'DRAFT',
  DISPUTE_WINDOW = 'DISPUTE_WINDOW',
  DISPUTED = 'DISPUTED',
  CONFIRMED = 'CONFIRMED',
  OVERDUE = 'OVERDUE',
  PAID = 'PAID',
}

export enum BillDisputeStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

/** A four-eyes control for manually reconciled merchant service-fee receipts. */
export enum BillPaymentConfirmationRequestStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum InvoiceStatus {
  PENDING = 'PENDING',
  ISSUED = 'ISSUED',
  NOT_REQUIRED = 'NOT_REQUIRED',
}

export enum AccountingAdjustmentStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  POSTED = 'POSTED',
  REJECTED = 'REJECTED',
  REVERSED = 'REVERSED',
}

export enum SupportTicketStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

export enum SupportTicketSource {
  CUSTOMER = 'CUSTOMER',
  MERCHANT = 'MERCHANT',
}

export enum SupportTicketType {
  GENERAL = 'GENERAL',
  EXCEPTION_REFUND = 'EXCEPTION_REFUND',
}

/** Approval is distinct from executing the external payment refund. */
export enum ExceptionRefundApprovalStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum SupportReplyVisibility {
  CUSTOMER = 'CUSTOMER',
  INTERNAL = 'INTERNAL',
}

export enum ExportJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

export enum AuditOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SIGNED = 'SIGNED',
  QUARANTINED = 'QUARANTINED',
}

/** Durable notification delivery states. FAILED is terminal until an operator retries it. */
export enum NotificationOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  CUSTOMER_INBOX = 'CUSTOMER_INBOX',
}

export enum ExportKind {
  ORDERS = 'orders',
  VERIFICATIONS = 'verifications',
}

export enum MerchantRegistrationStatus {
  DRAFT = 'DRAFT',
  PENDING_MATERIALS = 'PENDING_MATERIALS',
  SUBMITTED = 'SUBMITTED',
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  UNDER_REVIEW = 'UNDER_REVIEW',
  OPENED = 'OPENED',
  AUTHORIZING = 'AUTHORIZING',
  PUBLISHABLE = 'PUBLISHABLE',
  FAILED = 'FAILED',
}

/** Offline commercial agreement between the platform and an agency. */
export enum AgencyCooperationPlan {
  PER_PUBLISH = 'PER_PUBLISH',
  ANNUAL_UNLIMITED = 'ANNUAL_UNLIMITED',
}

/** Tracks a merchant's reserved or consumed agency publishing entitlement. */
export enum PublicationEntitlementStatus {
  NONE = 'NONE',
  RESERVED = 'RESERVED',
  CONSUMED = 'CONSUMED',
}

@Entity('agencies')
export class Agency {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) name: string;
  @Column({ default: true }) active: boolean;
  // The platform records an offline cooperation authorization only. It never
  // stores bank credentials or attempts to collect the cooperation fee.
  @Column({ type: 'varchar', default: AgencyCooperationPlan.PER_PUBLISH }) cooperationPlan: AgencyCooperationPlan;
  @Column({ type: 'integer', default: 0 }) publicationQuotaRemaining: number;
  @Column({ type: 'date', nullable: true }) cooperationStartsAt: Date | null;
  @Column({ type: 'date', nullable: true }) cooperationEndsAt: Date | null;
  @Column({ type: 'varchar', default: '' }) cooperationReference: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('merchants')
@Index('IDX_merchants_creation_idempotency', ['createdBy', 'creationIdempotencyKey'], { unique: true })
export class Merchant {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) agencyId: string;
  // Internal request-control fields. They are never exposed in merchant lists.
  @Column({ type: 'uuid', nullable: true, select: false }) createdBy: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) creationIdempotencyKey: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) creationRequestHash: string | null;
  @Column() legalName: string;
  @Column() brandName: string;
  @Column({ default: MerchantStatus.ACTIVE }) status: MerchantStatus;
  @Column({ default: '' }) logoUrl: string;
  @Column({ default: '#1677ff' }) primaryColor: string;
  @Column({ default: '' }) servicePhone: string;
  /** 商家评分（0-5，可含一位小数，管理端可改；首页星级展示） */
  @Column({ type: 'varchar', length: 8, default: '5.0' }) rating: string;
  /** 附加服务标签（可停车/有包间/有WiFi/可预约，管理端可配；首页商家卡片展示） */
  @Column({ type: 'simple-json', default: '[]' }) featureTags: string[];
  @Column({ default: '' }) contractNumber: string;
  @Column({ type: 'date', nullable: true }) contractEndsAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * 门店顶部轮播图（原商家级轮播图迁移至门店维度）：每个门店独立管理自己的轮播图，
 * 数据按 storeId 隔离存储；仅该门店所属商家有权限编辑。
 */
@Entity('merchant_banners')
@Index('IDX_merchant_banners_merchant_sort', ['merchantId', 'sortOrder'])
@Index('IDX_merchant_banners_store_sort', ['storeId', 'sortOrder'])
export class MerchantBanner {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  /** NULL 表示迁移前的商户级公共 Banner，不能在部署时强制回填到某个门店。 */
  @Index() @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'varchar', length: 500 }) url: string;
  /** 跳转链接：仅支持小程序内部路径（以 / 开头，如 /pages/detail/index?id=xx），空表示不可点击 */
  @Column({ type: 'varchar', length: 500, default: '' }) link: string;
  @Column({ type: 'int', default: 0 }) sortOrder: number;
  @Column({ type: 'boolean', default: false }) isDefault: boolean;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * Auditable mapping between one SaaS merchant and the merchant account created
 * manually in the payment provider's onboarding console. It stores identifiers
 * only; identity documents, bank cards and provider credentials remain at the
 * provider.
 */
@Entity('merchant_payment_profiles')
@Index(['provider', 'merchantId'], { unique: true })
@Index(['provider', 'externalMerchantNo'], { unique: true })
@Index(['provider', 'providerMerchantId'], { unique: true })
export class MerchantPaymentProfile {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 32, default: 'HUIFU' }) provider: string;
  @Column({ type: 'varchar', length: 64 }) externalMerchantNo: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) providerMerchantId: string | null;
  @Column({ type: 'varchar', length: 64, default: '' }) applicationNo: string;
  /** 汇付通道：微信小程序 APPID（绑定后用于小程序支付） */
  @Column({ type: 'varchar', length: 32, default: '' }) wxAppletAppId: string;
  /** 汇付直连：该商户自己的系统号（sys_id），与私钥同属一个身份 */
  @Column({ type: 'varchar', length: 32, default: '' }) huifuSysId: string;
  /** 汇付直连：该商户的产品号 */
  @Column({ type: 'varchar', length: 32, default: '' }) huifuProductId: string;
  /** 汇付直连：该商户 RSA 私钥（AES-256-GCM 加密信封，绝不落明文） */
  @Column({ type: 'text', default: '' }) huifuPrivateKeyEnc: string;
  /** 汇付直连：该商户自己的 RSA 公钥（商户后台「商户公钥」项；公钥非敏感，明文保存用于参数完整性核对） */
  @Column({ type: 'text', default: '' }) huifuMerchantPublicKey: string;
  /** 汇付直连：该商户的汇付公钥（回调验签用） */
  @Column({ type: 'text', default: '' }) huifuPublicKey: string;
  /** 汇付直连：该商户的微信业务开通类型（fee_type，如 02=标准费率线下） */
  @Column({ type: 'varchar', length: 2, default: '' }) huifuFeeType: string;
  /** 天阙直连：该商户的天阙商户编号（mno） */
  @Column({ type: 'varchar', length: 64, default: '' }) tianqueMno: string;
  /** 天阙直连：该商户的组织号（orgId） */
  @Column({ type: 'varchar', length: 64, default: '' }) tianqueOrgId: string;
  /** 天阙直连：该商户 RSA 私钥（AES-256-GCM 加密信封，绝不落明文） */
  @Column({ type: 'text', default: '' }) tianquePrivateKeyEnc: string;
  /** 天阙直连：天阙平台 RSA 公钥（验签） */
  @Column({ type: 'text', default: '' }) tianquePublicKey: string;
  /** 天阙直连：签名算法（sha256 | sha1） */
  @Column({ type: 'varchar', length: 8, default: 'sha256' }) tianqueSignAlg: string;
  /** 微信直连：该商户的微信支付商户号（mchid） */
  @Column({ type: 'varchar', length: 64, default: '' }) wechatMchid: string;
  /** 微信直连：该商户的小程序 APPID（sub_appid） */
  @Column({ type: 'varchar', length: 32, default: '' }) wechatAppId: string;
  /** 微信直连：APIv3 密钥（AES-256-GCM 加密信封） */
  @Column({ type: 'text', default: '' }) wechatApiV3KeyEnc: string;
  /** 微信直连：商户 API 证书序列号 */
  @Column({ type: 'varchar', length: 64, default: '' }) wechatCertSerialNo: string;
  /** 微信直连：商户 API 私钥（apiclient_key.pem 内容，AES-256-GCM 加密信封） */
  @Column({ type: 'text', default: '' }) wechatPrivateKeyEnc: string;
  /** 微信直连：微信支付公钥（回调验签） */
  @Column({ type: 'text', default: '' }) wechatPublicKey: string;
  @Column({ type: 'varchar', length: 24, default: MerchantPaymentProfileStatus.PENDING }) status: MerchantPaymentProfileStatus;
  @Column({ type: 'integer', default: 1 }) version: number;
  @Column({ type: 'uuid', nullable: true }) verifiedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) verifiedAt: Date | null;
  @Column({ type: 'uuid' }) updatedBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('merchant_status_change_commands')
@Index('IDX_merchant_status_change_command_idempotency', ['merchantId', 'requestedBy', 'idempotencyKey'], { unique: true })
export class MerchantStatusChangeCommand {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'varchar' }) expectedStatus: MerchantStatus;
  @Column({ type: 'varchar' }) targetStatus: MerchantStatus;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/**
 * Closing a workspace never deletes its transactions or audit records. The
 * case separates the commercial wind-down, data handover, authorization
 * revocation reminder and later retention review into explicit checkpoints.
 */
@Entity('merchant_exit_cases')
export class MerchantExitCase {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar' }) status: MerchantExitCaseStatus;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'text' }) requestReason: string;
  @Column({ type: 'timestamptz', nullable: true }) salesPausedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) fulfillmentStartedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) fulfillmentStartedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) exportReadyAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) dataExportConfirmedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) dataExportConfirmedBy: string | null;
  @Column({ type: 'text', default: '' }) dataExportConfirmationNote: string;
  @Column({ type: 'timestamptz', nullable: true }) authorizationRevocationAcknowledgedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) authorizationRevocationAcknowledgedBy: string | null;
  @Column({ type: 'text', default: '' }) authorizationRevocationNote: string;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) closedBy: string | null;
  // No statutory period is assumed in code; compliance records the reviewed
  // policy and retention end before lifecycle can mark purge eligibility.
  @Column({ type: 'varchar', default: '' }) retentionPolicyReference: string;
  @Column({ type: 'date', nullable: true }) retentionUntil: Date | null;
  @Column({ type: 'text', default: '' }) retentionReviewNote: string;
  @Column({ type: 'uuid', nullable: true }) retentionReviewedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) purgeEligibleAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('merchant_registrations')
export class MerchantRegistration {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', default: MerchantRegistrationStatus.DRAFT }) status: MerchantRegistrationStatus;
  @Column({ type: 'text', default: '' }) note: string;
  @Column({ type: 'text', default: '' }) failureReason: string;
  /** 代理商为商家填写的营业执照图片（data URL），提交昵称修改给微信时复用，刷新/换设备不丢失 */
  @Column({ type: 'text', default: '' }) filingLicenseDataUrl: string;
  /** 备案资料草稿（整份备案表单的 JSON），持久化到后端，刷新/换设备不丢失 */
  @Column({ type: 'text', default: '{}' }) filingDataJson: string;
  @Column({ type: 'varchar', default: PublicationEntitlementStatus.NONE }) publicationEntitlementStatus: PublicationEntitlementStatus;
  @Column({ type: 'varchar', nullable: true }) publicationEntitlementPlan: AgencyCooperationPlan | null;
  @Column({ type: 'timestamptz', nullable: true }) publicationEntitlementReservedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) publicationEntitlementConsumedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) updatedBy: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('merchant_template_configs')
export class MerchantTemplateConfig {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) merchantId: string;
  @Column({ default: '' }) homeTitle: string;
  @Column({ type: 'text', default: '' }) homeSubtitle: string;
  @Column({ type: 'uuid', nullable: true }) featuredPackageId: string | null;
  @Column({ type: 'integer', default: 1 }) version: number;
  @Column({ type: 'uuid', nullable: true }) updatedBy: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('stores')
@Index('UQ_stores_id_merchant', ['id', 'merchantId'], { unique: true })
export class Store {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column() name: string;
  @Column() address: string;
  @Column({ type: 'double precision', nullable: true }) latitude: number | null;
  @Column({ type: 'double precision', nullable: true }) longitude: number | null;
  @Column({ default: '' }) phone: string;
  @Column({ default: '09:00-21:00' }) businessHours: string;
  // FIX: 门店头像/简介（2026-08-10 商家体验增强，migration MerchantExpansion）
  @Column({ type: 'varchar', length: 500, nullable: true }) logoUrl: string | null;
  @Column({ type: 'text', default: '' }) description: string;
  /** 总店标记（商家名下仅一家总店，首页展示总店/分店标签与切换） */
  @Column({ type: 'boolean', default: false }) isDefault: boolean;
  /** 门店评分（0-5，管理端门店可改；首页星级按门店展示） */
  @Column({ type: 'varchar', length: 8, default: '' }) rating: string;
  /** 门店附加服务标签（可停车/有包间/有WiFi/自定义，管理端门店可配；首页按门店展示） */
  @Column({ type: 'simple-json', default: '[]' }) featureTags: string[];
  @Column({ default: true }) openForSale: boolean;
  /** Whether this physical location can still redeem vouchers already sold. */
  @Column({ default: true }) openForVerification: boolean;
  @Column({ type: 'integer', default: 1 }) version: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/** 顾客预约单（2026-08-10 商家体验增强：预约真实闭环，migration MerchantExpansion） */
@Entity('reservations')
@Index('UQ_reservations_id_merchant', ['id', 'merchantId'], { unique: true })
export class Reservation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  // customerId 存 wx:<openid哈希> 字符串（与 orders/vouchers/support_tickets 一致），不能用 uuid
  @Index() @Column({ length: 100 }) customerId: string;
  @Column({ default: '' }) customerName: string;
  @Column({ default: '' }) customerPhone: string;
  @Column({ default: '' }) storeId: string;
  @Column({ default: '' }) storeName: string;
  @Column() date: string;
  @Column() timeSlot: string;
  @Column({ type: 'integer', default: 1 }) peopleCount: number;
  @Column({ default: '' }) remark: string;
  @Column({ type: 'varchar', length: 128, nullable: true }) idempotencyKey: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) requestHash: string | null;
  @Column({ default: 'PENDING' }) status: ReservationStatus;
  @Column({ type: 'timestamptz', nullable: true }) handledAt: Date | null;
  @Column({ default: '' }) handledNote: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  IN_PROGRESS = 'IN_PROGRESS',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column() email: string;
  @Column() name: string;
  @Column({ select: false }) passwordHash: string;
  @Column({ type: 'varchar' }) role: UserRole;
  // NULL is a deliberate backward-compatible break-glass system administrator.
  // New production platform accounts must receive an explicit narrow profile.
  @Column({ type: 'varchar', nullable: true }) platformAccessProfile: PlatformAccessProfile | null;
  @Index() @Column({ type: 'uuid', nullable: true }) agencyId: string | null;
  @Index() @Column({ type: 'uuid', nullable: true }) merchantId: string | null;
  @Column({ type: 'simple-json', nullable: true }) storeIds: string[] | null;
  // 微信开放平台网站应用 OAuth 的 openid：核销员扫码绑定后，同一 openid 只能绑定一个账号。
  @Index({ unique: true, where: '"wechatOpenid" IS NOT NULL' }) @Column({ type: 'varchar', length: 64, nullable: true }) wechatOpenid: string | null;
  // 核销员绑定意图令牌：商家后台生成、一次性、带有效期；扫码绑定成功后清空。
  @Column({ type: 'varchar', length: 128, nullable: true }) wechatBindToken: string | null;
  @Column({ type: 'timestamptz', nullable: true }) wechatBindTokenExpiresAt: Date | null;
  @Column({ default: true }) active: boolean;
  @Column({ default: 0 }) sessionVersion: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/** A singleton operational control. New-order sales are the first protected capability. */
@Entity('platform_runtime_controls')
export class PlatformRuntimeControl {
  @PrimaryColumn({ type: 'varchar', length: 64 }) key: string;
  @Column({ type: 'varchar', length: 32, default: PlatformRuntimeControlStatus.ENABLED }) status: PlatformRuntimeControlStatus;
  @Column({ type: 'varchar', length: 500, default: '' }) reason: string;
  @Column({ type: 'uuid', nullable: true }) updatedBy: string | null;
  @Column({ type: 'uuid', nullable: true }) resumeRequestedBy: string | null;
  @Column({ type: 'integer', default: 1 }) version: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Durable command record for retry-safe platform runtime control mutations. */
@Entity('platform_runtime_control_commands')
@Index('UQ_platform_runtime_control_command_idempotency', ['controlKey', 'requestedBy', 'idempotencyKey'], { unique: true })
export class PlatformRuntimeControlCommand {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'varchar', length: 64 }) controlKey: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'varchar', length: 32 }) action: string;
  @Column({ type: 'integer' }) expectedVersion: number;
  @Column({ type: 'varchar', length: 128, select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', length: 64, select: false }) requestHash: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/** A single-use, encrypted-at-rest credential for creating a merchant admin. */
@Entity('merchant_admin_invites')
@Index('UQ_merchant_admin_invites_request', ['requestedBy', 'idempotencyKey'], { unique: true })
@Index('UQ_merchant_admin_invites_token', ['tokenHash'], { unique: true })
@Index('IDX_merchant_admin_invites_merchant_created', ['merchantId', 'createdAt'])
export class MerchantAdminInvite {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) agencyId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column() email: string;
  @Column() name: string;
  @Column({ type: 'varchar', select: false }) tokenHash: string;
  @Column({ type: 'text', select: false }) tokenCiphertext: string;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) consumedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) consumedUserId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('staff_active_commands')
@Index('IDX_staff_active_command_idempotency', ['merchantId', 'staffId', 'requestedBy', 'idempotencyKey'], { unique: true })
export class StaffActiveCommand {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) staffId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'boolean' }) active: boolean;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('auth_sessions')
@Index(['userId', 'revokedAt'])
export class AuthSession {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) userId: string;
  @Column({ type: 'integer' }) sessionVersion: number;
  @Column({ default: '' }) ipAddress: string;
  @Column({ type: 'varchar', default: '' }) userAgent: string;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz' }) lastSeenAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) stepUpVerifiedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
}

@Entity('login_throttles')
export class LoginThrottle {
  @PrimaryColumn({ length: 64 }) throttleKey: string;
  @Column({ type: 'integer', default: 0 }) failureCount: number;
  @Column({ type: 'timestamptz' }) resetAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) blockedUntil: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('request_throttles')
@Index('IDX_8d649e459e780ac27e27201809', ['resetAt'])
export class RequestThrottle {
  @PrimaryColumn({ length: 64 }) throttleKey: string;
  @Column({ type: 'integer', default: 0 }) hitCount: number;
  @Column({ type: 'timestamptz' }) resetAt: Date;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('commission_rate_versions')
@Index(['merchantId', 'effectiveFrom'], { unique: true })
@Index('IDX_rate_versions_operator_idempotency', ['merchantId', 'createdBy', 'idempotencyKey'], { unique: true })
export class CommissionRateVersion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'numeric', precision: 7, scale: 4 }) rate: string;
  @Column({ type: 'timestamptz' }) effectiveFrom: Date;
  @Column({ default: '' }) note: string;
  @Column() createdBy: string;
  // Request-control data is never returned by rate APIs or copied into audits.
  @Column({ type: 'varchar', nullable: true, select: false }) idempotencyKey: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) requestHash: string | null;
  @CreateDateColumn() createdAt: Date;
}

/** A four-eyes request that becomes an immutable rate version only on approval. */
@Entity('rate_change_requests')
@Index('IDX_rate_change_requests_idempotency', ['merchantId', 'requestedBy', 'idempotencyKey'], { unique: true })
export class RateChangeRequest {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'numeric', precision: 7, scale: 4 }) rate: string;
  @Column({ type: 'timestamptz' }) effectiveFrom: Date;
  @Column({ type: 'text' }) note: string;
  @Column({ type: 'varchar' }) status: RateChangeRequestStatus;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @Column({ type: 'uuid', nullable: true }) reviewedBy: string | null;
  @Column({ type: 'text', default: '' }) reviewNote: string;
  @Column({ type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) rateVersionId: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('packages')
@Index('UQ_packages_id_merchant', ['id', 'merchantId'], { unique: true })
export class DealPackage {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column() title: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) priceFen: number;
  @Column({ type: 'varchar', length: 32, default: 'GROUP_BUY' }) productType: 'STANDARD' | 'GROUP_BUY' | 'WEIGHED' | 'MULTI_SPEC';
  @Column({ type: 'varchar', length: 64, default: '' }) skuCode: string;
  @Column({ type: 'varchar', length: 64, default: '' }) barcode: string;
  @Column({ type: 'varchar', length: 500, default: '' }) recommendation: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) coverImageUrl: string | null;
  @Column({ type: 'simple-json', default: '[]' }) galleryUrls: string[];
  @Column({ type: 'varchar', length: 1000, nullable: true }) videoUrl: string | null;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer, nullable: true }) originalPriceFen: number | null;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer, nullable: true }) memberPriceFen: number | null;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer, nullable: true }) purchasePriceFen: number | null;
  @Column({ type: 'varchar', length: 120, default: '' }) categoryName: string;
  /** 所属商品分类（关联 merchant-operations settings type=PRODUCT_CATEGORY 的 id 列表，多对多；删除分类仅解除关联不删商品） */
  @Column({ type: 'simple-json', default: '[]' }) categoryIds: string[];
  @Column({ type: 'varchar', length: 20, default: '份' }) unit: string;
  @Column({ type: 'integer', default: 1 }) minPurchaseQuantity: number;
  @Column({ type: 'integer', default: 0 }) virtualSales: number;
  @Column({ type: 'simple-json', default: '[]' }) tags: string[];
  @Column({ type: 'simple-json', default: '["STORE_PICKUP"]' }) fulfillmentMethods: Array<'STORE_PICKUP' | 'LOCAL_DELIVERY' | 'EXPRESS'>;
  @Column({ type: 'boolean', default: false }) distributionEnabled: boolean;
  @Column({ type: 'boolean', default: false }) batchManaged: boolean;
  @Column({ type: 'boolean', default: true }) pointsEnabled: boolean;
  @Column({ type: 'boolean', default: true }) inventoryEnabled: boolean;
  @Column({ type: 'integer', default: 0 }) inventoryWarningThreshold: number;
  @Column({ type: 'simple-json', default: '["ONLINE","OFFLINE"]' }) salesChannels: Array<'ONLINE' | 'OFFLINE'>;
  @Column({ type: 'simple-json', default: '[]' }) guaranteeLabels: string[];
  @Column({ type: 'simple-json', default: '[]' }) parameterValues: string[];
  @Column({ type: 'text', default: '' }) purchaseNotes: string;
  @Column({ type: 'text', default: '' }) usageRules: string;
  @Column({ type: 'text', default: '' }) detailContent: string;
  @Column({ type: 'integer', default: 0 }) saleLimit: number;
  @Column({ type: 'integer', default: 0 }) soldCount: number;
  @Column({ type: 'integer', default: 0 }) perCustomerLimit: number;
  @Column({ type: 'simple-json' }) storeIds: string[];
  @Column({ type: 'date' }) validFrom: Date;
  @Column({ type: 'date' }) validTo: Date;
  /** 销售窗口内，券有效期采用绝对日期或支付日起算。历史数据默认 ABSOLUTE。 */
  @Column({ type: 'varchar', length: 24, default: 'ABSOLUTE' }) validityMode: 'ABSOLUTE' | 'PURCHASE_RELATIVE';
  @Column({ type: 'integer', nullable: true }) validityDurationDays: number | null;
  @Column({ type: 'varchar', default: PackageStatus.DRAFT }) status: PackageStatus;
  @Column({ type: 'integer', default: 1 }) version: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('batch_operations')
@Index('IDX_batch_operations_request', ['requestedBy', 'idempotencyKey'], { unique: true })
@Index('IDX_batch_operations_status_created', ['status', 'createdAt'])
@Index('IDX_batch_operations_merchant_created_id', ['merchantId', 'createdAt', 'id'])
export class BatchOperation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) kind: BatchOperationKind;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'varchar', default: BatchOperationStatus.PENDING }) status: BatchOperationStatus;
  @Column({ type: 'simple-json' }) payload: Record<string, unknown>;
  @Column({ type: 'integer' }) totalCount: number;
  @Column({ type: 'integer', default: 0 }) succeededCount: number;
  @Column({ type: 'integer', default: 0 }) failedCount: number;
  @Column({ type: 'simple-json', nullable: true }) results: Array<Record<string, unknown>> | null;
  @Column({ type: 'text', default: '' }) error: string;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('merchant_import_operations')
@Index('UQ_merchant_import_operations_request', ['requestedBy', 'idempotencyKey'], { unique: true })
@Index('IDX_merchant_import_operations_status_created', ['status', 'createdAt'])
@Index('IDX_merchant_import_operations_agency', ['agencyId', 'createdAt'])
export class MerchantImportOperation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) agencyId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'varchar', default: BatchOperationStatus.PENDING }) status: BatchOperationStatus;
  @Column({ type: 'simple-json' }) payload: Record<string, unknown>;
  @Column({ type: 'integer' }) totalCount: number;
  @Column({ type: 'integer', default: 0 }) succeededCount: number;
  @Column({ type: 'integer', default: 0 }) failedCount: number;
  @Column({ type: 'simple-json', nullable: true }) results: Array<Record<string, unknown>> | null;
  @Column({ type: 'text', default: '' }) error: string;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * Relational compatibility layer for package fulfillment stores.
 * `DealPackage.storeIds` remains during the compatibility window so older
 * clients and snapshots can still be read, but new writes also populate this
 * table and production migrations enforce merchant-scoped foreign keys.
 */
@Entity('package_stores')
@Index('UQ_package_stores_package_store', ['packageId', 'storeId'], { unique: true })
@Index('IDX_package_stores_merchant_package', ['merchantId', 'packageId'])
@Index('IDX_package_stores_merchant_store', ['merchantId', 'storeId'])
export class PackageStore {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) packageId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) merchantId: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('orders')
@Index('IDX_orders_customer_idempotency', ['customerId', 'idempotencyKey'], { unique: true })
@Index('IDX_orders_status_payment_expiry', ['status', 'paymentExpiresAt'])
@Index('IDX_orders_package_customer_status', ['packageId', 'customerId', 'status'])
export class Order {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column() orderNo: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) packageId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column() customerId: string;
  @Column({ type: 'varchar', nullable: true }) idempotencyKey: string | null;
  @Column({ type: 'integer' }) quantity: number;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) unitPriceFen: number;
  @Column() packageTitleSnapshot: string;
  @Column({ type: 'integer' }) packageVersionSnapshot: number;
  @Column({ type: 'date' }) validFromSnapshot: Date;
  @Column({ type: 'date' }) validToSnapshot: Date;
  @Column({ type: 'varchar', length: 24, default: 'ABSOLUTE' }) validityModeSnapshot: 'ABSOLUTE' | 'PURCHASE_RELATIVE';
  @Column({ type: 'integer', nullable: true }) validityDurationDaysSnapshot: number | null;
  @Column({ type: 'numeric', precision: 7, scale: 4 }) commissionRateSnapshot: string;
  @Column({ type: 'varchar' }) status: OrderStatus;
  @Column({ type: 'timestamptz' }) paymentExpiresAt: Date;
  @Column({ type: 'varchar', nullable: true }) paymentReference: string | null;
  /** 汇付 jspay 返回的小程序端调起支付参数（WeixinJSBridge.invoke 串），取支付参数时返回给前端 */
  @Column({ type: 'text', default: '' }) payInfo: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * Transactional outbox for payment-intent creation. It deliberately stores
 * only the minimum payment metadata; provider request payloads and customer
 * identifiers must never be copied into an operational queue.
 */
@Entity('payment_outbox')
@Index(['status', 'nextAttemptAt'])
export class PaymentOutbox {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) orderId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 32, nullable: true }) provider: string | null;
  @Column({ type: 'uuid', nullable: true }) paymentProfileId: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) providerMerchantId: string | null;
  @Index({ unique: true }) @Column() idempotencyKey: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'varchar', default: PaymentOutboxStatus.PENDING }) status: PaymentOutboxStatus;
  @Column({ type: 'integer', default: 0 }) attemptCount: number;
  @Column({ type: 'timestamptz', nullable: true }) lastAttemptAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) lastReconciledAt: Date | null;
  @Column({ type: 'timestamptz' }) nextAttemptAt: Date;
  @Column({ type: 'varchar', nullable: true }) providerReference: string | null;
  @Column({ type: 'varchar', default: '' }) lastError: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * Immutable, de-duplicated normalized provider event. Raw webhook bodies are
 * intentionally not retained here; the SHA-256 digest is enough to detect a
 * conflicting replay without persisting payment-provider or customer data.
 */
@Entity('payment_events')
@Index(['provider', 'providerEventId'], { unique: true })
@Index(['provider', 'providerPaymentReference'])
@Index(['status', 'receivedAt'])
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) orderId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) providerMerchantId: string | null;
  @Column() provider: string;
  @Column() providerEventId: string;
  @Column({ type: 'varchar' }) eventType: PaymentEventType;
  @Column() providerPaymentReference: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
  @CreateDateColumn() receivedAt: Date;
  @Column({ type: 'varchar', length: 64 }) rawPayloadHash: string;
  @Column({ type: 'varchar', length: 64 }) normalizedHash: string;
  @Column({ type: 'varchar', default: PaymentEventStatus.RECEIVED }) status: PaymentEventStatus;
  @Column({ type: 'varchar', nullable: true }) huifuFundControlStatus: 'FREEZE' | 'UNFREEZE' | null;
  @Column({ type: 'timestamptz', nullable: true }) huifuFundFrozenAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) huifuFundUnfrozenAt: Date | null;
  @Column({ type: 'bigint', nullable: true, transformer: bigintNumberTransformer }) huifuFundUnfrozenAmountFen: number | null;
  @Column({ type: 'varchar', default: '' }) processingNote: string;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('vouchers')
@Index('IDX_vouchers_status_valid_to', ['status', 'validTo'])
@Index('IDX_vouchers_customer_created', ['customerId', 'createdAt', 'id'])
export class Voucher {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column() code: string;
  @Index() @Column({ type: 'uuid' }) orderId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) packageId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column() customerId: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) faceValueFen: number;
  @Column({ type: 'numeric', precision: 7, scale: 4 }) commissionRateSnapshot: string;
  @Column({ type: 'varchar' }) status: VoucherStatus;
  @Column({ type: 'date' }) validFrom: Date;
  @Index() @Column({ type: 'date' }) validTo: Date;
  @Column({ type: 'uuid', nullable: true }) verificationId: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('verifications')
@Index(['voucherId', 'idempotencyKey'], { unique: true })
export class Verification {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) voucherId: string;
  @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) staffId: string;
  @Column() idempotencyKey: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @CreateDateColumn() verifiedAt: Date;
}

/** 退款状态（Refund.status）——TS 层枚举约束，DB 列为 varchar 无 CHECK，历史数据兼容 */
export enum RefundStatus {
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/** 退款外部渠道阶段：确认后退款必须先回退已确认资金，再执行普通退款。 */
export enum RefundPaymentStage {
  DIRECT = 'DIRECT',
  CONFIRM_REFUND_PENDING = 'CONFIRM_REFUND_PENDING',
  CONFIRM_REFUND_PROCESSING = 'CONFIRM_REFUND_PROCESSING',
  CONFIRM_REFUND_SUCCEEDED = 'CONFIRM_REFUND_SUCCEEDED',
  ORDINARY_REFUND_PENDING = 'ORDINARY_REFUND_PENDING',
  ORDINARY_REFUND_PROCESSING = 'ORDINARY_REFUND_PROCESSING',
  MANUAL_REVIEW = 'MANUAL_REVIEW',
}

@Entity('refunds')
@Index('IDX_refunds_merchant_status_created', ['merchantId', 'status', 'createdAt'])
export class Refund {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) voucherId: string;
  @Column({ type: 'uuid' }) orderId: string;
  @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @Column({ default: 'CUSTOMER_SELF_SERVICE' }) reason: string;
  /** 售后异常退款/停业补偿的关联工单（可追溯审批来源；普通用户退款为空） */
  @Column({ type: 'uuid', nullable: true }) ticketId: string | null;
  @Column({ default: 'SUCCEEDED' }) status: string;
  @Column({ type: 'varchar', default: RefundPaymentStage.DIRECT }) paymentStage: RefundPaymentStage;
  /** 确认后退款的原交易确认请求号/日期，持久化后重试不得重新生成。 */
  @Column({ type: 'varchar', length: 128, nullable: true }) confirmationRequestSeq: string | null;
  @Column({ type: 'date', nullable: true }) confirmationRequestDate: Date | null;
  @Column({ type: 'varchar', nullable: true }) paymentReference: string | null;
  /** 当前确认退款请求号/日期，confirmrefundquery 必须复用。 */
  @Column({ type: 'varchar', length: 128, nullable: true }) confirmRefundRequestSeq: string | null;
  @Column({ type: 'date', nullable: true }) confirmRefundRequestDate: Date | null;
  @Column({ type: 'timestamp', nullable: true }) lastAttemptAt: Date | null;
  @Column({ type: 'integer', default: 0 }) attemptCount: number;
  @CreateDateColumn() createdAt: Date;
}

@Entity('delayed_settlement_transactions')
@Index(['orderId'], { unique: true })
@Index(['status', 'createdAt'])
export class DelayedSettlementTransaction {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) orderId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 32 }) provider: string;
  @Column({ type: 'varchar', length: 128 }) providerPaymentReference: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @Column({ type: 'text' }) snapshotJson: string;
  @Column({ type: 'varchar', default: DelayedSettlementTransactionStatus.PENDING_CONFIRMATION }) status: DelayedSettlementTransactionStatus;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('delayed_settlement_confirmation_outbox')
@Index('IDX_delayed_confirmation_status_next_attempt', ['status', 'nextAttemptAt'])
@Index('UQ_delayed_confirmation_verification', ['verificationId'], { unique: true })
@Index('UQ_delayed_confirmation_idempotency', ['idempotencyKey'], { unique: true })
export class DelayedSettlementConfirmationOutbox {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) transactionId: string;
  @Index() @Column({ type: 'uuid' }) verificationId: string;
  @Index() @Column({ type: 'uuid' }) orderId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) voucherId: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) amountFen: number;
  @Column({ type: 'simple-json' }) acctSplitBunch: Array<{ div_amt: string }>;
  @Column({ type: 'varchar', length: 128 }) idempotencyKey: string;
  /** 首次交易确认请求的稳定请求号/日期，用于确认查询和确认后退款定位。 */
  @Column({ type: 'varchar', length: 128, nullable: true }) confirmationRequestSeq: string | null;
  @Column({ type: 'date', nullable: true }) confirmationRequestDate: Date | null;
  @Column({ type: 'varchar', default: DelayedSettlementOutboxStatus.PENDING }) status: DelayedSettlementOutboxStatus;
  @Column({ type: 'integer', default: 0 }) attemptCount: number;
  @Column({ type: 'timestamptz', nullable: true }) lastAttemptAt: Date | null;
  @Column({ type: 'timestamptz' }) nextAttemptAt: Date;
  @Column({ type: 'varchar', length: 128, nullable: true }) providerReference: string | null;
  @Column({ type: 'varchar', default: '' }) lastError: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('settlement_ledger_entries')
@Index(['voucherId', 'entryType'], { unique: true })
@Index('IDX_ledger_merchant_occurred', ['merchantId', 'occurredAt'])
export class SettlementLedgerEntry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) voucherId: string;
  @Column({ type: 'uuid' }) verificationId: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) verifiedAmountFen: number;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) serviceFeeFen: number;
  @Column({ type: 'numeric', precision: 7, scale: 4 }) rateSnapshot: string;
  @Column() entryType: string;
  @CreateDateColumn() occurredAt: Date;
}

@Entity('settlement_ledger_reversals')
@Index(['refundId'], { unique: true })
@Index(['merchantId', 'occurredAt'])
export class SettlementLedgerReversal {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'uuid' }) voucherId: string;
  @Column({ type: 'uuid' }) verificationId: string;
  @Column({ type: 'uuid' }) refundId: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) reversalAmountFen: number;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) reversalServiceFeeFen: number;
  @Column({ type: 'numeric', precision: 7, scale: 4 }) rateSnapshot: string;
  @Column({ type: 'varchar', default: 'REFUND' }) reason: string;
  @CreateDateColumn() occurredAt: Date;
}

@Entity('monthly_bills')
@Index(['merchantId', 'period'], { unique: true })
export class MonthlyBill {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column() period: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) verifiedAmountFen: number;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) serviceFeeFen: number;
  @Column({ type: 'varchar', default: BillStatus.DRAFT }) status: BillStatus;
  @Column({ type: 'varchar', default: InvoiceStatus.PENDING }) invoiceStatus: InvoiceStatus;
  @Column({ type: 'varchar', nullable: true }) invoiceNumber: string | null;
  @Column({ type: 'timestamptz' }) disputeEndsAt: Date;
  @Column({ type: 'timestamptz' }) dueAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) accountingLockedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) accountingLockedBy: string | null;
  @Column({ type: 'integer', default: 0 }) adjustmentVersion: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('bill_adjustments')
@Index(['billId', 'status'])
@Index(['merchantId', 'period', 'createdAt'])
@Index('IDX_bill_adjustments_idempotency', ['billId', 'requestedBy', 'idempotencyKey'], { unique: true })
export class BillAdjustment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) billId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar' }) period: string;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) verifiedAmountDeltaFen: number;
  @Column({ type: 'bigint', transformer: bigintNumberTransformer }) serviceFeeDeltaFen: number;
  @Column({ type: 'varchar', length: 60 }) reasonCode: string;
  @Column({ type: 'text' }) note: string;
  @Column({ type: 'varchar', default: AccountingAdjustmentStatus.PENDING_REVIEW }) status: AccountingAdjustmentStatus;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'uuid', nullable: true }) reviewedBy: string | null;
  @Column({ type: 'text', default: '' }) reviewNote: string;
  @Column({ type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) reversalOfId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) postedAt: Date | null;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('monthly_bill_generation_commands')
@Index('IDX_monthly_bill_generation_command_idempotency', ['requestedBy', 'idempotencyKey'], { unique: true })
export class MonthlyBillGenerationCommand {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) period: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('bill_payment_confirmation_requests')
@Index('IDX_bill_payment_confirmation_idempotency', ['billId', 'requestedBy', 'idempotencyKey'], { unique: true })
@Index('IDX_bill_payment_confirmation_pending', ['billId'], { unique: true, where: '"status" = \'PENDING_REVIEW\'' })
@Index('IDX_bill_payment_confirmation_reference_active', ['paymentReference'], { unique: true, where: '"status" IN (\'PENDING_REVIEW\', \'APPROVED\')' })
export class BillPaymentConfirmationRequest {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) billId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) requestedBy: string;
  // A bank-statement reference is a manual reconciliation pointer, never a bank-account credential.
  @Column({ type: 'varchar' }) paymentReference: string;
  @Column({ type: 'text' }) note: string;
  @Column({ type: 'varchar' }) status: BillPaymentConfirmationRequestStatus;
  @Column({ type: 'varchar', select: false }) idempotencyKey: string;
  @Column({ type: 'varchar', select: false }) requestHash: string;
  @Column({ type: 'uuid', nullable: true }) reviewedBy: string | null;
  @Column({ type: 'text', default: '' }) reviewNote: string;
  @Column({ type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('bill_disputes')
@Index(['merchantId', 'status'])
export class BillDispute {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) billId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) submittedBy: string;
  @Column({ type: 'text' }) content: string;
  @Column({ type: 'varchar', default: BillDisputeStatus.OPEN }) status: BillDisputeStatus;
  @Column({ type: 'text', default: '' }) resolutionNote: string;
  @Column({ type: 'uuid', nullable: true }) resolvedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('support_tickets')
@Index(['merchantId', 'status'])
@Index('IDX_open_exception_refund_per_voucher', ['merchantId', 'voucherId'], { unique: true, where: '"status" = \'OPEN\' AND "source" = \'MERCHANT\' AND "type" = \'EXCEPTION_REFUND\'' })
@Index('IDX_support_tickets_customer_idempotency', ['customerId', 'idempotencyKey'], { unique: true, where: '"customerId" IS NOT NULL AND "idempotencyKey" IS NOT NULL' })
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Index() @Column({ type: 'varchar', nullable: true }) customerId: string | null;
  @Column({ type: 'varchar', default: SupportTicketSource.CUSTOMER }) source: SupportTicketSource;
  @Column({ type: 'varchar', default: SupportTicketType.GENERAL }) type: SupportTicketType;
  @Column({ type: 'uuid', nullable: true }) submittedBy: string | null;
  @Column({ type: 'uuid', nullable: true }) voucherId: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) idempotencyKey: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) requestHash: string | null;
  @Column({ default: '' }) contactPhone: string;
  @Column({ type: 'text' }) content: string;
  @Column({ type: 'varchar', default: SupportTicketStatus.OPEN }) status: SupportTicketStatus;
  @Column({ type: 'varchar', nullable: true }) exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus | null;
  @Column({ type: 'uuid', nullable: true }) exceptionRefundApprovedBy: string | null;
  @Column({ type: 'text', default: '' }) exceptionRefundApprovalNote: string;
  @Column({ type: 'timestamptz', nullable: true }) exceptionRefundApprovedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) firstResponseDueAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) firstRespondedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) firstRespondedBy: string | null;
  @Column({ type: 'text', default: '' }) resolutionNote: string;
  @Column({ type: 'uuid', nullable: true }) resolvedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/** Immutable customer-visible or internal handling messages for a support ticket. */
@Entity('support_ticket_replies')
@Index(['ticketId', 'createdAt'])
export class SupportTicketReply {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) ticketId: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid' }) authorId: string;
  @Column({ type: 'varchar' }) authorRole: UserRole;
  @Column({ type: 'varchar', default: SupportReplyVisibility.CUSTOMER }) visibility: SupportReplyVisibility;
  @Column({ type: 'text' }) content: string;
  @CreateDateColumn() createdAt: Date;
}

/**
 * Bounded, encrypted export artifact. This is intentionally a short-lived
 * database artifact for the pilot; a production COS adapter can replace the
 * encryptedArtifact field without changing job, permission or audit rules.
 */
@Entity('export_jobs')
@Index(['requestedBy', 'createdAt'])
@Index(['status', 'expiresAt'])
@Index(['status', 'createdAt'])
@Index(['status', 'lastAttemptAt'])
@Index('IDX_export_jobs_request_idempotency', ['requestedBy', 'idempotencyKey'], { unique: true, where: '"idempotencyKey" IS NOT NULL' })
export class ExportJob {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) requestedBy: string;
  @Column({ type: 'varchar' }) requestedRole: UserRole;
  @Column({ type: 'varchar' }) kind: ExportKind;
  @Column({ type: 'simple-json' }) merchantScope: string[];
  @Column({ type: 'uuid', nullable: true }) requestedMerchantId: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) idempotencyKey: string | null;
  @Column({ type: 'varchar', nullable: true, select: false }) requestHash: string | null;
  // PostgreSQL DATE values are business-calendar strings, never UTC instants.
  @Column({ type: 'date' }) fromDay: string;
  @Column({ type: 'date' }) toDay: string;
  @Column({ type: 'varchar', default: ExportJobStatus.PENDING }) status: ExportJobStatus;
  @Column({ type: 'integer', default: 0 }) recordCount: number;
  @Column({ type: 'text', nullable: true }) encryptedArtifact: string | null;
  @Column({ type: 'varchar', default: '' }) artifactSha256: string;
  @Column({ type: 'integer', default: 0 }) downloadCount: number;
  @Column({ type: 'timestamptz', nullable: true }) lastDownloadedAt: Date | null;
  @Column({ type: 'integer', default: 0 }) attemptCount: number;
  @Column({ type: 'timestamptz', nullable: true }) lastAttemptAt: Date | null;
  @Column({ type: 'varchar', default: '' }) failureReason: string;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('audit_logs')
@Index('IDX_audit_logs_chain_version_sequence', ['chainVersion', 'chainSequence'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column() actorId: string;
  @Index() @Column({ type: 'varchar', nullable: true }) merchantId: string | null;
  @Column() action: string;
  @Column() resourceType: string;
  @Column() resourceId: string;
  @Column({ type: 'simple-json', nullable: true }) before: Record<string, unknown> | null;
  @Column({ type: 'simple-json', nullable: true }) after: Record<string, unknown> | null;
  @Index() @Column({ default: '' }) requestId: string;
  @Column({ default: '' }) actorRole: string;
  @Column({ default: '' }) ipAddress: string;
  @Column({ type: 'varchar', default: '' }) userAgent: string;
  @Column({ type: 'integer', default: 0 }) chainVersion: number;
  @Index({ unique: true }) @Column({ type: 'bigint', nullable: true }) chainSequence: string | null;
  @Column({ type: 'varchar', default: '' }) previousHash: string;
  @Column({ type: 'varchar', default: '' }) recordHash: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('audit_chain_state')
export class AuditChainState {
  @PrimaryColumn({ type: 'varchar', length: 32 }) id: string;
  @Column({ type: 'bigint', default: '0' }) lastSequence: string;
  @Column({ type: 'varchar', length: 64 }) lastHash: string;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * Transactional hand-off for signed audit records. The business transaction
 * commits this immutable payload before any signer touches the global chain.
 */
@Entity('audit_outbox')
@Index(['status', 'createdAt'])
@Index(['status', 'lastAttemptAt'])
export class AuditOutbox {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'integer', default: 1 }) outboxVersion: number;
  @Index() @Column() actorId: string;
  @Index() @Column({ type: 'varchar', nullable: true }) merchantId: string | null;
  @Column() action: string;
  @Column() resourceType: string;
  @Column() resourceId: string;
  @Column({ type: 'simple-json', nullable: true }) before: Record<string, unknown> | null;
  @Column({ type: 'simple-json', nullable: true }) after: Record<string, unknown> | null;
  @Index() @Column({ default: '' }) requestId: string;
  @Column({ default: '' }) actorRole: string;
  @Column({ default: '' }) ipAddress: string;
  @Column({ type: 'varchar', default: '' }) userAgent: string;
  @Column({ type: 'varchar', length: 64 }) payloadHash: string;
  @Column({ type: 'varchar', default: AuditOutboxStatus.PENDING }) status: AuditOutboxStatus;
  @Column({ type: 'integer', default: 0 }) attemptCount: number;
  @Column({ type: 'timestamptz', nullable: true }) lastAttemptAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) signedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) signedAuditLogId: string | null;
  @Column({ type: 'varchar', default: '' }) failureReason: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/**
 * Transactional hand-off for notifications. Recipient addresses and targets
 * are encrypted; payloads contain template variables only and never secrets
 * such as invitation tokens or payment credentials.
 */
@Entity('notification_outbox')
@Index('IDX_notification_outbox_status_next_attempt', ['status', 'nextAttemptAt'])
@Index('IDX_notification_outbox_status_created', ['status', 'createdAt'])
@Index('IDX_notification_outbox_merchant_created', ['merchantId', 'createdAt'])
@Index('UQ_notification_outbox_dedupe', ['dedupeKey'], { unique: true })
export class NotificationOutbox {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) eventType: string;
  @Column({ type: 'varchar' }) templateKey: string;
  @Column({ type: 'varchar' }) channel: NotificationChannel;
  @Column({ type: 'text' }) recipientCiphertext: string;
  @Index() @Column({ type: 'varchar', nullable: true }) merchantId: string | null;
  @Column({ type: 'varchar', nullable: true }) resourceType: string | null;
  @Column({ type: 'varchar', nullable: true }) resourceId: string | null;
  @Column({ type: 'simple-json', default: '{}' }) payload: Record<string, unknown>;
  @Column({ type: 'varchar' }) dedupeKey: string;
  @Column({ type: 'varchar', default: NotificationOutboxStatus.PENDING }) status: NotificationOutboxStatus;
  @Column({ type: 'integer', default: 0 }) attemptCount: number;
  @Column({ type: 'timestamptz' }) nextAttemptAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) lastAttemptAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) sentAt: Date | null;
  @Column({ type: 'varchar', nullable: true }) providerMessageId: string | null;
  @Column({ type: 'varchar', default: '' }) lastError: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export const entities = [
  Agency, Merchant, MerchantBanner, MerchantPaymentProfile, MerchantStatusChangeCommand, MerchantExitCase, MerchantRegistration, MerchantTemplateConfig, Store, User, PlatformRuntimeControl, PlatformRuntimeControlCommand, MerchantAdminInvite, StaffActiveCommand, AuthSession, LoginThrottle, RequestThrottle, CommissionRateVersion, RateChangeRequest, DealPackage, PackageStore, Order, Reservation,
  PaymentOutbox, PaymentEvent, DelayedSettlementTransaction, DelayedSettlementConfirmationOutbox, Voucher, Verification, Refund, SettlementLedgerEntry, SettlementLedgerReversal, MonthlyBill, BillAdjustment, MonthlyBillGenerationCommand, BillPaymentConfirmationRequest, BillDispute, BatchOperation, MerchantImportOperation, SupportTicket, SupportTicketReply, ExportJob, AuditLog, AuditChainState, AuditOutbox, NotificationOutbox,
  ...merchantOperationsEntities,
  ...wechatPlatformEntities,
  ...wechatOnboardingEntitlementEntities,
  ...appConfigEntities,
  ...customerProfileEntities,
];
