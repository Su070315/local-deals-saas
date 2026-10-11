import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CampaignStatus, InventoryBatchStatus, InventoryDocumentStatus, InventoryDocumentType, MemberStatus, MerchantSettingType, OperationalLedgerCategory, PromoterStatus } from './domain/merchant-operations.entities';

export class SaveInventoryBatchDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsUUID() packageId?: string;
  @IsOptional() @IsUUID() storeId?: string;
  @IsString() @MaxLength(64) skuCode: string;
  @IsString() @MaxLength(120) productName: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(10_000_000) quantity: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000_000) reservedQuantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) unitCostFen?: number;
  @IsOptional() @IsISO8601({ strict: true }) productionDate?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsIn(Object.values(InventoryBatchStatus)) status?: InventoryBatchStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SaveInventoryDocumentItemDto {
  @IsOptional() @IsUUID() batchId?: string;
  @IsString() @MaxLength(64) skuCode: string;
  @IsString() @MaxLength(120) productName: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(10_000_000) quantity: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) unitCostFen: number;
}

export class SaveInventoryDocumentDto {
  @IsOptional() @IsUUID() id?: string;
  @IsIn(Object.values(InventoryDocumentType)) type: InventoryDocumentType;
  @IsOptional() @IsUUID() storeId?: string;
  @IsOptional() @IsUUID() sourceStoreId?: string;
  @IsOptional() @IsUUID() targetStoreId?: string;
  @IsOptional() @IsString() @MaxLength(120) counterparty?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SaveInventoryDocumentItemDto) items: SaveInventoryDocumentItemDto[];
  @IsISO8601() occurredAt: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ChangeInventoryDocumentStatusDto {
  @IsIn([InventoryDocumentStatus.CONFIRMED, InventoryDocumentStatus.CANCELLED]) status: InventoryDocumentStatus;
}

export class SaveMemberProfileDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(100) externalCustomerId: string;
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(40) level?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000_000) balanceFen?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000_000) points?: number;
  @IsOptional() @IsIn(Object.values(MemberStatus)) status?: MemberStatus;
}

export class SaveMarketingCampaignDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(100) name: string;
  @IsString() @MaxLength(40) type: string;
  @IsOptional() @IsString() @MaxLength(40) scope?: string;
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsIn(Object.values(CampaignStatus)) status?: CampaignStatus;
}

export class SaveDistributionPromoterDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1) commissionRate: number;
  @IsOptional() @IsIn(Object.values(PromoterStatus)) status?: PromoterStatus;
}

export class SaveOperationalLedgerEntryDto {
  @IsOptional() @IsUUID() id?: string;
  @IsIn(Object.values(OperationalLedgerCategory)) category: OperationalLedgerCategory;
  @IsString() @MaxLength(100) subjectName: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000_000) amountFen: number;
  @IsIn(['PENDING', 'COMPLETED', 'REFUNDED', 'SETTLED', 'APPROVED', 'REJECTED']) status: string;
  @IsISO8601() occurredAt: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class SaveMerchantBusinessSettingDto {
  @IsOptional() @IsUUID() id?: string;
  @IsIn(Object.values(MerchantSettingType)) type: MerchantSettingType;
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED', 'DRAFT', 'PUBLISHED']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) sortOrder?: number;
}
