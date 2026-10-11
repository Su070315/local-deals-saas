import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Repository } from 'typeorm';
import { CUSTOMER_TOKEN_AUDIENCE, TOKEN_ISSUER } from './token-policy';
import { isLocalOrTestEnvironment } from './runtime-config';
import { CustomerProfile } from './domain/customer-profile.entities';
import { SensitiveDataService } from './sensitive-data.service';
import { WechatPlatformService } from './wechat-platform.service';

const CUSTOMER_SESSION_TTL_SECONDS = 12 * 60 * 60;

@Injectable()
export class CustomerAuthService {
  constructor(
    @InjectRepository(CustomerProfile) private readonly profiles: Repository<CustomerProfile>,
    private readonly sensitiveData: SensitiveDataService,
    private readonly wechat: WechatPlatformService,
  ) {}

  /**
   * 用 getPhoneNumber 按钮返回的 code 换取手机号（第三方平台代开发模式）。
   * 前端需带上小程序 appId，后端据此定位商家并取 authorizer_access_token。
   * 返回掩码手机号，完整号加密存库。
   */
  async exchangePhone(customerId: string, code: string, appId?: string) {
    const normalizedCode = String(code || '').trim();
    if (!normalizedCode) throw new ServiceUnavailableException('手机号授权凭证无效，请重新授权');
    const phone = await this.wechat.exchangeCustomerPhone(normalizedCode, appId);
    if (!phone) throw new ServiceUnavailableException('手机号获取失败，请重试');

    const masked = this.maskPhone(phone);
    // customerId 形如 wx:<hash>，提取稳定 openid 哈希标识
    const openidHash = this.openidHashOf(customerId);
    const existing = await this.profiles.findOneBy({ openidHash });
    if (existing) {
      existing.phoneCiphertext = this.sensitiveData.encrypt(phone);
      existing.phoneMasked = masked;
      existing.phoneAuthorizedAt = new Date();
      await this.profiles.save(existing);
    } else {
      await this.profiles.save({ openidHash, phoneCiphertext: this.sensitiveData.encrypt(phone), phoneMasked: masked, phoneAuthorizedAt: new Date() });
    }
    return { phone: masked };
  }

  /** 顾客已授权手机号掩码（无则空） */
  async cachedPhoneMasked(customerId: string): Promise<string> {
    const profile = await this.profiles.findOneBy({ openidHash: this.openidHashOf(customerId) });
    return profile?.phoneMasked || '';
  }

  /** 按顾客身份反查原始 openid（加密存储解密后返回），支付时传给汇付定位付款人 */
  async openidOf(customerId: string): Promise<string> {
    const profile = await this.profiles.findOneBy({ openidHash: this.openidHashOf(customerId) });
    const ciphertext = profile?.openidCiphertext || '';
    if (!ciphertext) return '';
    return this.sensitiveData.decrypt(ciphertext);
  }

  private openidHashOf(customerId: string): string {
    return customerId.replace(/^wx:/, '').slice(0, 64);
  }

  private maskPhone(phone: string): string {
    const str = String(phone || '').trim();
    if (str.length !== 11) return str;
    return `${str.slice(0, 3)}****${str.slice(-4)}`;
  }

  /**
   * 创建顾客微信会话。
   * 多租户：appId 必填（小程序端经 X-MiniProgram-AppId 传入），不再静默回退全局 APPID，
   * 避免不同商家小程序的顾客会话串号；merchantId 记录顾客归属商家。
   */
  async createWechatSession(code: string, appId?: string, merchantId?: string | null) {
    const normalizedCode = code.trim();
    const merchantAppId = String(appId || '').trim();
    if (!merchantAppId) {
      if (isLocalOrTestEnvironment()) return this.createDemoSession();
      throw new ServiceUnavailableException('缺少小程序 APPID，无法建立顾客会话（请确认小程序请求携带 X-MiniProgram-AppId）');
    }
    if (!normalizedCode) throw new ServiceUnavailableException('微信登录凭证无效，请重新打开小程序');
    // 第三方平台代开发模式：用 component_access_token 换 openid，不需要商家小程序 AppSecret
    const openid = await this.wechat.exchangeCustomerOpenid(normalizedCode, merchantAppId);
    const openidHash = createHash('sha256').update(`wechat-openid:${openid}`).digest('base64url');
    // 保存原始 openid（加密）：JSAPI 支付需把它传给汇付定位付款人，前端只持有哈希标识
    await this.profiles.upsert(
      { openidHash, openidCiphertext: this.sensitiveData.encrypt(openid), appId: merchantAppId, merchantId: merchantId || null },
      { conflictPaths: ['openidHash'] },
    );
    const subject = `wx:${openidHash}`;
    return this.createSession(subject);
  }

  createDemoSession() {
    if (!isLocalOrTestEnvironment() || process.env.ENABLE_DEMO_CUSTOMER_AUTH === 'false') {
      throw new ForbiddenException('演示顾客登录仅允许本地或测试环境');
    }
    return this.createSession(`demo-${randomUUID()}`);
  }

  private createSession(subject: string) {
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_SECONDS * 1000);
    const token = jwt.sign(
      { sub: subject, scope: 'CUSTOMER' },
      process.env.JWT_SECRET || 'dev-jwt-secret',
      { issuer: TOKEN_ISSUER, audience: CUSTOMER_TOKEN_AUDIENCE, expiresIn: CUSTOMER_SESSION_TTL_SECONDS },
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }
}
