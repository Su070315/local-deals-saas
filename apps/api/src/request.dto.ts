import {
  ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum,
  IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, Matches, ValidateIf, ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { AgencyCooperationPlan, ExportKind, InvoiceStatus, MerchantPaymentProfileStatus, MerchantRegistrationStatus, MerchantStatus, NotificationOutboxStatus, OrderStatus, PackageStatus } from './domain/entities';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  password: string;
}

export class CreateCustomerSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  code: string;

  /** 小程序 AppID（第三方平台代开发模式需用它定位授权小程序换取 openid） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appId?: string;

  /** 租户定位（多租户：用于解析顾客归属商家） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  merchantId?: string;
}

export class SaveMerchantPaymentProfileDto {
  /** 支付通道：WECHAT_DIRECT / HUIFU / TIANQUE（默认微信直连） */
  @IsOptional()
  @IsString()
  @Matches(/^(WECHAT_DIRECT|HUIFU|TIANQUE|WECHAT|HUIFU_PAY|TIANQUE_PAY)$/)
  provider?: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{4,64}$/)
  externalMerchantNo: string;

  /** 通道商户号（汇付 huifu_id / 天阙 mno；微信直连不填） */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/)
  providerMerchantId?: string;

  /** 汇付通道：微信小程序 APPID（填写后保存时自动调汇付绑定接口） */
  @IsOptional()
  @IsString()
  @Matches(/^wx[a-f0-9]{16}$/i, { message: '微信小程序 APPID 格式不正确' })
  wxAppletAppId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/)
  huifuId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  applicationNo?: string;

  /** 汇付直连：该商户自己的系统号（sys_id），直连时等于 huifu_id */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/)
  huifuSysId?: string;

  /** 汇付直连：该商户的产品号 */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,32}$/)
  huifuProductId?: string;

  /** 汇付直连：该商户 RSA 私钥（服务端 AES-256-GCM 加密存储） */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  huifuPrivateKey?: string;

  /** 汇付直连：该商户自己的 RSA 公钥（商户后台「商户公钥」项，非敏感） */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  huifuMerchantPublicKey?: string;

  /** 汇付直连：该商户的汇付公钥（回调验签用） */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  huifuPublicKey?: string;

  /** 汇付直连：该商户微信业务开通类型（fee_type，如 02=标准费率线下） */
  @IsOptional()
  @IsString()
  @Matches(/^(0[1-9])$/)
  huifuFeeType?: string;

  /** 天阙直连：该商户的天阙商户编号（mno） */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  tianqueMno?: string;

  /** 天阙直连：该商户的组织号（orgId） */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  tianqueOrgId?: string;

  /** 天阙直连：该商户 RSA 私钥（服务端 AES-256-GCM 加密存储） */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  tianquePrivateKey?: string;

  /** 天阙直连：天阙平台 RSA 公钥（验签） */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  tianquePublicKey?: string;

  /** 天阙直连：签名算法（sha256 | sha1） */
  @IsOptional()
  @IsString()
  @Matches(/^(sha256|sha1)$/)
  tianqueSignAlg?: string;

  /** 微信直连：该商户的微信支付商户号（mchid） */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/)
  wechatMchid?: string;

  /** 微信直连：该商户的小程序 APPID */
  @IsOptional()
  @IsString()
  @Matches(/^wx[a-f0-9]{16}$/i, { message: '微信小程序 APPID 格式不正确' })
  wechatAppId?: string;

  /** 微信直连：APIv3 密钥（32 位，服务端加密存储） */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  wechatApiV3Key?: string;

  /** 微信直连：商户 API 证书序列号 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  wechatCertSerialNo?: string;

  /** 微信直连：商户 API 私钥（apiclient_key.pem 内容，服务端加密存储） */
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  wechatPrivateKey?: string;

  /** 微信直连：微信支付公钥（回调验签） */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  wechatPublicKey?: string;

  @IsEnum(MerchantPaymentProfileStatus)
  status: MerchantPaymentProfileStatus;

  @IsBoolean()
  activationConfirmed: boolean;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  currentPassword: string;

  @IsString()
  @MinLength(10)
  @MaxLength(512)
  newPassword: string;
}

export class StepUpVerificationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  currentPassword: string;
}

export class PlatformRuntimeControlActionDto {
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  newPassword: string;
}

export class CreateMerchantAdminInviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class AcceptMerchantAdminInviteDto {
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  token: string;

  @IsString()
  @MinLength(10)
  @MaxLength(512)
  password: string;
}

export class CreateOrderDto {
  @Matches(/^[A-Za-z0-9_-]{12,128}$/)
  idempotencyKey: string;

  @IsUUID('4')
  packageId: string;

  @IsUUID('4')
  storeId: string;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity: number;
}

export class VerificationPreviewDto {
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  token: string;

  @IsUUID('4')
  workingStoreId: string;
}

export class VerificationConfirmDto extends VerificationPreviewDto {
  @Matches(/^[A-Za-z0-9_-]{12,128}$/)
  idempotencyKey: string;
}

export class CreateBillPaymentConfirmationRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  paymentReference: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class CreateBillAdjustmentDto {
  @IsInt()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  verifiedAmountDeltaFen: number;

  @IsInt()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  serviceFeeDeltaFen: number;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9_]+$/)
  reasonCode: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class ReviewBillAdjustmentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class CreateBillReversalDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class UpdateBillInvoiceDto {
  @IsEnum(InvoiceStatus)
  invoiceStatus: InvoiceStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  invoiceNumber?: string;
}

export class CreateBillDisputeDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  content: string;
}

export class ResolveBillDisputeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class CreateAgencyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  managerName: string;

  @IsEmail()
  @MaxLength(254)
  managerEmail: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  password?: string;

  @IsOptional()
  @IsEnum(AgencyCooperationPlan)
  cooperationPlan?: AgencyCooperationPlan;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  publicationQuotaRemaining?: number;

  @IsOptional()
  @IsDateString()
  cooperationStartsAt?: string;

  @IsOptional()
  @IsDateString()
  cooperationEndsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cooperationReference?: string;
}

export class UpdateAgencyCooperationDto {
  @IsEnum(AgencyCooperationPlan)
  cooperationPlan: AgencyCooperationPlan;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  publicationQuotaRemaining?: number;

  @IsOptional()
  @IsDateString()
  cooperationStartsAt?: string | null;

  @IsOptional()
  @IsDateString()
  cooperationEndsAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cooperationReference?: string;
}

export class SetAgencyActiveDto {
  @IsBoolean()
  active: boolean;
}

export class CreateMerchantDto {
  @IsOptional()
  @IsUUID('4')
  agencyId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brandName: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  servicePhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  contractNumber?: string;

  @IsOptional()
  @IsDateString()
  contractEndsAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  rate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  adminName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  adminEmail?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  adminPassword?: string;
}

export class MerchantImportItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  externalRef: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brandName: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  servicePhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  contractNumber?: string;

  @IsOptional()
  @IsDateString()
  contractEndsAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  rate?: number;
}

export class CreateMerchantImportBatchDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ArrayUnique((item: MerchantImportItemDto) => item.externalRef)
  @ValidateNested({ each: true })
  @Type(() => MerchantImportItemDto)
  items: MerchantImportItemDto[];
}

export class UpdateMerchantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brandName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  servicePhone?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  primaryColor?: string;

  @IsOptional()
  // 数字（InputNumber 提交）统一转字符串后再校验；空串/未设置放行；设置时须为 0-5 分、支持一位小数
  @Transform(({ value }) => (value === null || value === undefined || value === '' ? '' : String(value)))
  @Matches(/^(?:[0-4](\.[0-9])?|5(\.0)?)?$/)
  rating?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(12, { each: true })
  featureTags?: string[];

  @IsOptional()
  @IsEnum(MerchantStatus)
  status?: MerchantStatus;

  /** The state the operator saw before issuing a sales-state transition. */
  @IsOptional()
  @IsEnum(MerchantStatus)
  expectedStatus?: MerchantStatus;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  statusReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  contractNumber?: string;

  @IsOptional()
  @IsDateString()
  contractEndsAt?: string | null;
}

export class MerchantExitNoteDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class ReviewMerchantExitRetentionDto extends MerchantExitNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  retentionPolicyReference: string;

  @IsDateString()
  retentionUntil: string;
}

export class SaveMerchantTemplateConfigDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  homeTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  homeSubtitle?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  featuredPackageId?: string | null;
}

export class UpdateMerchantRegistrationDto {
  @IsEnum(MerchantRegistrationStatus)
  status: MerchantRegistrationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  failureReason?: string;
}

export class CreateRateVersionDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  rate: number;

  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  effectiveFrom: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;
}

export class ReviewRateChangeRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class SaveStoreDto {
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  address: string;

  // FIX(2026-08-10)：门店头像/简介（商家体验增强）
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessHours?: string;

  /** 总店标记（商家名下仅一家总店，首页展示总店/分店标签与切换） */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  /** 门店评分（0-5，支持一位小数；首页星级按门店展示） */
  @IsOptional()
  // 数字（InputNumber 提交）统一转字符串后再校验；空串/未设置放行；设置时须为 0-5 分、支持一位小数
  @Transform(({ value }) => (value === null || value === undefined || value === '' ? '' : String(value)))
  @Matches(/^(?:[0-4](\.[0-9])?|5(\.0)?)?$/)
  rating?: string;

