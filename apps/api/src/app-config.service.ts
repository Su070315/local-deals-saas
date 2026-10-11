import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { DealPackage, Merchant, MerchantBanner, MerchantTemplateConfig, PackageStatus, Store, User } from './domain/entities';
import { MerchantAppConfig } from './domain/app-config.entities';
import { MerchantBusinessSetting, MemberProfile, MemberStatus, MerchantSettingType } from './domain/merchant-operations.entities';
import { WechatAuthorizer, WechatAuthorizerStatus } from './domain/wechat-platform.entities';
import { MerchantAccessService } from './merchant-access.service';
import { isLocalOrTestEnvironment } from './runtime-config';

const DEFAULT_PRIMARY_COLOR = '#07C160';
const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const DEFAULT_PAGE_SECTIONS = {
  home: [
    { key: 'hero', label: '顶部品牌横幅', description: '品牌名称、评分、主标题、副标题、封面图。', visible: true, order: 1, locked: true },
    { key: 'search', label: '搜索框', description: '顾客搜索团购套餐。', visible: true, order: 2 },
    { key: 'categories', label: '分类标签', description: '按商品标签生成分类横向滚动。', visible: true, order: 3 },
    { key: 'nav', label: '快捷入口', description: '预约、券包、导航、电话等入口。', visible: true, order: 4 },
    { key: 'banner', label: '轮播图', description: '活动 Banner，可填多张 COS 图片 URL。', visible: false, order: 5 },
    { key: 'coupon', label: '优惠券', description: '开启优惠券功能后展示领券区。', visible: false, order: 6 },
    { key: 'store', label: '门店信息', description: '展示可售门店位置与营业时间。', visible: false, order: 7 },
    { key: 'merchant', label: '商家介绍', description: '展示商家简介、标签和联系方式。', visible: false, order: 8 },
    { key: 'richText', label: '图文内容', description: '一段商家自定义说明。', visible: false, order: 9 },
    { key: 'packages', label: '商品/团购列表', description: '从商品库读取在售商品，不能移除。', visible: true, order: 10, locked: true },
  ],
  orders: [
    { key: 'header', label: '页面标题', description: '订单页顶部标题。', visible: true, order: 1, locked: true },
    { key: 'tabs', label: '状态筛选', description: '全部、待支付、待使用、已完成、退款。', visible: true, order: 2 },
    { key: 'cards', label: '订单卡片', description: '订单号、商品图、金额、状态和操作按钮。', visible: true, order: 3, locked: true },
    { key: 'empty', label: '空状态', description: '无订单时展示引导文案。', visible: true, order: 4 },
  ],
  reservation: [
    { key: 'header', label: '页面标题', description: '预约页标题和说明。', visible: true, order: 1, locked: true },
    { key: 'store', label: '门店选择', description: '选择预约门店并展示电话/导航。', visible: true, order: 2 },
    { key: 'date', label: '日期选择', description: '默认展示最近 7 天。', visible: true, order: 3, locked: true },
    { key: 'time', label: '时间段选择', description: '使用本页配置的预约时段。', visible: true, order: 4, locked: true },
    { key: 'contact', label: '联系信息', description: '手机号授权和备注。', visible: true, order: 5 },
    { key: 'submit', label: '提交按钮', description: '底部预约提交按钮。', visible: true, order: 6, locked: true },
  ],
  profile: [
    { key: 'hero', label: '会员头部', description: '头像、欢迎语、绑定手机号。', visible: true, order: 1, locked: true },
    { key: 'orders', label: '快捷入口', description: '订单、券包、预约快捷入口。', visible: true, order: 2 },
    { key: 'service', label: '客户服务', description: '联系商家、客服中心、门店导航。', visible: true, order: 3 },
    { key: 'legal', label: '协议入口', description: '隐私政策、用户协议。', visible: true, order: 4 },
    { key: 'contact', label: '微信客服', description: '微信官方客服会话按钮。', visible: true, order: 5 },
    { key: 'footer', label: '底部版本', description: '小程序版本与商家名称。', visible: true, order: 6 },
  ],
  productDetail: [
    { key: 'cover', label: '商品头图', description: '商品封面轮播或占位图。', visible: true, order: 1 },
    { key: 'price', label: '价格卡片', description: '价格、原价、标签、标题、有效期。', visible: true, order: 2, locked: true },
    { key: 'contents', label: '套餐内容', description: '商品内容清单。', visible: true, order: 3 },
    { key: 'intro', label: '商品介绍', description: '商品描述。', visible: true, order: 4 },
    { key: 'rules', label: '购买须知', description: '购买/使用规则。', visible: true, order: 5 },
    { key: 'actions', label: '门店/电话', description: '详情页快捷联系按钮。', visible: true, order: 6 },
    { key: 'checkout', label: '购买弹层', description: '数量、备注、手机号授权、确认支付。', visible: true, order: 7, locked: true },
  ],
  vouchers: [
    { key: 'header', label: '页面标题', description: '券包页标题和返回按钮。', visible: true, order: 1, locked: true },
    { key: 'tabs', label: '状态 Tab', description: '未使用、已使用、已过期、退款。', visible: true, order: 2 },
    { key: 'cards', label: '券卡列表', description: '团购券金额、有效期、按钮。', visible: true, order: 3, locked: true },
    { key: 'codePopup', label: '核销码弹层', description: '券码、二维码、复制券码。', visible: true, order: 4, locked: true },
    { key: 'empty', label: '空状态', description: '无券时提示文案。', visible: true, order: 5 },
  ],
};

