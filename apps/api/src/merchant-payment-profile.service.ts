import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  MerchantPaymentProfile, MerchantPaymentProfileStatus, PlatformAccessProfile, User, UserRole,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { HuifuPaymentProvider } from './payments/huifu-payment-provider';
import { SensitiveDataService } from './sensitive-data.service';
import { SaveMerchantPaymentProfileDto } from './request.dto';

/** 可选支付通道 */
export const PAYMENT_CHANNELS = ['WECHAT_DIRECT', 'HUIFU', 'TIANQUE'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/** 通道能力描述（供前端渲染选项与可填参数） */
export type PaymentChannelOption = {
  provider: PaymentChannel;
  label: string;
  /** 该通道是否需要商家级参数（微信直连为全局商户号，无需填） */
  requiresMerchantParam: boolean;
  /** 通道是否可用（汇付暂未接入） */
  available: boolean;
  note: string;
};

export type MerchantPaymentProfileView = {
  profile: null | {
    id: string;
    merchantId: string;
    provider: string;
    externalMerchantNo: string;
    providerMerchantId: string | null;
    applicationNo: string;
    /** 汇付通道：微信小程序 APPID */
    wxAppletAppId: string;
    /** 汇付直连：该商户自己的系统号（直连时等于 providerMerchantId） */
    huifuSysId: string;
    /** 汇付直连：该商户的产品号 */
    huifuProductId: string;
    /** 是否已配置该商户自己的私钥（不回显密钥内容） */
    hasHuifuPrivateKey: boolean;
    /** 汇付直连：该商户自己的 RSA 公钥（仅展示前缀） */
    huifuMerchantPublicKeyPreview: string;
    /** 汇付直连：该商户的汇付公钥（回调验签用，仅展示前缀） */
    huifuPublicKeyPreview: string;
    /** 汇付直连：该商户微信业务开通类型 */
    huifuFeeType: string;
    /** 天阙直连：该商户的天阙商户编号（mno） */
    tianqueMno: string;
    /** 天阙直连：该商户的组织号 */
    tianqueOrgId: string;
    /** 是否已配置该商户自己的天阙私钥（不回显密钥内容） */
    hasTianquePrivateKey: boolean;
    /** 天阙直连：签名算法 */
    tianqueSignAlg: string;
    /** 微信直连：该商户的微信支付商户号（mchid） */
    wechatMchid: string;
    /** 微信直连：该商户的小程序 APPID */
    wechatAppId: string;
    /** 微信直连：是否已配置 APIv3 密钥与私钥（加密存储，不回显） */
    hasWechatCredentials: boolean;
    /** 微信直连：商户证书序列号 */
    wechatCertSerialNo: string;
    /** 微信直连：微信支付公钥（仅展示前缀） */
    wechatPublicKeyPreview: string;
    status: MerchantPaymentProfileStatus;
    version: number;
    verifiedAt: Date | null;
    updatedAt: Date;
  };
  suggestedExternalMerchantNo: string;
  /** 保存时汇付绑定 APPID 的结果提示（仅 save 返回） */
  bindNote?: string;
};

export type PaymentChannelView = {
  options: PaymentChannelOption[];
  /** 当前生效通道（无档案时回退微信直连） */
  current: PaymentChannel;
  profile: MerchantPaymentProfileView['profile'];
  /** 微信直连全局商户号（只读展示） */
  wechatMchid: string | null;
  suggestedExternalMerchantNo: string;
};

export type ActivePaymentRoute = {
  provider: string;
  paymentProfileId: string;
  providerMerchantId: string;
};

@Injectable()
export class MerchantPaymentProfileService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly huifu: HuifuPaymentProvider,
    private readonly sensitiveData: SensitiveDataService,
    @InjectRepository(MerchantPaymentProfile) private readonly profiles: Repository<MerchantPaymentProfile>,
  ) {}

  private channelOptions(): PaymentChannelOption[] {
    // 汇付可用：全局 env 已配置（单商户兼容）或数据库已有商户档案（多租户）
    const huifuConfigured = Boolean(
      ((process.env.HUIFU_SYS_ID || '').trim() && (process.env.HUIFU_PRODUCT_ID || '').trim())
      || true, // 多租户模式下按商户档案判定，面板始终允许选择并填写
    );
    return [
      {
        provider: 'WECHAT_DIRECT', label: '微信直连', requiresMerchantParam: false,
        available: true, note: '平台统一微信商户号收款（平台级收单，对账按商家订单区分）；顾客在小程序内直接拉起微信支付',
      },
      {
        provider: 'HUIFU', label: '汇付支付', requiresMerchantParam: true,
        available: huifuConfigured, note: '填写该商家在汇付的商户号及其直连开发参数（系统号/产品号/私钥/汇付公钥）',
      },
      {
        provider: 'TIANQUE', label: '天阙支付', requiresMerchantParam: true,
        available: true, note: '填写该商家在天阙的商户编号（mno）',
      },
    ];
  }

  /** 微信直连全局商户号（供前端只读展示） */
  private wechatMchid(): string | null {
    const value = String(process.env.WECHATPAY_MCHID || '').trim();
    return value || null;
  }

  async getChannels(user: User, merchantId: string): Promise<PaymentChannelView> {
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '查看商家支付通道', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const profile = await this.latestProfile(merchantId);
    return {
      options: this.channelOptions(),
      current: this.normalizeProvider(profile?.provider || 'WECHAT_DIRECT'),
      profile: profile ? this.profileView(profile) : null,
      wechatMchid: this.wechatMchid(),
      suggestedExternalMerchantNo: this.suggestedExternalMerchantNo(merchantId),
    };
  }

  async get(user: User, merchantId: string): Promise<MerchantPaymentProfileView> {
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '查看商家支付通道', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const profile = await this.latestProfile(merchantId);
    return this.view(profile, merchantId);
  }

  async save(user: User, merchantId: string, input: SaveMerchantPaymentProfileDto): Promise<MerchantPaymentProfileView> {
    const submittedByAgency = user.role === UserRole.AGENCY_ADMIN;
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '维护商家支付通道', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const provider = this.normalizeProvider(input.provider || 'WECHAT_DIRECT');
    const externalMerchantNo = input.externalMerchantNo.trim();
    const providerMerchantId = input.providerMerchantId?.trim() || null;
    const applicationNo = input.applicationNo?.trim() || '';
    const wxAppletAppId = input.wxAppletAppId?.trim() || '';

    // 微信直连使用全局商户号，不允许填商家级参数
    if (provider === 'WECHAT_DIRECT' && providerMerchantId) {
      throw new BadRequestException('微信直连使用平台统一商户号，无需填写商家参数');
    }
    if (input.status === MerchantPaymentProfileStatus.ACTIVE && provider !== 'WECHAT_DIRECT' && (!providerMerchantId || !input.activationConfirmed)) {
      throw new BadRequestException('启用收款前必须填写该通道的商户号并确认已在支付平台核对商家主体与审核状态');
    }

    if (provider === 'HUIFU' && wxAppletAppId && !/^wx[a-f0-9]{16}$/i.test(wxAppletAppId)) {
      throw new BadRequestException('微信小程序 APPID 格式不正确');
    }

    try {
      // 记录档案历史状态，供事务提交后判断是否需要重新提交汇付绑定申请
      let existedBefore = false;
      let existingProviderMerchantId = '';
      let existingHadApplyNo = false;
      let existingHadAppletAppId = false;
      // 汇付绑定结果（H1：绑定在事务提交后执行，结果回写档案）——必须在事务回调外声明，
      // 事务内的返回值与提交后的回写共用同一变量，否则提交后引用会 ReferenceError
      let bindNote = '';
      let bindApplyNo = '';
      const savedResult = await this.dataSource.transaction(async (manager) => {
        const existing = await manager.findOne(MerchantPaymentProfile, {
          where: { merchantId, provider }, lock: { mode: 'pessimistic_write' },
        });
        if (existing && existing.externalMerchantNo !== externalMerchantNo) {
          throw new ConflictException('外部商户号创建后不可修改；如填写错误，请联系平台安全管理员处理');
        }
        if (existing?.status === MerchantPaymentProfileStatus.ACTIVE && existing.providerMerchantId !== providerMerchantId) {
          throw new ConflictException('已启用档案不能直接更换商户号，请先停用后再修改');
        }
        const existingAppletAppId = String(existing?.wxAppletAppId || '').trim();
        if (existingAppletAppId && existingAppletAppId !== wxAppletAppId) {
          throw new ConflictException('汇付微信小程序 APPID 配置成功后不可修改或删除');
        }
        // H1：汇付绑定（外部 HTTP 20s）不再在事务内执行——事务只负责落库，绑定移出到提交后，
        // 避免外部调用持有档案行锁、且外部副作用不随事务回滚
        // （bindNote/bindApplyNo 在事务回调外声明，见上方函数作用域）
        // 供事务提交后判断是否真正需要重新提交绑定申请（见下方 needHuifuBind）
        existedBefore = Boolean(existing);
        existingProviderMerchantId = String(existing?.providerMerchantId || '').trim();
        existingHadApplyNo = Boolean(existing && String(existing.applicationNo || '').trim());
        existingHadAppletAppId = Boolean(existingAppletAppId);
        // 汇付直连凭据：该商户自己的系统号/产品号/私钥（加密）/汇付公钥/费率类型
        let huifuPrivateKeyEnc = existing?.huifuPrivateKeyEnc || '';
        if (input.huifuPrivateKey && input.huifuPrivateKey.trim()) {
          huifuPrivateKeyEnc = this.sensitiveData.encrypt(input.huifuPrivateKey.trim());
        }
        // 天阙直连凭据：该商户自己的 mno/orgId/私钥（加密）/天阙公钥/签名算法
        let tianquePrivateKeyEnc = existing?.tianquePrivateKeyEnc || '';
        if (input.tianquePrivateKey && input.tianquePrivateKey.trim()) {
          tianquePrivateKeyEnc = this.sensitiveData.encrypt(input.tianquePrivateKey.trim());
        }
        // 微信直连凭据：该商户自己的 mchid/appid/APIv3Key/证书序列号/私钥/微信公钥
        let wechatApiV3KeyEnc = existing?.wechatApiV3KeyEnc || '';
        if (input.wechatApiV3Key && input.wechatApiV3Key.trim()) {
          wechatApiV3KeyEnc = this.sensitiveData.encrypt(input.wechatApiV3Key.trim());
        }
        let wechatPrivateKeyEnc = existing?.wechatPrivateKeyEnc || '';
        if (input.wechatPrivateKey && input.wechatPrivateKey.trim()) {
          wechatPrivateKeyEnc = this.sensitiveData.encrypt(input.wechatPrivateKey.trim());
        }
        if (provider !== 'HUIFU') {
          huifuPrivateKeyEnc = '';
        }
        if (provider !== 'TIANQUE') {
          tianquePrivateKeyEnc = '';
        }
        if (provider !== 'WECHAT_DIRECT') {
          wechatApiV3KeyEnc = '';
          wechatPrivateKeyEnc = '';
        }
        const before = existing ? this.auditSnapshot(existing) : null;
        const accountChanged = Boolean(existing && existing.providerMerchantId !== providerMerchantId);
        const profile = existing || manager.create(MerchantPaymentProfile, {
          merchantId, provider, externalMerchantNo, version: 0, createdAt: new Date(),
        });
        profile.providerMerchantId = providerMerchantId;
        profile.applicationNo = bindApplyNo || applicationNo;
        profile.wxAppletAppId = wxAppletAppId;
        profile.huifuSysId = (provider === 'HUIFU' && (input.huifuSysId?.trim() || providerMerchantId || '')) || '';
        profile.huifuProductId = (provider === 'HUIFU' && input.huifuProductId?.trim()) || '';
        profile.huifuPrivateKeyEnc = huifuPrivateKeyEnc;
        profile.huifuMerchantPublicKey = (provider === 'HUIFU' && input.huifuMerchantPublicKey?.trim()) || '';
        profile.huifuPublicKey = (provider === 'HUIFU' && input.huifuPublicKey?.trim()) || '';
        profile.huifuFeeType = (provider === 'HUIFU' && input.huifuFeeType?.trim()) || '';
        profile.tianqueMno = (provider === 'TIANQUE' && input.tianqueMno?.trim()) || '';
        profile.tianqueOrgId = (provider === 'TIANQUE' && input.tianqueOrgId?.trim()) || '';
        profile.tianquePrivateKeyEnc = tianquePrivateKeyEnc;
        profile.tianquePublicKey = (provider === 'TIANQUE' && input.tianquePublicKey?.trim()) || '';
        profile.tianqueSignAlg = (provider === 'TIANQUE' && input.tianqueSignAlg?.trim()) || 'sha256';
        profile.wechatMchid = (provider === 'WECHAT_DIRECT' && input.wechatMchid?.trim()) || '';
        profile.wechatAppId = (provider === 'WECHAT_DIRECT' && input.wechatAppId?.trim()) || '';
        profile.wechatApiV3KeyEnc = wechatApiV3KeyEnc;
        profile.wechatCertSerialNo = (provider === 'WECHAT_DIRECT' && input.wechatCertSerialNo?.trim()) || '';
        profile.wechatPrivateKeyEnc = wechatPrivateKeyEnc;
        profile.wechatPublicKey = (provider === 'WECHAT_DIRECT' && input.wechatPublicKey?.trim()) || '';
        profile.status = input.status;
        // H-01/H1：绑定结果在事务提交后校验，此处不再检查（bindNote 此时为空）
        profile.version = Math.max(0, profile.version || 0) + 1;
        profile.updatedBy = user.id;
        if (input.status === MerchantPaymentProfileStatus.ACTIVE) {
          profile.verifiedBy = user.id;
          profile.verifiedAt = new Date();
        } else if (accountChanged || !existing) {
          profile.verifiedBy = null;
          profile.verifiedAt = null;
        }
        const result = await manager.save(MerchantPaymentProfile, profile);
        await this.auditWriter.write(
          user.id, merchantId,
          input.status === MerchantPaymentProfileStatus.ACTIVE ? 'MERCHANT_PAYMENT_PROFILE_ACTIVATED' : submittedByAgency ? 'MERCHANT_PAYMENT_PROFILE_SUBMITTED' : 'MERCHANT_PAYMENT_PROFILE_UPDATED',
          'MerchantPaymentProfile', result.id, before, this.auditSnapshot(result), manager,
        );
        return { profile: result, bindNote };
      });
      // H1：事务提交后再执行汇付绑定（外部调用不占行锁），结果单独回写档案
      // 仅在「新建档案」或「尚无申请单号」或「此前未配置过 APPID」或「更换了商户号(huifu_id)」或
      // 「用户主动清空申请单号（强制重绑）」时才向汇付提交绑定申请，
      // 避免每次保存参数都重复提交 busi/config（每保存一次 = 汇付侧新增一张申请单）。
      const huifuAccountChanged = existedBefore && existingProviderMerchantId !== String(providerMerchantId || '').trim();
      const huifuForceRebind = existedBefore && existingHadApplyNo && !applicationNo;
      const needHuifuBind = provider === 'HUIFU' && wxAppletAppId && providerMerchantId
        && (!existedBefore || !existingHadApplyNo || !existingHadAppletAppId || huifuAccountChanged || huifuForceRebind);
      if (needHuifuBind) {
        const bindResult = await this.huifu.bindAppletAppId(providerMerchantId, wxAppletAppId);
        bindApplyNo = bindResult.applyNo || '';
        bindNote = bindResult.note;
        // H-01：绑定失败（未完成/20002）且请求为启用收款时，回退档案状态并拒绝
        if (input.status === MerchantPaymentProfileStatus.ACTIVE && bindNote && (bindNote.includes('未完成') || bindNote.includes('20002'))) {
          await this.profiles.update({ id: savedResult.profile.id }, { status: MerchantPaymentProfileStatus.PENDING, verifiedBy: null, verifiedAt: null });
          throw new BadRequestException(`汇付小程序 APPID 绑定未完成，暂不能启用收款：${bindNote}`);
        }
        // 回写申请单号（若绑定返回了 apply_no）
        if (bindApplyNo) {
          await this.profiles.update({ id: savedResult.profile.id }, { applicationNo: bindApplyNo });
        }
      }
      const savedView = this.view(savedResult.profile, merchantId);
      return { ...savedView, bindNote };
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new ConflictException('外部商户号或商户号已绑定其他商家');
      throw error;
    }
  }

  /**
   * 查询商家汇付绑定申请审核状态（供代理端/平台端可视化展示）。
   * 只读：调汇付申请单状态查询接口，不产生任何写操作。
   */
  async huifuBindStatus(user: User, merchantId: string) {
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '查看商家汇付绑定状态', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const profile = await this.profiles.findOne({ where: { merchantId, provider: 'HUIFU' } });
    if (!profile) {
      return { provider: 'HUIFU', configured: false, wxAppletAppId: '', applyNo: null, applyStatus: null, note: '该商家尚未配置汇付通道', checkedAt: new Date().toISOString() };
    }
    const result = await this.huifu.queryBindStatus(profile.providerMerchantId || '', profile.applicationNo || '');
    return {
      provider: 'HUIFU',
      configured: true,
      wxAppletAppId: profile.wxAppletAppId || '',
      ...result,
    };
  }

  /** 下单时解析商家支付路由：按档案配置走对应通道，无档案默认微信直连 */
  async activeRoute(manager: EntityManager, merchantId: string): Promise<ActivePaymentRoute> {    const profile = await manager.findOne(MerchantPaymentProfile, {
      where: { merchantId, status: MerchantPaymentProfileStatus.ACTIVE },
      order: { updatedAt: 'DESC' },
    });
    // 微信直连：全局商户号
    const wechatMchid = String(process.env.WECHATPAY_MCHID || '').trim();
    if (!profile) {
      if (!wechatMchid) throw new ServiceUnavailableException('微信直连支付未配置商户号');
      return { provider: 'WECHAT_DIRECT', paymentProfileId: '', providerMerchantId: wechatMchid };
    }
    const provider = this.normalizeProvider(profile.provider);
    if (provider === 'WECHAT_DIRECT') {
      if (!wechatMchid) throw new ServiceUnavailableException('微信直连支付未配置商户号');
      return { provider: 'WECHAT_DIRECT', paymentProfileId: profile.id, providerMerchantId: wechatMchid };
    }
    if (!profile.providerMerchantId) throw new ServiceUnavailableException('该商家的支付通道商户号尚未配置');
    return { provider, paymentProfileId: profile.id, providerMerchantId: profile.providerMerchantId };
  }

  /** 兼容旧逻辑：按指定 provider 查激活档案（未使用则保留） */
  async activeRouteByProvider(manager: EntityManager, merchantId: string, provider: string): Promise<ActivePaymentRoute> {
    const normalized = this.normalizeProvider(provider);
    const profile = await manager.findOneBy(MerchantPaymentProfile, { merchantId, provider: normalized, status: MerchantPaymentProfileStatus.ACTIVE });
    if (!profile?.providerMerchantId) throw new ServiceUnavailableException('该商家的支付通道档案尚未启用');
    return { provider: profile.provider, paymentProfileId: profile.id, providerMerchantId: profile.providerMerchantId };
  }

  suggestedExternalMerchantNo(merchantId: string): string {
    return `XYM_${merchantId.replace(/-/g, '').slice(0, 24).toUpperCase()}`;
  }

  /** 查该商家最新一条支付通道档案（任意通道，取最近更新的） */
  private latestProfile(merchantId: string): Promise<MerchantPaymentProfile | null> {
    return this.profiles.findOne({ where: { merchantId }, order: { updatedAt: 'DESC' } });
  }

  /** 统一 provider 标识（小写转大写，兼容历史 HUIFU 记录） */
  private normalizeProvider(provider: string): PaymentChannel {
    const normalized = String(provider || '').toUpperCase();
    if (normalized === 'WECHAT_DIRECT' || normalized === 'WECHAT') return 'WECHAT_DIRECT';
    if (normalized === 'HUIFU' || normalized === 'HUIFU_PAY') return 'HUIFU';
    if (normalized === 'TIANQUE' || normalized === 'TIANQUE_PAY') return 'TIANQUE';
    return 'WECHAT_DIRECT';
  }

  private profileView(profile: MerchantPaymentProfile): MerchantPaymentProfileView['profile'] {
    return {
      id: profile.id, merchantId: profile.merchantId, provider: profile.provider,
      externalMerchantNo: profile.externalMerchantNo, providerMerchantId: profile.providerMerchantId,
      applicationNo: profile.applicationNo, wxAppletAppId: profile.wxAppletAppId || '',
      huifuSysId: profile.huifuSysId || '',
      huifuProductId: profile.huifuProductId || '',
      hasHuifuPrivateKey: Boolean(profile.huifuPrivateKeyEnc),
      huifuMerchantPublicKeyPreview: profile.huifuMerchantPublicKey ? `${profile.huifuMerchantPublicKey.slice(0, 24)}…` : '',
      huifuPublicKeyPreview: profile.huifuPublicKey ? `${profile.huifuPublicKey.slice(0, 24)}…` : '',
      huifuFeeType: profile.huifuFeeType || '',
      tianqueMno: profile.tianqueMno || '',
      tianqueOrgId: profile.tianqueOrgId || '',
      hasTianquePrivateKey: Boolean(profile.tianquePrivateKeyEnc),
      tianqueSignAlg: profile.tianqueSignAlg || 'sha256',
      wechatMchid: profile.wechatMchid || '',
      wechatAppId: profile.wechatAppId || '',
      hasWechatCredentials: Boolean(profile.wechatApiV3KeyEnc && profile.wechatPrivateKeyEnc),
      wechatCertSerialNo: profile.wechatCertSerialNo || '',
      wechatPublicKeyPreview: profile.wechatPublicKey ? `${profile.wechatPublicKey.slice(0, 24)}…` : '',
      status: profile.status, version: profile.version,
      verifiedAt: profile.verifiedAt, updatedAt: profile.updatedAt,
    };
  }

  private view(profile: MerchantPaymentProfile | null, merchantId: string): MerchantPaymentProfileView {
    return {
      profile: profile ? this.profileView(profile) : null,
      suggestedExternalMerchantNo: this.suggestedExternalMerchantNo(merchantId),
    };
  }

  private auditSnapshot(profile: MerchantPaymentProfile): Record<string, unknown> {
    return {
      provider: profile.provider, externalMerchantNo: profile.externalMerchantNo,
      providerMerchantId: profile.providerMerchantId, applicationNo: profile.applicationNo,
      wxAppletAppId: profile.wxAppletAppId || '',
      huifuSysId: profile.huifuSysId || '', huifuProductId: profile.huifuProductId || '',
      // 私钥绝不进审计快照；只记录是否已配置
      hasHuifuPrivateKey: Boolean(profile.huifuPrivateKeyEnc),
      huifuFeeType: profile.huifuFeeType || '',
      tianqueMno: profile.tianqueMno || '', hasTianquePrivateKey: Boolean(profile.tianquePrivateKeyEnc),
      status: profile.status, version: profile.version,
      verifiedAt: profile.verifiedAt,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
  }
}