  /** 门店附加服务标签（可停车/有包间/有WiFi/自定义，最多 12 个） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(12, { each: true })
  featureTags?: string[];

  @IsOptional()
  @IsBoolean()
  openForSale?: boolean;

  @IsOptional()
  @IsBoolean()
  openForVerification?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  fulfillmentChangeReason?: string;
}

export class SavePackageDto {
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(3000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  productType?: 'STANDARD' | 'GROUP_BUY' | 'WEIGHED' | 'MULTI_SPEC';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  skuCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  recommendation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  coverImageUrl?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  galleryUrls?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  videoUrl?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  originalPriceFen?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  memberPriceFen?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  purchasePriceFen?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  categoryName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9999)
  minPurchaseQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  virtualSales?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  fulfillmentMethods?: Array<'STORE_PICKUP' | 'LOCAL_DELIVERY' | 'EXPRESS'>;

  @IsOptional()
  @IsBoolean()
  distributionEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  batchManaged?: boolean;

  @IsOptional()
  @IsBoolean()
  pointsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  inventoryEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  inventoryWarningThreshold?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsString({ each: true })
  salesChannels?: Array<'ONLINE' | 'OFFLINE'>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  guaranteeLabels?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  parameterValues?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  purchaseNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3000)
  usageRules?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  detailContent?: string;

  @IsInt()
  @Min(1)
  @Max(100_000_000)
  priceFen: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  saleLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  perCustomerLimit?: number;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  storeIds: string[];

  @IsDateString()
  validFrom: string;

  @IsDateString()
  validTo: string;

  @IsOptional()
  @IsString()
  @Matches(/^(ABSOLUTE|PURCHASE_RELATIVE)$/)
  validityMode?: 'ABSOLUTE' | 'PURCHASE_RELATIVE';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  validityDurationDays?: number | null;

  @IsOptional()
  @IsEnum(PackageStatus)
  status?: PackageStatus;
}

export class ChangePackageStatusDto {
  @IsEnum(PackageStatus)
  status: PackageStatus;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class UpdateSoldCountDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  soldCount: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class BatchPackageStatusItemDto {
  @IsUUID('4')
  packageId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class CreatePackageBatchStatusDto {
  @IsEnum(PackageStatus)
  status: PackageStatus;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ArrayUnique((item: BatchPackageStatusItemDto) => item.packageId)
  @ValidateNested({ each: true })
  @Type(() => BatchPackageStatusItemDto)
  items: BatchPackageStatusItemDto[];
}

export class BatchStaffStoreAccessItemDto {
  @IsUUID('4')
  staffId: string;

  /** The operator's last observed authorization, used for optimistic conflict detection. */
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  expectedStoreIds: string[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  storeIds: string[];
}

export class CreateStaffStoreAccessBatchDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ArrayUnique((item: BatchStaffStoreAccessItemDto) => item.staffId)
  @ValidateNested({ each: true })
  @Type(() => BatchStaffStoreAccessItemDto)
  items: BatchStaffStoreAccessItemDto[];
}

export class BatchVoucherStoreTransferItemDto {
  @IsUUID('4')
  voucherId: string;

  @IsUUID('4')
  expectedStoreId: string;

  @IsUUID('4')
  targetStoreId: string;
}

export class CreateVoucherStoreTransferBatchDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ArrayUnique((item: BatchVoucherStoreTransferItemDto) => item.voucherId)
  @ValidateNested({ each: true })
  @Type(() => BatchVoucherStoreTransferItemDto)
  items: BatchVoucherStoreTransferItemDto[];
}

export class BatchVoucherCompensationRefundItemDto {
  @IsUUID('4')
  voucherId: string;

  @IsUUID('4')
  expectedStoreId: string;
}

export class CreateVoucherCompensationRefundBatchDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ArrayUnique((item: BatchVoucherCompensationRefundItemDto) => item.voucherId)
  @ValidateNested({ each: true })
  @Type(() => BatchVoucherCompensationRefundItemDto)
  items: BatchVoucherCompensationRefundItemDto[];
}

export class RestorePackageVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class RestoreStoreVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class RestoreMerchantTemplateConfigVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class SaveStaffDto {
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  password?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  storeIds: string[];
}

export class SetStaffActiveDto {
  @IsBoolean()
  active: boolean;
}

export class GenerateBillsDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period: string;
}

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class NotificationOutboxQueryDto {
  @IsOptional()
  @IsEnum(NotificationOutboxStatus)
  status?: NotificationOutboxStatus;

  @IsOptional()
  @IsUUID('4')
  merchantId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class TransactionListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('4')
  merchantId?: string;
}

export class OrderListQueryDto extends TransactionListQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  to?: string;
}

export class ExportQueryDto {
  @IsOptional()
  @IsUUID('4')
  merchantId?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  to?: string;
}

export class CreateExportJobDto extends ExportQueryDto {
  @IsEnum(ExportKind)
  kind: ExportKind;
}

export class CreateSupportTicketDto {
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{12,128}$/)
  idempotencyKey?: string;

  @IsUUID('4')
  merchantId: string;

  @IsOptional()
  @IsUUID('4')
  voucherId?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  content: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;
}

export class CreateExceptionRefundRequestDto {
  @IsUUID('4')
  voucherId: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  content: string;
}

export class TransferVoucherStoreDto {
  @IsUUID('4')
  targetStoreId: string;
}

export class MerchantScopeQueryDto {
  @IsOptional()
  @IsUUID('4')
  merchantId?: string;
}

export class ReportAnalyticsQueryDto extends MerchantScopeQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  to?: string;
}

export class ResolveSupportTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class ReplySupportTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  content: string;
}

export class ExecuteExceptionRefundDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}
