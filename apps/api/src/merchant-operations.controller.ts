import { Body, Controller, Delete, Get, Param, ParseEnumPipe, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { API_CONTROLLER_VERSION } from './api-versioning';
import { AuthGuard, CurrentUser, RoleGuard, Roles } from './auth';
import { User, UserRole } from './domain/entities';
import { InventoryDocumentType, MerchantSettingType, OperationalLedgerCategory } from './domain/merchant-operations.entities';
import {
  ChangeInventoryDocumentStatusDto, SaveDistributionPromoterDto, SaveInventoryBatchDto, SaveInventoryDocumentDto,
  SaveMarketingCampaignDto, SaveMemberProfileDto, SaveMerchantBusinessSettingDto, SaveOperationalLedgerEntryDto,
} from './merchant-operations.dto';
import { MerchantOperationsService } from './merchant-operations.service';

const OPERATOR_ROLES = [UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN];

@Controller({ path: 'merchant-operations', version: API_CONTROLLER_VERSION })
@UseGuards(AuthGuard, RoleGuard)
export class MerchantOperationsController {
  constructor(private readonly operations: MerchantOperationsService) {}

  @Get(':merchantId/summary') @Roles(...OPERATOR_ROLES)
  summary(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.operations.summary(user, merchantId); }

  @Get(':merchantId/inventory') @Roles(...OPERATOR_ROLES)
  inventory(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.operations.listInventory(user, merchantId); }

  @Post(':merchantId/inventory') @Roles(...OPERATOR_ROLES)
  saveInventory(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveInventoryBatchDto) { return this.operations.saveInventory(user, merchantId, body); }

  @Get(':merchantId/inventory-documents') @Roles(...OPERATOR_ROLES)
  inventoryDocuments(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Query('type', new ParseEnumPipe(InventoryDocumentType, { optional: true })) type?: InventoryDocumentType) { return this.operations.listInventoryDocuments(user, merchantId, type); }

  @Post(':merchantId/inventory-documents') @Roles(...OPERATOR_ROLES)
  saveInventoryDocument(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveInventoryDocumentDto) { return this.operations.saveInventoryDocument(user, merchantId, body); }

  @Post(':merchantId/inventory-documents/:documentId/status') @Roles(...OPERATOR_ROLES)
  inventoryDocumentStatus(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string, @Body() body: ChangeInventoryDocumentStatusDto) { return this.operations.changeInventoryDocumentStatus(user, merchantId, documentId, body.status); }

  @Get(':merchantId/members') @Roles(...OPERATOR_ROLES)
  members(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.operations.listMembers(user, merchantId); }

  @Post(':merchantId/members') @Roles(...OPERATOR_ROLES)
  saveMember(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveMemberProfileDto) { return this.operations.saveMember(user, merchantId, body); }

  @Get(':merchantId/campaigns') @Roles(...OPERATOR_ROLES)
  campaigns(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.operations.listCampaigns(user, merchantId); }

  @Post(':merchantId/campaigns') @Roles(...OPERATOR_ROLES)
  saveCampaign(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveMarketingCampaignDto) { return this.operations.saveCampaign(user, merchantId, body); }

  @Get(':merchantId/promoters') @Roles(...OPERATOR_ROLES)
  promoters(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.operations.listPromoters(user, merchantId); }

  @Post(':merchantId/promoters') @Roles(...OPERATOR_ROLES)
  savePromoter(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveDistributionPromoterDto) { return this.operations.savePromoter(user, merchantId, body); }

  @Get(':merchantId/ledger/:category') @Roles(...OPERATOR_ROLES)
  ledger(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('category', new ParseEnumPipe(OperationalLedgerCategory)) category: OperationalLedgerCategory) { return this.operations.listLedger(user, merchantId, category); }

  @Post(':merchantId/ledger') @Roles(...OPERATOR_ROLES)
  saveLedger(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveOperationalLedgerEntryDto) { return this.operations.saveLedgerEntry(user, merchantId, body); }

  @Get(':merchantId/settings/:type') @Roles(...OPERATOR_ROLES)
  settings(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('type', new ParseEnumPipe(MerchantSettingType)) type: MerchantSettingType) { return this.operations.listSettings(user, merchantId, type); }

  @Post(':merchantId/settings') @Roles(...OPERATOR_ROLES)
  saveSetting(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveMerchantBusinessSettingDto) { return this.operations.saveSetting(user, merchantId, body); }

  @Delete(':merchantId/settings/:id') @Roles(...OPERATOR_ROLES)
  deleteSetting(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.operations.deleteSetting(user, merchantId, id); }
}
