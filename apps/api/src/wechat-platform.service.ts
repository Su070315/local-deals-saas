import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, In, IsNull, LessThanOrEqual, Like, Not, Repository } from 'typeorm';
import { Merchant, MerchantRegistration, MerchantRegistrationStatus, PlatformAccessProfile, PublicationEntitlementStatus, User, UserRole } from './domain/entities';
import {
  WechatAuthorizationAttempt,
  WechatAuthorizer,
  WechatAuthorizerStatus,
  WechatComponentState,
  WechatIcpVerifyTask,
  WechatIcpVerifyTaskStatus,
  WechatOnboarding,
  WechatOnboardingStep,
  WechatOnboardingStepKey,
  WechatOnboardingBusinessStatus,
  WechatOnboardingSyncStatus,
  WechatCallbackEvent,
  WechatCallbackEventStatus,
  WechatSyncTask,
  WechatSyncTaskStatus,
  WechatMiniprogramRelease,
  WechatMiniprogramReleaseJob,
  WechatMiniprogramReleaseJobStatus,
  WechatMiniprogramReleaseJobType,
  WechatMiniprogramReleaseStatus,
} from './domain/wechat-platform.entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { RegistrationWorkflowService } from './registration-workflow.service';
import { SensitiveDataService } from './sensitive-data.service';
import { AppConfigService } from './app-config.service';
import { AgencyCooperationService } from './agency-cooperation.service';
import { WechatOnboardingEntitlementEventType } from './domain/wechat-onboarding-entitlement.entities';
import { calculateWechatOnboarding } from './wechat-onboarding.calculator';

const PLATFORM_PROFILES = [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.COMPLIANCE];
const REGISTRATION_ORDER: MerchantRegistrationStatus[] = [
  MerchantRegistrationStatus.DRAFT, MerchantRegistrationStatus.PENDING_MATERIALS, MerchantRegistrationStatus.SUBMITTED,
  MerchantRegistrationStatus.PENDING_CONFIRMATION, MerchantRegistrationStatus.UNDER_REVIEW, MerchantRegistrationStatus.OPENED,
  MerchantRegistrationStatus.AUTHORIZING, MerchantRegistrationStatus.PUBLISHABLE,
];

type WechatApiResponse = { errcode?: number; errmsg?: string; [key: string]: unknown };