@Injectable()
export class AppConfigService {
  constructor(
    @InjectRepository(MerchantAppConfig) private readonly configs: Repository<MerchantAppConfig>,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(DealPackage) private readonly packages: Repository<DealPackage>,
    @InjectRepository(WechatAuthorizer) private readonly authorizers: Repository<WechatAuthorizer>,
    @InjectRepository(MerchantBanner) private readonly banners: Repository<MerchantBanner>,
    @InjectRepository(MerchantBusinessSetting) private readonly businessSettings: Repository<MerchantBusinessSetting>,
    @InjectRepository(MemberProfile) private readonly members: Repository<MemberProfile>,
    @InjectRepository(MerchantTemplateConfig) private readonly templateConfigs: Repository<MerchantTemplateConfig>,
    private readonly merchantAccess: MerchantAccessService,
  ) {}

  /** 商家端读取自己的配置（未保存过则返回默认组装配置） */
  async getMerchantConfig(user: User, merchantId: string) {
    const merchant = await this.merchantAccess.getForUser(user, merchantId);
    const saved = await this.configs.findOneBy({ merchantId });
    if (saved) return { configVersion: saved.configVersion, config: await this.composeRuntimeConfig(merchant, saved.config), saved: true };
    const config = await this.composeRuntimeConfig(merchant);
    return { configVersion: 1, config, saved: false };
  }

  /** 商家端保存配置 */
  async saveMerchantConfig(user: User, merchantId: string, config: Record<string, unknown>) {
    const merchant = await this.merchantAccess.getForUser(user, merchantId);
    if (!config || typeof config !== 'object') throw new BadRequestException('配置格式不正确');
    const persistable = this.persistableConfig(config, merchant);
    const existing = await this.configs.findOneBy({ merchantId });
    if (existing) {
      existing.config = persistable;
      existing.configVersion += 1;
      existing.updatedBy = user.id;
      await this.configs.save(existing);
      return { configVersion: existing.configVersion, saved: true };
    }
    const created = await this.configs.save({
      merchantId,
      config: persistable,
      configVersion: 1,
      updatedBy: user.id,
    });
    return { configVersion: created.configVersion, saved: true };
  }

  /** 商家端图片素材上传：后端只签发 COS 直传 URL，不接收图片内容，不暴露 Secret。 */
  async createImageUploadUrl(user: User, merchantId: string, body: { fileName?: string; contentType?: string; size?: number; slot?: string }) {
    await this.merchantAccess.getForUser(user, merchantId);
    const contentType = String(body.contentType || '').toLowerCase();
    const size = Number(body.size || 0);
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException('只允许上传 JPG、PNG、WEBP、GIF 图片');
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_SIZE_BYTES) {
      throw new BadRequestException('图片大小必须在 1B 到 8MB 之间');
    }

