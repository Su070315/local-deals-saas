import { calculateWechatOnboarding, WechatOnboardingFacts } from './wechat-onboarding.calculator';
import {
  WechatAuthorizerStatus,
  WechatMiniprogramReleaseStatus,
  WechatOnboardingBusinessStatus,
  WechatOnboardingStepKey,
} from './domain/wechat-platform.entities';

function facts(overrides: Partial<WechatOnboardingFacts> = {}): WechatOnboardingFacts {
  return {
    merchant: {
      legalName: '示例企业有限公司',
      brandName: '示例品牌',
      servicePhone: '020-12345678',
      updatedAt: new Date('2026-08-18T00:00:00Z'),
    },
    filingData: {},
    registrationUpdatedAt: null,
    authorizer: null,
    latestIcpTask: null,
    latestRelease: null,
    ...overrides,
  };
}

function step(result: ReturnType<typeof calculateWechatOnboarding>, key: WechatOnboardingStepKey) {
  return result.steps.find((item) => item.key === key)!;
}

describe('calculateWechatOnboarding', () => {
  it('does not treat the absent fast-register record as a failed registration', () => {
    const result = calculateWechatOnboarding(facts());

    expect(step(result, WechatOnboardingStepKey.REGISTRATION).status)
      .toBe(WechatOnboardingBusinessStatus.ACTION_REQUIRED);
    expect(step(result, WechatOnboardingStepKey.REGISTRATION).evidence)
      .toEqual({ taskId: null, taskStatus: null, registeredAppId: null });
  });

  it('keeps registration incomplete when authorization exists without registration evidence', () => {
    const result = calculateWechatOnboarding(facts({
      filingData: {
        subjectName: '示例企业有限公司',
        certificateNo: '91440000000000000X',
        certificateFront: 'front.jpg',
        responsibleName: '张三',
        responsiblePhone: '13800138000',
        responsibleIdNo: '110101199001011234',
        responsibleFront: 'id-front.jpg',
        responsibleBack: 'id-back.jpg',
      },
      authorizer: {
        authorizerAppId: 'wxB3C17A05D7787655',
        status: WechatAuthorizerStatus.AUTHORIZED,
        revokedAt: null,
        updatedAt: new Date('2026-08-18T00:00:00Z'),
      },
    }));

    expect(step(result, WechatOnboardingStepKey.REGISTRATION).status)
      .toBe(WechatOnboardingBusinessStatus.ACTION_REQUIRED);
    expect(step(result, WechatOnboardingStepKey.AUTHORIZATION).status)
      .toBe(WechatOnboardingBusinessStatus.COMPLETE);
    expect(result.currentStep.key).toBe(WechatOnboardingStepKey.REGISTRATION);
  });

  it('marks registration complete only with successful status and a valid WeChat AppID', () => {
    const result = calculateWechatOnboarding(facts({
      filingData: {
        _fastRegister: { taskid: 'task-12345678', status: 12, appid: 'wxB3C17A05D7787655' },
      },
    }));

    expect(step(result, WechatOnboardingStepKey.REGISTRATION).status)
      .toBe(WechatOnboardingBusinessStatus.COMPLETE);
  });

  it('marks an existing failed fast-register record as failed', () => {
    const result = calculateWechatOnboarding(facts({
      filingData: { _fastRegister: { taskid: 'task-12345678', status: 11 } },
    }));

    expect(step(result, WechatOnboardingStepKey.REGISTRATION).status)
      .toBe(WechatOnboardingBusinessStatus.FAILED);
  });

  it('requires audit approval or release evidence for the publishable step', () => {
    const result = calculateWechatOnboarding(facts({
      filingData: {
        _fastRegister: { status: 12, appid: 'wxB3C17A05D7787655' },
        _accountProfile: { nickname: '示例', avatar: 'COMPLETE', introduction: 'COMPLETE' },
        _categories: { savedCount: 1 },
        _certification: { status: 'APPROVED' },
        _icpEntranceInfo: { status: 6 },
      },
      authorizer: {
        authorizerAppId: 'wxB3C17A05D7787655',
        status: WechatAuthorizerStatus.AUTHORIZED,
        revokedAt: null,
        updatedAt: new Date('2026-08-18T00:00:00Z'),
      },
      latestRelease: { status: WechatMiniprogramReleaseStatus.AUDIT_APPROVED, updatedAt: new Date('2026-08-18T00:00:00Z') },
    }));

    expect(step(result, WechatOnboardingStepKey.PUBLISHABLE).status)
      .toBe(WechatOnboardingBusinessStatus.COMPLETE);
  });
});