type WechatVerifyStatus = {
  taskid: string;
  authUrl: string;
  taskStatus: number;
  applyStatus: number;
  orderId: number | null;
  refillReason: string;
  failReason: string;
  feeFen: number;
  customerType: number;
  payType: number;
  submittedAt: string;
  expired: boolean;
  rejected: boolean;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

@Injectable()
export class WechatPlatformService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly registration: RegistrationWorkflowService,
    private readonly sensitiveData: SensitiveDataService,
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly appConfig: AppConfigService,
    private readonly agencyCooperation: AgencyCooperationService,
    @InjectRepository(WechatComponentState) private readonly componentStates: Repository<WechatComponentState>,
    @InjectRepository(WechatAuthorizationAttempt) private readonly authorizationAttempts: Repository<WechatAuthorizationAttempt>,
    @InjectRepository(WechatAuthorizer) private readonly authorizers: Repository<WechatAuthorizer>,
    @InjectRepository(WechatIcpVerifyTask) private readonly icpVerifyTasks: Repository<WechatIcpVerifyTask>,
    @InjectRepository(WechatMiniprogramRelease) private readonly releases: Repository<WechatMiniprogramRelease>,
    @InjectRepository(WechatMiniprogramReleaseJob) private readonly releaseJobs: Repository<WechatMiniprogramReleaseJob>,
    @InjectRepository(WechatOnboarding) private readonly onboardings: Repository<WechatOnboarding>,
    @InjectRepository(WechatOnboardingStep) private readonly onboardingSteps: Repository<WechatOnboardingStep>,
    @InjectRepository(WechatCallbackEvent) private readonly callbackEvents: Repository<WechatCallbackEvent>,
    @InjectRepository(WechatSyncTask) private readonly syncTasks: Repository<WechatSyncTask>,
  ) {}

  async status(user: User, merchantId: string) {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const registration = await this.registration.findForMerchant(merchantId);
    const filingData = this.parseFilingData(registration?.filingDataJson);
    const eventCallbackUrl = this.value('WECHAT_COMPONENT_EVENT_CALLBACK_URL') || this.callback('/api/wechat/callback');
    const messageCallbackTemplate = this.value('WECHAT_COMPONENT_MESSAGE_CALLBACK_TEMPLATE') || this.callback('/api/wechat/$APPID$/callback');
    const [componentState, authorizer] = await Promise.all([
      this.componentStates.findOneBy({ id: 'component' }),
      this.authorizers.findOneBy({ merchantId }),
    ]);
    const latestRelease = await this.findLatestRelease(merchantId);
    const ticketReceived = Boolean(componentState?.ticketUpdatedAt);
    const latestIcpTask = await this.icpVerifyTasks.findOne({ where: { merchantId }, order: { createdAt: 'DESC' } });
    // 状态查询只读取已持久化事实，不在 HTTP 请求内再次调用微信。
    // 微信查询由回调入队和后台同步任务负责，避免页面刷新把微信接口当作状态机。
    const persistedOnboarding = await this.onboardings.findOne({ where: { merchantId } });
    const certifiedEvidence = objectRecord(filingData._certification);
    const categoryEvidence = objectRecord(filingData._categories);
    const icpEvidence = objectRecord(filingData._icpEntranceInfo);
    const certified = certifiedEvidence.status === 'APPROVED' || certifiedEvidence.approved === true;
    const savedCategoryCount = Number.isInteger(Number(categoryEvidence.savedCount)) ? Number(categoryEvidence.savedCount) : 0;
    const icpStatus = Number.isInteger(Number(icpEvidence.status)) ? Number(icpEvidence.status) : null;
    const syncStatus = persistedOnboarding?.syncStatus || WechatOnboardingSyncStatus.UNKNOWN;
    const lastSyncError = persistedOnboarding?.lastSyncError || '';
    const lastSyncAt = persistedOnboarding?.lastSyncAt || null;
    let onboarding = calculateWechatOnboarding({
      merchant,
      filingData,
      registrationUpdatedAt: registration?.updatedAt || null,
      authorizer,
      latestIcpTask,
      latestRelease,
      syncStatus,
      lastSyncAt,
      lastSyncError,
    });
    if (syncStatus === WechatOnboardingSyncStatus.STALE) {
      const previousSteps = await this.onboardingSteps.find({ where: { merchantId } });
      const previousComplete = new Map(previousSteps.filter((step) => step.status === WechatOnboardingBusinessStatus.COMPLETE).map((step) => [step.key, step]));
      onboarding.steps = onboarding.steps.map((step) => {
        const previous = previousComplete.get(step.key);
        return previous && step.status !== WechatOnboardingBusinessStatus.COMPLETE
          ? { ...step, status: WechatOnboardingBusinessStatus.COMPLETE, evidence: previous.evidence, evidenceUpdatedAt: previous.evidenceUpdatedAt }
          : step;
      });
      const firstIncomplete = onboarding.steps.findIndex((step) => step.status !== WechatOnboardingBusinessStatus.COMPLETE);
      onboarding.steps = onboarding.steps.map((step, index) => ({
        ...step,
        state: firstIncomplete === -1 || index < firstIncomplete ? 'complete' : index === firstIncomplete ? 'current' : 'pending',
      }));
      const current = onboarding.steps[firstIncomplete === -1 ? onboarding.steps.length - 1 : firstIncomplete];
      onboarding.currentStep = { key: current.key, label: current.label };
    }
    await this.persistOnboardingSnapshot(merchantId, onboarding);
    const filingVerified = onboarding.steps.find((step) => step.key === WechatOnboardingStepKey.FILING)?.status === WechatOnboardingBusinessStatus.COMPLETE;
    const checks = [
      this.check('componentAppId', '第三方平台 AppID', 'WECHAT_COMPONENT_APP_ID'),
      this.check('componentSecret', '第三方平台 AppSecret', 'WECHAT_COMPONENT_APP_SECRET'),
      this.check('messageCrypto', '消息校验 Token 与加解密 Key', 'WECHAT_COMPONENT_TOKEN', 'WECHAT_COMPONENT_ENCODING_AES_KEY'),
      { key: 'callbacks', label: '授权事件与消息回调', configured: Boolean(eventCallbackUrl && messageCallbackTemplate) },
      this.check('authorizationDomain', '授权发起页域名', 'WECHAT_COMPONENT_AUTH_DOMAIN'),
      { key: 'componentTicket', label: 'ComponentVerifyTicket', configured: ticketReceived },
      this.check('cosCredentials', '腾讯云 COS 访问凭据', 'TENCENT_COS_SECRET_ID', 'TENCENT_COS_SECRET_KEY'),
      this.check('cosBucket', '腾讯云 COS 存储桶与地域', 'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION'),
    ];
    const componentReady = checks.slice(0, 6).every((item) => item.configured);
    const cosReady = checks.slice(6).every((item) => item.configured);
    const smsChecks = [
      this.check('smsCredentials', '腾讯云短信访问凭据', 'TENCENT_SMS_SECRET_ID', 'TENCENT_SMS_SECRET_KEY'),
      this.check('smsSdkAppId', '短信应用 SDK AppID', 'TENCENT_SMS_SDK_APP_ID'),
      this.check('smsSignName', '已审核短信签名', 'TENCENT_SMS_SIGN_NAME'),
      this.check('smsTemplate', '默认短信模板 ID', 'TENCENT_SMS_DEFAULT_TEMPLATE_ID'),
    ];
    const smsReady = smsChecks.every((item) => item.configured);
    const localDeliveryChecks = [
      this.check('sfLocalAppId', '顺丰同城 AppID', 'SF_LOCAL_APP_ID'),
      this.check('sfLocalSecret', '顺丰同城 AppSecret', 'SF_LOCAL_APP_SECRET'),
      this.check('sfLocalShop', '顺丰同城店铺 ID', 'SF_LOCAL_SHOP_ID'),
      this.check('sfLocalCallback', '顺丰同城状态回调', 'SF_LOCAL_CALLBACK_URL'),
    ];
    const expressChecks = [
      this.check('kuaidi100Key', '快递100 Key', 'KUAIDI100_KEY'),
      this.check('kuaidi100Customer', '快递100 Customer', 'KUAIDI100_CUSTOMER'),
      this.check('kuaidi100Callback', '快递轨迹回调', 'KUAIDI100_CALLBACK_URL'),
    ];
    const steps = onboarding.steps;
    const currentStep = onboarding.currentStep;
    const stepComplete = (key: WechatOnboardingStepKey) => steps.find((step) => step.key === key)?.status === WechatOnboardingBusinessStatus.COMPLETE;
    return {
      merchantId, merchantName: merchant.brandName, merchantLegalName: merchant.legalName, servicePhone: merchant.servicePhone, filingVerified,
      filingLicenseDataUrl: registration?.filingLicenseDataUrl || '',
      filingData,
      // 兼容旧客户端字段，但业务状态以 onboardingStatus/steps 为唯一真实来源。
      registrationStatus: onboarding.status,
      registrationNote: registration?.note || '', registrationFailureReason: registration?.failureReason || '',
      publicationEntitlementStatus: registration?.publicationEntitlementStatus || 'NONE',
      componentAppId: this.maskIdentifier(this.value('WECHAT_COMPONENT_APP_ID')),
      // 商家小程序 AppID：平台/代理商可见（脱敏展示）；明文经 getPlainAppId 获取（用于配置支付等）。
      // 商家经营端（MERCHANT_ADMIN）不展示，避免非运营角色接触平台侧敏感信息。
      authorizerAppId: (user.role === UserRole.PLATFORM_ADMIN || user.role === UserRole.AGENCY_ADMIN) ? this.maskIdentifier(authorizer?.authorizerAppId || '') : '',
      authorizationStatus: authorizer?.status || null,
      authorizedAt: authorizer?.authorizedAt || null,
      latestRelease: latestRelease ? this.releaseSummary(latestRelease) : null,
      componentReady, cosReady, configuredCount: checks.filter((item) => item.configured).length, totalCount: checks.length,
      ticketReceived, ticketUpdatedAt: componentState?.ticketUpdatedAt || null,
      eventCallbackUrl, messageCallbackTemplate,
      authorizationDomain: this.value('WECHAT_COMPONENT_AUTH_DOMAIN'),
      cosRegion: this.value('TENCENT_COS_REGION'), cosBucket: this.maskIdentifier(this.value('TENCENT_COS_BUCKET')),
      smsReady, smsChecks, smsRegion: this.value('TENCENT_SMS_REGION') || 'ap-guangzhou',
      smsSdkAppId: this.maskIdentifier(this.value('TENCENT_SMS_SDK_APP_ID')),
      smsSignName: this.value('TENCENT_SMS_SIGN_NAME'),
      localDeliveryReady: localDeliveryChecks.every((item) => item.configured), localDeliveryChecks,
      localDeliveryShopId: this.maskIdentifier(this.value('SF_LOCAL_SHOP_ID')),
      expressReady: expressChecks.every((item) => item.configured), expressChecks,
      checks,
      requirements: [
        { key: 'subject', label: '商户主体资料', configured: stepComplete(WechatOnboardingStepKey.MATERIALS) },
        { key: 'category', label: '服务类目', configured: stepComplete(WechatOnboardingStepKey.CATEGORIES) },
        { key: 'wechatCertification', label: '微信认证', configured: certified === true },
        { key: 'filing', label: '微信备案', configured: filingVerified },
      ],
      certified: certified === true,
      savedCategoryCount,
      onboardingStatus: onboarding.status,
      syncStatus: onboarding.syncStatus,
      lastSyncAt: onboarding.lastSyncAt,
      lastSyncError: onboarding.lastSyncError,
      evidenceUpdatedAt: onboarding.evidenceUpdatedAt,
      evidenceFreshness: onboarding.evidenceFreshness,
      currentStep,
      steps,
      actions: {
        canStartAuthorization: user.role === UserRole.AGENCY_ADMIN && componentReady && stepComplete(WechatOnboardingStepKey.REGISTRATION),
        canManageFiling: user.role === UserRole.AGENCY_ADMIN && componentReady && stepComplete(WechatOnboardingStepKey.AUTHORIZATION),
        canUploadMaterials: user.role === UserRole.AGENCY_ADMIN && cosReady,
      },
    };
  }

  /**
   * 平台管理端查看商家小程序明文 AppID。
   * 调用方必须同时通过 @Roles(PLATFORM_ADMIN) 与 StepUpAuthGuard（身份确认后 10 分钟内有效）。
   */
  async getPlainAppId(user: User, merchantId: string) {
    // 明文 AppID 供代理商/平台为商家配置支付接口使用；代理商数据隔离由 getForUser 保证（只能取自己名下商家）
    if (user.role !== UserRole.PLATFORM_ADMIN && user.role !== UserRole.AGENCY_ADMIN) throw new ForbiddenException('仅平台管理端与代理商可查看明文 AppID');
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId });
    return { appid: authorizer?.authorizerAppId || '' };
  }

  async createAuthorizationUrl(user: User, merchantId: string) {
    // 已按业务要求放开：任意开户阶段均可发起授权（不再限定 OPENED/AUTHORIZING/PUBLISHABLE），
    // 状态机推进仍保留（OPENED 才自动置 AUTHORIZING），不跳过必要环节。
    const merchant = await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const registration = await this.registration.findForMerchant(merchantId);

    const componentAccessToken = await this.getComponentAccessToken();
    const componentAppId = this.required('WECHAT_COMPONENT_APP_ID');
    const preAuth = await this.wechatPost('https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode', { component_appid: componentAppId }, componentAccessToken);
    const preAuthCode = this.responseString(preAuth, 'pre_auth_code', 8, 1024);
    const expiresIn = this.responseSeconds(preAuth, 'expires_in', 60, 3600);
    const state = randomBytes(32).toString('base64url');
    const callbackUrl = this.authorizationCallbackUrl(state);
    const expiresAt = new Date(Date.now() + Math.min(expiresIn, 600) * 1000);
    await this.dataSource.transaction(async (manager) => {
      await manager.save(WechatAuthorizationAttempt, {
        merchantId, requestedBy: user.id, stateHash: this.hashState(state), expiresAt, consumedAt: null,
      });
      await this.agencyCooperation.applyOnboardingEntitlementEvent(
        manager,
        merchant,
        registration,
        WechatOnboardingEntitlementEventType.STARTED,
      );
    });
    const authorizationUrl = new URL('https://mp.weixin.qq.com/cgi-bin/componentloginpage');
    authorizationUrl.searchParams.set('component_appid', componentAppId);
    authorizationUrl.searchParams.set('pre_auth_code', preAuthCode);
    authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizationUrl.searchParams.set('auth_type', '3');
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_AUTHORIZATION_STARTED', 'WechatAuthorizationAttempt', merchantId, null, { expiresAt });
    return { url: authorizationUrl.toString(), expiresAt };
  }

  /** 快速注册企业小程序（新版接口）：平台代商家创建，返回 authorize_url 二维码，法人 24h 内扫码验证（人脸+手机号），无需邮箱 */
  async fastRegisterMiniProgram(user: User, merchantId: string, body: { name?: string; code?: string; codeType?: number }) {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const name = String(body.name || '').trim();
    const code = String(body.code || '').trim();
    if (!name || !code) throw new BadRequestException('请完整填写企业名称、统一社会信用代码');
    if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/i.test(code.replace(/\s+/g, ''))) throw new BadRequestException('统一社会信用代码格式不正确（应为 18 位）');
    const componentAccessToken = await this.getComponentAccessToken();
    const componentPhone = this.value('WECHAT_COMPONENT_CONTACT_PHONE') || '';
    if (!componentPhone) throw new BadRequestException('第三方平台联系电话未配置，请联系平台管理员设置 WECHAT_COMPONENT_CONTACT_PHONE');
    console.log('[FAST_REGISTER_REQ]', JSON.stringify({ name, code, component_phone: componentPhone, new_version: true }));
    const result = await this.wechatPost('https://api.weixin.qq.com/wxa/component/fastregisterenterpriseweapp?action=create', {
      name, code, component_phone: componentPhone, new_version: true,
    }, componentAccessToken);
    console.log('[FAST_REGISTER_RESP]', JSON.stringify(result).slice(0, 500));
    const taskid = this.responseString(result, 'taskid', 8, 128);
    const authorizeUrl = this.responseString(result, 'authorize_url', 8, 2048);
    if (!/^https:\/\/mp\.weixin\.qq\.com\//.test(authorizeUrl)) throw new BadGatewayException('微信返回的授权验证地址无效');
    const status = this.responseInteger(result, 'status', 0, 1008);
    // 记录待确认状态与 taskid，供状态查询与回调归因；名额事件与事实记录同事务提交。
    const registration = await this.registration.findForMerchant(merchantId);
    let registrationId = registration?.id || '';
    await this.dataSource.transaction(async (manager) => {
      const lockedRegistration = registration
        ? await manager.findOne(MerchantRegistration, { where: { id: registration.id }, lock: { mode: 'pessimistic_write' } })
        : null;
      if (lockedRegistration) {
        const filing = this.parseFilingData(lockedRegistration.filingDataJson);
        filing._fastRegister = { name, code, taskid, authorizeUrl, status, statusLabel: this.fastRegisterStatusLabel(status), phase: 'AWAIT_VERIFY', requestedAt: new Date().toISOString() };
        lockedRegistration.filingDataJson = JSON.stringify(filing);
        await manager.save(MerchantRegistration, lockedRegistration);
        registrationId = lockedRegistration.id;
      }
      await this.agencyCooperation.applyOnboardingEntitlementEvent(
        manager,
        merchant,
        lockedRegistration,
        WechatOnboardingEntitlementEventType.STARTED,
      );
    });
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_FAST_REGISTER_CREATED', 'MerchantRegistration', registrationId, null, { name, code, taskid });
    return { submitted: true, taskid, authorizeUrl, status };
  }

  /** 查询快速注册任务状态（action=query，法人扫码验证进度） */
  async queryFastRegisterTask(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const registration = await this.registration.findForMerchant(merchantId);
    const filing = this.parseFilingData(registration?.filingDataJson);
    const record = filing._fastRegister as Record<string, unknown> | undefined;
    if (!record || typeof record.taskid !== 'string') throw new BadRequestException('该商户尚未发起快速注册，请先发起');
    const componentAccessToken = await this.getComponentAccessToken();
    const result = await this.wechatPost('https://api.weixin.qq.com/wxa/component/fastregisterenterpriseweapp?action=query', {
      taskid: record.taskid, new_version: true,
    }, componentAccessToken);
    const status = this.responseInteger(result, 'status', -1, 1008);
    const authorizeUrl = this.optionalResponseString(result, 'authorize_url', 8, 2048);
    if (registration && filing) {
      record.status = status;
      record.statusLabel = this.fastRegisterStatusLabel(status);
      if (authorizeUrl) record.authorizeUrl = authorizeUrl;
      registration.filingDataJson = JSON.stringify(filing);
      await this.dataSource.getRepository(MerchantRegistration).save(registration);
    }
    return { taskid: record.taskid, status, statusLabel: this.fastRegisterStatusLabel(status), authorizeUrl };
  }

  /** 快速注册任务状态枚举文案（status: -1、0-14、1001-1008） */
  private fastRegisterStatusLabel(status: number): string {
    const labels: Record<number, string> = {
      '-1': '创建失败', 0: '等待法人扫码验证', 1: '任务超时', 2: '已拒绝', 3: '已同意创建',
      4: '人脸验证中', 5: '人脸认证失败', 6: '人脸认证通过', 7: '等待手机号验证码', 8: '手机验证失败',
      9: '手机验证通过', 10: '已提交创建', 11: '创建失败', 12: '创建成功', 13: '企业信息验证通过', 14: '企业信息验证不通过',
      1001: '主体创建小程序数量达上限', 1002: '主体违规黑名单', 1003: '管理员绑定账号数达上限', 1004: '管理员违规黑名单',
      1005: '管理员手机绑定账号数达上限', 1006: '管理员手机号违规黑名单', 1007: '管理员身份证创建账号数达上限', 1008: '管理员身份证违规黑名单',
    };
    return labels[status] || `未知状态(${status})`;
  }

  /** 快速注册回调：法人确认后微信推送 appid+auth_code，用回调携带的企业名称+信用代码精确归因绑定 */
  async completeFastRegisterAuth(authCode: string, appid: string, merchantName?: string, merchantCode?: string) {
    if (!/^[A-Za-z0-9_@-]{8,1024}$/.test(authCode)) throw new BadRequestException('快速注册授权码格式错误');
    const componentAccessToken = await this.getComponentAccessToken();
    const result = await this.wechatPost('https://api.weixin.qq.com/cgi-bin/component/api_query_auth', {
      component_appid: this.required('WECHAT_COMPONENT_APP_ID'), authorization_code: authCode,
    }, componentAccessToken);
    const authorizationInfo = this.responseObject(result, 'authorization_info');
    const authorizerAppId = this.responseString(authorizationInfo, 'authorizer_appid', 10, 64);
    const refreshToken = this.responseString(authorizationInfo, 'authorizer_refresh_token', 16, 2048);
    const permissionIds = this.permissionIds(authorizationInfo.func_info);
    // 新版快速注册回调携带 info.name（企业名称）+ info.code（信用代码），据此精确归因商家；
    // 若回调未携带（老微信版本），降级为"恰好 1 个待验证商家"策略。
    const registrations = await this.dataSource.getRepository(MerchantRegistration).find();
    const withRecord = registrations
      .map((r) => ({ r, filing: this.parseFilingData(r.filingDataJson) }))
      .filter(({ filing }) => {
        const record = filing._fastRegister as Record<string, unknown> | undefined;
        return record && (record.phase === 'AWAIT_VERIFY' || record.status === 'BOUND');
      });
    let target: { r: MerchantRegistration; filing: Record<string, unknown> } | null = null;
    const nameMatch = String(merchantName || '').trim();
    const codeMatch = String(merchantCode || '').trim();
    if (nameMatch && codeMatch) {
      target = withRecord.find(({ filing }) => {
        const record = filing._fastRegister as Record<string, unknown>;
        return String(record.name || '').trim() === nameMatch && String(record.code || '').trim().replace(/\s+/g, '') === codeMatch.replace(/\s+/g, '');
      }) || null;
      if (!target) console.warn(`[FAST_REGISTER] 回调 name/code 无匹配商家 name=${nameMatch} code=${codeMatch}`);
    } else {
      const pending = withRecord
        .filter(({ filing }) => (filing._fastRegister as Record<string, unknown>).phase === 'AWAIT_VERIFY')
        .sort((a, b) => String((b.filing._fastRegister as Record<string, unknown>).requestedAt || '').localeCompare(String((a.filing._fastRegister as Record<string, unknown>).requestedAt || '')));
      if (pending.length !== 1) {
        console.warn(`[FAST_REGISTER] 回调无 name/code 且待验证商家数=${pending.length}，拒绝绑定 appid=${appid}`);
        return { bound: false, appid, reason: pending.length === 0 ? 'NO_PENDING' : 'AMBIGUOUS_PENDING' };
      }
      target = pending[0];
    }
    if (!target) { console.log('[FAST_REGISTER] no matching merchant for', appid); return { bound: false, appid }; }
    await this.dataSource.transaction(async (manager) => {
      const conflicting = await manager.findOne(WechatAuthorizer, { where: { authorizerAppId }, lock: { mode: 'pessimistic_write' } });
      if (conflicting && conflicting.merchantId !== target.r.merchantId) throw new BadRequestException('该小程序已绑定其他商户');
      const existing = await manager.findOne(WechatAuthorizer, { where: { merchantId: target.r.merchantId }, lock: { mode: 'pessimistic_write' } });
      const saved = await manager.save(WechatAuthorizer, {
        ...(existing || {}), merchantId: target.r.merchantId, authorizerAppId,
        refreshTokenCiphertext: this.sensitiveData.encrypt(refreshToken), permissionIds,
        status: WechatAuthorizerStatus.AUTHORIZED, authorizedAt: new Date(), revokedAt: null,
      });
      await this.auditWriter.write('system', target.r.merchantId, 'WECHAT_FAST_REGISTER_BOUND', 'WechatAuthorizer', saved.id, existing ? { authorizerAppId: existing.authorizerAppId } : null, { authorizerAppId, permissionCount: permissionIds.length }, manager);
      const filing = target.filing;
      (filing._fastRegister as Record<string, unknown>).status = 12;
      (filing._fastRegister as Record<string, unknown>).phase = 'BOUND';
      (filing._fastRegister as Record<string, unknown>).appid = authorizerAppId;
      target.r.filingDataJson = JSON.stringify(filing);
      await manager.save(MerchantRegistration, target.r);
    });
    // 授权成功后自动配置域名
    try { await this.configureAuthorizerDomains(target.r.merchantId); } catch { /* 不阻塞 */ }
    return { bound: true, merchantId: target.r.merchantId, appid: authorizerAppId };
  }

  async completeAuthorization(authCode: string, state: string) {
    if (!/^[A-Za-z0-9_@-]{8,1024}$/.test(authCode)) throw new BadRequestException('微信授权码格式错误');
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(state)) throw new BadRequestException('微信授权状态参数无效');
    const stateHash = this.hashState(state);
    const attempt = await this.authorizationAttempts.createQueryBuilder('attempt')
      .addSelect('attempt.stateHash')
      .where('attempt.stateHash = :stateHash', { stateHash })
      .getOne();
    if (!attempt || attempt.consumedAt || attempt.expiresAt.getTime() <= Date.now()) throw new BadRequestException('微信授权会话已失效，请重新发起授权');
    const consumedAt = new Date();
    const claimed = await this.authorizationAttempts.update({ id: attempt.id, consumedAt: IsNull() }, { consumedAt });
    if (claimed.affected !== 1) throw new BadRequestException('微信授权会话已被使用');

    try {
      const componentAccessToken = await this.getComponentAccessToken();
      const componentAppId = this.required('WECHAT_COMPONENT_APP_ID');
      const result = await this.wechatPost('https://api.weixin.qq.com/cgi-bin/component/api_query_auth', {
        component_appid: componentAppId, authorization_code: authCode,
      }, componentAccessToken);
      const authorizationInfo = this.responseObject(result, 'authorization_info');
      const authorizerAppId = this.responseString(authorizationInfo, 'authorizer_appid', 10, 64);
      if (!/^wx[A-Za-z0-9]{8,32}$/.test(authorizerAppId)) throw new BadGatewayException('微信开放平台返回的授权方 AppID 格式错误');
      const refreshToken = this.responseString(authorizationInfo, 'authorizer_refresh_token', 16, 2048);
      const permissionIds = this.permissionIds(authorizationInfo.func_info);
      await this.dataSource.transaction(async (manager) => {
        const conflicting = await manager.findOne(WechatAuthorizer, { where: { authorizerAppId }, lock: { mode: 'pessimistic_write' } });
        if (conflicting && conflicting.merchantId !== attempt.merchantId) throw new BadRequestException('该小程序已绑定其他商户');
        const existing = await manager.findOne(WechatAuthorizer, { where: { merchantId: attempt.merchantId }, lock: { mode: 'pessimistic_write' } });
        const saved = await manager.save(WechatAuthorizer, {
          ...(existing || {}), merchantId: attempt.merchantId, authorizerAppId,
          refreshTokenCiphertext: this.sensitiveData.encrypt(refreshToken), permissionIds,
          status: WechatAuthorizerStatus.AUTHORIZED, authorizedAt: new Date(), revokedAt: null,
        });
        await this.auditWriter.write(attempt.requestedBy, attempt.merchantId, 'WECHAT_AUTHORIZATION_COMPLETED', 'WechatAuthorizer', saved.id, existing ? { authorizerAppId: existing.authorizerAppId, status: existing.status } : null, { authorizerAppId, status: saved.status, permissionCount: permissionIds.length }, manager);
      });
      // 授权成功后自动配置小程序服务器域名，避免体验版/审核时网络错误
      try { await this.configureAuthorizerDomains(attempt.merchantId); } catch { /* 域名配置失败不阻塞授权 */ }
      return { redirectUrl: this.authorizationSuccessUrl() };
    } catch (error) {
      await this.auditWriter.write(attempt.requestedBy, attempt.merchantId, 'WECHAT_AUTHORIZATION_FAILED', 'WechatAuthorizationAttempt', attempt.id, null, { consumedAt });
      throw error;
    }
  }

  async createIcpVerifyTask(user: User, merchantId: string, alongWithAuth = false) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    // FIX(2026-08-09)：按认证状态动态决定 along_with_auth——官方 create_icp_verifytask 文档：
    // along_with_auth=true 仅用于「认证及备案二合一」场景，适用范围是「账号已完成注册，但未完成认证和备案」。
    // 已认证的小程序再发起二合一会被微信拒绝（86439：已完成认证无法发起新流程），且 verify_url 仅在二合一时返回。
    // 因此：已认证 → 强制 false（纯备案核身，微信向管理员发核身通知）；未认证 → 按前端意图（默认 true 走二合一）。
    const certified = await this.detectCertified(merchantId);
    const effectiveAlongWithAuth = certified === true ? false : alongWithAuth;
    // 幂等：同一商家存在「进行中」的核身任务（PENDING 未终态）时复用并刷新，避免运营在多环节
    // 重复点击「发起人脸核身」给微信侧生成多个核身任务（微信 create_icp_verifytask 无去重）。
    // 仅当无任务或已有任务已终态（SUCCEEDED/FAILED）时才新建。
    const pending = await this.icpVerifyTasks.findOne({
      // FIX(2026-08-09)：排除 sim_ 历史模拟任务，防止残留假任务被幂等复用而阻塞真实核身发起
      where: { merchantId, status: WechatIcpVerifyTaskStatus.PENDING, taskId: Not(Like('sim\\_%')) },
      order: { createdAt: 'DESC' },
    });
    if (pending) {
      await this.refreshIcpVerifyTask(user, merchantId, pending);
      // 刷新后若已到终态（并发下微信侧刚完成），继续新建会让管理员再扫一次；
      // 此时直接返回终态任务，由前端提示核身结果，不再重复发起。
      const refreshed = await this.icpVerifyTasks.findOneBy({ id: pending.id });
      if (refreshed && refreshed.status !== WechatIcpVerifyTaskStatus.PENDING) {
        await this.auditWriter.write(user.id, merchantId, 'WECHAT_ICP_VERIFY_TASK_REUSED_FINISHED', 'WechatIcpVerifyTask', refreshed.id, null, { taskId: refreshed.taskId, status: refreshed.status, note: '复用进行中任务，刷新后已终态，不重复发起核身' });
        return this.icpTaskResponse(refreshed);
      }
      await this.auditWriter.write(user.id, merchantId, 'WECHAT_ICP_VERIFY_TASK_REUSED', 'WechatIcpVerifyTask', pending.id, null, { taskId: pending.taskId, note: '复用进行中核身任务，未重复发起（幂等）' });
      return this.icpTaskResponse(refreshed || pending);
    }
    let taskId: string;
    let verifyUrl: string;
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/icp/create_icp_verifytask', { along_with_auth: effectiveAlongWithAuth }, 'access_token', authorizerToken));
      taskId = this.responseString(result, 'task_id', 4, 128);
      verifyUrl = this.optionalResponseString(result, 'verify_url', 0, 2048);
    } catch (error) {
      // FIX(2026-08-09)：生产环境禁止降级为「模拟核验任务」（sim_verify_* + mock-verify.html 假页面）。
      // 此前微信接口失败时静默生成假任务，前端展示假二维码、查询结果被误判为核身成功（审计实证），
      // 导致运营误以为已发起官方核身。现在微信调用失败直接显式报错，由前端提示真实失败原因。
      throw new BadGatewayException(`微信官方核身服务暂不可用，请稍后重试：${(error as Error).message}`);
    }
    const task = await this.icpVerifyTasks.save({
      merchantId,
      requestedBy: user.id,
      taskId,
      alongWithAuth: effectiveAlongWithAuth,
      verifyUrl,
      status: WechatIcpVerifyTaskStatus.PENDING,
      isFinish: false,
      faceStatus: null,
      alongWithAuthResult: null,
      lastMessage: effectiveAlongWithAuth
        ? '已发起微信官方认证及备案核身，请小程序管理员用手机微信扫码完成授权与人脸核身。'
        : '已向小程序管理员微信发送备案核身通知，请管理员点击通知完成人脸核身。',
      lastCheckedAt: null,
    });
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_ICP_VERIFY_TASK_CREATED', 'WechatIcpVerifyTask', task.id, null, { taskId, alongWithAuth: effectiveAlongWithAuth, hasVerifyUrl: Boolean(verifyUrl) });
    return this.icpTaskResponse(task);
  }

  async queryLatestIcpVerifyTask(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    // FIX(2026-08-09)：只查询真实微信官方任务（过滤 sim_ 模拟任务），避免把假任务状态当作核身结果展示。
    const tasks = await this.icpVerifyTasks.find({ where: { merchantId }, order: { createdAt: 'DESC' }, take: 20 });
    const task = tasks.find((t) => !String(t.taskId || '').startsWith('sim_')) || null;
    if (!task) throw new BadRequestException('尚未发起微信官方人脸核身任务（历史模拟任务不计）');
    return this.refreshIcpVerifyTask(user, merchantId, task);
  }

  /** 上传备案媒体材料到微信，返回 media_id（兼容 data URL 与 COS 图片链接） */
  private async uploadIcpMedia(merchantId: string, imageSource: string, label: string, icpOrderField: string, certificateType?: number, mediaType: 'image' | 'video' = 'image'): Promise<string> {
    // 备案材料照片传的是 COS 链接，需先下载字节再上传微信（承诺视频为 video 类型，放宽大小限制）
    const maxBytes = mediaType === 'video' ? 100 * 1024 * 1024 : 2 * 1024 * 1024;
    let contentType: string;
    let bytes: Buffer;
    const source = String(imageSource || '').trim();
    // 归一出可下载 URL：http(s) → COS 重签名；代理相对路径（filingProxyUrl）→ 提取 objectKey 重签名；
    // 其余（data URL / 其他）→ 交给 decodeImageDataUrl 处理（含格式校验）。
    let downloadUrl: string | null = null;
    if (/^https?:\/\//i.test(source)) {
      // FIX: 备案证件图存的是 COS 私有桶的短期签名 URL（上传时签发 5 分钟），过期后裸 fetch 必 403。
      // 对 COS 链接用 SDK 按 bucket/region/objectKey 重新签发临时 URL 再下载，其余 URL 保持原逻辑。
      downloadUrl = await this.resolveCosSignedUrl(source, label);
    } else if (source.startsWith('/api/v1/merchants/')) {
      // FIX(2026-08-09)：前端 uploadFilingImage 返回 filingProxyUrl（/api/v1/merchants/{id}/filing-files?key=...）
      // 用于前端展示鉴权，存入 filing 后提交备案时后端拿不到字节 → 此前走 decodeImageDataUrl 误报「数据格式无效」。
      // 这里从 query 提取 key（=objectKey）重新签发 COS 签名 URL 下载。
      try {
        const proxyUrl = new URL(source, 'https://example.com');
        const objectKey = proxyUrl.searchParams.get('key');
        if (objectKey) downloadUrl = await this.appConfig.createPrivateFileAccessUrl('', decodeURIComponent(objectKey));
      } catch {
        downloadUrl = null; // 解析失败走 data URL 分支，由 decodeImageDataUrl 报格式错误
      }
    }
    if (downloadUrl) {
      let response: Response;
      try {
        response = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new BadRequestException(`${label}图片地址无法访问`);
      }
      if (!response.ok) throw new BadRequestException(`${label}图片地址无法访问（HTTP ${response.status}）`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new BadRequestException(`${label}图片内容为空`);
      if (bytes.length > maxBytes) throw new BadRequestException(`${label}文件不能超过 ${mediaType === 'video' ? '100MB' : '2MB'}`);
      contentType = String(response.headers.get('content-type') || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg')).split(';')[0].toLowerCase();
    } else {
      const decoded = this.decodeImageDataUrl(source, label);
      contentType = decoded.contentType;
      bytes = decoded.bytes;
    }
    const extension: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'video/mp4': 'mp4' };
    const upload = async (authorizerToken: string): Promise<WechatApiResponse> => {
      const url = new URL('https://api.weixin.qq.com/wxa/icp/upload_icp_media');
      url.searchParams.set('access_token', authorizerToken);
      const form = new FormData();
      form.append('type', mediaType);
      form.append('icp_order_field', icpOrderField);
      if (certificateType !== undefined) form.append('certificate_type', String(certificateType));
      form.append('media', new Blob([new Uint8Array(bytes)], { type: contentType }), `upload.${extension[contentType] || (mediaType === 'video' ? 'mp4' : 'jpg')}`);
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new ServiceUnavailableException('暂时无法连接微信开放平台，请稍后重试');
      }
      const text = await response.text();
      let value: WechatApiResponse;
      try { value = JSON.parse(text) as WechatApiResponse; }
      catch { throw new BadGatewayException('微信开放平台响应格式错误'); }
      if (typeof value.errcode === 'number' && value.errcode !== 0) {
        const errmsg = typeof value.errmsg === 'string' && value.errmsg ? `：${value.errmsg}` : '';
        throw new BadGatewayException(`上传${label}失败（${value.errcode}）${errmsg}`);
      }
      return value;
    };
    const result = await this.callWechat(merchantId, upload);
    return this.responseString(result, 'media_id', 5, 256);
  }

  /**
   * FIX: 备案证件图存的是 COS 私有桶的短期签名 URL（上传时签发 5 分钟），过期后裸 fetch 必 403，
   * 导致「提交备案」永远卡在下载营业执照环节。这里对 COS 链接（*.myqcloud.com）按 objectKey 重新
   * 签发临时签名 URL（复用 app-config 的 createPrivateFileAccessUrl，10 分钟有效），其余 URL 原样返回。
   */
  private async resolveCosSignedUrl(source: string, label: string): Promise<string> {
    try {
      const url = new URL(source);
      if (!url.hostname.endsWith('.myqcloud.com')) return source;
      const objectKey = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (!objectKey) return source;
      return this.appConfig.createPrivateFileAccessUrl('', objectKey);
    } catch {
      // 解析失败（非常规 URL）按原样返回，交给下游 fetch 报错兜底
      return source;
    }
  }

  /** 拉取备案编码信息（行政区划/服务内容/主体性质/证件类型/前置审批） */
  private async fetchIcpCodes(merchantId: string): Promise<Record<string, WechatApiResponse>> {
    const query = (path: string) => this.callWechat(merchantId, (t) => this.wechatGetJsonWithAccessToken(`https://api.weixin.qq.com${path}`, 'access_token', t));
    const [district, serviceContent, subjectTypes, certificateTypes, nrlx] = await Promise.all([
      query('/wxa/icp/query_icp_district_code'),
      query('/wxa/icp/query_icp_service_content_types'),
      query('/wxa/icp/query_icp_subject_types'),
      query('/wxa/icp/query_icp_certificate_types'),
      query('/wxa/icp/query_icp_nrlx_types'),
    ]);
    return { district, serviceContent, subjectTypes, certificateTypes, nrlx };
  }

  /** 在微信备案编码响应里按中文名查找 type（先精确、再包含匹配） */
  private findIcpCode(value: WechatApiResponse, name: string, label: string): number | null {
    const list = Array.isArray(value.items) ? value.items as Array<Record<string, unknown>> : [];
    if (!list.length) return null;
    const nameOf = (row: Record<string, unknown>) => String(row.name || row.value || row.type_name || row.label || '').trim();
    const hit = list.find((row) => nameOf(row) === name) || list.find((row) => nameOf(row).includes(name));
    if (!hit) return null;
    const code = Number(hit.type ?? hit.code ?? hit.id ?? hit.type_id);
    return Number.isInteger(code) && code >= 0 ? code : null;
  }

  async submitIcpFiling(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    await this.getAuthorizedAuthorizer(merchantId);

    // FIX: 商户可能在微信公众平台手动提交过备案（含被驳回场景）。提交前先查微信侧真实备案状态，
    // 避免「审核中重复提交(86324)」「已备案仍重复申请」「入口未开放(available=0)」；
    // 被驳回(3/5)与未备案(1024+)直接放行重新提交（官方：驳回后无需撤回，可直接 apply）。
    await this.assertIcpFilingSubmittable(merchantId);

    // 前置条件检查
    const certified = await this.detectCertified(merchantId);
    if (certified !== true) throw new BadRequestException('未完成微信认证，无法提交备案。请先让商家完成微信认证（300 元/年），认证通过后再提交。');
    const categoryCount = await this.detectSavedCategoryCount(merchantId);
    if (categoryCount <= 0) throw new BadRequestException('请先在「类目设置」把服务类目保存到微信（需至少一个审核通过的类目）。');
    // 核身校验移至 appletsPrincipal 构造处（小程序负责人/管理员必须有人脸核身通过的真实任务）

    const registration = await this.registration.findForMerchant(merchantId);
    const filing = this.parseFilingData(registration?.filingDataJson);
    const subjectName = String(filing.subjectName || '').trim();
    const certificateNo = String(filing.certificateNo || '').trim();
    if (!subjectName || !certificateNo) throw new BadRequestException('请先在备案资料中完整填写主体名称与统一社会信用代码。');
    if (!filing.certificateFront || !filing.responsibleFront || !filing.responsibleBack) throw new BadRequestException('请先上传营业执照、负责人身份证正反面照片。');
    if (!filing.responsibleName || !filing.responsiblePhone || !filing.responsibleIdNo) throw new BadRequestException('请先填写主体负责人姓名、手机与证件号码。');

    // 上传材料 → media_id（icp_order_field 对应 apply_icp_filing 里的字段路径；营业执照 certificate_type=1，身份证=2）
    const mediaJobs = [
      this.uploadIcpMedia(merchantId, String(filing.certificateFront), '营业执照', 'icp_subject.organize_info.certificate_photo', 1),
      this.uploadIcpMedia(merchantId, String(filing.responsibleFront), '负责人身份证正面', 'icp_subject.principal_info.certificate_photo_front', 2),
      this.uploadIcpMedia(merchantId, String(filing.responsibleBack), '负责人身份证背面', 'icp_subject.principal_info.certificate_photo_back', 2),
    ];
    // 按微信官方口径：负责人不是法人（企业=法定代表人，个体工商户=经营者）时需授权书（签名+盖章）。
    // FIX(2026-08-09)：授权书是「小程序负责人授权书」，应挂 icp_applets.principal_info.authorization_letter——
    // 此前误挂 icp_subject（主体负责人非法人时才需要主体授权书），导致小程序负责人（管理员）收不到授权书。
    // 若主体负责人也非法人需主体授权书，可后续拆分为两个独立上传字段。
    if (String(filing.authorizationLetter || '').trim()) {
      mediaJobs.push(this.uploadIcpMedia(merchantId, String(filing.authorizationLetter), '小程序负责人授权书', 'icp_applets.principal_info.authorization_letter'));
    }
    // icp_materials 其他备案媒体材料（官方字段名即 icp_order_field；承诺视频为 video 类型，其余为图片）
    // 字段说明（apply_icp_filing 官方文档）：commitment_letter 互联网信息服务承诺书、business_name_change_letter 主体更名函、
    // party_building_confirmation_letter 党建确认函、promise_video 承诺视频、authenticity_responsibility_letter 真实性责任告知书、
    // authenticity_commitment_letter 真实性承诺书、website_construction_proposal 小程序建设方案书、
    // subject_other_materials 主体其它附件(≤10)、applets_other_materials 小程序其它附件(≤10)、holding_certificate_photo 手持证件照
    const materialsConfig: Array<{ key: string; label: string; type: 'image' | 'video' }> = [
      { key: 'commitmentLetter', label: '互联网信息服务承诺书', type: 'image' },
      { key: 'businessNameChangeLetter', label: '主体更名函', type: 'image' },
      { key: 'partyBuildingConfirmationLetter', label: '党建确认函', type: 'image' },
      { key: 'promiseVideo', label: '承诺视频', type: 'video' },
      { key: 'authenticityResponsibilityLetter', label: '真实性责任告知书', type: 'image' },
      { key: 'authenticityCommitmentLetter', label: '真实性承诺书', type: 'image' },
      { key: 'websiteConstructionProposal', label: '小程序建设方案书', type: 'image' },
      { key: 'subjectOtherMaterials', label: '主体其它附件', type: 'image' },
      { key: 'appletsOtherMaterials', label: '小程序其它附件', type: 'image' },
      { key: 'holdingCertificatePhoto', label: '手持证件照', type: 'image' },
    ];
    const materialMediaIds: Record<string, string> = {};
    for (const m of materialsConfig) {
      const value = String((filing as Record<string, unknown>)[m.key] || '').trim();
      if (!value) continue;
      // 数组字段（其它附件可传多个 media_id）按逗号分隔逐个上传
      const items = value.includes(',') ? value.split(',').map((s) => s.trim()).filter(Boolean) : [value];
      const ids = await Promise.all(items.map((item) => this.uploadIcpMedia(merchantId, item, m.label, `icp_materials.${m.key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`, undefined, m.type)));
      materialMediaIds[m.key] = ids.join(',');
    }
    const [licenseMediaId, idFrontMediaId, idBackMediaId, authorizationLetterMediaId] = await Promise.all(mediaJobs as [Promise<string>, Promise<string>, Promise<string>, Promise<string | undefined>]);

    // 拉取编码并映射（编码响应统一为 items:[{type,name}]）
    const codes = await this.fetchIcpCodes(merchantId);
    // 微信主体性质没有"个体工商户"，个体户有营业执照，按"企业"（type=4）处理；个人主体才用"个人"
    const subjectType = this.findIcpCode(codes.subjectTypes, filing.subjectNature === 'INDIVIDUAL' ? '企业' : '企业', '主体性质');
    const certType = this.findIcpCode(codes.certificateTypes, '营业执照', '主体证件类型');
    const principalCertType = this.findIcpCode(codes.certificateTypes, '居民身份证', '负责人证件类型');
    const region = this.resolveIcpRegion(codes.district, Array.isArray(filing.filingRegion) ? filing.filingRegion : []);
    const serviceTypes = this.resolveIcpServiceTypes(codes.serviceContent, Array.isArray(filing.serviceContentType) ? filing.serviceContentType : []);
    const nrlx = this.resolveIcpNrlx(codes.nrlx, String(filing.approvalType || 'NONE'), String(filing.approvalNo || ''), String(filing.approvalMaterial || ''));
    if (!subjectType) throw new BadRequestException('备案编码映射失败：无法识别主体性质，请联系技术人员核对备案编码表。');
    if (!certType) throw new BadRequestException('备案编码映射失败：无法识别主体证件类型，请联系技术人员核对备案编码表。');
    if (!principalCertType) throw new BadRequestException('备案编码映射失败：无法识别负责人证件类型，请联系技术人员核对备案编码表。');

    const principal = {
      name: String(filing.responsibleName),
      mobile: String(filing.responsiblePhone),
      email: String(filing.responsibleEmail || ''),
      emergency_contact: String(filing.emergencyContact || ''),
      certificate_type: principalCertType,
      certificate_number: String(filing.responsibleIdNo),
      certificate_validity_date_start: this.icpDate(String(filing.responsibleIdStartAt || '')),
      certificate_validity_date_end: this.icpDate(String(filing.responsibleIdEndAt || ''), true),
      certificate_photo_front: idFrontMediaId,
      certificate_photo_back: idBackMediaId,
      // 官方：verify_task_id 仅小程序负责人需要扫脸，主体负责人无需（不传）
      // FIX(2026-08-09)：授权书仅挂 icp_applets.principal_info（小程序负责人非法人时所需），主体负责人（法人）无需
    };
    // FIX: 小程序负责人（=小程序管理员）信息为「条件必填」。
    // 官方 apply_icp_filing 注意事项第 7 条：管理员实名信息未补充 + 小程序负责人为法人时，
    // 微信自动把管理员实名信息更新为法人，无需单独填管理员；仅当管理员实名已补充（或小程序负责人≠法人）时才需填。
    // 逻辑：填了管理员信息 → 用管理员信息；未填 → 回退用主体负责人（法人/经营者）信息。
    const appletsName = String(filing.appletPrincipalName || '').trim();
    const appletsPhone = String(filing.appletPrincipalPhone || '').trim();
    const appletsIdNo = String(filing.appletPrincipalIdNo || '').trim();
    const appletsFront = String(filing.appletPrincipalFront || '').trim();
    const appletsBack = String(filing.appletPrincipalBack || '').trim();
    const appletsEmail = String(filing.appletPrincipalEmail || '').trim();
    const appletsEmergency = String(filing.appletPrincipalEmergency || '').trim();
    // FIX(2026-08-09)：官方 icp_applets.principal_info 的 email / emergency_contact 均为必填。
    // 此前只校验 5 个字段导致邮箱/应急电话空串直传微信（报「缺少必填字段」+「格式不正确」）。
    // 填了管理员基本信息就视为「需填管理员」场景 → 邮箱与应急电话也强制必填 + 格式校验。
    const hasAppletsInfo = Boolean(appletsName && appletsPhone && appletsIdNo && appletsFront && appletsBack);
    if (hasAppletsInfo) {
      if (!appletsEmail) throw new BadRequestException('请填写小程序负责人（管理员）邮箱：微信备案要求该字段必填。');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appletsEmail)) throw new BadRequestException('小程序负责人（管理员）邮箱格式不正确，请检查后重填。');
      if (!appletsEmergency) throw new BadRequestException('请填写小程序负责人（管理员）应急联系电话：微信备案要求该字段必填。');
      if (!/^1\d{10}$/.test(appletsEmergency)) throw new BadRequestException('小程序负责人（管理员）应急联系电话格式有误，需为 11 位手机号。');
      if (appletsEmergency === appletsPhone) throw new BadRequestException('小程序负责人手机号与应急联系电话需为不同号码。');
    }
    const appletsPrincipal: {
      authorization_letter?: string; name: string; mobile: string; email: string; emergency_contact: string;
      certificate_type: number; certificate_number: string;
      certificate_validity_date_start: string; certificate_validity_date_end: string;
      certificate_photo_front: string; certificate_photo_back: string; verify_task_id?: string;
    } = hasAppletsInfo
      ? {
          name: appletsName,
          mobile: appletsPhone,
          email: appletsEmail,
          emergency_contact: appletsEmergency,
          certificate_type: principalCertType,
          certificate_number: appletsIdNo,
          certificate_validity_date_start: this.icpDate(String(filing.appletPrincipalIdStartAt || '')),
          certificate_validity_date_end: this.icpDate(String(filing.appletPrincipalIdEndAt || ''), true),
          certificate_photo_front: await this.uploadIcpMedia(merchantId, appletsFront, '小程序负责人身份证正面', 'icp_applets.principal_info.certificate_photo_front', 2),
          certificate_photo_back: await this.uploadIcpMedia(merchantId, appletsBack, '小程序负责人身份证背面', 'icp_applets.principal_info.certificate_photo_back', 2),
          // FIX(2026-08-09)：小程序负责人非法人时需要「小程序负责人授权书」（官方 icp_applets.principal_info.authorization_letter），
          // 此前授权书误挂到主体负责人（icp_subject...）导致小程序负责人收不到。
          ...(authorizationLetterMediaId ? { authorization_letter: authorizationLetterMediaId } : {}),
        }
      : {
          // 豁免场景：管理员实名未补充且小程序负责人为法人 → 复用主体负责人（法人/经营者）信息，微信自动同步管理员实名
          name: String(filing.responsibleName),
          mobile: String(filing.responsiblePhone),
          email: String(filing.responsibleEmail || ''),
          emergency_contact: String(filing.emergencyContact || ''),
          certificate_type: principalCertType,
          certificate_number: String(filing.responsibleIdNo),
          certificate_validity_date_start: this.icpDate(String(filing.responsibleIdStartAt || '')),
          certificate_validity_date_end: this.icpDate(String(filing.responsibleIdEndAt || ''), true),
          certificate_photo_front: idFrontMediaId,
          certificate_photo_back: idBackMediaId,
        };
    // 核身任务必须是小程序负责人的官方任务（sim_ 前缀为开发降级模拟任务，提交备案禁止使用）
    const appletsVerifyTask = await this.icpVerifyTasks.findOne({
      where: { merchantId, status: WechatIcpVerifyTaskStatus.SUCCEEDED },
      order: { createdAt: 'DESC' },
    });
    const realVerifyTask = appletsVerifyTask && !String(appletsVerifyTask.taskId || '').startsWith('sim_') ? appletsVerifyTask : null;
    if (!realVerifyTask) {
      throw new BadRequestException('请先发起并完成小程序负责人人脸核身：点「发起人脸核身」后由小程序负责人/管理员本人扫码核验，核验通过后再提交备案。');
    }
    appletsPrincipal.verify_task_id = realVerifyTask.taskId;
    const regionNames = Array.isArray(filing.filingRegion) ? filing.filingRegion as string[] : [];
    const payload = {
      icp_subject: {
        base_info: {
          type: subjectType,
          name: subjectName,
          province: region.province,
          city: region.city,
          district: region.district,
          // 微信要求通讯地址不能以省市区开头，去掉前缀只留详细地址
          address: this.stripRegionPrefix(String(filing.communicationAddress || ''), regionNames),
          comment: String(filing.serviceDescription2 || ''),
        },
        organize_info: {
          certificate_type: certType,
          certificate_number: certificateNo,
          // FIX: 证件住所（certificate_address）必须与营业执照/工商登记完全一致（含省市区前缀），
          // 官方示例为完整地址（如"北京市朝阳区高碑店路181号1栋12345室"）；只有通讯地址(address)才要求去省市区前缀。
          // 此前错误地 stripRegionPrefix 导致提交"清泉镇..."与工商库"湖北省黄冈市..."比对失败（86202）。
          certificate_address: String(filing.certificateAddress || '').trim(),
          certificate_photo: licenseMediaId,
        },
        principal_info: { ...principal },
      },
      icp_applets: {
        base_info: {
          service_content_types: serviceTypes,
          nrlx_details: nrlx,
          comment: String(filing.serviceDescription || ''),
        },
        principal_info: { ...appletsPrincipal },
      },
      icp_materials: Object.fromEntries(
        materialsConfig
          .filter((m) => materialMediaIds[m.key])
          .map((m) => [m.key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), materialMediaIds[m.key].split(',').filter(Boolean)]),
      ),
    };

    // 提交备案：捕获完整响应便于排查 86202
    const result = await this.callWechat(merchantId, async (authorizerToken) => {
      const url = new URL('https://api.weixin.qq.com/wxa/icp/apply_icp_filing');
      url.searchParams.set('access_token', authorizerToken);
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
      const rawText = await response.text();
      console.log('[ICP_APPLY_RESP]', rawText.slice(0, 2000));
      let rawValue: WechatApiResponse;
      try { rawValue = JSON.parse(rawText) as WechatApiResponse; }
      catch { throw new BadGatewayException('微信开放平台响应格式错误'); }
      if (typeof rawValue.errcode === 'number' && rawValue.errcode !== 0) {
        // FIX: 细化备案提交错误提示——86202 解析 hints 逐字段定位；86324/86358 说明重复提交/订单未完成的原因
        const errcode = rawValue.errcode;
        const errmsg = typeof rawValue.errmsg === 'string' && rawValue.errmsg ? `：${rawValue.errmsg}` : '';
        if (errcode === 86324) throw new BadRequestException('该小程序备案正在审核中，请勿重复提交（86324）。请等待审核结果。');
        if (errcode === 86358) throw new BadRequestException('存在未完成的备案订单，暂不能重新提交（86358）。请先在微信公众平台完成或撤销该订单。');
        if (errcode === 86202) {
          const hints = Array.isArray(rawValue.hints) ? rawValue.hints as Array<Record<string, unknown>> : [];
          const detail = hints.map((h) => `${String(h.err_field || h.field || '')} ${String(h.errmsg || h.error || '')}`.trim()).filter(Boolean).join('；');
          throw new BadRequestException(`微信备案校验未通过（86202）${errmsg}${detail ? `，具体问题：${detail}` : ''}`);
        }
        throw new BadGatewayException(`微信开放平台返回错误（${rawValue.errcode}）${errmsg}`);
      }
      return rawValue;
    });
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_ICP_FILING_SUBMITTED', 'MerchantRegistration', registration?.id || '', null, { subjectName, region, serviceTypes });
    return { submitted: true, wechat: result };
  }

  /** 去掉地址开头的省/市/区前缀（微信要求通讯地址不能以省市区开头） */
  private stripRegionPrefix(address: string, regionNames: string[]): string {
    let result = String(address || '').trim();
    for (const name of regionNames) {
      if (!name) continue;
      if (result.startsWith(name)) result = result.slice(name.length).trim();
    }
    return result || String(address || '').trim();
  }

  /** 备案省市区：把表单里的名称转成微信行政区划代码（省→市→区 嵌套结构，各带 code） */
  private resolveIcpRegion(district: WechatApiResponse, regionNames: string[]): { province: string; city: string; district: string } {
    if (!regionNames.length) throw new BadRequestException('请先选择备案地区（省/市/区）。');
    const provinces = Array.isArray(district.items) ? district.items as Array<Record<string, unknown>> : [];
    const prov = provinces.find((item) => String(item.name || '') === regionNames[0]);
    if (!prov) throw new BadRequestException(`无法识别备案省份「${regionNames[0]}」，请核对备案地区选择。`);
    const subList = (Array.isArray(prov.sub_list) ? prov.sub_list : []) as Array<Record<string, unknown>>;
    const city = subList.find((item) => String(item.name || '') === (regionNames[1] || regionNames[0]));
    const cityCode = city ? String(city.code ?? '') : String(prov.code ?? '');
    const distList = (city && Array.isArray(city.sub_list) ? city.sub_list : []) as Array<Record<string, unknown>>;
    const area = regionNames[2] ? distList.find((item) => String(item.name || '') === regionNames[2]) : undefined;
    return {
      province: String(prov.code ?? ''),
      city: cityCode,
      district: area ? String(area.code ?? '') : '',
    };
  }

  /** 服务内容类型：把前端自定义值映射成微信编码（按中文名匹配，找不到则抛错） */
  private resolveIcpServiceTypes(serviceContent: WechatApiResponse, customValues: string[]): number[] {
    const labels: Record<string, string> = {
      LIFE_SERVICE: '生活服务', DINING: '餐饮服务', RETAIL: '零售电商', EDUCATION: '教育培训',
      MEDICAL: '医疗健康', HOUSEKEEPING: '家政服务', BEAUTY: '美业美发', FITNESS: '运动健身',
      ENTERTAINMENT: '休闲娱乐', TRAVEL: '旅游出行', LOGISTICS: '物流仓储', OTHER: '其他',
    };
    const list = Array.isArray(serviceContent.items) ? serviceContent.items : [];
    if (!list.length) throw new BadRequestException('无法加载微信备案服务内容类型，请稍后重试。');
    const codes: number[] = [];
    for (const raw of customValues) {
      // 若已存的是微信 type 编码（纯数字），直接用
      const numeric = Number(raw);
      if (Number.isInteger(numeric) && numeric > 0) { codes.push(numeric); continue; }
      const label = labels[raw] || raw;
      const code = this.findIcpCode({ items: list }, label, '服务内容类型');
      if (code === null) throw new BadRequestException(`服务内容类型「${label}」无法匹配微信备案编码，请重新选择。`);
      codes.push(code);
    }
    return codes.slice(0, 5);
  }

  /** 前置审批：'以上都不涉及' 也要带一个 nrlx 项 */
  private resolveIcpNrlx(nrlx: WechatApiResponse, approvalType: string, approvalNo: string, approvalMaterial: string): Array<Record<string, unknown>> {
    const list = Array.isArray(nrlx.items) ? nrlx.items : [];
    const none = list.find((item) => {
      const row = item as Record<string, unknown>;
      return String(row.name || row.value || '').includes('以上都不涉及');
    });
    const noneCode = none ? Number((none as Record<string, unknown>).type) : 0;
    if (approvalType === 'NONE' || !approvalType) {
      return [{ type: Number.isInteger(noneCode) && noneCode > 0 ? noneCode : 0 }];
    }
    // 把前端自定义值映射成中文名再匹配微信编码
    const nrlxLabels: Record<string, string> = {
      ICP: '增值电信', NETCULTURE: '网络文化', PUBLICATION: '出版物', FOOD: '食品', DRUG: '药品',
      MEDICAL_DEVICE: '医疗器械', EDUCATION_PERMIT: '教育', ROAD_TRANSPORT: '道路运输', TOURISM: '旅游',
    };
    const label = nrlxLabels[approvalType] || approvalType;
    const code = this.findIcpCode({ items: list }, label, '前置审批');
    if (code === null) throw new BadRequestException(`前置审批「${approvalType}」无法匹配微信备案编码，请重新选择或改为「以上都不涉及」。`);
    return [{ type: code, code: approvalNo || undefined, media: approvalMaterial || undefined }];
  }

  /** 日期 'YYYY-MM-DD' → 'YYYYMMDD'；长期返回 '长期' */
  private icpDate(value: string, isEnd = false): string {
    const cleaned = String(value || '').replace(/[-/]/g, '');
    if (!cleaned) return isEnd ? '长期' : '';
    if (/^\d{8}$/.test(cleaned)) return cleaned;
    if (isEnd) return '长期';
    return cleaned;
  }

  /** 撤回/取消当前未完结的备案申请（微信拒绝重复备案时用） */
  async cancelIcpFiling(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/icp/cancel_apply_icp_filing', {}, 'access_token', authorizerToken));
    return { canceled: true, wechat: result };
  }

  /** 拉取微信真实行政区划（省→市→区，含区县代码），供备案地区级联选择 */
  async getIcpDistricts(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/icp/query_icp_district_code', 'access_token', authorizerToken));
    const provinces = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : [];
    const mapNode = (node: Record<string, unknown>): { value: string; label: string; children?: Array<{ value: string; label: string }> } => ({
      value: String(node.name || ''),
      label: String(node.name || ''),
      children: Array.isArray(node.sub_list) ? (node.sub_list as Array<Record<string, unknown>>).map(mapNode) : undefined,
    });
    return provinces.map(mapNode);
  }

  /** 拉取微信真实的服务内容类型（含二级类目），供备案表单选择 */
  async getIcpServiceContentTypes(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/icp/query_icp_service_content_types', 'access_token', authorizerToken));
    const items = Array.isArray(result.items) ? result.items as Array<{ type: number; parent_type: number; name: string }> : [];
    // 只保留二级类目（parent_type>0），附上一级代码与名称，供级联选择
    const parents = new Map<number, string>();
    items.forEach((item) => { if (item.parent_type === 0) parents.set(item.type, item.name || ''); });
    return items
      .filter((item) => item.parent_type > 0)
      .map((item) => ({ type: item.type, name: item.name || '', parentType: item.parent_type, parentName: parents.get(item.parent_type) || '' }));
  }

  async getIcpFilingStatus(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/icp/get_icp_entrance_info', 'access_token', authorizerToken));
    const info = result.info && typeof result.info === 'object' && !Array.isArray(result.info) ? result.info as Record<string, unknown> : {};
    const registration = await this.registration.findForMerchant(merchantId);
    if (registration) {
      const filing = this.parseFilingData(registration.filingDataJson);
      filing._icpEntranceInfo = { status: Number.isInteger(Number(info.status)) ? Number(info.status) : null, info, updatedAt: new Date().toISOString() };
      registration.filingDataJson = JSON.stringify(filing);
      await this.dataSource.getRepository(MerchantRegistration).save(registration);
    }
    return { icpStatus: result };
  }

  /**
   * 提交备案前校验微信侧备案状态（get_icp_entrance_info）。
   * 状态枚举：2平台审核中 / 3平台审核驳回 / 4管局审核中 / 5管局审核驳回 / 6已备案 / 1024未备案 / 1025-1031未备案+缺前置条件。
   * 规则：审核中(2/4)与已备案(6)禁止重复提交；入口未开放(available=0)禁止提交；驳回(3/5)与未备案(1024+)放行重提。
   */
  private async assertIcpFilingSubmittable(merchantId: string): Promise<void> {
    let info: Record<string, unknown>;
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/icp/get_icp_entrance_info', 'access_token', authorizerToken));
      info = result && typeof result.info === 'object' && !Array.isArray(result.info) ? result.info as Record<string, unknown> : {};
    } catch {
      // 查询失败不阻塞提交（降级为放行，由微信 apply 接口的 86324/86358 兜底拦截）
      return;
    }
    const status = Number(info.status ?? -1);
    const available = Number(info.available ?? 1);
    if (status === 2 || status === 4) throw new BadRequestException('该小程序备案正在审核中（平台/管局），请等待审核结果后再重新提交。');
    if (status === 6) throw new BadRequestException('该小程序已完成备案，无需重复提交。');
    if (available === 0) throw new BadRequestException('微信备案入口当前未开放（如小程序昵称含特定关键词或管局系统不可用），暂不能提交备案。');
    // status 3（平台驳回）/ 5（管局驳回）/ 1024+（未备案）：允许重新提交
  }

  async listReleases(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const [releases, jobs] = await Promise.all([
      this.releases.find({ where: { merchantId }, order: { createdAt: 'DESC' }, take: 20 }),
      this.releaseJobs.find({ where: { merchantId }, order: { createdAt: 'DESC' }, take: 80 }),
    ]);
    return {
      items: releases.map((release) => ({
        ...this.releaseSummary(release),
        jobs: jobs.filter((job) => job.releaseId === release.id).map((job) => this.releaseJobSummary(job)),
      })),
    };
  }

  async commitMiniprogram(user: User, merchantId: string, body: { templateId?: number; userVersion?: string; userDesc?: string }) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.getAuthorizedAuthorizer(merchantId);
    const templateId = Number(body.templateId || this.value('WECHAT_MINIPROGRAM_TEMPLATE_ID'));
    if (!Number.isInteger(templateId) || templateId <= 0) throw new BadRequestException('请配置或填写微信第三方平台小程序代码模板 ID');
    const userVersion = this.safeVersion(body.userVersion || this.defaultUserVersion());
    const userDesc = String(body.userDesc || 'SaaS 小程序模板发布').trim().slice(0, 240);
    const extJson = this.buildExtJson(merchantId, authorizer.authorizerAppId);
    const release = await this.releases.save({
      merchantId,
      authorizerAppId: authorizer.authorizerAppId,
      templateId,
      userVersion,
      userDesc,
      extJson,
      status: WechatMiniprogramReleaseStatus.DRAFT,
      auditId: null,
      trialQrUrl: '',
      errorMessage: '',
      requestedBy: user.id,
    }) as WechatMiniprogramRelease;
    const payload = { template_id: templateId, ext_json: JSON.stringify(extJson), user_version: userVersion, user_desc: userDesc };
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/commit', payload, 'access_token', authorizerToken));
      release.status = WechatMiniprogramReleaseStatus.COMMITTED;
      release.errorMessage = '';
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.COMMIT, WechatMiniprogramReleaseJobStatus.SUCCEEDED, payload, result);
      await this.auditWriter.write(user.id, merchantId, 'WECHAT_MINIPROGRAM_COMMITTED', 'WechatMiniprogramRelease', release.id, null, { templateId, userVersion });
      return this.releaseWithJobs(release);
    } catch (error) {
      release.status = WechatMiniprogramReleaseStatus.FAILED;
      release.errorMessage = (error as Error).message;
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.COMMIT, WechatMiniprogramReleaseJobStatus.FAILED, payload, {}, (error as Error).message);
      throw error;
    }
  }

  /**
   * 平台端一键同步：把所有已授权商家的小程序更新到模板库最新模板，
   * 并设为体验版（wxa/commit 生成开发版 + wxa/settrialversion 设为体验版），
   * 保证每个商家的体验成员扫到的是最新模板代码。
   */
  async syncAllMerchantsToLatestTemplate(user: User, templateId?: number) {
    // FIX：批量同步开放给代理商（按 agencyId 隔离名下商家，多租户不越权）；平台端保持全量
    let authorizers: WechatAuthorizer[];
    if (user.role === UserRole.AGENCY_ADMIN) {
      if (!user.agencyId) throw new ForbiddenException('代理商账号缺少归属代理商，无法批量同步');
      const merchants = await this.dataSource.manager.find(Merchant, { where: { agencyId: user.agencyId }, select: { id: true } });
      const merchantIds = merchants.map((merchant) => merchant.id);
      authorizers = merchantIds.length
        ? await this.authorizers.find({ where: { status: WechatAuthorizerStatus.AUTHORIZED, revokedAt: IsNull(), merchantId: In(merchantIds) } })
        : [];
    } else {
      this.merchantAccess.requirePlatformAccess(user, '同步全部商家小程序', PLATFORM_PROFILES);
      authorizers = await this.authorizers.find({ where: { status: WechatAuthorizerStatus.AUTHORIZED, revokedAt: IsNull() } });
    }
    // 可指定模板版本回退；未指定时用环境变量默认模板
    const resolvedTemplateId = Number(templateId || this.value('WECHAT_MINIPROGRAM_TEMPLATE_ID'));
    if (!Number.isInteger(resolvedTemplateId) || resolvedTemplateId <= 0) throw new BadRequestException('请选择要同步的小程序模板版本');
    const userVersion = this.safeVersion(this.defaultUserVersion());
    const userDesc = 'SaaS 小程序模板同步';
    const results: Array<{ merchantId: string; appId: string; status: string; version?: string; message?: string }> = [];
    for (const authorizer of authorizers) {
      try {
        const extJson = this.buildExtJson(authorizer.merchantId, authorizer.authorizerAppId);
        const release = await this.releases.save({
          merchantId: authorizer.merchantId,
          authorizerAppId: authorizer.authorizerAppId,
          templateId: resolvedTemplateId,
          userVersion,
          userDesc,
          extJson,
          status: WechatMiniprogramReleaseStatus.DRAFT,
          auditId: null,
          trialQrUrl: '',
          errorMessage: '',
          requestedBy: user.id,
        }) as WechatMiniprogramRelease;
        const payload = { template_id: resolvedTemplateId, ext_json: JSON.stringify(extJson), user_version: userVersion, user_desc: userDesc };
        await this.callWechat(authorizer.merchantId, (at) =>
          this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/commit', payload, 'access_token', at));
        release.status = WechatMiniprogramReleaseStatus.COMMITTED;
        await this.releases.save(release);
        // 第三方平台代开发模式下 wxa/commit 即"上传代码并生成体验版"，无需额外 settrialversion
        results.push({ merchantId: authorizer.merchantId, appId: authorizer.authorizerAppId, status: 'ok', version: userVersion });
      } catch (error) {
        results.push({ merchantId: authorizer.merchantId, appId: authorizer.authorizerAppId, status: 'error', message: (error as Error).message });
      }
    }
    return { total: authorizers.length, templateId: resolvedTemplateId, userVersion, results };
  }

  /** 获取模板库模板列表（用于选择同步到哪个版本 / 回退到旧版本） */
  async listTemplates(user: User) {
    // FIX(2026-08-10)：代理端"批量同步"需选择模板版本，放行 AGENCY_ADMIN（与 syncAll 的 AGENCY 分支一致，仅限查询模板列表，不涉及平台职责数据）
    if (user.role !== UserRole.AGENCY_ADMIN) {
      this.merchantAccess.requirePlatformAccess(user, '查看小程序模板', PLATFORM_PROFILES);
    }
    const result = await this.fetchTemplateListWithRetry();
    const list = Array.isArray(result.template_list) ? result.template_list as Array<Record<string, unknown>> : [];
    return {
      items: list
        .map((item) => ({
          templateId: Number(item.template_id || 0),
          userVersion: String(item.user_version || ''),
          userDesc: String(item.user_desc || ''),
          createTime: Number(item.create_time || 0),
        }))
        .filter((item) => item.templateId > 0)
        .sort((a, b) => b.createTime - a.createTime),
    };
  }

  /** 拉取模板列表；遇 40001（component_access_token 失效/非最新）时强制刷新后重试一次 */
  private async fetchTemplateListWithRetry(): Promise<WechatApiResponse> {
    try {
      return await this.fetchTemplateList(await this.getComponentAccessToken());
    } catch (error) {
      const message = (error as Error).message || '';
      if (!message.includes('40001')) throw error;
      return this.fetchTemplateList(await this.getComponentAccessToken(true));
    }
  }

  private async fetchTemplateList(componentAccessToken: string) {
    // gettemplatelist 的 URL 参数名是 access_token，值用第三方平台 component_access_token
    return this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/gettemplatelist', 'access_token', componentAccessToken);
  }

  async createTrialQr(user: User, merchantId: string, releaseId?: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const release = await this.getReleaseForUser(merchantId, releaseId);
    if (![WechatMiniprogramReleaseStatus.COMMITTED, WechatMiniprogramReleaseStatus.AUDIT_SUBMITTED, WechatMiniprogramReleaseStatus.AUDIT_APPROVED, WechatMiniprogramReleaseStatus.RELEASED].includes(release.status)) {
      throw new BadRequestException('请先上传小程序代码后再生成体验版二维码');
    }
    const payload = { path: 'pages/home/index' };
    try {
      const qr = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatGetBinaryWithAccessToken('https://api.weixin.qq.com/wxa/get_qrcode', 'access_token', authorizerToken, payload));
      release.trialQrUrl = `data:${qr.contentType};base64,${qr.bytes.toString('base64')}`;
      release.errorMessage = '';
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.TRIAL_QR, WechatMiniprogramReleaseJobStatus.SUCCEEDED, payload, { contentType: qr.contentType, bytes: qr.bytes.length });
      return this.releaseWithJobs(release);
    } catch (error) {
      release.errorMessage = (error as Error).message;
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.TRIAL_QR, WechatMiniprogramReleaseJobStatus.FAILED, payload, {}, (error as Error).message);
      throw error;
    }
  }

  async submitAudit(user: User, merchantId: string, body: { releaseId?: string; itemList?: Array<Record<string, unknown>>; feedbackInfo?: string; feedbackStuff?: string }) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const release = await this.getReleaseForUser(merchantId, body.releaseId);
    if (![WechatMiniprogramReleaseStatus.COMMITTED, WechatMiniprogramReleaseStatus.AUDIT_REJECTED].includes(release.status)) throw new BadRequestException('当前小程序版本不能提交审核，请先上传代码');
    const itemList = Array.isArray(body.itemList) ? body.itemList : [];
    if (!itemList.length) throw new BadRequestException('提交微信审核需要 itemList，请先在类目设置中选择审核类目并配置页面地址');
    // FIX(C)：官方规定 feedback_info/feedback_stuff 仅「上一版本被驳回」时可用，否则微信忽略处理；
    // 首次提交（COMMITTED）不传，仅驳回重提（AUDIT_REJECTED）时携带
    const isRejectedRetry = release.status === WechatMiniprogramReleaseStatus.AUDIT_REJECTED;
    const payload: Record<string, unknown> = {
      item_list: itemList,
      // 模板代码不使用地理位置隐私接口（getLocation 已确认不需要，仅保留 openLocation 到店导航），
      // 提交审核时声明不使用，避免微信检测到代码中的地理位置接口而报 61040。
      privacy_api_not_use: true,
      ...(isRejectedRetry ? { feedback_info: String(body.feedbackInfo || '').slice(0, 200) } : {}),
      ...(isRejectedRetry ? { feedback_stuff: String(body.feedbackStuff || '').slice(0, 2048) } : {}),
    };
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/submit_audit', payload, 'access_token', authorizerToken));
      const auditId = this.responseInteger(result, 'auditid', 1, Number.MAX_SAFE_INTEGER);
      release.auditId = auditId;
      release.status = WechatMiniprogramReleaseStatus.AUDIT_SUBMITTED;
      release.errorMessage = '';
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.SUBMIT_AUDIT, WechatMiniprogramReleaseJobStatus.SUCCEEDED, payload, result);
      await this.auditWriter.write(user.id, merchantId, 'WECHAT_MINIPROGRAM_AUDIT_SUBMITTED', 'WechatMiniprogramRelease', release.id, null, { auditId });
      return this.releaseWithJobs(release);
    } catch (error) {
      release.errorMessage = (error as Error).message;
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.SUBMIT_AUDIT, WechatMiniprogramReleaseJobStatus.FAILED, payload, {}, (error as Error).message);
      throw error;
    }
  }

  async queryAudit(user: User, merchantId: string, releaseId?: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const release = await this.getReleaseForUser(merchantId, releaseId);
    const payload = { auditid: release.auditId };
    if (!release.auditId) {
      // FIX(A)：本地无审核单号时兜底查询微信侧最新一次提审单（wxa/get_latest_auditstatus，官方 GET 无参），
      // 避免「审核单号缺失导致永远查不到审核结果」。
      const latest = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/get_latest_auditstatus', 'access_token', authorizerToken));
      const latestAuditId = typeof latest.auditid === 'number' ? latest.auditid : null;
      if (!latestAuditId) throw new BadRequestException('微信侧暂无提审单，无法查询审核结果');
      release.auditId = latestAuditId;
      const latestStatus = typeof latest.status === 'number' ? latest.status : null;
      // 官方 status：0 通过 / 1 驳回 / 2 审核中 / 3 已撤回 / 4 审核延后
      if (latestStatus === 0) release.status = WechatMiniprogramReleaseStatus.AUDIT_APPROVED;
      if (latestStatus === 1) release.status = WechatMiniprogramReleaseStatus.AUDIT_REJECTED;
      if (latestStatus === 3) release.status = WechatMiniprogramReleaseStatus.COMMITTED;
      release.errorMessage = latestStatus === 1 ? String(latest.reason || latest.errmsg || '微信审核未通过') : latestStatus === 3 ? '审核已撤回，可重新提交' : '';
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.QUERY_AUDIT, WechatMiniprogramReleaseJobStatus.SUCCEEDED, { auditid: latestAuditId, via: 'get_latest_auditstatus' }, latest);
      return this.releaseWithJobs(release);
    }
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/get_auditstatus', payload, 'access_token', authorizerToken));
      const status = typeof result.status === 'number' ? result.status : null;
      if (status === 0) release.status = WechatMiniprogramReleaseStatus.AUDIT_APPROVED;
      if (status === 1) release.status = WechatMiniprogramReleaseStatus.AUDIT_REJECTED;
      // FIX(C)：官方 status=3 为「已撤回」，撤回后可重新提交审核，本地状态回退为 COMMITTED 而非滞留 AUDIT_SUBMITTED
      if (status === 3) release.status = WechatMiniprogramReleaseStatus.COMMITTED;
      release.errorMessage = status === 1 ? String(result.reason || result.errmsg || '微信审核未通过') : status === 3 ? '审核已撤回，可重新提交' : '';
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.QUERY_AUDIT, WechatMiniprogramReleaseJobStatus.SUCCEEDED, payload, result);
      return this.releaseWithJobs(release);
    } catch (error) {
      release.errorMessage = (error as Error).message;
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.QUERY_AUDIT, WechatMiniprogramReleaseJobStatus.FAILED, payload, {}, (error as Error).message);
      throw error;
    }
  }

  async releaseMiniprogram(user: User, merchantId: string, releaseId?: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const release = await this.getReleaseForUser(merchantId, releaseId);
    if (release.status !== WechatMiniprogramReleaseStatus.AUDIT_APPROVED) throw new BadRequestException('只有微信审核通过的版本才能发布上线');
    const payload = {};
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/release', payload, 'access_token', authorizerToken));
      release.status = WechatMiniprogramReleaseStatus.RELEASED;
      release.errorMessage = '';
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.RELEASE, WechatMiniprogramReleaseJobStatus.SUCCEEDED, payload, result);
      await this.auditWriter.write(user.id, merchantId, 'WECHAT_MINIPROGRAM_RELEASED', 'WechatMiniprogramRelease', release.id, null, { auditId: release.auditId });
      return this.releaseWithJobs(release);
    } catch (error) {
      release.errorMessage = (error as Error).message;
      await this.releases.save(release);
      await this.recordReleaseJob(user, release, WechatMiniprogramReleaseJobType.RELEASE, WechatMiniprogramReleaseJobStatus.FAILED, payload, {}, (error as Error).message);
      throw error;
    }
  }

  /**
   * 版本对账（wxa/getversioninfo）：查询微信侧当前「体验版/线上版」真实版本，与本地最新发布记录对比，
   * 用于判断线上运行的是否为最新上传/发布的代码（官方：POST 必须带空 json body，否则 44002）。
   */
  async versionInfo(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.getAuthorizedAuthorizer(merchantId);
    const local = await this.releases.findOne({ where: { merchantId }, order: { createdAt: 'DESC' } });
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/getversioninfo', {}, 'access_token', authorizerToken));
    const exp = (result?.exp_info || null) as { exp_time?: number; exp_version?: string; exp_desc?: string } | null;
    const rel = (result?.release_info || null) as { release_time?: number; release_version?: string; release_desc?: string } | null;
    const wechatReleasedVersion = rel?.release_version ? String(rel.release_version) : '';
    const wechatTrialVersion = exp?.exp_version ? String(exp.exp_version) : '';
    return {
      wechat: {
        trial: exp ? { version: wechatTrialVersion, desc: String(exp.exp_desc || ''), updatedAt: exp.exp_time ? new Date(Number(exp.exp_time) * 1000).toISOString() : null } : null,
        released: rel ? { version: wechatReleasedVersion, desc: String(rel.release_desc || ''), updatedAt: rel.release_time ? new Date(Number(rel.release_time) * 1000).toISOString() : null } : null,
      },
      local: local ? this.releaseSummary(local) : null,
      // 线上一致性：本地最新 RELEASED 版本号 与 微信侧线上版本号 是否一致
      onlineConsistent: Boolean(local && local.status === WechatMiniprogramReleaseStatus.RELEASED && local.userVersion === wechatReleasedVersion),
      note: !wechatReleasedVersion ? '微信侧暂无线上版本（尚未发布或刚回退）' : local?.status === WechatMiniprogramReleaseStatus.RELEASED && local.userVersion !== wechatReleasedVersion ? '本地记录与微信侧线上版本不一致，请以微信侧为准' : '',
    };
  }

  async receiveCallback(rawBody: Buffer, signature: string, timestamp: string, nonce: string, authorizerAppId?: string): Promise<void> {
    if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 1024 * 1024) throw new BadRequestException('微信回调请求体无效');
    if (!/^\d{1,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) throw new BadRequestException('微信回调参数无效');
    if (authorizerAppId && !/^wx[A-Za-z0-9]{8,32}$/.test(authorizerAppId)) throw new BadRequestException('授权方 AppID 格式错误');
    const token = this.required('WECHAT_COMPONENT_TOKEN');
    const componentAppId = this.required('WECHAT_COMPONENT_APP_ID');
    const encrypted = this.xmlValue(rawBody.toString('utf8'), 'Encrypt');
    this.verifySignature(token, timestamp, nonce, encrypted, signature);
    const decrypted = this.decrypt(encrypted, this.required('WECHAT_COMPONENT_ENCODING_AES_KEY'));
    console.log('[WECHAT_DECRYPT] receiveId:', decrypted.receiveId, 'expected:', componentAppId, 'authorizer:', authorizerAppId, 'msgStart:', decrypted.message.substring(0, 100));
    if (decrypted.receiveId.toLowerCase() !== componentAppId.toLowerCase() && decrypted.receiveId !== authorizerAppId) throw new BadRequestException('微信回调接收方不匹配');
    const infoType = this.xmlValue(decrypted.message, 'InfoType', false);
    const messageEvent = this.xmlValue(decrypted.message, 'Event', false);
    const eventAuthorizerAppId = authorizerAppId
      || this.xmlValue(decrypted.message, 'AuthorizerAppid', false)
      || this.xmlValue(decrypted.message, 'verify_appid', false)
      || this.xmlValue(decrypted.message, 'appid', false);
    const eventType = infoType || messageEvent || 'unknown';
    const eventPayload: Record<string, unknown> = {
      eventType,
      authorizerAppId: eventAuthorizerAppId || null,
      createTime: this.xmlValue(decrypted.message, 'CreateTime', false) || timestamp,
      messageDigest: createHash('sha256').update(decrypted.message).digest('hex'),
    };
    if (eventType === 'notify_third_fasteregister') {
      const authCode = this.xmlValue(decrypted.message, 'auth_code', false);
      if (authCode) eventPayload.authCodeCiphertext = this.sensitiveData.encrypt(authCode);
      eventPayload.appid = this.xmlValue(decrypted.message, 'appid', false);
      eventPayload.status = this.xmlValue(decrypted.message, 'status', false);
      eventPayload.message = this.xmlValue(decrypted.message, 'msg', false);
      const infoXml = decrypted.message.match(/<info>([\s\S]*?)<\/info>/)?.[1] || '';
      eventPayload.merchantName = infoXml ? this.xmlValue(`<info>${infoXml}</info>`, 'name', false) : '';
      eventPayload.merchantCode = infoXml ? this.xmlValue(`<info>${infoXml}</info>`, 'code', false) : '';
    } else if (eventType === 'authorized') {
      const authCode = this.xmlValue(decrypted.message, 'AuthorizationCode', false);
      if (authCode) eventPayload.authCodeCiphertext = this.sensitiveData.encrypt(authCode);
      eventPayload.appid = this.xmlValue(decrypted.message, 'AuthorizerAppid', false) || eventAuthorizerAppId || '';
    } else if (eventType === 'notify_icpfiling_verify_result') {
      eventPayload.taskId = this.xmlValue(decrypted.message, 'task_id', false);
      eventPayload.result = this.xmlValue(decrypted.message, 'result', false);
      eventPayload.alongWithAuthResult = this.xmlValue(decrypted.message, 'along_with_auth_result', false);
    } else if (eventType === 'notify_3rd_wxa_auth') {
      // 微信认证事件：任务创建、授权/人脸/短信/支付完成、审核派单、打回重填、重新提审、成功/失败
      eventPayload.taskid = this.xmlValue(decrypted.message, 'taskid', false);
      eventPayload.taskStatus = this.xmlValue(decrypted.message, 'task_status', false);
      eventPayload.applyStatus = this.xmlValue(decrypted.message, 'apply_status', false);
      eventPayload.orderId = this.xmlValue(decrypted.message, 'orderid', false);
      eventPayload.message = this.xmlValue(decrypted.message, 'message', false);
    } else if (eventType === 'wxa_audit_success' || eventType === 'wxa_audit_fail') {
      eventPayload.approved = eventType === 'wxa_audit_success';
    } else if (eventType === 'component_verify_ticket') {
      const ticket = this.xmlValue(decrypted.message, 'ComponentVerifyTicket', false);
      if (ticket.length < 16 || ticket.length > 512) throw new BadRequestException('ComponentVerifyTicket 格式错误');
      eventPayload.ticketCiphertext = this.sensitiveData.encrypt(ticket);
    }
    await this.enqueueCallbackEvent({
      eventType,
      authorizerAppId: eventAuthorizerAppId || null,
      createTime: String(eventPayload.createTime),
      messageDigest: String(eventPayload.messageDigest),
      payload: eventPayload,
    });
    /* callback body ends after enqueue; business side effects are handled by processWechatSyncTasks. */
    return;
  }

  /**
   * 第三方平台代开发模式：用 wx.login 的 code 换取用户 openid。
   * 走 sns/component/jscode2session（带 component_access_token），不需要商家小程序 AppSecret。
   */
  async exchangeCustomerOpenid(code: string, appId: string): Promise<string> {
    const componentAppId = this.required('WECHAT_COMPONENT_APP_ID');
    const componentAccessToken = await this.getComponentAccessToken();
    const params = new URLSearchParams({
      appid: appId,
      js_code: code,
      grant_type: 'authorization_code',
      component_appid: componentAppId,
      component_access_token: componentAccessToken,
    });
    let payload: { openid?: unknown; errcode?: unknown };
    try {
      const response = await fetch(`https://api.weixin.qq.com/sns/component/jscode2session?${params.toString()}`, { signal: AbortSignal.timeout(8_000) });
      payload = await response.json() as { openid?: unknown; errcode?: unknown };
    } catch {
      throw new ServiceUnavailableException('微信登录服务暂不可用，请稍后重试');
    }
    if (typeof payload.openid !== 'string' || !payload.openid) {
      throw new ServiceUnavailableException(`微信登录未完成（${String(payload.errcode || '')}），请稍后重试`);
    }
    return payload.openid;
  }

  /** H5：component token 刷新 single-flight（防并发刷新触发微信 45009 频控） */
  private componentTokenRefreshes: Promise<string> | null = null;

  private async getComponentAccessToken(forceRefresh = false): Promise<string> {
    const state = await this.loadComponentState();
    if (!state?.verifyTicketCiphertext || !state.ticketUpdatedAt) throw new ServiceUnavailableException('尚未收到微信 ComponentVerifyTicket，请检查授权事件回调配置');
    // 缓存有效期内直接复用；forceRefresh（如遇 40001 失效）时强制向微信换取最新 token
    if (!forceRefresh && state.accessTokenCiphertext && state.accessTokenExpiresAt && state.accessTokenExpiresAt.getTime() > Date.now() + 300_000) {
      return this.sensitiveData.decrypt(state.accessTokenCiphertext);
    }
    if (this.componentTokenRefreshes && !forceRefresh) return this.componentTokenRefreshes;
    const promise = this.refreshComponentTokenInner().finally(() => { this.componentTokenRefreshes = null; });
    if (!forceRefresh) this.componentTokenRefreshes = promise;
    return promise;
  }

  private async refreshComponentTokenInner(): Promise<string> {
    const state = await this.loadComponentState();
    if (!state?.verifyTicketCiphertext) throw new ServiceUnavailableException('尚未收到微信 ComponentVerifyTicket');
    const appId = this.required('WECHAT_COMPONENT_APP_ID');
    const appSecret = this.required('WECHAT_COMPONENT_APP_SECRET');
    let ticket: string;
    try { ticket = this.sensitiveData.decrypt(state.verifyTicketCiphertext); }
    catch (e) { console.log('[WECHAT_TOKEN] ticket decrypt FAILED:', (e as Error).message); throw e; }
    console.log('[WECHAT_TOKEN] calling api_component_token - appId:', appId, 'secretLen:', appSecret.length, 'ticketLen:', ticket.length, 'ticketStart:', ticket.substring(0, 20));
    const result = await this.wechatPost('https://api.weixin.qq.com/cgi-bin/component/api_component_token', {
      component_appid: appId,
      component_appsecret: appSecret,
      component_verify_ticket: ticket,
    });
    const token = this.responseString(result, 'component_access_token', 16, 2048);
    const expiresIn = this.responseSeconds(result, 'expires_in', 300, 7200);
    state.accessTokenCiphertext = this.sensitiveData.encrypt(token);
    state.accessTokenExpiresAt = new Date(Date.now() + Math.max(60, expiresIn - 300) * 1000);
    await this.componentStates.save(state);
    return token;
  }

  /**
   * 自动配置商家小程序的服务器域名。
   * 授权成功后调用，避免体验版/审核时因域名未白名单而网络错误。
   * 注意：授权小程序只能请求第三方平台已配置的服务器域名（wxa_server_domain），
   * 因此先确保平台层域名，再对单个小程序 modify_domain_directly。
   * P0-2：经运营端入口调用时（user 提供）必须校验该商家的访问权限，防止跨租户越权改他人小程序域名；
   * 授权流程内部调用（无 user）不校验（系统行为）。
   */
  async configureAuthorizerDomains(merchantId: string, user?: User): Promise<{ configured: boolean; message: string }> {
    if (user) {
      await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    }
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) return { configured: false, message: '商家尚未授权' };
    const requestDomain = this.value('WECHAT_MINIPROGRAM_REQUEST_DOMAIN') || this.value('PUBLIC_BASE_URL');
    if (!requestDomain) return { configured: false, message: '未配置小程序服务器域名' };
    const apiBase = this.miniprogramApiBase();
    const host = new URL(apiBase).origin;
    await this.ensurePlatformServerDomain();
    try {
      const payload = {
        action: 'add',
        requestdomain: [host],
        wsrequestdomain: [],
        uploaddomain: [host],
        downloaddomain: [host],
        udpdomain: [],
        tcpdomain: [],
      };
      // SaaS 模板模式（第三方平台代开发）：必须用 wxa/modify_domain（方式一，域名先登记到第三方平台），
      // modify_domain_directly（方式二）仅对个性化小程序有效且限 100 主体，模板模式下不生效
      await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/modify_domain', payload, 'access_token', authorizerToken));
      return { configured: true, message: `已配置服务器域名 ${host}` };
    } catch (error) {
      const message = (error as Error).message || '';
      // 域名已存在等情况视为已配置
      if (message.includes('85016') || message.includes('85017') || message.includes('85018')) {
        return { configured: true, message: `服务器域名已配置（${host}）` };
      }
      throw new BadGatewayException(`自动配置小程序服务器域名失败：${message}`);
    }
  }

  /**
   * 查询授权小程序当前配置的服务器域名（request/upload/download）。
   * 商户端可视化展示：让商户看到当前生效的合法域名。
   */
  async getAuthorizerDomains(user: User, merchantId: string): Promise<{
    requestDomain: string[];
    uploadDomain: string[];
    downloadDomain: string[];
  }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/modify_domain_directly', { action: 'get' }, 'access_token', authorizerToken));
    const list = (value: unknown) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    return {
      requestDomain: list(result.requestdomain),
      uploadDomain: list(result.uploaddomain),
      downloadDomain: list(result.downloaddomain),
    };
  }

  /**
   * 商户端自定义服务器域名：商户可自行填写 request/upload/download 合法域名，
   * 保存时通过 wxa/modify_domain_directly action=set 覆盖到授权小程序。
   * 域名必须为 https 且不含路径；设置前会先确保第三方平台层已登记该域名。
   */
  async updateAuthorizerDomains(
    user: User,
    merchantId: string,
    body: { requestDomain?: unknown; uploadDomain?: unknown; downloadDomain?: unknown },
  ): Promise<{
    configured: boolean;
    message: string;
    domains: { requestDomain: string[]; uploadDomain: string[]; downloadDomain: string[] };
  }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const normalize = (value: unknown, label: string): string[] => {
      const raw = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : (typeof value === 'string' && value.trim() ? [value] : []);
      return [...new Set(raw.map((item) => this.normalizeWechatDomain(item, label)))];
    };
    const requestDomain = normalize(body.requestDomain, 'request 域名');
    const uploadDomain = normalize(body.uploadDomain, 'upload 域名');
    const downloadDomain = normalize(body.downloadDomain, 'download 域名');
    if (!requestDomain.length) throw new BadRequestException('请至少填写一个 request 合法域名');
    // 授权小程序只能请求平台层已登记的域名，先逐个登记
    for (const domain of requestDomain) {
      await this.ensurePlatformServerDomainFor(new URL(domain).hostname);
    }
    const payload = {
      action: 'set',
      requestdomain: requestDomain,
      wsrequestdomain: [],
      uploaddomain: uploadDomain,
      downloaddomain: downloadDomain,
      udpdomain: [],
      tcpdomain: [],
    };
    try {
      await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/modify_domain_directly', payload, 'access_token', authorizerToken));
    } catch (error) {
      const message = (error as Error).message || '';
      // 域名已存在等情况视为已配置
      if (!(message.includes('85016') || message.includes('85017') || message.includes('85018'))) {
        throw new BadGatewayException(`设置小程序服务器域名失败：${message}`);
      }
    }
    return {
      configured: true,
      message: '服务器域名已更新',
      domains: { requestDomain, uploadDomain, downloadDomain },
    };
  }

  /** 校验并规范化商户填写的合法域名：必须 https、不能含路径、可带端口 */
  private normalizeWechatDomain(value: string, label: string): string {
    const trimmed = value.trim().replace(/\/+$/, '');
    let parsed: URL;
    try { parsed = new URL(trimmed); }
    catch { throw new BadRequestException(`${label}格式不正确，请填写形如 https://example.com`); }
    if (parsed.protocol !== 'https:') throw new BadRequestException(`${label}必须是 https 地址`);
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new BadRequestException(`${label}不能包含路径，只填写域名，例如 https://example.com`);
    }
    if (parsed.search || parsed.hash) throw new BadRequestException(`${label}不能包含查询参数`);
    return trimmed;
  }

  /**
   * 获取小程序体验者列表（wxa/memberauth）。
   * 体验成员是唯一可扫码进入体验版的白名单，商户端可视化管理。
   */
  async listTesters(user: User, merchantId: string): Promise<{ members: Array<{ wechatid: string; userstr: string }> }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/memberauth', { action: 'get_experiencer' }, 'access_token', authorizerToken));
    // 微信接口返回 members[].userstr（部分版本同时含 wechatid），统一归一为 wechatid 展示
    const members = Array.isArray(result.members)
      ? result.members.map((member) => {
        const source = (member || {}) as { wechatid?: unknown; userstr?: unknown };
        const userstr = String(source.userstr || '');
        return { wechatid: String(source.wechatid || userstr || ''), userstr };
      }).filter((member) => member.wechatid)
      : [];
    return { members };
  }

  /** 绑定体验者（wxa/bind_tester）：新增一个微信号为体验成员 */
  async bindTester(user: User, merchantId: string, wechatid: string): Promise<{ message: string }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const id = String(wechatid || '').trim();
    if (!id) throw new BadRequestException('请填写体验成员的微信号');
    await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/bind_tester', { wechatid: id }, 'access_token', authorizerToken));
    return { message: '已添加体验成员' };
  }

  /** 解绑体验者（wxa/unbind_tester）：移除指定微信号的体验成员资格 */
  async unbindTester(user: User, merchantId: string, wechatid: string): Promise<{ message: string }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const id = String(wechatid || '').trim();
    if (!id) throw new BadRequestException('请填写体验成员的微信号');
    await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/unbind_tester', { wechatid: id }, 'access_token', authorizerToken));
    return { message: '已移除体验成员' };
  }

  /**
   * 获取发布后真实生效的服务器域名（wxa/get_effective_domain）。
   * 用于校验 modify_domain_directly 配置的域名是否已真实生效（含旧接口配置）。
   */
  async getEffectiveDomains(user: User, merchantId: string): Promise<{
    requestDomain: string[];
    uploadDomain: string[];
    downloadDomain: string[];
  }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/get_effective_domain', {}, 'access_token', authorizerToken));
    const list = (value: unknown) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    return {
      requestDomain: list(result.requestdomain),
      uploadDomain: list(result.uploaddomain),
      downloadDomain: list(result.downloaddomain),
    };
  }

  /** 回退线上版本（wxa/revertcoderelease）：将线上版本回退到上一个已发布版本（每次发布后有一次回退机会） */
  async revertRelease(user: User, merchantId: string): Promise<{ message: string }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/revertcoderelease', {}, 'access_token', authorizerToken));
    return { message: '已回退线上版本' };
  }

  /**
   * 确保第三方平台层的服务器域名已登记（wxa_server_domain，不含协议、分号分隔）。
   * 授权小程序只能请求平台层已登记的域名，缺了会整体网络错误。
   */
  private async ensurePlatformServerDomain(): Promise<void> {
    await this.ensurePlatformServerDomainFor(new URL(this.miniprogramApiBase()).hostname);
  }

  private async ensurePlatformServerDomainFor(hostname: string): Promise<void> {
    try {
      const componentAccessToken = await this.getComponentAccessToken();
      await this.wechatPost('https://api.weixin.qq.com/cgi-bin/component/modify_wxa_server_domain', {
        action: 'add',
        is_modify_published_together: true,
        wxa_server_domain: hostname,
      }, componentAccessToken);
    } catch (error) {
      // 平台层登记域名：已存在（85016/85017/85018/65316）视为成功；其他错误必须暴露，
      // 否则后续 wxa/modify_domain 会因域名未登记到第三方平台而失败
      const message = (error as Error).message || '';
      if (message.includes('85016') || message.includes('85017') || message.includes('85018') || message.includes('65316')) return;
      console.error(`[WECHAT] 第三方平台登记服务器域名失败: ${message}`);
      throw error;
    }
  }

  /**
   * 生成小程序码（用于代理商/商家端展示）。
   * 正式版已发布 → 生成正式小程序码；未发布但已上传代码 → 降级生成体验版二维码；
   * 未发布且未上传代码 → 返回空码 + not-released，由前端展示引导文案（不再抛 400 弹问题诊断）。
   */
  async createMiniProgramCode(user: User, merchantId: string): Promise<{ qrDataUrl: string; mode: 'official' | 'trial' | 'not-released' }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    const payload = { path: 'pages/home/index', width: 430 };
    try {
      const qr = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatGetBinaryWithAccessToken('https://api.weixin.qq.com/wxa/getwxacode', 'access_token', authorizerToken, payload));
      return { qrDataUrl: `data:${qr.contentType};base64,${qr.bytes.toString('base64')}`, mode: 'official' };
    } catch (error) {
      const message = (error as Error).message || '';
      // 43002 = 小程序尚未发布正式版本，微信不允许生成正式小程序码，此时降级为体验版二维码
      if (!message.includes('43002')) throw new BadGatewayException(message);
      const release = await this.releases.findOne({ where: { merchantId }, order: { createdAt: 'DESC' } });
      if (release && [
        WechatMiniprogramReleaseStatus.COMMITTED,
        WechatMiniprogramReleaseStatus.AUDIT_SUBMITTED,
        WechatMiniprogramReleaseStatus.AUDIT_APPROVED,
        WechatMiniprogramReleaseStatus.RELEASED,
      ].includes(release.status)) {
        try {
          const qr = await this.callWechat(merchantId, (authorizerToken) =>
            this.wechatGetBinaryWithAccessToken('https://api.weixin.qq.com/wxa/get_qrcode', 'access_token', authorizerToken, { path: 'pages/home/index' }));
          release.trialQrUrl = `data:${qr.contentType};base64,${qr.bytes.toString('base64')}`;
          release.errorMessage = '';
          await this.releases.save(release);
          return { qrDataUrl: release.trialQrUrl, mode: 'trial' };
        } catch (fallbackError) {
          // 体验版二维码生成失败不阻塞页面，记录原因并按"未发布未上传"展示引导
          release.errorMessage = `体验版二维码生成失败：${(fallbackError as Error).message}`;
          await this.releases.save(release);
        }
      }
      return { qrDataUrl: '', mode: 'not-released' };
    }
  }

  /**
   * 生成核销员微信绑定专用小程序码（顾客小程序绑定页）：
   * 用 wxacode.getUnlimited 生成带 scene 参数的正式小程序码，扫码直达顾客小程序绑定页。
   * scene 编码 staffId + bindToken（URL 安全 base64），页面解析后调绑定接口。
   */
  async createVerifierBindMiniProgramQr(merchantId: string, scene: string): Promise<string> {
    const authorizer = await this.authorizers.findOneBy({ merchantId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new BadRequestException('该商户尚未完成小程序授权');
    // scene 现在直接就是 bindToken（≤32 字符，满足 getwxacodeunlimit 限制）
    const payload = { scene, page: 'pkgSub/pages/verifier-bind/index', check_path: false, env_version: 'release' };
    try {
      const qr = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatGetBinaryWithAccessToken('https://api.weixin.qq.com/wxa/getwxacodeunlimit', 'access_token', authorizerToken, payload));
      return `data:${qr.contentType};base64,${qr.bytes.toString('base64')}`;
    } catch (error) {
      const message = (error as Error).message || '';
      // 43002 = 尚未发布正式版，此时用 get_qrcode（体验版二维码，page 需完整路径）。
      // bindToken 直接作为 query 参数（get_qrcode path 最多 128 字节，JSON 包装会超长）
      if (!message.includes('43002')) throw new BadGatewayException(message);
      const qr = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatGetBinaryWithAccessToken('https://api.weixin.qq.com/wxa/get_qrcode', 'access_token', authorizerToken, { path: `pkgSub/pages/verifier-bind/index?bindToken=${scene}` }));
      return `data:${qr.contentType};base64,${qr.bytes.toString('base64')}`;
    }
  }

  /**
   * 将代理商填写的头像/昵称/简介真实提交给微信官方。
   * 每个字段独立处理：昵称进审核（返回 audit_id）、头像/简介直接生效；
   * 任一字段失败不阻塞其他字段，结果逐字段返回。营业执照同时持久化到后端，供后续昵称修改复用。
   */
  async updateAccountProfile(
    user: User,
    merchantId: string,
    body: { nickname?: string; introduction?: string; avatarDataUrl?: string; subjectNature?: string; licenseDataUrl?: string; idCardDataUrl?: string },
  ): Promise<{
    results: Array<{ field: 'nickname' | 'avatar' | 'introduction'; ok: boolean; message: string; auditId?: number }>;
    licenseSaved: boolean;
  }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    await this.getAuthorizedAuthorizer(merchantId);
    const nickname = String(body.nickname || '').trim();
    const introduction = String(body.introduction || '').trim();
    const avatarDataUrl = String(body.avatarDataUrl || '').trim();
    const licenseDataUrl = String(body.licenseDataUrl || '').trim();
    const idCardDataUrl = String(body.idCardDataUrl || '').trim();
    const subjectNature = String(body.subjectNature || 'ENTERPRISE').trim();
    const results: Array<{ field: 'nickname' | 'avatar' | 'introduction'; ok: boolean; message: string; auditId?: number }> = [];

    if (avatarDataUrl) {
      try {
        const mediaId = await this.wechatUploadImage(merchantId, avatarDataUrl, '头像');
        await this.callWechat(merchantId, (authorizerToken) =>
          this.wechatPostWithAccessToken(
            'https://api.weixin.qq.com/cgi-bin/account/modifyheadimage',
            { head_img_media_id: mediaId, x1: '0', y1: '0', x2: '1', y2: '1' },
            'access_token', authorizerToken,
          ));
        results.push({ field: 'avatar', ok: true, message: '头像已提交微信生效' });
      } catch (error) {
        results.push({ field: 'avatar', ok: false, message: `头像提交失败：${(error as Error).message}` });
      }
    }

    if (nickname) {
      try {
        const payload: Record<string, unknown> = { nick_name: nickname };
        // 对齐微信官方 setnickname 口径：组织主体（含个体工商户，有营业执照）传 license；
        // 仅无营业执照的纯个人主体才传 id_card。个体工商户有营业执照，应走 license 分支。
        if (licenseDataUrl) {
          payload.license = await this.wechatUploadImage(merchantId, licenseDataUrl, '营业执照');
        } else if (subjectNature === 'INDIVIDUAL' && idCardDataUrl) {
          payload.id_card = await this.wechatUploadImage(merchantId, idCardDataUrl, '身份证');
        } else {
          throw new BadRequestException('修改昵称需提供营业执照（组织主体）或身份证（个人主体）照片');
        }
        const value = await this.callWechat(merchantId, (authorizerToken) =>
          this.wechatPostWithAccessToken(
            'https://api.weixin.qq.com/wxa/setnickname', payload,
            'access_token', authorizerToken,
          ));
        const auditId = typeof value.audit_id === 'number' ? value.audit_id : undefined;
        results.push({ field: 'nickname', ok: true, message: auditId ? `昵称已提交微信审核（审核单 ${auditId}）` : '昵称已设置成功', auditId });
      } catch (error) {
        results.push({ field: 'nickname', ok: false, message: `昵称提交失败：${(error as Error).message}` });
      }
    }

    if (introduction) {
      try {
        await this.callWechat(merchantId, (authorizerToken) =>
          this.wechatPostWithAccessToken(
            'https://api.weixin.qq.com/cgi-bin/account/modifysignature',
            { signature: introduction },
            'access_token', authorizerToken,
          ));
        results.push({ field: 'introduction', ok: true, message: '简介已提交微信生效' });
      } catch (error) {
        results.push({ field: 'introduction', ok: false, message: `简介提交失败：${(error as Error).message}` });
      }
    }

    if (!results.length) throw new BadRequestException('请至少提供头像、昵称或简介中的一项');

    // 持久化营业执照，刷新/换设备后仍可复用（用于后续昵称修改）
    let licenseSaved = false;
    const registration = await this.registration.findForMerchant(merchantId);
    if (registration) {
      if (licenseDataUrl) {
        registration.filingLicenseDataUrl = licenseDataUrl;
        licenseSaved = true;
      }
      const filing = this.parseFilingData(registration.filingDataJson);
      const previousProfile = filing._accountProfile && typeof filing._accountProfile === 'object' && !Array.isArray(filing._accountProfile)
        ? filing._accountProfile as Record<string, unknown>
        : {};
      const profile = { ...previousProfile };
      for (const result of results) {
        profile[result.field] = result.ok
          ? result.field === 'nickname' && result.auditId
            ? { status: 'PROCESSING', auditId: result.auditId, message: result.message }
            : { status: 'COMPLETE', message: result.message }
          : { status: 'FAILED', message: result.message };
      }
      profile.updatedAt = new Date().toISOString();
      filing._accountProfile = profile;
      registration.filingDataJson = JSON.stringify(filing);
      await this.dataSource.getRepository(MerchantRegistration).save(registration);
    }
    return { results, licenseSaved };
  }

  /**
   * 持久化备案资料草稿到后端（整份备案表单 JSON），刷新/换设备不丢失。
   * 同时把营业执照同步到 filingLicenseDataUrl，供昵称修改提交微信时复用。
   */
  async updateFilingData(user: User, merchantId: string, filingData: Record<string, unknown>): Promise<{ saved: boolean }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const registrations = this.dataSource.getRepository(MerchantRegistration);
    let registration = await registrations.findOneBy({ merchantId });
    if (!registration) {
      registration = await registrations.save({
        merchantId,
        status: MerchantRegistrationStatus.DRAFT,
        note: '',
        failureReason: '',
        publicationEntitlementStatus: PublicationEntitlementStatus.NONE,
        filingDataJson: '{}',
        filingLicenseDataUrl: '',
      });
    }
    const existingFiling = this.parseFilingData(registration.filingDataJson);
    const cleaned = this.sanitizeFilingData(filingData);
    for (const internalKey of ['_fastRegister', '_accountProfile', '_categories', '_certification', '_icpEntranceInfo', '_wechatVerify']) {
      if (existingFiling[internalKey] !== undefined) cleaned[internalKey] = existingFiling[internalKey];
    }
    registration.filingDataJson = JSON.stringify(cleaned);
    const certificateFront = typeof cleaned.certificateFront === 'string' ? cleaned.certificateFront : '';
    if (certificateFront) registration.filingLicenseDataUrl = certificateFront;
    await registrations.save(registration);
    await this.auditWriter.write(user.id, merchantId, 'MERCHANT_FILING_DATA_SAVED', 'MerchantRegistration', registration.id, null, { fieldCount: Object.keys(cleaned).length });
    return { saved: true };
  }

  private parseFilingData(json: string | undefined): Record<string, unknown> {
    if (!json) return {};
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  private sanitizeFilingData(value: Record<string, unknown>): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const allowed = new Set([
      'subjectNature', 'subjectName', 'filingRegion', 'communicationAddress',
      'certificateType', 'certificateNo', 'certificateAddress', 'certificateStartAt', 'certificateEndAt',
      'certificateFront', 'certificateBack',
      'responsibleName', 'responsiblePhone', 'responsibleEmail', 'emergencyContact',
      'verifyContactEmail',
      'responsibleIdType', 'responsibleIdNo', 'responsibleIdStartAt', 'responsibleIdEndAt',
      'responsibleFront', 'responsibleBack',
      'serviceContentType', 'serviceDescription', 'serviceDescription2',
      'approvalType', 'approvalNo', 'approvalMaterial', 'businessCategory',
      'authorizationLetter',
      // 小程序负责人（=小程序管理员）信息：独立于主体负责人，微信备案 icp_applets.principal_info 必填
      'appletPrincipalName', 'appletPrincipalPhone', 'appletPrincipalEmail', 'appletPrincipalEmergency',
      'appletPrincipalIdNo', 'appletPrincipalIdStartAt', 'appletPrincipalIdEndAt',
      'appletPrincipalFront', 'appletPrincipalBack',
      // icp_materials 其他备案媒体材料（微信官方字段，COS URL，附件类可逗号分隔多个）
      'commitmentLetter', 'businessNameChangeLetter', 'partyBuildingConfirmationLetter', 'promiseVideo',
      'authenticityResponsibilityLetter', 'authenticityCommitmentLetter', 'websiteConstructionProposal',
      'subjectOtherMaterials', 'appletsOtherMaterials', 'holdingCertificatePhoto',
      // 系统内部保存的微信事实证据；外部请求不能覆盖这些字段，合并时沿用数据库原值
      '_fastRegister', '_accountProfile', '_categories', '_certification', '_icpEntranceInfo', '_wechatVerify',
    ]);
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (!allowed.has(key)) continue;
      if (typeof val === 'string') {
        // 图片 data URL 允许较大体积，普通文本按 4KB 截断
        if (key.endsWith('Front') || key.endsWith('Back') || key === 'certificateFront' || key === 'certificateBack') {
          if (val.length <= 4 * 1024 * 1024) result[key] = val;
        } else if (val.length <= 4096) {
          result[key] = val;
        }
      } else if (Array.isArray(val)) {
        result[key] = val.filter((item) => typeof item === 'string' && item.length <= 200).slice(0, 20);
      }
    }
    return result;
  }

  /**
   * 顾客手机号换取：小程序端 getPhoneNumber 返回 code 后，
   * 用该小程序（商家授权）的 authorizer_access_token 调微信 getuserphonenumber。
   * H6：appId 必传（调用链 customer-auth 已从 X-MiniProgram-AppId 头取值），缺失直接拒绝，
   * 禁止静默回退"首个已授权商家"造成跨租户 token 误用。
   */
  async exchangeCustomerPhone(code: string, appId?: string): Promise<string> {
    if (!appId) throw new BadRequestException('缺少小程序 APPID，无法定位商家换取手机号');
    const authorizer = await this.authorizers.findOneBy({ authorizerAppId: appId, status: WechatAuthorizerStatus.AUTHORIZED });
    if (!authorizer) throw new ServiceUnavailableException('该小程序尚未授权，无法获取手机号');
    const merchantId = authorizer.merchantId;

    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken(
        'https://api.weixin.qq.com/wxa/business/getuserphonenumber',
        { code },
        'access_token',
        authorizerToken,
      ));
    const phoneInfo = this.responseObject(result, 'phone_info');
    const purePhone = this.optionalResponseString(phoneInfo, 'purePhoneNumber', 5, 20);
    if (!purePhone) throw new ServiceUnavailableException('手机号获取失败，请重试');
    return purePhone;
  }

  /** H5：authorizer token 刷新 single-flight——同商户并发刷新只执行一次，防止 refresh_token 轮换冲突（40001） */
  private readonly authorizerTokenRefreshes = new Map<string, Promise<string>>();

  private async getAuthorizerAccessToken(merchantId: string): Promise<string> {
    const authorizer = await this.authorizers.createQueryBuilder('authorizer')
      .addSelect(['authorizer.refreshTokenCiphertext', 'authorizer.accessTokenCiphertext'])
      .where('authorizer.merchantId = :merchantId', { merchantId })
      .getOne();
    if (!authorizer || authorizer.status !== WechatAuthorizerStatus.AUTHORIZED || authorizer.revokedAt) throw new BadRequestException('该商户尚未完成微信小程序授权，不能发起微信官方人脸核身');
    if (authorizer.accessTokenCiphertext && authorizer.accessTokenExpiresAt && authorizer.accessTokenExpiresAt.getTime() > Date.now() + 300_000) {
      return this.sensitiveData.decrypt(authorizer.accessTokenCiphertext);
    }
    const inflight = this.authorizerTokenRefreshes.get(merchantId);
    if (inflight) return inflight;
    const promise = this.refreshAuthorizerAccessTokenInner(merchantId).finally(() => this.authorizerTokenRefreshes.delete(merchantId));
    this.authorizerTokenRefreshes.set(merchantId, promise);
    return promise;
  }

  private async refreshAuthorizerAccessTokenInner(merchantId: string): Promise<string> {
    const authorizer = await this.authorizers.createQueryBuilder('authorizer')
      .addSelect(['authorizer.refreshTokenCiphertext', 'authorizer.accessTokenCiphertext'])
      .where('authorizer.merchantId = :merchantId', { merchantId })
      .getOne();
    if (!authorizer || authorizer.status !== WechatAuthorizerStatus.AUTHORIZED || authorizer.revokedAt) throw new BadRequestException('该商户尚未完成微信小程序授权');
    const componentAccessToken = await this.getComponentAccessToken();
    const componentAppId = this.required('WECHAT_COMPONENT_APP_ID');
    const refreshToken = this.sensitiveData.decrypt(authorizer.refreshTokenCiphertext);
    let result: WechatApiResponse;
    try {
      result = await this.wechatPost('https://api.weixin.qq.com/cgi-bin/component/api_authorizer_token', {
        component_appid: componentAppId,
        authorizer_appid: authorizer.authorizerAppId,
        authorizer_refresh_token: refreshToken,
      }, componentAccessToken);
    } catch (error) {
      const message = (error as Error).message || '';
      // 40001 在 api_authorizer_token 场景下表示 refresh_token 已失效（过期或授权被撤销），
      // 此时重试无意义，给出明确引导而非裸 502。
      if (message.includes('40001')) {
        throw new BadRequestException('微信小程序授权已失效（refresh_token 过期或授权被撤销），请为该商户重新发起小程序授权');
      }
      throw error;
    }
    const accessToken = this.responseString(result, 'authorizer_access_token', 16, 2048);
    const nextRefreshToken = this.optionalResponseString(result, 'authorizer_refresh_token', 16, 2048);
    const expiresIn = this.responseSeconds(result, 'expires_in', 300, 7200);
    authorizer.accessTokenCiphertext = this.sensitiveData.encrypt(accessToken);
    authorizer.accessTokenExpiresAt = new Date(Date.now() + Math.max(60, expiresIn - 300) * 1000);
    if (nextRefreshToken) authorizer.refreshTokenCiphertext = this.sensitiveData.encrypt(nextRefreshToken);
    await this.authorizers.save(authorizer);
    return accessToken;
  }

  /** 强制清除并换新 authorizer access token（微信侧 40001 表示 token 已失效时用） */
  private async refreshAuthorizerToken(merchantId: string): Promise<string> {
    const authorizer = await this.getAuthorizedAuthorizer(merchantId);
    authorizer.accessTokenCiphertext = '';
    authorizer.accessTokenExpiresAt = null;
    await this.authorizers.save(authorizer);
    return this.getAuthorizerAccessToken(merchantId);
  }

  /**
   * 用 authorizer token 调微信接口；若遇 40001（access_token invalid or not latest），
   * 强制刷新后重试一次。避免缓存 token 被微信提前作废导致的间歇性失败。
   */
  private async callWechat<T>(merchantId: string, call: (token: string) => Promise<T>): Promise<T> {    const firstToken = await this.getAuthorizerAccessToken(merchantId);
    try {
      return await call(firstToken);
    } catch (error) {
      const message = (error as Error).message || '';
      if (!message.includes('40001')) throw error;
      const refreshed = await this.refreshAuthorizerToken(merchantId);
      return call(refreshed);
    }
  }

  private loadComponentState(): Promise<WechatComponentState | null> {
    return this.componentStates.createQueryBuilder('state')
      .addSelect(['state.verifyTicketCiphertext', 'state.accessTokenCiphertext'])
      .where('state.id = :id', { id: 'component' })
      .getOne();
  }

  private async wechatGetJsonWithAccessToken(urlValue: string, tokenName: 'component_access_token' | 'access_token', accessToken: string): Promise<WechatApiResponse> {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.hostname !== 'api.weixin.qq.com') throw new ServiceUnavailableException('微信开放平台接口地址配置错误');
    url.searchParams.set(tokenName, accessToken);
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接微信开放平台，请稍后重试');
    }
    const text = await response.text();
    let value: WechatApiResponse;
    try { value = JSON.parse(text) as WechatApiResponse; }
    catch { throw new BadGatewayException('微信开放平台响应格式错误'); }
    if (typeof value.errcode === 'number' && value.errcode !== 0) {
      const errmsg = typeof value.errmsg === 'string' && value.errmsg ? `：${value.errmsg}` : '';
      throw new BadGatewayException(`微信开放平台返回错误（${value.errcode}）${errmsg}`);
    }
    return value;
  }

  private async wechatPost(urlValue: string, body: Record<string, unknown>, componentAccessToken?: string): Promise<WechatApiResponse> {
    return this.wechatPostWithAccessToken(urlValue, body, 'component_access_token', componentAccessToken);
  }

  private async wechatPostWithAccessToken(urlValue: string, body: Record<string, unknown>, tokenName: 'component_access_token' | 'access_token', accessToken?: string): Promise<WechatApiResponse> {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.hostname !== 'api.weixin.qq.com') throw new ServiceUnavailableException('微信开放平台接口地址配置错误');
    if (accessToken) url.searchParams.set(tokenName, accessToken);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接微信开放平台，请稍后重试');
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new BadGatewayException('微信开放平台响应过大');
    let value: WechatApiResponse;
    try { value = JSON.parse(text) as WechatApiResponse; }
    catch { throw new BadGatewayException('微信开放平台响应格式错误'); }
    if (!response.ok) throw new BadGatewayException(`微信开放平台请求失败（HTTP ${response.status}）`);
    if (typeof value.errcode === 'number' && value.errcode !== 0) {
      const errmsg = typeof value.errmsg === 'string' && value.errmsg ? `：${value.errmsg}` : '';
      throw new BadGatewayException(`微信开放平台返回错误（${value.errcode}）${errmsg}`);
    }
    return value;
  }

  private async wechatGetBinaryWithAccessToken(urlValue: string, tokenName: 'component_access_token' | 'access_token', accessToken: string, params: Record<string, string | number | boolean>): Promise<{ contentType: string; bytes: Buffer }> {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.hostname !== 'api.weixin.qq.com') throw new ServiceUnavailableException('微信开放平台接口地址配置错误');
    url.searchParams.set(tokenName, accessToken);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接微信开放平台，请稍后重试');
    }
    if (!response.ok) throw new BadGatewayException(`微信开放平台请求失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024) throw new BadGatewayException('微信开放平台二维码响应过大');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (contentType.includes('application/json')) {
      let value: WechatApiResponse;
      try { value = JSON.parse(bytes.toString('utf8')) as WechatApiResponse; }
      catch { throw new BadGatewayException('微信开放平台响应格式错误'); }
      if (typeof value.errcode === 'number' && value.errcode !== 0) throw new BadGatewayException(`微信开放平台返回错误（${value.errcode}）`);
      throw new BadGatewayException('微信开放平台未返回体验码图片');
    }
    return { contentType, bytes };
  }

  /** 解析 data URL 图片，校验格式（JPG/PNG/WebP/GIF/BMP）与大小（≤2MB） */
  private decodeImageDataUrl(dataUrl: string, label: string): { contentType: string; bytes: Buffer } {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(String(dataUrl || '').trim());
    if (!match) throw new BadRequestException(`${label}数据格式无效`);
    const contentType = match[1].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'].includes(contentType)) {
      throw new BadRequestException(`${label}仅支持 JPG/PNG/WebP/GIF/BMP 格式`);
    }
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length) throw new BadRequestException(`${label}图片内容为空`);
    if (bytes.length > 2 * 1024 * 1024) throw new BadRequestException(`${label}图片不能超过 2MB`);
    return { contentType, bytes };
  }

  /**
   * 上传临时图片素材到微信并返回 media_id。
   * 必须使用 authorizer_access_token 上传，否则微信报 40007 invalid media_id。
   */
  private async wechatUploadImage(merchantId: string, imageSource: string, label: string): Promise<string> {
    // 兼容 data URL（旧头像）与 COS 图片链接（备案照片/证件）：先取字节再上传微信。
    // FIX: 与 uploadIcpMedia 同源问题——COS 私有桶签名 URL 过期后裸 fetch 必 403，这里同样先重新签发。
    // FIX(2026-08-09)：代理相对路径（filingProxyUrl）同样支持——提取 objectKey 重新签名下载，与 uploadIcpMedia 一致。
    let contentType: string;
    let bytes: Buffer;
    const source = String(imageSource || '').trim();
    let downloadUrl: string | null = null;
    if (/^https?:\/\//i.test(source)) {
      downloadUrl = await this.resolveCosSignedUrl(source, label);
    } else if (source.startsWith('/api/v1/merchants/')) {
      try {
        const proxyUrl = new URL(source, 'https://example.com');
        const objectKey = proxyUrl.searchParams.get('key');
        if (objectKey) downloadUrl = await this.appConfig.createPrivateFileAccessUrl('', decodeURIComponent(objectKey));
      } catch {
        downloadUrl = null;
      }
    }
    if (downloadUrl) {
      let response: Response;
      try {
        response = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new BadRequestException(`${label}图片地址无法访问`);
      }
      if (!response.ok) throw new BadRequestException(`${label}图片地址无法访问（HTTP ${response.status}）`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new BadRequestException(`${label}图片内容为空`);
      if (bytes.length > 2 * 1024 * 1024) throw new BadRequestException(`${label}图片不能超过 2MB`);
      contentType = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0].toLowerCase();
    } else {
      const decoded = this.decodeImageDataUrl(source, label);
      contentType = decoded.contentType;
      bytes = decoded.bytes;
    }
    const extension: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
    const upload = async (authorizerToken: string): Promise<WechatApiResponse> => {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/media/upload');
      url.searchParams.set('access_token', authorizerToken);
      url.searchParams.set('type', 'image');
      const form = new FormData();
      form.append('media', new Blob([new Uint8Array(bytes)], { type: contentType }), `upload.${extension[contentType] || 'jpg'}`);
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new ServiceUnavailableException('暂时无法连接微信开放平台，请稍后重试');
      }
      const text = await response.text();
      let value: WechatApiResponse;
      try { value = JSON.parse(text) as WechatApiResponse; }
      catch { throw new BadGatewayException('微信开放平台响应格式错误'); }
      if (typeof value.errcode === 'number' && value.errcode !== 0) {
        const errmsg = typeof value.errmsg === 'string' && value.errmsg ? `：${value.errmsg}` : '';
        throw new BadGatewayException(`微信上传${label}失败（${value.errcode}）${errmsg}`);
      }
      return value;
    };
    const result = await this.callWechat(merchantId, upload);
    return this.responseString(result, 'media_id', 5, 256);
  }

  private async getAuthorizedAuthorizer(merchantId: string): Promise<WechatAuthorizer> {
    const authorizer = await this.authorizers.findOneBy({ merchantId });
    if (!authorizer || authorizer.status !== WechatAuthorizerStatus.AUTHORIZED || authorizer.revokedAt) {
      throw new BadRequestException('该商户尚未完成微信小程序授权');
    }
    return authorizer;
  }

  private async getReleaseForUser(merchantId: string, releaseId?: string): Promise<WechatMiniprogramRelease> {
    const release = releaseId
      ? await this.releases.findOneBy({ id: releaseId, merchantId })
      : await this.releases.findOne({ where: { merchantId }, order: { createdAt: 'DESC' } });
    if (!release) throw new BadRequestException('尚未创建小程序发布版本，请先上传代码');
    return release;
  }

  private buildExtJson(merchantId: string, authorizerAppId: string): Record<string, unknown> {
    return {
      extEnable: true,
      extAppid: authorizerAppId,
      ext: {
        tenantCode: merchantId,
        merchantId,
        apiBase: this.miniprogramApiBase(),
      },
    };
  }

  private miniprogramApiBase(): string {
    const configured = this.value('MINIPROGRAM_API_BASE');
    if (configured) return configured.replace(/\/$/, '');
    const base = this.value('PUBLIC_BASE_URL').replace(/\/$/, '');
    if (!base) throw new ServiceUnavailableException('请配置 PUBLIC_BASE_URL 或 MINIPROGRAM_API_BASE');
    return `${base}/api/v1`;
  }

  private safeVersion(value: string): string {
    const version = String(value || '').trim();
    if (!/^[0-9A-Za-z._-]{1,64}$/.test(version)) throw new BadRequestException('版本号只能包含字母、数字、点、下划线和短横线，最长 64 位');
    return version;
  }

  private defaultUserVersion(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  private async recordReleaseJob(user: User, release: WechatMiniprogramRelease, type: WechatMiniprogramReleaseJobType, status: WechatMiniprogramReleaseJobStatus, payload: Record<string, unknown>, result: Record<string, unknown>, errorMessage = '') {
    await this.releaseJobs.save({
      merchantId: release.merchantId,
      releaseId: release.id,
      type,
      status,
      payload,
      result,
      errorMessage,
      requestedBy: user.id,
    });
  }

  private async releaseWithJobs(release: WechatMiniprogramRelease) {
    const jobs = await this.releaseJobs.find({ where: { releaseId: release.id }, order: { createdAt: 'DESC' }, take: 20 });
    return { ...this.releaseSummary(release), jobs: jobs.map((job) => this.releaseJobSummary(job)) };
  }

  private releaseSummary(release: WechatMiniprogramRelease) {
    return {
      id: release.id,
      merchantId: release.merchantId,
      authorizerAppId: this.maskIdentifier(release.authorizerAppId),
      templateId: release.templateId,
      userVersion: release.userVersion,
      userDesc: release.userDesc,
      extJson: release.extJson,
      status: release.status,
      auditId: release.auditId,
      trialQrUrl: release.trialQrUrl,
      errorMessage: release.errorMessage,
      createdAt: release.createdAt,
      updatedAt: release.updatedAt,
    };
  }

  private releaseJobSummary(job: WechatMiniprogramReleaseJob) {
    return {
      id: job.id,
      releaseId: job.releaseId,
      type: job.type,
      status: job.status,
      payload: job.payload,
      result: job.result,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
    };
  }

  /** 获取微信服务类目列表（模拟授权时返回常用类目） */
  async getCategoryList(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    try {
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/cgi-bin/wxopen/getallcategories', {}, 'access_token', authorizerToken));
      // 微信真实返回：categories_list.categories，数组内 id/name/level/father/children
      const list = (result.categories_list as { categories?: unknown } | undefined)?.categories;
      if (!Array.isArray(list)) throw new BadGatewayException('微信类目列表格式错误');
      const raw = list as Array<{ id: number; name: string; level: number; father: number; children?: number[] }>;
      // 一级类目：level===1；二级类目：level===2 且 father 指向一级
      const firstLevel = raw.filter((item) => item.level === 1 && item.id > 0);
      return firstLevel.map((first) => ({
        id: first.id,
        name: first.name || '',
        children: (first.children || [])
          .map((childId) => raw.find((item) => item.id === childId && item.level === 2))
          .filter((item): item is { id: number; name: string; level: number; father: number; children?: number[] } => Boolean(item))
          .map((item) => ({ id: item.id, name: item.name || '' })),
      }));
    } catch (error) {
      console.log('[WECHAT_CATEGORIES] 拉取真实类目失败:', (error as Error).message);
      return this.mockCategories();
    }
  }

  /** 设置微信服务类目（模拟授权时直接返回成功） */
  async setCategories(user: User, merchantId: string, categories: Array<{ firstId: number; secondId: number; certificates?: string[] }>) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    if (!Array.isArray(categories) || categories.length === 0) throw new BadRequestException('请至少选择一个服务类目');
    try {
      const body = { categories: categories.map((c) => ({ first: c.firstId, second: c.secondId, cert_list: (c.certificates || []).map((v) => ({ key: '1', value: v })) })) };
      const result = await this.callWechat(merchantId, (authorizerToken) =>
        this.wechatPostWithAccessToken('https://api.weixin.qq.com/cgi-bin/wxopen/addcategory', body, 'access_token', authorizerToken));
      const registration = await this.registration.findForMerchant(merchantId);
      if (registration) {
        const filing = this.parseFilingData(registration.filingDataJson);
        filing._categories = {
          savedCount: categories.length,
          targetCategories: categories.map((category) => ({ firstId: category.firstId, secondId: category.secondId })),
          updatedAt: new Date().toISOString(),
        };
        registration.filingDataJson = JSON.stringify(filing);
        await this.dataSource.getRepository(MerchantRegistration).save(registration);
      }
      return { saved: true, wechat: result };
    } catch (error) {
      // 不再静默降级"模拟环境"，避免商家以为已保存实则没保存
      const message = (error as Error).message || '';
      console.log('[WECHAT_CATEGORIES] 设置类目失败:', message);
      if (message.includes('53302')) {
        throw new BadRequestException('该类目当前小程序主体/认证状态不允许设置。如未完成微信认证，多数商业类目不可用；请先完成微信认证，或选择其他允许的类目（如已生效的 生活服务/丽人服务）。');
      }
      throw error;
    }
  }

  /**
   * 配置小程序用户隐私保护指引（setprivacysetting）。
   * 授权给第三方平台代开发的小程序无法在小程序后台自行配置隐私指引，必须由平台通过接口配置。
   * setting_list 每项含 privacy_key（用户信息类型）与 privacy_text（收集用途说明）。
   * privacy_ver=2（开发版），配置后需重新提交代码审核并在发布后才对现网生效。
   * owner_setting.notice_method 为微信必填项（信息变动通知方式），默认"通过弹窗"。
   */
  async setPrivacySetting(user: User, merchantId: string, settingList: Array<{ privacyKey: string; privacyText: string }>, contactEmail?: string, noticeMethod?: string, storeExpireTimestamp?: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    if (!Array.isArray(settingList) || settingList.length === 0) throw new BadRequestException('请至少提供一项隐私用途说明');
    const ownerSetting: Record<string, unknown> = {
      notice_method: noticeMethod?.trim() || '通过弹窗',
    };
    if (contactEmail?.trim()) ownerSetting.contact_email = contactEmail.trim();
    if (storeExpireTimestamp?.trim()) ownerSetting.store_expire_timestamp = storeExpireTimestamp.trim();
    const body: Record<string, unknown> = {
      owner_setting: ownerSetting,
      setting_list: settingList.map((item) => ({ privacy_key: item.privacyKey, privacy_text: item.privacyText })),
      privacy_ver: 2,
    };
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/cgi-bin/component/setprivacysetting', body, 'access_token', authorizerToken));
    return { saved: true, wechat: result };
  }

  /** 查询当前小程序用户隐私保护指引（getprivacysetting），用于核对配置是否生效 */
  async getPrivacySetting(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/cgi-bin/component/getprivacysetting', {}, 'access_token', authorizerToken));
    return result;
  }

  /** 获取商家小程序已设置的类目（getcategory），用于同步小程序审核时回填真实类目 */
  async getSavedCategories(user: User, merchantId: string) {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/cgi-bin/wxopen/getcategory', {}, 'access_token', authorizerToken));
    // 微信真实返回：categories 数组，字段为 first/first_name/second/second_name
    const list = Array.isArray(result.categories) ? result.categories as Array<{ first: number; first_name: string; second: number; second_name: string; audit_status?: number }> : [];
    return list
      .filter((item) => item.first && item.second)
      .map((item) => ({ firstId: item.first, firstClass: item.first_name || '', secondId: item.second, secondClass: item.second_name || '', auditStatus: item.audit_status ?? null }));
  }

  /** 查询小程序微信认证状态（getaccountbasicinfo），用于代理商端认证状态引导 */
  async getVerifyStatus(user: User, merchantId: string): Promise<{
    verified: boolean;
    namingVerified: boolean;
    principalName: string;
    accountType: number;
    annualReview: boolean;
    annualReviewBeginAt: number | null;
    annualReviewEndAt: number | null;
  }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const result = await this.callWechat(merchantId, (authorizerToken) =>
      this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/cgi-bin/account/getaccountbasicinfo', 'access_token', authorizerToken));
    const verifyInfo = result.wx_verify_info && typeof result.wx_verify_info === 'object' && !Array.isArray(result.wx_verify_info)
      ? result.wx_verify_info as Record<string, unknown>
      : {};
    // 按微信官方 getaccountbasicinfo 文档：qualification_verify=是否资质认证（认证状态判定依据），
    // naming_verify=名称认证，annual_review+年审起止时间=是否需要年审（超过截止时间未年审则认证过期）
    return {
      verified: Boolean(verifyInfo.qualification_verify),
      namingVerified: Boolean(verifyInfo.naming_verify),
      principalName: typeof result.principal_name === 'string' ? result.principal_name : '',
      accountType: typeof result.account_type === 'number' ? result.account_type : 0,
      annualReview: Boolean(verifyInfo.annual_review),
      annualReviewBeginAt: typeof verifyInfo.annual_review_begin_time === 'number' ? verifyInfo.annual_review_begin_time : null,
      annualReviewEndAt: typeof verifyInfo.annual_review_end_time === 'number' ? verifyInfo.annual_review_end_time : null,
    };
  }

  /**
   * 代发起微信认证（wxa/sec/wxaauth，权限集 18）。
   * 字段全部取自已保存的备案资料：主体性质 → customer_type（1 企业 / 12 个体工商户）、
   * 负责人信息 → contact_info、营业执照 → qualification（media_id 一次性，每次重新上传）。
   * 支付采用商家自付（pay_type=2），微信按 customer_type 定价（个体 30 元 / 企业 300 元）。
   * 返回 auth_url 由前端渲染二维码，商家管理员扫码在微信内完成授权与支付。
   */
  async createWechatVerify(user: User, merchantId: string, body: { payType?: number } = {}): Promise<{
    taskid: string; authUrl: string; feeFen: number; customerType: number; expiresAt: string;
  }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    await this.getAuthorizedAuthorizer(merchantId);
    const registration = await this.registration.findForMerchant(merchantId);
    const filing = this.parseFilingData(registration?.filingDataJson);
    const existing = this.wechatVerifyRecord(filing);
    if (existing && typeof existing.taskid === 'string' && existing.applyStatus !== 3) {
      throw new BadRequestException('已有进行中的认证任务，请刷新进度查看。若已超时 24 小时可重新发起。');
    }
    const payType = body.payType === 1 ? 1 : 2;
    const customerType = String(filing.subjectNature || '').toUpperCase() === 'INDIVIDUAL' ? 12 : 1;
    const feeFen = customerType === 12 ? 3000 : 30000;
    // contact_info.email 为微信必填，取认证联系人邮箱（新字段）或小程序负责人邮箱
    const contactName = String(filing.responsibleName || '').trim();
    const contactEmail = String(filing.verifyContactEmail || filing.appletPrincipalEmail || filing.responsibleEmail || '').trim();
    if (!contactName) throw new BadRequestException('请先在备案资料中填写主体负责人姓名。');
    if (!contactEmail) throw new BadRequestException('请先填写认证联系人邮箱（微信认证审核沟通必填）。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new BadRequestException('认证联系人邮箱格式不正确。');
    if (!filing.certificateFront) throw new BadRequestException('请先上传营业执照。');
    const accountName = String(filing.subjectName || '').trim();
    if (!accountName) throw new BadRequestException('请先填写主体名称（用于小程序账号命名）。');

    const result = await this.submitWechatVerifyRequest(merchantId, {
      customer_type: customerType,
      contact_info: { name: contactName, email: contactEmail },
      account_name: accountName,
      account_name_type: 1,
      pay_type: payType,
      third_party_phone: this.value('WECHAT_COMPONENT_CONTACT_PHONE') || '',
      invoice_info: { invoice_type: 1 },
    }, filing);
    const taskid = this.responseString(result, 'taskid', 8, 128);
    const authUrl = this.responseString(result, 'auth_url', 8, 2048);
    await this.saveWechatVerifyEvidence(merchantId, {
      taskid, authUrl, payType, customerType, feeFen,
      taskStatus: 0, applyStatus: 0, orderId: null,
      refillReason: '', failReason: '', submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_VERIFY_STARTED', 'MerchantRegistration', registration?.id || '', null, { taskid, payType, customerType });
    return { taskid, authUrl, feeFen, customerType, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  }

  /** 查询认证任务进度（wxa/sec/queryauth），并把真实状态同步回 _wechatVerify / _certification */
  async queryWechatVerify(user: User, merchantId: string): Promise<WechatVerifyStatus> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const registration = await this.registration.findForMerchant(merchantId);
    const filing = this.parseFilingData(registration?.filingDataJson);
    const record = this.wechatVerifyRecord(filing);
    if (!record || typeof record.taskid !== 'string') throw new BadRequestException('尚未发起微信认证，请先发起认证。');
    const result = await this.callWechat(merchantId, (token) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/sec/queryauth', { taskid: record.taskid }, 'access_token', token));
    const taskStatus = this.responseInteger(result, 'task_status', 0, 15);
    const applyStatus = this.responseInteger(result, 'apply_status', 0, 5);
    const orderId = typeof result.orderid === 'number' ? result.orderid : null;
    const authUrl = this.optionalResponseString(result, 'auth_url', 8, 2048) || String(record.authUrl || '');
    const refillReason = this.optionalResponseString(result, 'refill_reason', 0, 2048);
    const failReason = this.optionalResponseString(result, 'fail_reason', 0, 2048);
    await this.saveWechatVerifyEvidence(merchantId, {
      ...record, taskStatus, applyStatus, orderId, authUrl, refillReason, failReason,
      updatedAt: new Date().toISOString(),
    });
    if (applyStatus === 4) {
      await this.syncCertificationEvidence(merchantId, 'APPROVED');
    }
    return this.wechatVerifyStatusOf(record, taskStatus, applyStatus, orderId, authUrl, refillReason, failReason);
  }

  /** 打回重填后重新提审（wxaauth + taskid + reauth）；微信官方：打回重填不重复收费 */
  async reauthWechatVerify(user: User, merchantId: string): Promise<{ taskid: string; authUrl: string; feeFen: number; customerType: number; expiresAt: string }> {
    await this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES);
    const registration = await this.registration.findForMerchant(merchantId);
    const filing = this.parseFilingData(registration?.filingDataJson);
    const record = this.wechatVerifyRecord(filing);
    if (!record || typeof record.taskid !== 'string') throw new BadRequestException('尚未发起微信认证，请先发起认证。');
    if (record.applyStatus !== 3) throw new BadRequestException('仅被打回重填的认证单才能重新提审。');
    if (record.taskStatus === 1 || record.taskStatus === 2) throw new BadRequestException('认证任务已超时或被拒绝，请重新发起认证。');
    const contactName = String(filing.responsibleName || '').trim();
    const contactEmail = String(filing.verifyContactEmail || filing.appletPrincipalEmail || filing.responsibleEmail || '').trim();
    if (!contactName || !contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new BadRequestException('请先补全主体负责人姓名与认证联系人邮箱。');
    const customerType = String(filing.subjectNature || '').toUpperCase() === 'INDIVIDUAL' ? 12 : 1;
    const feeFen = customerType === 12 ? 3000 : 30000;
    const accountName = String(filing.subjectName || '').trim();
    if (!accountName) throw new BadRequestException('请先填写主体名称。');
    const result = await this.submitWechatVerifyRequest(merchantId, {
      taskid: record.taskid,
      customer_type: customerType,
      contact_info: { name: contactName, email: contactEmail },
      account_name: accountName,
      account_name_type: 1,
      pay_type: typeof record.payType === 'number' && record.payType === 1 ? 1 : 2,
      third_party_phone: this.value('WECHAT_COMPONENT_CONTACT_PHONE') || '',
      invoice_info: { invoice_type: 1 },
      reauth: true,
    }, filing);
    const taskid = this.responseString(result, 'taskid', 8, 128);
    const authUrl = this.responseString(result, 'auth_url', 8, 2048);
    await this.saveWechatVerifyEvidence(merchantId, {
      ...record, taskid, authUrl, taskStatus: 0, applyStatus: 2, refillReason: '',
      updatedAt: new Date().toISOString(),
    });
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_VERIFY_REAUTH_SUBMITTED', 'MerchantRegistration', registration?.id || '', null, { taskid });
    return { taskid, authUrl, feeFen, customerType, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  }

  /** 组装并调用 wxaauth：上传营业执照 media_id 后提交认证申请 */
  private async submitWechatVerifyRequest(merchantId: string, authData: Record<string, unknown>, filing: Record<string, unknown>): Promise<WechatApiResponse> {
    const qualification = await this.uploadIcpMedia(merchantId, String(filing.certificateFront || ''), '营业执照', 'wechat_verify.qualification', 1);
    const payload: Record<string, unknown> = { ...authData };
    payload.qualification = qualification;
    return this.callWechat(merchantId, (token) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/sec/wxaauth', payload, 'access_token', token));
  }

  /** 认证任务证据统一写入口：只更新 filingData._wechatVerify（过程证据），不改七步业务状态 */
  private async saveWechatVerifyEvidence(merchantId: string, evidence: Record<string, unknown>): Promise<void> {
    const registration = await this.registration.findForMerchant(merchantId);
    if (!registration) throw new BadRequestException('商户注册信息不存在');
    const filing = this.parseFilingData(registration.filingDataJson);
    filing._wechatVerify = evidence;
    registration.filingDataJson = JSON.stringify(filing);
    await this.dataSource.getRepository(MerchantRegistration).save(registration);
  }

  /** 认证最终结果写回 _certification（真实事实），供七步状态机与备案门槛消费 */
  private async syncCertificationEvidence(merchantId: string, status: 'APPROVED' | 'ACTION_REQUIRED'): Promise<void> {
    const registration = await this.registration.findForMerchant(merchantId);
    if (!registration) return;
    const filing = this.parseFilingData(registration.filingDataJson);
    filing._certification = { status, updatedAt: new Date().toISOString() };
    registration.filingDataJson = JSON.stringify(filing);
    await this.dataSource.getRepository(MerchantRegistration).save(registration);
  }

  /** 认证回调（notify_3rd_wxa_auth）事实处理：按 taskid 归因商家并更新过程证据，通过时同步真实事实 */
  private async applyWechatVerifyCallbackFacts(payload: Record<string, unknown>): Promise<void> {
    const taskid = String(payload.taskid || '');
    if (!taskid) return;
    const registrations = await this.dataSource.getRepository(MerchantRegistration).find();
    const target = registrations
      .map((r) => ({ r, filing: this.parseFilingData(r.filingDataJson) }))
      .find(({ filing }) => this.wechatVerifyRecord(filing).taskid === taskid);
    if (!target) { console.warn(`[WECHAT_VERIFY] 认证回调 taskid 无匹配商家 taskid=${taskid}`); return; }
    const record = this.wechatVerifyRecord(target.filing);
    const taskStatus = Number.isInteger(Number(payload.taskStatus)) ? Number(payload.taskStatus) : Number(record.taskStatus) || 0;
    let applyStatus = Number.isInteger(Number(payload.applyStatus)) ? Number(payload.applyStatus) : Number(record.applyStatus) || 0;
    const orderId = Number.isInteger(Number(payload.orderId)) ? Number(payload.orderId) : Number(record.orderId) || 0;
    const message = String(payload.message || '');
    if (taskStatus === 15 && applyStatus === 0) applyStatus = 1; // 等待支付
    const evidence: Record<string, unknown> = {
      ...record, taskStatus, applyStatus, orderId, updatedAt: new Date().toISOString(),
    };
    if (applyStatus === 3 && message) evidence.refillReason = message;
    if (applyStatus === 5 && message) evidence.failReason = message;
    target.filing._wechatVerify = evidence;
    if (applyStatus === 4) target.filing._certification = { status: 'APPROVED', updatedAt: new Date().toISOString() };
    target.r.filingDataJson = JSON.stringify(target.filing);
    await this.dataSource.getRepository(MerchantRegistration).save(target.r);
  }

  private wechatVerifyRecord(filing: Record<string, unknown>): Record<string, unknown> {
    const record = filing._wechatVerify;
    return record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : {};
  }

  private wechatVerifyStatusOf(record: Record<string, unknown>, taskStatus: number, applyStatus: number, orderId: number | null, authUrl: string, refillReason: string, failReason: string): WechatVerifyStatus {
    return {
      taskid: String(record.taskid || ''),
      authUrl,
      taskStatus,
      applyStatus,
      orderId,
      refillReason,
      failReason,
      feeFen: typeof record.feeFen === 'number' ? record.feeFen : 0,
      customerType: typeof record.customerType === 'number' ? record.customerType : 0,
      payType: typeof record.payType === 'number' ? record.payType : 2,
      submittedAt: typeof record.submittedAt === 'string' ? record.submittedAt : '',
      expired: taskStatus === 1,
      rejected: taskStatus === 2,
    };
  }

  private mockCategories() {
    return [
      { id: 301, name: '购物', children: [{ id: 3010, name: '电商平台' }, { id: 3011, name: '二手闲置' }, { id: 3012, name: '日用百货' }] },
      { id: 302, name: '生活服务', children: [{ id: 3020, name: '丽人服务' }, { id: 3021, name: '家政服务' }, { id: 3022, name: '洗浴保健' }] },
      { id: 303, name: '餐饮', children: [{ id: 3030, name: '点餐平台' }, { id: 3031, name: '外卖服务' }, { id: 3032, name: '餐饮门店' }] },
      { id: 304, name: '教育', children: [{ id: 3040, name: '在线教育' }, { id: 3041, name: '教育培训' }, { id: 3042, name: '驾校培训' }] },
      { id: 305, name: '医疗', children: [{ id: 3050, name: '医疗服务平台' }, { id: 3051, name: '药品经营' }] },
      { id: 306, name: '工具', children: [{ id: 3060, name: '记账' }, { id: 3061, name: '预约/报名' }, { id: 3062, name: '效率工具' }] },
      { id: 307, name: '商业服务', children: [{ id: 3070, name: '人力资源' }, { id: 3071, name: '法律服务' }] },
      { id: 308, name: '汽车', children: [{ id: 3080, name: '汽车资讯' }, { id: 3081, name: '汽车服务' }] },
      { id: 309, name: '旅游', children: [{ id: 3090, name: '旅游度假' }, { id: 3091, name: '酒店' }] },
      { id: 310, name: '金融', children: [{ id: 3100, name: '银行' }, { id: 3101, name: '保险' }] },
    ];
  }

  private async refreshIcpVerifyTask(user: User, merchantId: string, task: WechatIcpVerifyTask) {
    // FIX(2026-08-09)：sim_ 前缀为历史「模拟核验任务」（开发期降级产物），微信侧不存在该任务，
    // 查询必失败。此前 catch 会降级为「核验通过」（faceStatus=3），导致前端展示虚假的核身成功。
    // 现在直接拒绝查询并明确提示，杜绝虚假状态。
    if (String(task.taskId || '').startsWith('sim_')) {
      throw new BadRequestException('该核身任务为历史模拟任务（sim_ 前缀），无真实微信核身结果，请重新发起微信官方人脸核身。');
    }
    let isFinish = false;
    let faceStatus: number | null = null;
    let alongWithAuthResult: number | null = null;
    try {
      const authorizerToken = await this.getAuthorizerAccessToken(merchantId);
      const result = await this.wechatPostWithAccessToken('https://api.weixin.qq.com/wxa/icp/query_icp_verifytask', { task_id: task.taskId }, 'access_token', authorizerToken);
      isFinish = Boolean(result.is_finish);
      faceStatus = typeof result.face_status === 'number' && Number.isInteger(result.face_status) ? result.face_status : null;
      alongWithAuthResult = typeof result.along_with_auth_result === 'number' && Number.isInteger(result.along_with_auth_result) ? result.along_with_auth_result : null;
    } catch (error) {
      // FIX(2026-08-09)：查询失败不再降级为「核验通过」——微信 query_icp_verifytask 对无效 task_id 返回错误码，
      // 且网络/微信故障时也不能把失败当成成功。改为显式抛错，让前端展示真实失败原因。
      throw new BadGatewayException(`查询微信核身状态失败：${(error as Error).message}`);
    }
    task.isFinish = isFinish;
    task.faceStatus = faceStatus;
    task.alongWithAuthResult = alongWithAuthResult;
    task.lastCheckedAt = new Date();
    task.status = this.icpTaskStatus(isFinish, faceStatus);
    task.lastMessage = this.icpTaskMessage(isFinish, faceStatus, alongWithAuthResult);
    const saved = await this.icpVerifyTasks.save(task);
    await this.auditWriter.write(user.id, merchantId, 'WECHAT_ICP_VERIFY_TASK_QUERIED', 'WechatIcpVerifyTask', saved.id, null, { taskId: saved.taskId, isFinish, faceStatus, alongWithAuthResult });
    return this.icpTaskResponse(saved);
  }

  private responseObject(value: WechatApiResponse, field: string): WechatApiResponse {
    const result = value[field];
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new BadGatewayException(`微信开放平台响应缺少 ${field}`);
    return result as WechatApiResponse;
  }

  private responseString(value: WechatApiResponse, field: string, minLength: number, maxLength: number): string {
    const result = value[field];
    if (typeof result !== 'string' || result.length < minLength || result.length > maxLength) throw new BadGatewayException(`微信开放平台响应字段 ${field} 无效`);
    return result;
  }

  private optionalResponseString(value: WechatApiResponse, field: string, minLength: number, maxLength: number): string {
    const result = value[field];
    if (result === undefined || result === null || result === '') return '';
    if (typeof result !== 'string' || result.length < minLength || result.length > maxLength) throw new BadGatewayException(`微信开放平台响应字段 ${field} 无效`);
    return result;
  }

  private responseSeconds(value: WechatApiResponse, field: string, minimum: number, maximum: number): number {
    const result = value[field];
    if (typeof result !== 'number' || !Number.isInteger(result) || result < minimum || result > maximum) throw new BadGatewayException(`微信开放平台响应字段 ${field} 无效`);
    return result;
  }

  private responseInteger(value: WechatApiResponse, field: string, minimum: number, maximum: number): number {
    const result = value[field];
    if (typeof result !== 'number' || !Number.isInteger(result) || result < minimum || result > maximum) throw new BadGatewayException(`微信开放平台响应字段 ${field} 无效`);
    return result;
  }

  private permissionIds(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const category = (item as Record<string, unknown>).funcscope_category;
      if (!category || typeof category !== 'object' || Array.isArray(category)) return null;
      const id = (category as Record<string, unknown>).id;
      return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
    }).filter((id): id is number => id !== null))].sort((left, right) => left - right);
  }

  private authorizationCallbackUrl(state: string): string {
    const configured = this.value('WECHAT_COMPONENT_AUTH_REDIRECT_URL') || this.callback('/api/wechat/authorization/callback');
    const url = this.publicUrl(configured, '微信授权回调地址');
    url.searchParams.set('state', state);
    return url.toString();
  }

  private authorizationSuccessUrl(): string {
    const configured = this.value('WECHAT_COMPONENT_AUTH_SUCCESS_URL') || this.callback('/merchant/');
    const url = this.publicUrl(configured, '微信授权完成返回地址');
    url.searchParams.set('wechatAuthorization', 'success');
    return url.toString();
  }

  private publicUrl(value: string, label: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ServiceUnavailableException(`${label}尚未正确配置`); }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local)) throw new ServiceUnavailableException(`${label}必须使用 HTTPS`);
    return url;
  }

  private hashState(value: string): string { return createHash('sha256').update(value).digest('hex'); }

  private value(name: string) { return String(process.env[name] || '').trim(); }
  private required(name: string) { const value = this.value(name); if (!value) throw new BadRequestException('微信第三方平台服务尚未配置'); return value; }
  private check(key: string, label: string, ...names: string[]) { return { key, label, configured: names.every((name) => Boolean(this.value(name))) }; }
  private callback(path: string) { const base = this.value('PUBLIC_BASE_URL').replace(/\/$/, ''); return base ? `${base}${path}` : ''; }
  private maskIdentifier(value: string) { return value.length > 10 ? `${value.slice(0, 4)}****${value.slice(-4)}` : value; }

  private step(key: string, label: string, requiredIndex: number, currentIndex: number) { return { key, label, state: currentIndex > requiredIndex ? 'complete' : currentIndex === requiredIndex ? 'current' : 'pending' }; }

  /** 步骤完成状态由真实数据驱动：当前步骤 = 第一个未完成项 */
  private buildRealSteps(input: { materialsReady: boolean; registered: boolean; authorized: boolean; basicReady: boolean; categoryReady: boolean; certified: boolean; filingVerified: boolean; released: boolean; }): Array<{ key: string; label: string; state: 'complete' | 'current' | 'pending' }> {
    const definitions = [
      { key: 'materials', label: '商户资料', complete: input.materialsReady },
      { key: 'registration', label: '小程序注册', complete: input.registered },
      { key: 'authorization', label: '平台授权', complete: input.authorized },
      { key: 'basicInfo', label: '基础信息', complete: input.basicReady },
      // 服务类目在前：微信备案需要在提交备案前先选好服务类目
      { key: 'categories', label: '服务类目', complete: input.categoryReady },
      { key: 'filing', label: '微信认证/备案', complete: input.certified && input.filingVerified },
      { key: 'publishable', label: '可发布', complete: input.released },
    ];
    const currentIndex = definitions.findIndex((item) => !item.complete);
    return definitions.map((item, index) => ({
      key: item.key, label: item.label,
      state: currentIndex === -1 ? 'complete' : index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'pending',
    }));
  }

  private async fetchCertified(merchantId: string): Promise<boolean> {
    const result = await this.callWechat(merchantId, (token) =>
      this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/cgi-bin/account/getaccountbasicinfo', 'access_token', token));
    const verifyInfo = result.wx_verify_info && typeof result.wx_verify_info === 'object' && !Array.isArray(result.wx_verify_info)
      ? result.wx_verify_info as Record<string, unknown>
      : {};
    return Boolean(verifyInfo.qualification_verify);
  }

  private async detectCertified(merchantId: string): Promise<boolean | null> {
    try { return await this.fetchCertified(merchantId); }
    catch { return null; }
  }

  private async fetchSavedCategoryCount(merchantId: string): Promise<number> {
    const result = await this.callWechat(merchantId, (token) =>
      this.wechatPostWithAccessToken('https://api.weixin.qq.com/cgi-bin/wxopen/getcategory', {}, 'access_token', token));
    return Array.isArray(result.categories) ? (result.categories as unknown[]).length : 0;
  }

  private async detectSavedCategoryCount(merchantId: string): Promise<number> {
    try { return await this.fetchSavedCategoryCount(merchantId); }
    catch { return 0; }
  }

  private async fetchIcpEntranceStatus(merchantId: string): Promise<number | null> {
    const result = await this.callWechat(merchantId, (token) =>
      this.wechatGetJsonWithAccessToken('https://api.weixin.qq.com/wxa/icp/get_icp_entrance_info', 'access_token', token));
    const info = result.info && typeof result.info === 'object' && !Array.isArray(result.info)
      ? result.info as Record<string, unknown>
      : {};
    const status = Number(info.status);
    return Number.isInteger(status) ? status : null;
  }

  async processWechatSyncTasks(limit = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    const tasks = await this.syncTasks.find({
      where: { status: WechatSyncTaskStatus.PENDING, availableAt: LessThanOrEqual(new Date()) },
      order: { createdAt: 'ASC' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    let succeeded = 0;
    let failed = 0;
    for (const task of tasks) {
      const claimed = await this.syncTasks.update(
        { id: task.id, status: WechatSyncTaskStatus.PENDING },
        { status: WechatSyncTaskStatus.RUNNING, startedAt: new Date(), attempts: task.attempts + 1 },
      );
      if (claimed.affected !== 1) continue;
      try {
        await this.processWechatCallbackFacts(task.merchantId, task.payload);
        await this.dataSource.transaction(async (manager) => {
          await manager.update(WechatSyncTask, { id: task.id }, {
            status: WechatSyncTaskStatus.SUCCEEDED,
            finishedAt: new Date(),
            lastError: '',
          });
          await manager.update(WechatCallbackEvent, { id: task.callbackEventId }, {
            status: WechatCallbackEventStatus.PROCESSED,
            processedAt: new Date(),
            errorMessage: '',
          });
        });
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = task.attempts + 1 < 5;
        await this.dataSource.transaction(async (manager) => {
          await manager.update(WechatSyncTask, { id: task.id }, {
            status: retryable ? WechatSyncTaskStatus.PENDING : WechatSyncTaskStatus.FAILED,
            availableAt: new Date(Date.now() + Math.min(60 * 60_000, 2 ** (task.attempts + 1) * 1000)),
            finishedAt: retryable ? null : new Date(),
            lastError: message.slice(0, 2000),
          });
          if (!retryable) await manager.update(WechatCallbackEvent, { id: task.callbackEventId }, {
            status: WechatCallbackEventStatus.FAILED,
            processedAt: new Date(),
            errorMessage: message.slice(0, 2000),
          });
        });
        failed += 1;
      }
    }
    return { processed: succeeded + failed, succeeded, failed };
  }

  private async processWechatCallbackFacts(merchantId: string | null, payload: Record<string, unknown>): Promise<void> {
    const eventType = String(payload.eventType || '');
    if (eventType === 'component_verify_ticket') {
      const ticketCiphertext = String(payload.ticketCiphertext || '');
      const existing = await this.loadComponentState();
      await this.componentStates.save({
        ...(existing || {}), id: 'component', verifyTicketCiphertext: ticketCiphertext,
        ticketUpdatedAt: new Date(), accessTokenCiphertext: existing?.accessTokenCiphertext || '', accessTokenExpiresAt: existing?.accessTokenExpiresAt || null,
      });
      return;
    }
    if (eventType === 'notify_third_fasteregister' || eventType === 'authorized') {
      const authCodeCiphertext = String(payload.authCodeCiphertext || '');
      const appid = String(payload.appid || payload.authorizerAppId || '');
      const authCode = authCodeCiphertext ? this.sensitiveData.decrypt(authCodeCiphertext) : '';
      if (authCode && appid && String(payload.status || '0') === '0') {
        await this.completeFastRegisterAuth(authCode, appid, String(payload.merchantName || ''), String(payload.merchantCode || ''));
      }
      return;
    }
    if (eventType === 'notify_icpfiling_verify_result') {
      const taskId = String(payload.taskId || '');
      const result = Number(payload.result);
      if (taskId && (result === 2 || result === 3)) {
        const task = await this.icpVerifyTasks.findOne({ where: { taskId } });
        if (task) {
          const alongWithAuthResult = Number.isInteger(Number(payload.alongWithAuthResult)) ? Number(payload.alongWithAuthResult) : null;
          task.isFinish = true;
          task.faceStatus = result;
          task.alongWithAuthResult = alongWithAuthResult;
          task.lastCheckedAt = new Date();
          task.status = this.icpTaskStatus(true, result);
          task.lastMessage = this.icpTaskMessage(true, result, alongWithAuthResult);
          await this.icpVerifyTasks.save(task);
        }
      }
      return;
    }
    if (eventType === 'notify_3rd_wxa_auth') {
      await this.applyWechatVerifyCallbackFacts(payload);
      return;
    }
    if (eventType === 'wxa_audit_success' || eventType === 'wxa_audit_fail') {
      if (!merchantId) return;
      const pending = await this.releases.findOne({
        where: { merchantId, status: WechatMiniprogramReleaseStatus.AUDIT_SUBMITTED },
        order: { createdAt: 'DESC' },
      });
      if (pending) {
        pending.status = payload.approved === true ? WechatMiniprogramReleaseStatus.AUDIT_APPROVED : WechatMiniprogramReleaseStatus.AUDIT_REJECTED;
        pending.errorMessage = payload.approved === true ? '' : '微信审核未通过（详见微信审核结果）';
        await this.releases.save(pending);
      }
    }
    await this.syncWechatOnboardingFacts(merchantId, payload);
  }

  private async syncWechatOnboardingFacts(merchantId: string | null, payload: Record<string, unknown>): Promise<void> {
    if (!merchantId) return;
    const registration = await this.registration.findForMerchant(merchantId);
    const authorizer = await this.authorizers.findOneBy({ merchantId });
    const latestRelease = await this.findLatestRelease(merchantId);
    const latestIcpTask = await this.icpVerifyTasks.findOne({ where: { merchantId }, order: { createdAt: 'DESC' } });
    const filingData = this.parseFilingData(registration?.filingDataJson);
    let syncStatus = WechatOnboardingSyncStatus.HEALTHY;
    const errors: string[] = [];
    if (authorizer && authorizer.status === WechatAuthorizerStatus.AUTHORIZED && !authorizer.revokedAt) {
      const [certificationResult, categoryResult, icpResult] = await Promise.allSettled([
        this.fetchCertified(merchantId),
        this.fetchSavedCategoryCount(merchantId),
        this.fetchIcpEntranceStatus(merchantId),
      ]);
      if (certificationResult.status === 'fulfilled') filingData._certification = { status: certificationResult.value ? 'APPROVED' : 'ACTION_REQUIRED', updatedAt: new Date().toISOString() };
      else errors.push(certificationResult.reason instanceof Error ? certificationResult.reason.message : String(certificationResult.reason));
      if (categoryResult.status === 'fulfilled') filingData._categories = { savedCount: categoryResult.value, updatedAt: new Date().toISOString() };
      else errors.push(categoryResult.reason instanceof Error ? categoryResult.reason.message : String(categoryResult.reason));
      if (icpResult.status === 'fulfilled') filingData._icpEntranceInfo = { status: icpResult.value, updatedAt: new Date().toISOString() };
      else errors.push(icpResult.reason instanceof Error ? icpResult.reason.message : String(icpResult.reason));
      if (errors.length) syncStatus = WechatOnboardingSyncStatus.STALE;
      if (registration) {
        registration.filingDataJson = JSON.stringify(filingData);
        await this.dataSource.getRepository(MerchantRegistration).save(registration);
      }
    }
    const snapshot = calculateWechatOnboarding({
      merchant: await this.dataSource.getRepository(Merchant).findOneByOrFail({ id: merchantId }),
      filingData,
      registrationUpdatedAt: registration?.updatedAt || null,
      authorizer,
      latestIcpTask,
      latestRelease,
      syncStatus,
      lastSyncAt: new Date(),
      lastSyncError: errors.join('; ').slice(0, 2000),
    });
    await this.persistOnboardingSnapshot(merchantId, snapshot, true);
  }

  /** 取线上生效的发布记录：优先最近一次 RELEASED / AUDIT_APPROVED（真实上线事实），无则回退最新记录（COMMITTED 上传中/提审中） */
  private async findLatestRelease(merchantId: string) {
    const effective = await this.releases.findOne({
      where: { merchantId, status: In([WechatMiniprogramReleaseStatus.RELEASED, WechatMiniprogramReleaseStatus.AUDIT_APPROVED]) },
      order: { updatedAt: 'DESC' },
    });
    return effective || this.releases.findOne({ where: { merchantId }, order: { createdAt: 'DESC' } });
  }
  private async persistOnboardingSnapshot(
    merchantId: string,
    snapshot: ReturnType<typeof calculateWechatOnboarding>,
    applyPublishableEntitlement = false,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(WechatOnboarding, { where: { merchantId }, lock: { mode: 'pessimistic_write' } });
      const merchant = await manager.findOneByOrFail(Merchant, { id: merchantId });
      const registration = await manager.findOne(MerchantRegistration, { where: { merchantId }, lock: { mode: 'pessimistic_write' } });
      const previousStatus = existing?.status || null;
      const saved = await manager.save(WechatOnboarding, {
        ...(existing || {}),
        merchantId,
        status: snapshot.status,
        syncStatus: snapshot.syncStatus,
        evidenceUpdatedAt: snapshot.evidenceUpdatedAt,
        lastSyncAt: snapshot.lastSyncAt,
        lastSyncError: snapshot.lastSyncError,
      });
      for (const step of snapshot.steps) {
        const current = await manager.findOne(WechatOnboardingStep, { where: { merchantId, key: step.key } });
        await manager.save(WechatOnboardingStep, {
          ...(current || {}), merchantId, key: step.key, status: step.status,
          evidence: step.evidence, evidenceUpdatedAt: step.evidenceUpdatedAt,
        });
      }
      const publishableStep = snapshot.steps.find((step) => step.key === WechatOnboardingStepKey.PUBLISHABLE);
      const becamePublishable = publishableStep?.status === WechatOnboardingBusinessStatus.COMPLETE
        && (previousStatus !== WechatOnboardingBusinessStatus.COMPLETE || applyPublishableEntitlement);
      if (applyPublishableEntitlement && becamePublishable) {
        await this.agencyCooperation.applyOnboardingEntitlementEvent(
          manager,
          merchant,
          registration,
          WechatOnboardingEntitlementEventType.PUBLISHABLE,
        );
      }
      void saved;
    });
  }
  private icpTaskStatus(isFinish: boolean, faceStatus: number | null): WechatIcpVerifyTaskStatus {
    if (!isFinish) return WechatIcpVerifyTaskStatus.PENDING;
    if (faceStatus === 3) return WechatIcpVerifyTaskStatus.SUCCEEDED;
    if (faceStatus === 2) return WechatIcpVerifyTaskStatus.FAILED;
    return WechatIcpVerifyTaskStatus.PENDING;
  }
  private icpTaskMessage(isFinish: boolean, faceStatus: number | null, alongWithAuthResult: number | null) {
    if (!isFinish) return faceStatus === 1 ? '微信官方核身等待中，请法人继续在微信内完成。' : '微信官方核身未开始，请法人使用微信扫码打开核身页面。';
    if (faceStatus === 3) return alongWithAuthResult === 9 ? '微信官方人脸核身成功，认证短信核验已通过。' : '微信官方人脸核身成功。';
    if (faceStatus === 2) return '微信官方人脸核身失败，请重新发起核身任务。';
    return '微信官方核身状态暂未返回最终结果，请稍后查询。';
  }
  private icpTaskResponse(task: WechatIcpVerifyTask) {
    return {
      id: task.id,
      taskId: task.taskId,
      verifyUrl: task.verifyUrl,
      alongWithAuth: task.alongWithAuth,
      status: task.status,
      isFinish: task.isFinish,
      faceStatus: task.faceStatus,
      alongWithAuthResult: task.alongWithAuthResult,
      message: task.lastMessage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      lastCheckedAt: task.lastCheckedAt,
    };
  }
  private async enqueueCallbackEvent(input: { eventType: string; authorizerAppId: string | null; createTime: string; messageDigest: string; payload: Record<string, unknown> }): Promise<void> {
    const authorizer = input.authorizerAppId ? await this.authorizers.findOne({ where: { authorizerAppId: input.authorizerAppId } }) : null;
    const fingerprint = createHash('sha256').update([
      input.eventType, input.authorizerAppId || '', input.createTime, input.messageDigest,
    ].join('|')).digest('hex');
    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(WechatCallbackEvent, { where: { fingerprint } });
      if (existing) return;
      const event = await manager.save(WechatCallbackEvent, {
        fingerprint,
        merchantId: authorizer?.merchantId || null,
        authorizerAppId: input.authorizerAppId,
        eventType: input.eventType.slice(0, 64),
        payload: input.payload,
        status: WechatCallbackEventStatus.RECEIVED,
        processedAt: null,
        errorMessage: '',
      });
      await manager.save(WechatSyncTask, {
        merchantId: authorizer?.merchantId || null,
        callbackEventId: event.id,
        type: 'SYNC_ONBOARDING_FACTS',
        payload: input.payload,
        status: WechatSyncTaskStatus.PENDING,
        attempts: 0,
        availableAt: new Date(),
        startedAt: null,
        finishedAt: null,
        lastError: '',
      });
    });
  }

  private verifySignature(token: string, timestamp: string, nonce: string, encrypted: string, signature: string) {
    if (!/^[a-fA-F0-9]{40}$/.test(signature)) throw new BadRequestException('微信回调签名格式错误');
    const expected = createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest();
    const actual = Buffer.from(signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException('微信回调签名无效');
  }
  private decrypt(encrypted: string, encodingAesKey: string) {
    const key = Buffer.from(`${encodingAesKey}=`, 'base64');
    if (key.length !== 32) throw new BadRequestException('微信消息加解密 Key 配置错误');
    try {
      const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
      decipher.setAutoPadding(false);
      const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
      const padding = padded[padded.length - 1];
      if (!padding || padding > 32 || padding > padded.length) throw new Error('invalid padding');
      for (let index = padded.length - padding; index < padded.length; index += 1) if (padded[index] !== padding) throw new Error('invalid padding');
      const value = padded.subarray(0, padded.length - padding);
      if (value.length < 24) throw new Error('invalid envelope');
      const messageLength = value.readUInt32BE(16);
      if (messageLength < 1 || messageLength > value.length - 20) throw new Error('invalid message length');
      return { message: value.subarray(20, 20 + messageLength).toString('utf8'), receiveId: value.subarray(20 + messageLength).toString('utf8') };
    } catch { throw new BadRequestException('微信回调解密失败'); }
  }
  private xmlValue(xml: string, field: string, required = true) {
    // 微信回调字段既有 PascalCase，也有 task_id / verify_appid 等下划线命名。
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || xml.length > 1024 * 1024) throw new BadRequestException('微信 XML 消息无效');
    const match = xml.match(new RegExp(`<${field}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${field}>`));
    if (!match) { if (required) throw new BadRequestException(`微信 XML 缺少 ${field}`); return ''; }
    return (match[1] ?? match[2] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
  }
}