    const secretId = String(process.env.TENCENT_COS_SECRET_ID || '').trim();
    const secretKey = String(process.env.TENCENT_COS_SECRET_KEY || '').trim();
    const bucket = String(process.env.TENCENT_COS_BUCKET || '').trim();
    const region = String(process.env.TENCENT_COS_REGION || '').trim();
    if (!secretId || !secretKey || !bucket || !region) {
      throw new ServiceUnavailableException('腾讯云 COS 上传未配置，请先在服务器环境变量中配置 COS Secret、Bucket 和 Region');
    }

    const expiresInSeconds = 10 * 60;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = nowSeconds - 60;
    const endSeconds = nowSeconds + expiresInSeconds;
    const extension = this.imageExtension(contentType, body.fileName);
    const slot = this.safePathPart(body.slot || 'asset');
    const objectKey = [
      'merchant-assets',
      merchantId,
      slot,
      new Date().toISOString().slice(0, 7),
      `${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`,
    ].join('/');
    const host = `${bucket}.cos.${region}.myqcloud.com`;
    const signTime = `${startSeconds};${endSeconds}`;
    const authQuery = this.createCosAuthorizationQuery({
      secretId,
      secretKey,
      method: 'put',
      host,
      objectKey,
      signTime,
    });
    const uploadUrl = `https://${host}/${objectKey}?${authQuery}`;
    const publicBaseUrl = String(process.env.TENCENT_COS_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    const publicUrl = publicBaseUrl ? `${publicBaseUrl}/${objectKey}` : `https://${host}/${objectKey}`;

    return {
      method: 'PUT',
      uploadUrl,
      publicUrl,
      objectKey,
      expiresAt: new Date(endSeconds * 1000).toISOString(),
      maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
      headers: { 'Content-Type': contentType },
      /** filing（备案敏感资料）为私有文件：publicUrl 不可匿名访问，需经代理接口获取临时签名 URL */
      private: slot === 'filing',
    };
  }

  /** 生成 COS 对象临时签名 GET URL（私有文件经登录校验后返回给前端展示）。 */
  createPrivateFileAccessUrl(merchantId: string, objectKey: string): string {
    const secretId = String(process.env.TENCENT_COS_SECRET_ID || '').trim();
    const secretKey = String(process.env.TENCENT_COS_SECRET_KEY || '').trim();
    const bucket = String(process.env.TENCENT_COS_BUCKET || '').trim();
    const region = String(process.env.TENCENT_COS_REGION || '').trim();
    if (!secretId || !secretKey || !bucket || !region) throw new ServiceUnavailableException('腾讯云 COS 未配置');
    const host = `${bucket}.cos.${region}.myqcloud.com`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = nowSeconds - 60;
    const endSeconds = nowSeconds + 10 * 60; // 10 分钟有效
    const signTime = `${startSeconds};${endSeconds}`;
    const authQuery = this.createCosAuthorizationQuery({ secretId, secretKey, method: 'get', host, objectKey, signTime });
    return `https://${host}/${objectKey}?${authQuery}`;
  }

  /** 把已上传的 COS 对象设为私有 ACL，使其不再匿名可读（用官方 SDK，避免手写签名踩坑）。 */
  async makeObjectPrivate(objectKey: string): Promise<void> {
    const secretId = String(process.env.TENCENT_COS_SECRET_ID || '').trim();
    const secretKey = String(process.env.TENCENT_COS_SECRET_KEY || '').trim();
    const bucket = String(process.env.TENCENT_COS_BUCKET || '').trim();
    const region = String(process.env.TENCENT_COS_REGION || '').trim();
    if (!secretId || !secretKey || !bucket || !region) throw new ServiceUnavailableException('腾讯云 COS 未配置');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const COS = require('cos-nodejs-sdk-v5') as new (options: { SecretId: string; SecretKey: string }) => { putObjectAcl: (params: unknown, cb: (err: Error | null, data: unknown) => void) => void };
    const cos = new COS({ SecretId: secretId, SecretKey: secretKey });
    await new Promise<void>((resolve, reject) => {
      cos.putObjectAcl({ Bucket: bucket, Region: region, Key: objectKey, ACL: 'private' }, (err) => {
        if (err) reject(new ServiceUnavailableException(`设置文件私有权限失败：${err.message}`));
        else resolve();
      });
    });
  }

