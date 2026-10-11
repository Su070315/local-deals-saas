import { Body, Controller, Delete, Get, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { API_CONTROLLER_VERSION } from './api-versioning';
import { AuthGuard, CurrentUser, RoleGuard, Roles } from './auth';
import { User, UserRole } from './domain/entities';
import { WechatPlatformService } from './wechat-platform.service';

@Controller({ path: 'wechat-platform', version: API_CONTROLLER_VERSION })
@UseGuards(AuthGuard, RoleGuard)
export class WechatPlatformController {
  constructor(private readonly wechat: WechatPlatformService) {}

  @Get('status')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  status(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.status(user, merchantId); }

  /** 平台/代理商查看商家小程序明文 AppID（用于配置支付等；代理商数据隔离由服务端保证） */
  @Get('appid')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  appid(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getPlainAppId(user, merchantId); }

  @Post('authorization-url')
  @Roles(UserRole.AGENCY_ADMIN)
  authorizationUrl(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.createAuthorizationUrl(user, merchantId); }

  @Post('icp-verify-task')
  @Roles(UserRole.AGENCY_ADMIN)
  createIcpVerifyTask(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: { alongWithAuth?: boolean } = {},
  ) { return this.wechat.createIcpVerifyTask(user, merchantId, Boolean(body.alongWithAuth)); }

  @Post('icp-filing/submit')
  @Roles(UserRole.AGENCY_ADMIN)
  submitIcpFiling(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.submitIcpFiling(user, merchantId); }

  @Post('icp-filing/cancel')
  @Roles(UserRole.AGENCY_ADMIN)
  cancelIcpFiling(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.cancelIcpFiling(user, merchantId); }

  @Get('icp-filing/status')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  icpFilingStatus(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getIcpFilingStatus(user, merchantId); }

  @Get('icp-filing/service-types')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  icpServiceContentTypes(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getIcpServiceContentTypes(user, merchantId); }

  @Get('icp-filing/districts')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  icpDistricts(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getIcpDistricts(user, merchantId); }

  @Get('icp-verify-task')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  queryIcpVerifyTask(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.queryLatestIcpVerifyTask(user, merchantId); }

  @Get('categories')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  categories(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getCategoryList(user, merchantId); }

  @Get('categories/saved')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  savedCategories(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getSavedCategories(user, merchantId); }

  @Get('verify-status')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  verifyStatus(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getVerifyStatus(user, merchantId); }

  /** 代发起微信认证（wxaauth）：代理商发起，返回授权二维码链接由商家管理员扫码完成授权与支付 */
  @Post('wechat-verify')
  @Roles(UserRole.AGENCY_ADMIN)
  createWechatVerify(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: { payType?: number } = {},
  ) { return this.wechat.createWechatVerify(user, merchantId, body); }

  /** 查询认证任务进度（queryauth）并同步真实状态 */
  @Post('wechat-verify/query')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  queryWechatVerify(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.queryWechatVerify(user, merchantId); }

  /** 认证被打回重填后重新提审（微信不重复收费） */
  @Post('wechat-verify/reauth')
  @Roles(UserRole.AGENCY_ADMIN)
  reauthWechatVerify(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.reauthWechatVerify(user, merchantId); }

  @Post('categories')
  @Roles(UserRole.AGENCY_ADMIN)
  saveCategories(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { categories: Array<{ firstId: number; secondId: number; certificates?: string[] }> }) { return this.wechat.setCategories(user, merchantId, body.categories); }

  @Post('privacy-setting')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  privacySetting(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { settingList?: Array<{ privacyKey: string; privacyText: string }>; contactEmail?: string; noticeMethod?: string; storeExpireTimestamp?: string }) {
    return this.wechat.setPrivacySetting(user, merchantId, body.settingList || [], body.contactEmail, body.noticeMethod, body.storeExpireTimestamp);
  }

  @Get('privacy-setting')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  getPrivacySetting(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getPrivacySetting(user, merchantId); }

  @Get('releases')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  releases(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.listReleases(user, merchantId); }

  /** 获取模板库模板列表（用于选择同步到哪个版本 / 回退）——FIX(2026-08-10)：放开代理端（批量同步需选模板版本），服务端按角色隔离 */
  @Get('templates')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  templates(@CurrentUser() user: User) { return this.wechat.listTemplates(user); }

  /** 批量同步：平台端全量所有已授权商家；代理端仅同步名下商家（服务端按 agencyId 隔离） */
  @Post('sync-all')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  syncAll(@CurrentUser() user: User, @Body() body: { templateId?: number } = {}) { return this.wechat.syncAllMerchantsToLatestTemplate(user, body.templateId); }

  @Post('mini-program-code')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  miniProgramCode(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.createMiniProgramCode(user, merchantId); }

  @Post('fast-register')
  @Roles(UserRole.AGENCY_ADMIN)
  fastRegister(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: { name?: string; code?: string; codeType?: number },
  ) { return this.wechat.fastRegisterMiniProgram(user, merchantId, body); }

  @Post('fast-register/query')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  fastRegisterQuery(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
  ) { return this.wechat.queryFastRegisterTask(user, merchantId); }

  @Post('account-profile')
  @Roles(UserRole.AGENCY_ADMIN)
  updateAccountProfile(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: { nickname?: string; introduction?: string; avatarDataUrl?: string; subjectNature?: string; licenseDataUrl?: string; idCardDataUrl?: string },
  ) { return this.wechat.updateAccountProfile(user, merchantId, body); }

  @Post('filing-data')
  @Roles(UserRole.AGENCY_ADMIN)
  updateFilingData(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: Record<string, unknown>,
  ) { return this.wechat.updateFilingData(user, merchantId, body); }

  @Post('configure-domain')
  @Roles(UserRole.AGENCY_ADMIN)
  configureDomain(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.configureAuthorizerDomains(merchantId, user); }

  /** 查询授权小程序当前配置的服务器域名（request/upload/download），商户端可视化展示 */
  @Get('server-domains')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  serverDomains(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getAuthorizerDomains(user, merchantId); }

  /** 商户端自定义服务器域名：保存后通过 modify_domain_directly 覆盖到授权小程序 */
  @Put('server-domains')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  updateServerDomains(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: { requestDomain?: unknown; uploadDomain?: unknown; downloadDomain?: unknown },
  ) { return this.wechat.updateAuthorizerDomains(user, merchantId, body); }

  /** 获取发布后真实生效的服务器域名（校验 modify_domain_directly 配置是否生效） */
  @Get('effective-domains')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  effectiveDomains(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.getEffectiveDomains(user, merchantId); }

  /** 获取体验者列表（wxa/memberauth） */
  @Get('testers')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  testers(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.listTesters(user, merchantId); }

  /** 绑定体验者（wxa/bind_tester）：wechatid 从 body 取（与前端 wechat-testers-page 一致） */
  @Post('testers')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  bindTester(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Body() body: { wechatid?: string },
  ) { return this.wechat.bindTester(user, merchantId, String(body.wechatid || '')); }

  /** 解绑体验者（wxa/unbind_tester） */
  @Delete('testers')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  unbindTester(
    @CurrentUser() user: User,
    @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Query('wechatid') wechatid: string,
  ) { return this.wechat.unbindTester(user, merchantId, String(wechatid || '')); }

  @Post('releases/commit')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  commitRelease(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { templateId?: number; userVersion?: string; userDesc?: string } = {}) { return this.wechat.commitMiniprogram(user, merchantId, body); }

  @Post('releases/trial-qrcode')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  trialQr(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { releaseId?: string } = {}) { return this.wechat.createTrialQr(user, merchantId, body.releaseId); }

  @Post('releases/submit-audit')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  submitAudit(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { releaseId?: string; itemList?: Array<Record<string, unknown>>; feedbackInfo?: string; feedbackStuff?: string } = {}) { return this.wechat.submitAudit(user, merchantId, body); }

  @Post('releases/query-audit')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  queryAudit(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { releaseId?: string } = {}) { return this.wechat.queryAudit(user, merchantId, body.releaseId); }

  @Post('releases/release')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  publishRelease(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { releaseId?: string } = {}) { return this.wechat.releaseMiniprogram(user, merchantId, body.releaseId); }

  /** 版本对账（wxa/getversioninfo）：查询微信侧体验版/线上版真实版本，与本地记录对比（商家只读可查） */
  @Get('releases/version-info')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  versionInfo(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.versionInfo(user, merchantId); }

  /** 回退线上版本（wxa/revertcoderelease）：每次发布后有一次回退机会 */
  @Post('releases/revert')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  revertRelease(@CurrentUser() user: User, @Query('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.wechat.revertRelease(user, merchantId); }
}
