import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum InventoryBatchStatus {
  NORMAL = 'NORMAL',
  EXPIRING = 'EXPIRING',
  EXPIRED = 'EXPIRED',
  DISABLED = 'DISABLED',
}

export enum InventoryDocumentType {
  PURCHASE = 'PURCHASE',
  REQUISITION = 'REQUISITION',
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
  LOSS = 'LOSS',
  COUNT = 'COUNT',
  TRANSFER = 'TRANSFER',
}

export enum InventoryDocumentStatus {
  DRAFT = 'DRAFT',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

export type InventoryDocumentItem = {
  batchId?: string;
  skuCode: string;
  productName: string;
  quantity: number;
  unitCostFen: number;
};

export enum MemberStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED',
}

export enum PromoterStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

export enum OperationalLedgerCategory {
  MEMBER_RECHARGE = 'MEMBER_RECHARGE',
  DISTRIBUTION_COMMISSION = 'DISTRIBUTION_COMMISSION',
  DISTRIBUTION_WITHDRAWAL = 'DISTRIBUTION_WITHDRAWAL',
}

export enum MerchantSettingType {
  PRODUCT_CATEGORY = 'PRODUCT_CATEGORY',
  RESERVATION_PROJECT = 'RESERVATION_PROJECT',
  PRODUCT_SPEC = 'PRODUCT_SPEC',
  PRODUCT_TAG = 'PRODUCT_TAG',
  PRODUCT_GUARANTEE = 'PRODUCT_GUARANTEE',
  PRODUCT_PARAMETER = 'PRODUCT_PARAMETER',
  PRODUCT_GROUP_PACKAGE = 'PRODUCT_GROUP_PACKAGE',
  PRODUCT_REVIEW = 'PRODUCT_REVIEW',
  PRODUCT_REVIEW_SETTING = 'PRODUCT_REVIEW_SETTING',
  MEMBER_LEVEL = 'MEMBER_LEVEL',
  MEMBER_TAG = 'MEMBER_TAG',
  MEMBER_PAID_PLAN = 'MEMBER_PAID_PLAN',
  MEMBER_RECHARGE_RULE = 'MEMBER_RECHARGE_RULE',
  MEMBER_BENEFITS = 'MEMBER_BENEFITS',
  DISTRIBUTION_LEVEL = 'DISTRIBUTION_LEVEL',
  DISTRIBUTION_REWARD = 'DISTRIBUTION_REWARD',
  DISTRIBUTION_RECOMMENDATION_REWARD = 'DISTRIBUTION_RECOMMENDATION_REWARD',
  DISTRIBUTION_RECRUITMENT = 'DISTRIBUTION_RECRUITMENT',
  DISTRIBUTION_WITHDRAWAL_SETTING = 'DISTRIBUTION_WITHDRAWAL_SETTING',
  INVENTORY_SUPPLIER = 'INVENTORY_SUPPLIER',
  INVENTORY_EXPIRY_SETTING = 'INVENTORY_EXPIRY_SETTING',
  INVENTORY_OUTBOUND_RULE = 'INVENTORY_OUTBOUND_RULE',
  INVENTORY_TRANSFER_DISPUTE = 'INVENTORY_TRANSFER_DISPUTE',
  MARKETING_RULE = 'MARKETING_RULE',
  MARKETING_SMS_TEMPLATE = 'MARKETING_SMS_TEMPLATE',
  MARKETING_SMS_PROVIDER = 'MARKETING_SMS_PROVIDER',
  MARKETING_SMS_RECORD = 'MARKETING_SMS_RECORD',
  MARKETING_MATERIAL = 'MARKETING_MATERIAL',
  MARKETING_PUBLISH_CHANNEL = 'MARKETING_PUBLISH_CHANNEL',
  MARKETING_GROUP_INSTANCE = 'MARKETING_GROUP_INSTANCE',
  POINTS_EXCHANGE = 'POINTS_EXCHANGE',
  COUPON_DISTRIBUTION = 'COUPON_DISTRIBUTION',
  STORE_SYSTEM_MESSAGE = 'STORE_SYSTEM_MESSAGE',
  STORE_DELIVERY_PLAN = 'STORE_DELIVERY_PLAN',
  STORE_FREIGHT_RULE = 'STORE_FREIGHT_RULE',
  STORE_EXPRESS_RULE = 'STORE_EXPRESS_RULE',
  POINTS_PRODUCT = 'POINTS_PRODUCT',
  MALL_PAGE = 'MALL_PAGE',
  MALL_SYSTEM_PAGE = 'MALL_SYSTEM_PAGE',
  MALL_MEMBER_CENTER = 'MALL_MEMBER_CENTER',
  MALL_CATEGORY_LAYOUT = 'MALL_CATEGORY_LAYOUT',
  MALL_ROLE = 'MALL_ROLE',
  MALL_MATERIAL = 'MALL_MATERIAL',
  MALL_THEME = 'MALL_THEME',
}