  /** 小程序端 bootstrap：按 appId/tenantCode/merchantId 找商家，返回配置 */
  async bootstrap(appId: string | undefined, tenantCode: string | undefined, merchantIdHint: string | undefined, knownVersion: string | undefined) {
    const merchant = await this.resolveMerchant(appId, tenantCode, merchantIdHint);

    const saved = await this.configs.findOneBy({ merchantId: merchant.id });
    const config = await this.composeRuntimeConfig(merchant, saved?.config);

    const version = String(saved?.configVersion || 1);
    if (knownVersion && knownVersion === version) return { notModified: true };
    // 品牌主页配置（商家后台「品牌主页」可改）：首页大标题等实时下发，避免"改了没反应"
    const templateConfig = await this.templateConfigs.findOne({
      where: { merchantId: merchant.id },
      order: { version: 'DESC' },
      select: { homeTitle: true, homeSubtitle: true, featuredPackageId: true },
    });
    // 商品分类（商家后台「分类管理」创建，启用态）：首页 tabs 实时同步，无需商家额外配置
    const categories = await this.businessSettings.find({
      where: { merchantId: merchant.id, type: MerchantSettingType.PRODUCT_CATEGORY, status: 'ACTIVE' },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
      select: { id: true, name: true, sortOrder: true },
    });
    // 预约项目（商家后台「预约项目」创建，启用态）：首页在线预约卡片展示
    const reservationSettings = await this.businessSettings.find({
      where: { merchantId: merchant.id, type: MerchantSettingType.RESERVATION_PROJECT, status: 'ACTIVE' },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
      select: { id: true, name: true, description: true, config: true, sortOrder: true },
    });
    const reservationProjects = reservationSettings.map((project) => {
      const configValue = project.config && typeof project.config === 'object' && typeof (project.config as { value?: unknown }).value === 'string' ? (project.config as { value: string }).value : '';
      const parsed = typeof configValue === 'string' && configValue.trim() ? this.safeParseConfig(configValue) : {};
      return { id: project.id, name: project.name, description: project.description || '', priceYuan: Number(parsed.price) > 0 ? Number(parsed.price) : 0, sortOrder: project.sortOrder };
    });
    return {
      ...config,
      ...(templateConfig ? {
        templateConfig: {
          homeTitle: templateConfig.homeTitle || '',
          homeSubtitle: templateConfig.homeSubtitle || '',
          featuredPackageId: templateConfig.featuredPackageId || null,
        },
      } : {}),
      categories: categories.map((category) => ({ id: category.id, name: category.name, sortOrder: category.sortOrder })),
      reservationProjects,
      configVersion: version,
    };
  }

