import { Merchant } from './domain/entities';
import {
  WechatAuthorizerStatus,
  WechatMiniprogramReleaseStatus,
  WechatOnboardingBusinessStatus,
  WechatOnboardingStepKey,
  WechatOnboardingSyncStatus,
} from './domain/wechat-platform.entities';

export type OnboardingStepResult = {
  key: WechatOnboardingStepKey;
  label: string;
  status: WechatOnboardingBusinessStatus;
  state: 'complete' | 'current' | 'pending';
  evidence: Record<string, unknown>;
  evidenceUpdatedAt: Date | null;
};

export type WechatOnboardingFacts = {
  merchant: Pick<Merchant, 'legalName' | 'brandName' | 'servicePhone' | 'updatedAt'>;
  filingData: Record<string, unknown>;
  registrationUpdatedAt: Date | null;
  authorizer: { authorizerAppId: string; status: WechatAuthorizerStatus; revokedAt: Date | null; updatedAt: Date } | null;
  latestIcpTask: { status: string; isFinish: boolean; faceStatus: number | null; updatedAt: Date } | null;
  latestRelease: { status: WechatMiniprogramReleaseStatus; updatedAt: Date } | null;
  syncStatus?: WechatOnboardingSyncStatus;
  lastSyncAt?: Date | null;
  lastSyncError?: string;
};

const DEFINITIONS: Array<{ key: WechatOnboardingStepKey; label: string }> = [
  { key: WechatOnboardingStepKey.MATERIALS, label: '商户资料' },
  { key: WechatOnboardingStepKey.REGISTRATION, label: '小程序注册' },
  { key: WechatOnboardingStepKey.AUTHORIZATION, label: '平台授权' },
  { key: WechatOnboardingStepKey.BASIC_INFO, label: '基础信息' },
  { key: WechatOnboardingStepKey.CATEGORIES, label: '服务类目' },
  { key: WechatOnboardingStepKey.FILING, label: '微信认证/备案' },
  { key: WechatOnboardingStepKey.PUBLISHABLE, label: '可发布' },
];