@Entity('inventory_batches')
@Index('IDX_inventory_batches_merchant_status', ['merchantId', 'status'])
export class InventoryBatch {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'uuid', nullable: true }) packageId: string | null;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'varchar', length: 64 }) skuCode: string;
  @Column({ type: 'varchar', length: 120 }) productName: string;
  @Column({ type: 'integer', default: 0 }) quantity: number;
  @Column({ type: 'integer', default: 0 }) reservedQuantity: number;
  @Column({ type: 'integer', default: 0 }) unitCostFen: number;
  @Column({ type: 'date', nullable: true }) productionDate: string | null;
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date | null;
  @Column({ type: 'varchar', length: 24, default: InventoryBatchStatus.NORMAL }) status: InventoryBatchStatus;
  @Column({ type: 'varchar', length: 500, default: '' }) note: string;
  @Column({ type: 'integer', default: 1 }) version: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('inventory_documents')
@Index('UQ_inventory_documents_merchant_number', ['merchantId', 'documentNo'], { unique: true })
@Index('IDX_inventory_documents_merchant_type_status', ['merchantId', 'type', 'status'])
export class InventoryDocument {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 40 }) documentNo: string;
  @Column({ type: 'varchar', length: 24 }) type: InventoryDocumentType;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) sourceStoreId: string | null;
  @Column({ type: 'uuid', nullable: true }) targetStoreId: string | null;
  @Column({ type: 'varchar', length: 120, default: '' }) counterparty: string;
  @Column({ type: 'simple-json' }) items: InventoryDocumentItem[];
  @Column({ type: 'integer', default: 0 }) totalQuantity: number;
  @Column({ type: 'integer', default: 0 }) totalAmountFen: number;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
  @Column({ type: 'varchar', length: 24, default: InventoryDocumentStatus.DRAFT }) status: InventoryDocumentStatus;
  @Column({ type: 'varchar', length: 500, default: '' }) note: string;
  @Column({ type: 'uuid' }) createdBy: string;
  @Column({ type: 'uuid', nullable: true }) confirmedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('member_profiles')
@Index('UQ_member_profiles_merchant_external', ['merchantId', 'externalCustomerId'], { unique: true })
export class MemberProfile {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 100 }) externalCustomerId: string;
  @Column({ type: 'varchar', length: 80 }) name: string;
  @Column({ type: 'varchar', length: 32, default: '' }) phoneMasked: string;
  @Column({ type: 'varchar', length: 40, default: '普通会员' }) level: string;
  @Column({ type: 'simple-json', nullable: true }) tags: string[] | null;
  @Column({ type: 'integer', default: 0 }) balanceFen: number;
  @Column({ type: 'integer', default: 0 }) points: number;
  @Column({ type: 'integer', default: 0 }) orderCount: number;
  @Column({ type: 'integer', default: 0 }) totalSpendFen: number;
  @Column({ type: 'varchar', length: 24, default: MemberStatus.ACTIVE }) status: MemberStatus;
  @Column({ type: 'timestamptz', nullable: true }) lastActiveAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('marketing_campaigns')
@Index('IDX_marketing_campaigns_merchant_status', ['merchantId', 'status'])
export class MarketingCampaign {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 40 }) type: string;
  @Column({ type: 'varchar', length: 40, default: 'ALL_PRODUCTS' }) scope: string;
  @Column({ type: 'simple-json', nullable: true }) rules: Record<string, unknown> | null;
  @Column({ type: 'timestamptz', nullable: true }) startsAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) endsAt: Date | null;
  @Column({ type: 'varchar', length: 24, default: CampaignStatus.DRAFT }) status: CampaignStatus;
  @Column({ type: 'integer', default: 0 }) redemptions: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('distribution_promoters')
@Index('IDX_distribution_promoters_merchant_status', ['merchantId', 'status'])
export class DistributionPromoter {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 80 }) name: string;
  @Column({ type: 'varchar', length: 32, default: '' }) phoneMasked: string;
  @Column({ type: 'numeric', precision: 7, scale: 4, default: '0' }) commissionRate: string;
  @Column({ type: 'integer', default: 0 }) salesFen: number;
  @Column({ type: 'integer', default: 0 }) commissionFen: number;
  @Column({ type: 'varchar', length: 24, default: PromoterStatus.PENDING }) status: PromoterStatus;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('merchant_operational_ledger')
@Index('UQ_merchant_operational_ledger_reference', ['merchantId', 'referenceNo'], { unique: true })
@Index('IDX_merchant_operational_ledger_scope', ['merchantId', 'category', 'status'])
export class OperationalLedgerEntry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 40 }) category: OperationalLedgerCategory;
  @Column({ type: 'varchar', length: 48 }) referenceNo: string;
  @Column({ type: 'varchar', length: 100 }) subjectName: string;
  @Column({ type: 'integer' }) amountFen: number;
  @Column({ type: 'varchar', length: 24, default: 'PENDING' }) status: string;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
  @Column({ type: 'varchar', length: 500, default: '' }) note: string;
  @Column({ type: 'simple-json', nullable: true }) metadata: Record<string, unknown> | null;
  @Column({ type: 'uuid' }) createdBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('merchant_business_settings')
@Index('IDX_merchant_business_settings_scope', ['merchantId', 'type', 'status'])
export class MerchantBusinessSetting {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 40 }) type: MerchantSettingType;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 300, default: '' }) description: string;
  @Column({ type: 'simple-json', nullable: true }) config: Record<string, unknown> | null;
  @Column({ type: 'varchar', length: 24, default: 'ACTIVE' }) status: string;
  @Column({ type: 'integer', default: 0 }) sortOrder: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export const merchantOperationsEntities = [InventoryBatch, InventoryDocument, MemberProfile, MarketingCampaign, DistributionPromoter, OperationalLedgerEntry, MerchantBusinessSetting];