  /** 预约项目 config.value 解析：支持 JSON（{price, desc, imageUrl}）或纯数字（价格元），解析失败返回空对象 */
  private safeParseConfig(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      const numeric = Number(raw);
      return Number.isFinite(numeric) && numeric > 0 ? { price: numeric } : {};
    }
  }

  /** C 端会员查询：按手机号（掩码匹配）查会员等级 + 商家配置的会员权益（普通会员/尊贵会员由商家在「会员列表」升级维护） */
  async publicMember(appId: string | undefined, tenantCode: string | undefined, merchantIdHint: string | undefined, phone: string | undefined) {
    const merchant = await this.resolveMerchant(appId, tenantCode, merchantIdHint);
    if (!phone || typeof phone !== 'string') {
      return { isMember: false, levelName: '', benefits: [] };
    }
    const masked = this.maskPhone(phone);
    const member = await this.members.findOneBy({ merchantId: merchant.id, phoneMasked: masked, status: MemberStatus.ACTIVE });
    const benefitsSetting = await this.businessSettings.findOne({
      where: { merchantId: merchant.id, type: MerchantSettingType.MEMBER_BENEFITS, status: 'ACTIVE' },
      order: { createdAt: 'DESC' },
    });
    const benefits = this.parseMemberBenefits(benefitsSetting);
    return {
      isMember: !!member,
      levelName: member?.level || '',
      benefits,
    };
  }

  /** 会员权益解析：config.value 支持 JSON（数组 或 {benefits:[...]}）或纯文本（每行一条 / 逗号分隔） */
  private parseMemberBenefits(setting: MerchantBusinessSetting | null): string[] {
    if (!setting) return [];
    const raw = setting.config && typeof setting.config === 'object' && typeof (setting.config as { value?: unknown }).value === 'string' ? (setting.config as { value: string }).value : '';
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((item: unknown) => typeof item === 'string' && item.trim()).slice(0, 12);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { benefits?: unknown }).benefits)) {
        return ((parsed as { benefits: unknown[] }).benefits).filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 12);
      }
    } catch {
      // 非 JSON：按行拆分
    }
    return raw.split(/\n|[,，]/).map((line: string) => line.trim()).filter(Boolean).slice(0, 12);
  }

  /** 手机号掩码：与 merchant-operations 一致（138****1234），用于 C 端会员匹配 */
  private maskPhone(value: string) {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : digits ? '***' : '';
  }

  /** 根据 tenantCode / appId / merchantId 定位商家（桌面版模板的 /public/packages、/public/orders 等接口复用） */
  async resolveMerchantId(appId: string | undefined, tenantCode: string | undefined, merchantIdHint: string | undefined): Promise<string> {
    const merchant = await this.resolveMerchant(appId, tenantCode, merchantIdHint);
    return merchant.id;
  }

  private async resolveMerchant(appId: string | undefined, tenantCode: string | undefined, merchantIdHint: string | undefined): Promise<Merchant> {
    // appId 是权威标识：已授权的小程序 appid 唯一对应一个商家。优先按 appId 定位，
    // 避免 ext 里 tenantCode 因版本差异（体验版/开发版）传错时加载错商家内容。
    if (appId) {
      const authorizer = await this.authorizers.findOneBy({ authorizerAppId: appId, status: WechatAuthorizerStatus.AUTHORIZED });
      if (authorizer) {
        const byApp = await this.merchants.findOneBy({ id: authorizer.merchantId });
        if (byApp) return byApp;
      }
    }
    let merchant: Merchant | null = null;
    if (merchantIdHint && this.isUuid(merchantIdHint)) {
      merchant = await this.merchants.findOneBy({ id: merchantIdHint });
    } else if (tenantCode && this.isUuid(tenantCode)) {
      merchant = await this.merchants.findOneBy({ id: tenantCode });
    }
    if (!merchant && isLocalOrTestEnvironment()) {
      merchant = await this.merchants.createQueryBuilder('m').where('m.status = :status', { status: 'ACTIVE' }).orderBy('m.createdAt', 'ASC').getOne();
    }
    if (!merchant) throw new NotFoundException('未找到商户配置');
    return merchant;
  }

  /** 从商家资料/商品/门店组装默认配置（与小程序模板 config 结构一致） */
  private async buildDefaultConfig(merchant: Merchant): Promise<Record<string, unknown>> {
    const [stores, packages, banners] = await Promise.all([
      this.stores.findBy({ merchantId: merchant.id, openForSale: true }),
      this.packages.createQueryBuilder('p')
        .where('p.merchantId = :merchantId AND p.status = :status', { merchantId: merchant.id, status: PackageStatus.ON_SALE })
        .orderBy('p.createdAt', 'ASC')
        .take(50)
        .getMany(),
      this.banners.find({ where: { merchantId: merchant.id }, order: { sortOrder: 'ASC' } }),
    ]);
    // 门店级 Banner 优先；storeId 为空的是迁移前商户级公共 Banner，作为无门店专属图时的兼容回退。
    type RuntimeBanner = { id: string; url: string; link: string; isDefault: boolean };
    const bannersByStore = new Map<string, RuntimeBanner[]>();
    const publicBanners: RuntimeBanner[] = [];
    for (const banner of banners) {
      const runtimeBanner: RuntimeBanner = { id: banner.id, url: banner.url, link: banner.link || '', isDefault: banner.isDefault };
      if (banner.storeId) {
        const list = bannersByStore.get(banner.storeId) || [];
        list.push(runtimeBanner);
        bannersByStore.set(banner.storeId, list);
      } else {
        publicBanners.push(runtimeBanner);
      }
    }
    const primaryColor = merchant.primaryColor || DEFAULT_PRIMARY_COLOR;
    return {
      merchant: {
        id: merchant.id,
        brandName: merchant.brandName || '本地生活',
        primaryColor,
        servicePhone: merchant.servicePhone || '',
        // FIX(2026-08-12)：评分/附加服务标签由管理端可改（merchant 表字段），不再硬编码
        rating: /^([0-4](\.[0-9])?|5(\.0)?)$/.test(String(merchant.rating || '')) ? String(merchant.rating) : '5.0',
        featureTags: Array.isArray(merchant.featureTags) ? merchant.featureTags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 12).slice(0, 12) : [],
        reviewCount: 0,
        avgPrice: 0,
        category: '团购',
        features: ['到店团购', '在线预约'],
        tags: [],
      },
      theme: {
        primaryColor,
        accentColor: '',
        backgroundColor: '#F5F5F7',
        radiusStyle: 'rounded',
        cardStyle: 'shadow',
        fontScale: 1,
        iconStyle: 'line',
      },
      hero: {
        title: merchant.brandName || '本地生活',
        subtitle: '到店团购 · 精选本地生活',
        coverImageUrl: '',
      },
      layout: {
        packageSectionTitle: '超值团购',
        bannerSubtitle: '本地精选 · 品质保证',
        sections: [
          { type: 'nav', order: 1, data: {} },
          { type: 'packages', order: 2, data: {} },
        ],
        actions: [
          { type: 'reservation', label: '预约到店', icon: 'time' },
          { type: 'vouchers', label: '我的券包', icon: 'wallet' },
          { type: 'location', label: '门店导航', icon: 'location' },
          { type: 'call', label: '电话联系', icon: 'call' },
        ],
      },
      texts: {
        appTitle: merchant.brandName || '本地生活',
        tabHome: '首页', tabOrders: '订单', tabReservation: '预约', tabProfile: '我的',
        homeSearchPlaceholder: '搜索团购套餐', homeSectionAll: '全部', homeSectionTitle: '超值团购', homeSectionSub: '本地精选 · 品质保证',
        detailTitle: '套餐详情', detailSectionContents: '套餐内容', detailSectionIntro: '套餐介绍', detailSectionRules: '购买须知', detailValidity: '有效期',
        detailBtnBuy: '立即购买', detailBtnLocation: '门店', detailBtnCall: '电话',
        detailConfirmTitle: '确认订单', detailConfirmQty: '购买数量', detailConfirmRemark: '备注', detailConfirmRemarkPlaceholder: '选填，可备注特殊需求',
        detailConfirmPhone: '手机号', detailConfirmPhoneEmpty: '下单需授权手机号', detailConfirmPhoneBtn: '授权', detailConfirmTotal: '合计', detailConfirmSubmit: '确认支付',
        ordersTitle: '我的订单', ordersTabAll: '全部', ordersTabPending: '待支付', ordersTabPaid: '待使用', ordersTabUsed: '已完成', ordersTabRefund: '退款',
        ordersBtnPay: '去支付', ordersBtnCancel: '取消订单', ordersBtnCode: '查看券码', ordersBtnRebuy: '查看详情', ordersEmpty: '暂无相关订单',
        vouchersTitle: '我的券包', vouchersTabUnused: '未使用', vouchersTabUsed: '已使用', vouchersTabExpired: '已过期', vouchersTabRefund: '退款',
        vouchersEmptyUnused: '暂无未使用的团购券', vouchersEmptyUsed: '暂无已使用的团购券', vouchersEmptyExpired: '暂无已过期的团购券', vouchersEmptyRefund: '暂无退款记录',
        vouchersBtnShowCode: '出示券码', vouchersBtnRefund: '申请退款', vouchersBtnViewCode: '查看券码', vouchersCodeTitle: '到店核销',
        vouchersCodeTip: '请向店员出示此券码进行核销', vouchersCodeCopy: '复制券码', vouchersCodeValidity: '有效期至',
        reservationTitle: '预约到店', reservationSub: '选择门店与时间，到店享受服务', reservationSectionStore: '选择门店',
        reservationSectionDate: '选择日期', reservationSectionTime: '选择时间段', reservationPhone: '手机号', reservationRemark: '备注',
        reservationRemarkPlaceholder: '选填，备注特殊需求', reservationSubmit: '提交预约',
        profileHi: 'Hi，欢迎光临', profileSectionService: '客户服务', profileItemVouchers: '我的券包', profileItemOrders: '我的订单',
        profileItemReservation: '我的预约', profileItemSupport: '客服中心', profileItemPrivacy: '隐私政策', profileItemTerms: '用户协议',
        profileSubLoggedIn: '享受超值团购体验', profileSubGuest: '绑定手机号后即可下单', profileUnbind: '点击授权手机号', profileBound: '已绑定',
        supportTitle: '客服中心', supportContactCall: '电话咨询', supportContactMessage: '联系客服',
      },
      pages: {
        home: { showSearch: true, showCategoryTabs: true, sections: DEFAULT_PAGE_SECTIONS.home },
        orders: { showTabs: true, showCoverImage: true, showCancelButton: true, showRebuyButton: true, sections: DEFAULT_PAGE_SECTIONS.orders },
        reservation: { requirePhone: true, enableRemark: true, showStoreActions: true, sections: DEFAULT_PAGE_SECTIONS.reservation },
        profile: { showBindPhone: true, showOrderShortcut: true, showVoucherShortcut: true, showReservationShortcut: true, sections: DEFAULT_PAGE_SECTIONS.profile },
        productDetail: { showTags: true, showValidity: true, showQuantity: true, enableRemark: true, requirePhone: true, sections: DEFAULT_PAGE_SECTIONS.productDetail },
        vouchers: { showTabs: true, showCounts: true, showRefundButton: true, showCodeCopy: true, sections: DEFAULT_PAGE_SECTIONS.vouchers },
      },
      features: { groupBuy: false, seckill: false, membership: false, coupon: false, review: false, reservation: true },
      stores: stores.map((store) => ({
        id: store.id,
        name: store.name,
        address: store.address,
        latitude: store.latitude,
        longitude: store.longitude,
        phone: store.phone,
        businessHours: store.businessHours,
        // FIX(2026-08-10)：门店头像/简介下发（商家体验增强，首页门店卡展示）
        logoUrl: store.logoUrl || '',
        description: store.description || '',
        // 总店标记/门店评分/附加服务（2026-08-12 门店级：首页按门店展示）
        isDefault: store.isDefault === true,
        rating: store.rating || '',
        featureTags: Array.isArray(store.featureTags) ? store.featureTags : [],
        // 门店级轮播图优先；旧商户级 Banner 仅在该门店没有专属图时回退展示。
        banners: bannersByStore.get(store.id) || publicBanners,
      })),
      packages: packages.map((pkg) => ({
        id: pkg.id,
        title: pkg.title,
        description: pkg.description,
        priceFen: pkg.priceFen,
        originalPriceFen: pkg.originalPriceFen,
        coverImageUrl: pkg.coverImageUrl || '',
        emoji: '券',
        tags: pkg.tags || [],
        validFrom: pkg.validFrom ? this.day(pkg.validFrom) : '',
        validTo: pkg.validTo ? this.day(pkg.validTo) : '',
      })),
      coupons: [],
      timeSlots: [
        { key: '10:00', label: '10:00 - 11:00' },
        { key: '12:00', label: '12:00 - 13:00' },
        { key: '14:00', label: '14:00 - 15:00' },
        { key: '16:00', label: '16:00 - 17:00' },
        { key: '18:00', label: '18:00 - 19:00' },
        { key: '20:00', label: '20:00 - 21:00' },
      ],
      faq: [],
      legal: {
        privacyTitle: '隐私政策', privacyUpdatedAt: '', termsTitle: '用户协议', termsUpdatedAt: '', aboutContent: '',
        privacySections: [{ title: '一、信息收集', content: '本小程序在您使用过程中会收集微信账号信息、手机号码（经授权）、地理位置（经授权）、订单与支付信息，用于提供团购下单、到店核销、客户服务等功能。' }],
        termsSections: [{ title: '一、服务说明', content: '本小程序由商户通过微信小程序第三方平台代开发模式接入，为您提供团购商品浏览、下单、支付、到店核销等服务。' }],
      },
      assets: { packagePlaceholder: '/images/illustrations/package-placeholder.jpg', emptyState: '/images/illustrations/empty-state.png', defaultAvatar: '/images/illustrations/default-avatar.jpg' },
    };
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private imageExtension(contentType: string, fileName?: string): string {
    const mapped = IMAGE_EXTENSION_BY_CONTENT_TYPE[contentType];
    if (mapped) return mapped;
    const extension = String(fileName || '').split('.').pop()?.toLowerCase() || '';
    return /^[a-z0-9]{2,8}$/.test(extension) ? extension : 'jpg';
  }

  private safePathPart(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';
  }

  private createCosAuthorizationQuery(input: { secretId: string; secretKey: string; method: string; host: string; objectKey: string; signTime: string; urlParams?: string; headers?: Record<string, string> }): string {
    const urlParamList = input.urlParams || '';
    const headerList = ['host', ...Object.keys(input.headers || {}).map((h) => h.toLowerCase())];
    const httpString = [
      input.method.toLowerCase(),
      `/${input.objectKey}`,
      urlParamList ? `${urlParamList}=` : '',
      ...headerList.map((h) => `${h}=${h === 'host' ? input.host.toLowerCase() : String((input.headers || {})[Object.keys(input.headers || {}).find((k) => k.toLowerCase() === h) || ''] || '')}`),
      '',
    ].join('\n');
    const signKey = createHmac('sha1', input.secretKey).update(input.signTime).digest('hex');
    const stringToSign = [
      'sha1',
      input.signTime,
      createHash('sha1').update(httpString).digest('hex'),
      '',
    ].join('\n');
    const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
    return [
      ['q-sign-algorithm', 'sha1'],
      ['q-ak', input.secretId],
      ['q-sign-time', input.signTime],
      ['q-key-time', input.signTime],
      ['q-header-list', headerList.join(';')],
      ['q-url-param-list', urlParamList],
      ['q-signature', signature],
    ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  }

  private async composeRuntimeConfig(merchant: Merchant, saved?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = await this.buildDefaultConfig(merchant);
    const merged = this.mergeConfig(base, saved || {});
    const mergedMerchant = this.isRecord(merged.merchant) ? merged.merchant : {};
    // 商品、门店、轮播图、商户 ID 必须来自实时数据库，避免页面装修保存旧快照后导致小程序内容为空/过期。
    // FIX(2026-08-12)：评分/附加服务标签/服务电话同样以数据库实时值为准——
    // 否则装修配置里的旧 merchant 快照会覆盖商家刚修改的评分/标签，造成"改了没反应"。
    return {
      ...merged,
      merchant: {
        ...(base.merchant as Record<string, unknown>),
        ...mergedMerchant,
        id: merchant.id,
        brandName: merchant.brandName || String(mergedMerchant.brandName || '本地生活'),
        primaryColor: merchant.primaryColor || String((merged.theme as Record<string, unknown> | undefined)?.primaryColor || DEFAULT_PRIMARY_COLOR),
        servicePhone: merchant.servicePhone || String(mergedMerchant.servicePhone || ''),
        rating: /^([0-4](\.[0-9])?|5(\.0)?)$/.test(String(merchant.rating || '')) ? String(merchant.rating) : String(mergedMerchant.rating || '5.0'),
        featureTags: Array.isArray(merchant.featureTags) && merchant.featureTags.length
          ? merchant.featureTags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= 12).slice(0, 12)
          : (Array.isArray(mergedMerchant.featureTags) ? mergedMerchant.featureTags : []),
      },
      stores: base.stores,
      packages: base.packages,
    };
  }

  private persistableConfig(config: Record<string, unknown>, merchant: Merchant): Record<string, unknown> {
    const copy = this.mergeConfig({}, config);
    delete copy.stores;
    delete copy.packages;
    delete copy.tenant;
    delete copy.loadedAt;
    delete copy.configVersion;
    const merchantConfig = this.isRecord(copy.merchant) ? { ...copy.merchant } : {};
    merchantConfig.id = merchant.id;
    merchantConfig.brandName = merchant.brandName;
    copy.merchant = merchantConfig;
    return copy;
  }

  private mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (Array.isArray(value)) {
        output[key] = value;
        continue;
      }
      if (this.isRecord(value) && this.isRecord(output[key])) {
        output[key] = this.mergeConfig(output[key] as Record<string, unknown>, value);
        continue;
      }
      if (value !== undefined && value !== null) output[key] = value;
    }
    return output;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private day(date: Date | string): string {
    if (typeof date === 'string') return date.slice(0, 10);
    return date.toISOString().slice(0, 10);
  }
}