export function calculateWechatOnboarding(facts: WechatOnboardingFacts) {
  const filing = facts.filingData;
  const requiredMaterialFields = [
    ['merchant.legalName', facts.merchant.legalName], ['merchant.brandName', facts.merchant.brandName],
    ['merchant.servicePhone', facts.merchant.servicePhone], ['subjectName', filing.subjectName],
    ['certificateNo', filing.certificateNo], ['certificateFront', filing.certificateFront],
    ['responsibleName', filing.responsibleName], ['responsiblePhone', filing.responsiblePhone],
    ['responsibleIdNo', filing.responsibleIdNo], ['responsibleFront', filing.responsibleFront],
    ['responsibleBack', filing.responsibleBack],
  ] as Array<[string, unknown]>;
  const missingMaterialFields = requiredMaterialFields.filter(([, value]) => !hasValue(value)).map(([key]) => key);
  const fastRegister = objectValue(filing._fastRegister);
  const hasFastRegisterEvidence = Object.keys(fastRegister).length > 0;
  const registeredAppId = stringValue(fastRegister.appid);
  const fastRegisterStatus = integerValue(fastRegister.status, -1);
  const registered = fastRegisterStatus === 12 && isWechatAppId(registeredAppId);
  // -1 只是“尚未有快速注册记录”时的内部哨兵；只有存在微信返回/本地持久化证据时，失败码才代表真实失败。
  const registrationFailed = hasFastRegisterEvidence && [-1, 1, 2, 5, 8, 11, 14, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008].includes(fastRegisterStatus);
  const authorized = Boolean(facts.authorizer
    && facts.authorizer.status === WechatAuthorizerStatus.AUTHORIZED
    && !facts.authorizer.revokedAt
    && isWechatAppId(facts.authorizer.authorizerAppId));
  const profile = objectValue(filing._accountProfile);
  const basicFields = ['nickname', 'avatar', 'introduction'];
  const completedBasicFields = basicFields.filter((key) => profileFieldStatus(profile[key]) === 'COMPLETE');
  const processingBasicFields = basicFields.filter((key) => profileFieldStatus(profile[key]) === 'PROCESSING');
  const failedBasicFields = basicFields.filter((key) => profileFieldStatus(profile[key]) === 'FAILED');
  const categories = objectValue(filing._categories);
  const savedCategoryCount = integerValue(categories.savedCount);
  const icpEvidence = objectValue(filing._icpEntranceInfo);
  const icpStatus = integerValue(icpEvidence.status, -1);
  const certification = objectValue(filing._certification);
  const certificationApproved = certification.status === 'APPROVED' || certification.approved === true;
  const filingComplete = certificationApproved && icpStatus === 6;
  const filingProcessing = !filingComplete && (
    [2, 4].includes(icpStatus)
    || facts.latestIcpTask?.status === 'PENDING'
    || facts.latestIcpTask?.status === 'SUCCEEDED'
  );
  const publishable = Boolean(facts.latestRelease && [
    WechatMiniprogramReleaseStatus.AUDIT_APPROVED,
    WechatMiniprogramReleaseStatus.RELEASED,
  ].includes(facts.latestRelease.status));

  const statuses: Record<WechatOnboardingStepKey, { status: WechatOnboardingBusinessStatus; evidence: Record<string, unknown>; updatedAt: Date | null }> = {
    [WechatOnboardingStepKey.MATERIALS]: {
      status: missingMaterialFields.length ? WechatOnboardingBusinessStatus.ACTION_REQUIRED : WechatOnboardingBusinessStatus.COMPLETE,
      evidence: { missingFields: missingMaterialFields }, updatedAt: latestDate(facts.merchant.updatedAt, facts.registrationUpdatedAt),
    },
    [WechatOnboardingStepKey.REGISTRATION]: {
      status: registered
        ? WechatOnboardingBusinessStatus.COMPLETE
        : registrationFailed
          ? WechatOnboardingBusinessStatus.FAILED
          : hasValue(fastRegister.taskid)
            ? WechatOnboardingBusinessStatus.PROCESSING
            : WechatOnboardingBusinessStatus.ACTION_REQUIRED,
      evidence: { taskId: fastRegister.taskid || null, taskStatus: fastRegisterStatus >= 0 ? fastRegisterStatus : null, registeredAppId: registered ? registeredAppId : null }, updatedAt: facts.registrationUpdatedAt,
    },
    [WechatOnboardingStepKey.AUTHORIZATION]: {
      status: authorized ? WechatOnboardingBusinessStatus.COMPLETE : WechatOnboardingBusinessStatus.ACTION_REQUIRED,
      evidence: { authorized, authorizerStatus: facts.authorizer?.status || null }, updatedAt: facts.authorizer?.updatedAt || null,
    },
    [WechatOnboardingStepKey.BASIC_INFO]: {
      status: completedBasicFields.length === basicFields.length
        ? WechatOnboardingBusinessStatus.COMPLETE
        : failedBasicFields.length
          ? WechatOnboardingBusinessStatus.FAILED
          : processingBasicFields.length
            ? WechatOnboardingBusinessStatus.PROCESSING
            : WechatOnboardingBusinessStatus.ACTION_REQUIRED,
      evidence: {
        completedFields: completedBasicFields,
        processingFields: processingBasicFields,
        failedFields: failedBasicFields,
        missingFields: basicFields.filter((key) => !completedBasicFields.includes(key) && !processingBasicFields.includes(key) && !failedBasicFields.includes(key)),
      }, updatedAt: dateValue(profile.updatedAt),
    },
    [WechatOnboardingStepKey.CATEGORIES]: {
      status: savedCategoryCount > 0 ? WechatOnboardingBusinessStatus.COMPLETE : WechatOnboardingBusinessStatus.ACTION_REQUIRED,
      evidence: { savedCategoryCount }, updatedAt: dateValue(categories.updatedAt),
    },
    [WechatOnboardingStepKey.FILING]: {
      status: filingComplete
        ? WechatOnboardingBusinessStatus.COMPLETE
        : [3, 5].includes(icpStatus)
          ? WechatOnboardingBusinessStatus.FAILED
          : filingProcessing
            ? WechatOnboardingBusinessStatus.PROCESSING
            : WechatOnboardingBusinessStatus.ACTION_REQUIRED,
      evidence: {
        certificationApproved,
        icpStatus: icpStatus >= 0 ? icpStatus : null,
        faceVerified: facts.latestIcpTask?.status === 'SUCCEEDED',
        finalFilingEvidencePresent: icpStatus === 6,
      },
      updatedAt: latestDate(dateValue(icpEvidence.updatedAt), dateValue(certification.updatedAt), facts.latestIcpTask?.updatedAt || null),
    },
    [WechatOnboardingStepKey.PUBLISHABLE]: {
      status: publishable ? WechatOnboardingBusinessStatus.COMPLETE : facts.latestRelease ? WechatOnboardingBusinessStatus.PROCESSING : WechatOnboardingBusinessStatus.ACTION_REQUIRED,
      evidence: { releaseStatus: facts.latestRelease?.status || null, released: facts.latestRelease?.status === WechatMiniprogramReleaseStatus.RELEASED }, updatedAt: facts.latestRelease?.updatedAt || null,
    },
  };

  const firstIncomplete = DEFINITIONS.findIndex(({ key }) => statuses[key].status !== WechatOnboardingBusinessStatus.COMPLETE);
  const steps: OnboardingStepResult[] = DEFINITIONS.map((definition, index) => ({
    ...definition,
    status: statuses[definition.key].status,
    state: firstIncomplete === -1 || index < firstIncomplete ? 'complete' : index === firstIncomplete ? 'current' : 'pending',
    evidence: statuses[definition.key].evidence,
    evidenceUpdatedAt: statuses[definition.key].updatedAt,
  }));
  const currentStep = steps[firstIncomplete === -1 ? steps.length - 1 : firstIncomplete];
  const evidenceUpdatedAt = latestDate(...steps.map((step) => step.evidenceUpdatedAt));
  return {
    status: firstIncomplete === -1 ? WechatOnboardingBusinessStatus.COMPLETE : steps[firstIncomplete].status,
    syncStatus: facts.syncStatus || WechatOnboardingSyncStatus.UNKNOWN,
    lastSyncAt: facts.lastSyncAt || null,
    lastSyncError: facts.lastSyncError || '',
    evidenceUpdatedAt,
    evidenceFreshness: evidenceUpdatedAt ? { asOf: evidenceUpdatedAt, stale: Date.now() - evidenceUpdatedAt.getTime() > 24 * 60 * 60_000 } : { asOf: null, stale: true },
    steps,
    currentStep: { key: currentStep.key, label: currentStep.label },
  };
}

function hasValue(value: unknown): boolean { return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integerValue(value: unknown, fallback = 0): number { const result = Number(value); return Number.isInteger(result) ? result : fallback; }
function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function isWechatAppId(value: string): boolean { return /^wx[A-Za-z0-9]{8,32}$/.test(value); }
function profileFieldStatus(value: unknown): 'COMPLETE' | 'PROCESSING' | 'FAILED' | 'MISSING' {
  if (value === true || value === 'COMPLETE') return 'COMPLETE';
  if (value === 'PROCESSING') return 'PROCESSING';
  if (value === false || value === 'FAILED') return 'FAILED';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const status = String((value as Record<string, unknown>).status || '').toUpperCase();
    if (status === 'COMPLETE' || status === 'PROCESSING' || status === 'FAILED') return status;
  }
  return 'MISSING';
}
function dateValue(value: unknown): Date | null { const date = typeof value === 'string' || value instanceof Date ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function latestDate(...values: Array<Date | null | undefined>): Date | null { const valid = values.filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime())); return valid.length ? new Date(Math.max(...valid.map((value) => value.getTime()))) : null; }
