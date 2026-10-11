import { CheckOutlined, DeleteOutlined, DownOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UploadOutlined, UpOutlined } from '@ant-design/icons';
import { Alert, Button, ColorPicker, Divider, Form, Input, InputNumber, Select, Space, Switch, Tag, message } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Role } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type JsonRecord = Record<string, unknown>;
type SectionType = 'banner' | 'nav' | 'packages' | 'richText' | 'store' | 'merchant' | 'coupon';
type PageKey = 'home' | 'orders' | 'reservation' | 'profile' | 'productDetail' | 'vouchers';
type TabKey = 'overview' | 'theme' | PageKey | 'assets' | 'faq' | 'legal' | 'publish';
export type ReleaseStatus = 'DRAFT' | 'COMMITTED' | 'AUDIT_SUBMITTED' | 'AUDIT_APPROVED' | 'AUDIT_REJECTED' | 'RELEASED' | 'FAILED';
export type ReleaseJob = { id: string; type: string; status: string; errorMessage?: string; createdAt?: string };
export type MiniProgramRelease = {
  id: string;
  templateId: number;
  userVersion: string;
  userDesc: string;
  status: ReleaseStatus;
  auditId?: number | null;
  trialQrUrl?: string;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  jobs?: ReleaseJob[];
};
export type WechatPublishStatus = {
  componentReady: boolean;
  authorizerAppId: string;
  authorizationStatus: string | null;
  latestRelease?: MiniProgramRelease | null;
  actions?: { canStartAuthorization?: boolean };
};
export type AuditItemDraft = {
  address: string;
  tag: string;
  firstClass: string;
  secondClass: string;
  firstId: number;
  secondId: number;
  title: string;
};

type PageSection = {
  key: string;
  label: string;
  description: string;
  visible: boolean;
  order: number;
  locked?: boolean;
};

type TextField = { path: string; label: string; placeholder?: string };
type SwitchField = { path: string; label: string; help?: string };
type UploadImage = (file: File, slot: string) => Promise<string>;
type ImageUploadTicket = {
  method?: string;
  uploadUrl: string;
  publicUrl: string;
  objectKey: string;
  expiresAt: string;
  maxSizeBytes?: number;
  headers?: Record<string, string>;
};

const SECTION_LABEL: Record<SectionType, string> = {
  banner: '轮播图',
  nav: '快捷入口',
  packages: '套餐列表',
  richText: '图文内容',
  store: '门店信息',
  merchant: '商家介绍',
  coupon: '优惠券',
};

const SECTION_TYPES: SectionType[] = ['banner', 'nav', 'richText', 'store', 'merchant', 'coupon', 'packages'];

const DEFAULT_TIME_SLOTS = [
  { key: '10:00', label: '10:00 - 11:00' },
  { key: '12:00', label: '12:00 - 13:00' },
  { key: '14:00', label: '14:00 - 15:00' },
  { key: '16:00', label: '16:00 - 17:00' },
  { key: '18:00', label: '18:00 - 19:00' },
  { key: '20:00', label: '20:00 - 21:00' },
];

const PAGE_LABELS: Record<PageKey, string> = {
  home: '首页',
  orders: '订单页',
  reservation: '预约页',
  profile: '个人中心',
  productDetail: '商品详情',
  vouchers: '券包页',
};

const PAGE_DESCRIPTIONS: Record<PageKey, string> = {
  home: '控制首页头图、搜索、快捷入口、门店/优惠券/套餐区块。',
  orders: '控制订单状态 Tab、订单卡片、按钮和空状态。',
  reservation: '控制预约门店、日期、时段、手机号授权和备注。',
  profile: '控制个人中心顶部、快捷入口、客服、协议和联系商家。',
  productDetail: '控制商品详情图、价格卡、套餐内容、购买须知和底部按钮。',
  vouchers: '控制券包状态 Tab、券卡按钮、核销码弹层和退款入口。',
};

export const RELEASE_STATUS_META: Record<ReleaseStatus, { label: string; color: string; step: number }> = {
  // FIX：步骤条已去掉「保存装修配置」，草稿/失败状态不再标记任何步骤完成（step=-1）
  DRAFT: { label: '草稿', color: 'default', step: -1 },
  COMMITTED: { label: '已上传代码', color: 'blue', step: 1 },
  AUDIT_SUBMITTED: { label: '微信审核中', color: 'gold', step: 3 },
  AUDIT_APPROVED: { label: '审核通过', color: 'green', step: 4 },
  AUDIT_REJECTED: { label: '审核驳回', color: 'red', step: 3 },
  RELEASED: { label: '已发布上线', color: 'green', step: 5 },
  FAILED: { label: '执行失败', color: 'red', step: -1 },
};

const RELEASE_JOB_LABELS: Record<string, string> = {
  COMMIT: '上传模板代码',
  TRIAL_QR: '生成体验版二维码',
  SUBMIT_AUDIT: '提交微信审核',
  QUERY_AUDIT: '查询审核结果',
  RELEASE: '发布上线',
};

export const DEFAULT_AUDIT_ITEM: AuditItemDraft = {
  address: 'pages/home/index',
  tag: '本地生活,团购,到店自取',
  firstClass: '生活服务',
  secondClass: '商超百货/团购',
  firstId: 302,
  secondId: 3022,
  title: '首页',
};

const SUPPORTED_NAV_ACTION_TYPES = new Set(['reservation', 'vouchers', 'location', 'call']);

const PAGE_SECTION_DEFAULTS: Record<PageKey, PageSection[]> = {
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

const PAGE_TEXT_FIELDS: Record<PageKey, TextField[]> = {
  home: [
    { path: 'hero.title', label: '首页主标题' },
    { path: 'hero.subtitle', label: '首页副标题' },
    { path: 'hero.coverImageUrl', label: '顶部封面图 URL', placeholder: 'https://.../cover.jpg' },
    { path: 'texts.homeSearchPlaceholder', label: '搜索框提示' },
    { path: 'texts.homeSectionAll', label: '全部分类文案' },
    { path: 'texts.homeSectionTitle', label: '商品区标题' },
    { path: 'layout.bannerSubtitle', label: '商品区副标题' },
  ],
  orders: [
    { path: 'texts.ordersTitle', label: '页面标题' },
    { path: 'texts.ordersTabAll', label: '全部 Tab' },
    { path: 'texts.ordersTabPending', label: '待支付 Tab' },
    { path: 'texts.ordersTabPaid', label: '待使用 Tab' },
    { path: 'texts.ordersTabUsed', label: '已完成 Tab' },
    { path: 'texts.ordersTabRefund', label: '退款 Tab' },
    { path: 'texts.ordersBtnPay', label: '支付按钮' },
    { path: 'texts.ordersBtnCancel', label: '取消按钮' },
    { path: 'texts.ordersBtnCode', label: '查看券码按钮' },
    { path: 'texts.ordersBtnRebuy', label: '已完成按钮' },
    { path: 'texts.ordersEmpty', label: '空状态标题' },
  ],
  reservation: [
    { path: 'texts.reservationTitle', label: '页面标题' },
    { path: 'texts.reservationSub', label: '页面说明' },
    { path: 'texts.reservationSectionStore', label: '门店区标题' },
    { path: 'texts.reservationSectionDate', label: '日期区标题' },
    { path: 'texts.reservationSectionTime', label: '时间区标题' },
    { path: 'texts.reservationPhone', label: '手机号字段' },
    { path: 'texts.reservationRemark', label: '备注字段' },
    { path: 'texts.reservationRemarkPlaceholder', label: '备注提示' },
    { path: 'texts.reservationSubmit', label: '提交按钮' },
  ],
  profile: [
    { path: 'texts.profileHi', label: '欢迎语前缀' },
    { path: 'texts.profileSubLoggedIn', label: '已绑定说明' },
    { path: 'texts.profileSubGuest', label: '未绑定说明' },
    { path: 'texts.profileUnbind', label: '绑定手机号按钮' },
    { path: 'texts.profileBound', label: '已绑定标签' },
    { path: 'texts.profileItemOrders', label: '订单入口' },
    { path: 'texts.profileItemVouchers', label: '券包入口' },
    { path: 'texts.profileItemReservation', label: '预约入口' },
    { path: 'texts.profileItemSupport', label: '客服中心入口' },
    { path: 'texts.profileItemPrivacy', label: '隐私政策入口' },
    { path: 'texts.profileItemTerms', label: '用户协议入口' },
    { path: 'texts.supportContactMessage', label: '微信客服入口' },
  ],
  productDetail: [
    { path: 'texts.detailTitle', label: '页面标题' },
    { path: 'texts.detailSectionContents', label: '套餐内容标题' },
    { path: 'texts.detailSectionIntro', label: '介绍标题' },
    { path: 'texts.detailSectionRules', label: '须知标题' },
    { path: 'texts.detailValidity', label: '有效期文案' },
    { path: 'texts.detailBtnLocation', label: '门店按钮' },
    { path: 'texts.detailBtnCall', label: '电话按钮' },
    { path: 'texts.detailBtnBuy', label: '购买按钮' },
    { path: 'texts.detailConfirmTitle', label: '确认弹层标题' },
    { path: 'texts.detailConfirmQty', label: '数量字段' },
    { path: 'texts.detailConfirmRemark', label: '备注字段' },
    { path: 'texts.detailConfirmRemarkPlaceholder', label: '备注提示' },
    { path: 'texts.detailConfirmPhone', label: '手机号字段' },
    { path: 'texts.detailConfirmPhoneEmpty', label: '手机号空提示' },
    { path: 'texts.detailConfirmPhoneBtn', label: '手机号授权按钮' },
    { path: 'texts.detailConfirmTotal', label: '合计文案' },
    { path: 'texts.detailConfirmSubmit', label: '确认支付按钮' },
  ],
  vouchers: [
    { path: 'texts.vouchersTitle', label: '页面标题' },
    { path: 'texts.vouchersTabUnused', label: '未使用 Tab' },
    { path: 'texts.vouchersTabUsed', label: '已使用 Tab' },
    { path: 'texts.vouchersTabExpired', label: '已过期 Tab' },
    { path: 'texts.vouchersTabRefund', label: '退款 Tab' },
    { path: 'texts.vouchersEmptyUnused', label: '未使用空状态' },
    { path: 'texts.vouchersEmptyUsed', label: '已使用空状态' },
    { path: 'texts.vouchersEmptyExpired', label: '已过期空状态' },
    { path: 'texts.vouchersEmptyRefund', label: '退款空状态' },
    { path: 'texts.vouchersBtnShowCode', label: '出示券码按钮' },
    { path: 'texts.vouchersBtnRefund', label: '申请退款按钮' },
    { path: 'texts.vouchersBtnViewCode', label: '查看券码按钮' },
    { path: 'texts.vouchersCodeTitle', label: '核销弹层标题' },
    { path: 'texts.vouchersCodeTip', label: '核销提示' },
    { path: 'texts.vouchersCodeCopy', label: '复制按钮' },
    { path: 'texts.vouchersCodeValidity', label: '有效期文案' },
  ],
};

const PAGE_SWITCH_FIELDS: Record<PageKey, SwitchField[]> = {
  home: [
    { path: 'pages.home.showSearch', label: '显示搜索框' },
    { path: 'pages.home.showCategoryTabs', label: '显示分类标签' },
    { path: 'features.coupon', label: '开启优惠券入口', help: '开启后首页优惠券区块才会在小程序显示。' },
    { path: 'features.reservation', label: '开启预约入口', help: '关闭后首页和个人中心会隐藏预约入口。' },
  ],
  orders: [
    { path: 'pages.orders.showTabs', label: '显示订单状态筛选' },
    { path: 'pages.orders.showCoverImage', label: '显示商品图片' },
    { path: 'pages.orders.showCancelButton', label: '允许取消待支付订单' },
    { path: 'pages.orders.showRebuyButton', label: '已完成订单显示查看/复购入口' },
  ],
  reservation: [
    { path: 'features.reservation', label: '启用预约功能' },
    { path: 'pages.reservation.requirePhone', label: '提交前要求授权手机号' },
    { path: 'pages.reservation.enableRemark', label: '显示备注输入' },
    { path: 'pages.reservation.showStoreActions', label: '显示门店电话/导航' },
  ],
  profile: [
    { path: 'pages.profile.showBindPhone', label: '显示手机号绑定' },
    { path: 'pages.profile.showOrderShortcut', label: '显示订单快捷入口' },
    { path: 'pages.profile.showVoucherShortcut', label: '显示券包快捷入口' },
    { path: 'pages.profile.showReservationShortcut', label: '显示预约快捷入口' },
  ],
  productDetail: [
    { path: 'pages.productDetail.showTags', label: '显示商品标签' },
    { path: 'pages.productDetail.showValidity', label: '显示有效期' },
    { path: 'pages.productDetail.showQuantity', label: '购买弹层显示数量选择' },
    { path: 'pages.productDetail.enableRemark', label: '购买弹层显示备注' },
    { path: 'pages.productDetail.requirePhone', label: '下单前要求授权手机号' },
  ],
  vouchers: [
    { path: 'pages.vouchers.showTabs', label: '显示券状态 Tab' },
    { path: 'pages.vouchers.showCounts', label: 'Tab 显示数量' },
    { path: 'pages.vouchers.showRefundButton', label: '未使用券显示申请退款' },
    { path: 'pages.vouchers.showCodeCopy', label: '核销弹层显示复制券码' },
  ],
};

const DEFAULT_CONFIG = (brandName: string): JsonRecord => ({
  industry: 'local_life',
  merchant: {
    id: '',
    brandName: brandName || '本地生活',
    logoUrl: '',
    primaryColor: '#07C160',
    servicePhone: '',
    rating: '5.0',
    reviewCount: 0,
    avgPrice: 0,
    category: '团购',
    features: ['到店团购', '在线预约'],
    tags: [],
  },
  theme: {
    primaryColor: '#07C160',
    accentColor: '#FF5A5F',
    backgroundColor: '#F5F5F7',
    radiusStyle: 'rounded',
    cardStyle: 'shadow',
    fontScale: 1,
    iconStyle: 'line',
  },
  hero: {
    title: brandName || '本地生活',
    subtitle: '到店团购 · 精选本地生活',
    coverImageUrl: '',
  },
  layout: {
    packageSectionTitle: '超值团购',
    bannerSubtitle: '本地精选 · 品质保证',
    sections: [
      { type: 'nav', order: 1, visible: true, data: {} },
      { type: 'packages', order: 2, visible: true, data: {} },
    ],
    actions: [
      { type: 'reservation', label: '预约到店', icon: 'time' },
      { type: 'vouchers', label: '我的券包', icon: 'wallet' },
      { type: 'location', label: '门店导航', icon: 'location' },
      { type: 'call', label: '电话联系', icon: 'call' },
    ],
  },
  texts: {
    appTitle: brandName || '本地生活',
    tabHome: '首页',
    tabOrders: '订单',
    tabReservation: '预约',
    tabProfile: '我的',
    homeSearchPlaceholder: '搜索团购套餐',
    homeSectionAll: '全部',
    homeSectionTitle: '超值团购',
    homeSectionSub: '本地精选 · 品质保证',
    detailTitle: '套餐详情',
    detailSectionContents: '套餐内容',
    detailSectionIntro: '套餐介绍',
    detailSectionRules: '购买须知',
    detailValidity: '有效期',
    detailBtnBuy: '立即购买',
    detailBtnLocation: '门店',
    detailBtnCall: '电话',
    detailConfirmTitle: '确认订单',
    detailConfirmQty: '购买数量',
    detailConfirmRemark: '备注',
    detailConfirmRemarkPlaceholder: '选填，可备注特殊需求',
    detailConfirmPhone: '手机号',
    detailConfirmPhoneEmpty: '下单需授权手机号',
    detailConfirmPhoneBtn: '授权',
    detailConfirmTotal: '合计',
    detailConfirmSubmit: '确认支付',
    ordersTitle: '我的订单',
    ordersTabAll: '全部',
    ordersTabPending: '待支付',
    ordersTabPaid: '待使用',
    ordersTabUsed: '已完成',
    ordersTabRefund: '退款',
    ordersBtnPay: '去支付',
    ordersBtnCancel: '取消订单',
    ordersBtnCode: '查看券码',
    ordersBtnRebuy: '查看详情',
    ordersEmpty: '暂无相关订单',
    vouchersTitle: '我的券包',
    vouchersTabUnused: '未使用',
    vouchersTabUsed: '已使用',
    vouchersTabExpired: '已过期',
    vouchersTabRefund: '退款',
    vouchersEmptyUnused: '暂无未使用的团购券',
    vouchersEmptyUsed: '暂无已使用的团购券',
    vouchersEmptyExpired: '暂无已过期的团购券',
    vouchersEmptyRefund: '暂无退款记录',
    vouchersBtnShowCode: '出示券码',
    vouchersBtnRefund: '申请退款',
    vouchersBtnViewCode: '查看券码',
    vouchersCodeTitle: '到店核销',
    vouchersCodeTip: '请向店员出示此券码进行核销',
    vouchersCodeCopy: '复制券码',
    vouchersCodeValidity: '有效期至',
    reservationTitle: '预约到店',
    reservationSub: '选择门店与时间，到店享受服务',
    reservationSectionStore: '选择门店',
    reservationSectionDate: '选择日期',
    reservationSectionTime: '选择时间段',
    reservationPhone: '手机号',
    reservationRemark: '备注',
    reservationRemarkPlaceholder: '选填，备注特殊需求',
    reservationSubmit: '提交预约',
    profileHi: 'Hi，欢迎光临',
    profileSubLoggedIn: '享受超值团购体验',
    profileSubGuest: '绑定手机号后即可下单',
    profileUnbind: '点击授权手机号',
    profileBound: '已绑定',
    profileItemVouchers: '我的券包',
    profileItemOrders: '我的订单',
    profileItemReservation: '我的预约',
    profileItemSupport: '客服中心',
    profileItemPrivacy: '隐私政策',
    profileItemTerms: '用户协议',
    supportTitle: '客服中心',
    supportContactCall: '电话咨询',
    supportContactMessage: '联系客服',
  },
  pages: {
    home: { showSearch: true, showCategoryTabs: true, sections: PAGE_SECTION_DEFAULTS.home },
    orders: { showTabs: true, showCoverImage: true, showCancelButton: true, showRebuyButton: true, sections: PAGE_SECTION_DEFAULTS.orders },
    reservation: { requirePhone: true, enableRemark: true, showStoreActions: true, sections: PAGE_SECTION_DEFAULTS.reservation },
    profile: { showBindPhone: true, showOrderShortcut: true, showVoucherShortcut: true, showReservationShortcut: true, sections: PAGE_SECTION_DEFAULTS.profile },
    productDetail: { showTags: true, showValidity: true, showQuantity: true, enableRemark: true, requirePhone: true, sections: PAGE_SECTION_DEFAULTS.productDetail },
    vouchers: { showTabs: true, showCounts: true, showRefundButton: true, showCodeCopy: true, sections: PAGE_SECTION_DEFAULTS.vouchers },
  },
  features: { groupBuy: false, seckill: false, membership: false, coupon: false, review: false, reservation: true },
  stores: [],
  packages: [],
  coupons: [],
  timeSlots: DEFAULT_TIME_SLOTS,
  faq: [],
  legal: {
    privacyTitle: '隐私政策',
    privacyUpdatedAt: '',
    termsTitle: '用户协议',
    termsUpdatedAt: '',
    aboutContent: '',
    privacySections: [{ title: '一、信息收集', content: '本小程序在您使用过程中会收集微信账号信息、手机号码（经授权）、地理位置（经授权）、订单与支付信息，用于提供团购下单、到店核销、客户服务等功能。' }],
    termsSections: [{ title: '一、服务说明', content: '本小程序由商户通过微信小程序第三方平台代开发模式接入，为您提供团购商品浏览、下单、支付、到店核销等服务。' }],
  },
  assets: {
    packagePlaceholder: '/images/illustrations/package-placeholder.jpg',
    emptyState: '/images/illustrations/empty-state.png',
    defaultAvatar: '/images/illustrations/default-avatar.jpg',
  },
});

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function getNested(obj: JsonRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), obj);
}

function setNested(obj: JsonRecord, path: string, value: unknown): JsonRecord {
  const keys = path.split('.');
  const result = { ...obj };
  let cursor: JsonRecord = result;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const current = cursor[keys[i]];
    cursor[keys[i]] = { ...(isRecord(current) ? current : {}) };
    cursor = cursor[keys[i]] as JsonRecord;
  }
  cursor[keys[keys.length - 1]] = value;
  return result;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  return String(value).slice(0, 16).replace('T', ' ');
}

export function releaseMeta(status?: string) {
  return RELEASE_STATUS_META[(status || 'DRAFT') as ReleaseStatus] || RELEASE_STATUS_META.DRAFT;
}

export function auditPayload(item: AuditItemDraft) {
  return {
    address: item.address.trim() || DEFAULT_AUDIT_ITEM.address,
    tag: item.tag.trim(),
    first_class: item.firstClass.trim(),
    second_class: item.secondClass.trim(),
    first_id: item.firstId,
    second_id: item.secondId,
    title: item.title.trim() || DEFAULT_AUDIT_ITEM.title,
  };
}

function mergeDeep(base: JsonRecord, override: JsonRecord): JsonRecord {
  const output: JsonRecord = { ...base };
  Object.entries(override).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      output[key] = value;
      return;
    }
    if (isRecord(value) && isRecord(base[key])) {
      output[key] = mergeDeep(base[key] as JsonRecord, value);
      return;
    }
    if (value !== undefined && value !== null) output[key] = value;
  });
  return output;
}

function mergeConfig(brandName: string, config?: JsonRecord): JsonRecord {
  const merged = mergeDeep(DEFAULT_CONFIG(brandName), config || {});
  const pages = asRecord(merged.pages);
  (Object.keys(PAGE_SECTION_DEFAULTS) as PageKey[]).forEach((pageKey) => {
    const page = asRecord(pages[pageKey]);
    const rawSections = Array.isArray(page.sections) ? page.sections as PageSection[] : [];
    const defaultSections = PAGE_SECTION_DEFAULTS[pageKey];
    const sections = defaultSections.map((fallback, index) => {
      const saved = rawSections.find((item) => item.key === fallback.key);
      return { ...fallback, ...(isRecord(saved) ? saved : {}), order: Number((saved as PageSection | undefined)?.order ?? fallback.order ?? index + 1), locked: fallback.locked };
    }).sort((left, right) => left.order - right.order).map((section, index) => ({ ...section, order: index + 1 }));
    pages[pageKey] = { ...page, sections };
  });
  return { ...merged, pages };
}

function Field({ label, children, block }: { label: string; children: ReactNode; block?: boolean }) {
  return <Form.Item label={label} style={{ marginBottom: 12, ...(block ? { display: 'block' } : {}) }}>{children}</Form.Item>;
}

function ImageUploadButton({ slot, onUpload, onUploaded }: { slot: string; onUpload?: UploadImage; onUploaded: (url: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  async function handleFile(file?: File) {
    if (!file || !onUpload) return;
    setUploading(true);
    try {
      const url = await onUpload(file, slot);
      onUploaded(url);
      message.success('图片已上传并回填');
    } catch (error) {
      message.error((error as Error).message || '图片上传失败');
    } finally {
      setUploading(false);
    }
  }
  return <>
    <input
      ref={inputRef}
      type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      style={{ display: 'none' }}
      onChange={(event) => {
        void handleFile(event.target.files?.[0]);
        event.target.value = '';
      }}
    />
    <Button icon={<UploadOutlined />} loading={uploading} disabled={!onUpload} onClick={() => inputRef.current?.click()}>上传图片</Button>
  </>;
}

function ImageUrlInput({ value, placeholder, slot, onChange, onUpload }: { value: string; placeholder?: string; slot: string; onChange: (value: string) => void; onUpload?: UploadImage }) {
  return <div className="app-config-url-row">
    <Input value={value} placeholder={placeholder || 'https://...'} onChange={(event) => onChange(event.target.value)} />
    <ImageUploadButton slot={slot} onUpload={onUpload} onUploaded={onChange} />
  </div>;
}

function isImageUrlField(path: string): boolean {
  return /(?:image|logo|avatar|placeholder|emptyState).*url|url$/i.test(path);
}

function colorValue(config: JsonRecord, path: string, fallback: string) {
  const value = getNested(config, path);
  return typeof value === 'string' && value ? value : fallback;
}

function syncHomeLayout(config: JsonRecord): JsonRecord {
  const home = asRecord(asRecord(config.pages).home);
  const sections = ((home.sections as PageSection[] | undefined) || PAGE_SECTION_DEFAULTS.home)
    .filter((item) => item.visible !== false)
    .sort((left, right) => left.order - right.order);
  const layoutSections = sections
    .map((section) => section.key)
    .filter((key): key is SectionType => SECTION_TYPES.includes(key as SectionType))
    .map((type, index) => {
      const previous = (((asRecord(config.layout).sections as Array<{ type: string; data?: JsonRecord }> | undefined) || []).find((item) => item.type === type));
      return { type, order: index + 1, visible: true, data: previous?.data || {} };
    });
  if (!layoutSections.some((item) => item.type === 'packages')) {
    layoutSections.push({ type: 'packages', order: layoutSections.length + 1, visible: true, data: {} });
  }
  return setNested(config, 'layout.sections', layoutSections);
}

function updateConfig(config: JsonRecord, path: string, value: unknown): JsonRecord {
  const next = setNested(config, path, value);
  return path.startsWith('pages.home.') ? syncHomeLayout(next) : next;
}

function ThemeForm({ config, onChange, onImageUpload }: { config: JsonRecord; onChange: (c: JsonRecord) => void; onImageUpload?: UploadImage }) {
  const theme = asRecord(config.theme);
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>主题风格</strong><span>这些会变成小程序全局 CSS 变量，影响首页、订单、预约、个人中心、详情和券包。</span></div>
    <Field label="主色"><ColorPicker value={colorValue(config, 'theme.primaryColor', '#07C160')} onChangeComplete={(c) => onChange(updateConfig(config, 'theme.primaryColor', c.toHexString()))} /></Field>
    <Field label="强调色"><ColorPicker value={colorValue(config, 'theme.accentColor', '#FF5A5F')} onChangeComplete={(c) => onChange(updateConfig(config, 'theme.accentColor', c.toHexString()))} /></Field>
    <Field label="页面背景"><ColorPicker value={colorValue(config, 'theme.backgroundColor', '#F5F5F7')} onChangeComplete={(c) => onChange(updateConfig(config, 'theme.backgroundColor', c.toHexString()))} /></Field>
    <Field label="圆角风格"><Select value={(theme.radiusStyle as string) || 'rounded'} style={{ width: '100%' }} options={[{ value: 'sharp', label: '硬朗' }, { value: 'rounded', label: '圆润' }, { value: 'pill', label: '胶囊' }]} onChange={(v) => onChange(updateConfig(config, 'theme.radiusStyle', v))} /></Field>
    <Field label="卡片风格"><Select value={(theme.cardStyle as string) || 'shadow'} style={{ width: '100%' }} options={[{ value: 'flat', label: '扁平' }, { value: 'shadow', label: '阴影' }, { value: 'bordered', label: '描边' }]} onChange={(v) => onChange(updateConfig(config, 'theme.cardStyle', v))} /></Field>
    <Field label="字体缩放"><InputNumber min={0.9} max={1.1} step={0.05} value={Number(theme.fontScale || 1)} onChange={(v) => onChange(updateConfig(config, 'theme.fontScale', v || 1))} /></Field>
    <Field label="图标风格"><Select value={(theme.iconStyle as string) || 'line'} style={{ width: '100%' }} options={[{ value: 'line', label: '线性' }, { value: 'filled', label: '填充' }]} onChange={(v) => onChange(updateConfig(config, 'theme.iconStyle', v))} /></Field>
    <Divider />
    <div className="app-config-block-title"><strong>商家展示信息</strong><span>这里是模板展示用字段；正式门店、商品仍从商品库和门店库读取。</span></div>
    <Field label="Logo URL"><ImageUrlInput value={String(getNested(config, 'merchant.logoUrl') || '')} placeholder="https://.../logo.png" slot="merchant-logo" onUpload={onImageUpload} onChange={(value) => onChange(updateConfig(config, 'merchant.logoUrl', value))} /></Field>
    <Field label="客服电话"><Input value={String(getNested(config, 'merchant.servicePhone') || '')} onChange={(e) => onChange(updateConfig(config, 'merchant.servicePhone', e.target.value))} /></Field>
    <Field label="行业/类目"><Input value={String(getNested(config, 'merchant.category') || '')} onChange={(e) => onChange(updateConfig(config, 'merchant.category', e.target.value))} /></Field>
    <Field label="评分"><Input value={String(getNested(config, 'merchant.rating') || '')} onChange={(e) => onChange(updateConfig(config, 'merchant.rating', e.target.value))} /></Field>
    <Field label="人均消费"><InputNumber min={0} value={Number(getNested(config, 'merchant.avgPrice') || 0)} onChange={(v) => onChange(updateConfig(config, 'merchant.avgPrice', v || 0))} /></Field>
  </div>;
}

function SectionNav({ config, onChange }: { config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  const actions = ((asRecord(config.layout).actions as Array<{ type: string; label: string; icon: string }> | undefined) || [])
    .filter((item) => SUPPORTED_NAV_ACTION_TYPES.has(String(item.type || '')));
  function updateAction(index: number, patch: Partial<{ label: string; icon: string; type: string }>) {
    onChange(updateConfig(config, 'layout.actions', actions.map((a, i) => i === index ? { ...a, ...patch } : a)));
  }
  function moveAction(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(updateConfig(config, 'layout.actions', next));
  }
  function addAction() {
    onChange(updateConfig(config, 'layout.actions', [...actions, { type: 'vouchers', label: '新入口', icon: 'wallet' }]));
  }
  function removeAction(index: number) {
    onChange(updateConfig(config, 'layout.actions', actions.filter((_, i) => i !== index)));
  }
  return <div className="app-config-subblock">
    <div className="app-config-subtitle">首页快捷入口</div>
    {actions.map((action, index) => (
      <Space key={`${action.type}-${index}`} className="app-config-inline-row" align="baseline" wrap>
        <Select size="small" value={action.type} style={{ width: 110 }} options={[
          { value: 'reservation', label: '预约' },
          { value: 'vouchers', label: '券包' },
          { value: 'location', label: '导航' },
          { value: 'call', label: '电话' },
        ]} onChange={(type) => updateAction(index, { type })} />
        <Input size="small" placeholder="显示文案" value={action.label} onChange={(e) => updateAction(index, { label: e.target.value })} style={{ width: 130 }} />
        <Select size="small" value={action.icon} style={{ width: 100 }} options={[
          { value: 'time', label: '时钟' },
          { value: 'wallet', label: '钱包' },
          { value: 'location', label: '位置' },
          { value: 'call', label: '电话' },
          { value: 'gift', label: '礼物' },
          { value: 'service', label: '客服' },
        ]} onChange={(icon) => updateAction(index, { icon })} />
        <Button type="text" size="small" icon={<UpOutlined />} disabled={index === 0} onClick={() => moveAction(index, -1)} />
        <Button type="text" size="small" icon={<DownOutlined />} disabled={index === actions.length - 1} onClick={() => moveAction(index, 1)} />
        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeAction(index)} />
      </Space>
    ))}
    <Button size="small" icon={<PlusOutlined />} onClick={addAction}>添加入口</Button>
  </div>;
}

function SectionDataForm({ config, onChange, onImageUpload }: { config: JsonRecord; onChange: (c: JsonRecord) => void; onImageUpload?: UploadImage }) {
  const layout = asRecord(config.layout);
  const sections = (layout.sections as Array<{ type: string; order: number; data?: JsonRecord }> | undefined) || [];
  const findSection = (type: SectionType) => sections.find((item) => item.type === type);
  const updateSectionData = (type: SectionType, data: JsonRecord) => {
    const next = sections.map((section) => section.type === type ? { ...section, data: { ...section.data, ...data } } : section);
    onChange(updateConfig(config, 'layout.sections', next));
  };
  const banner = findSection('banner');
  const richText = findSection('richText');
  const bannerImages = (banner?.data?.images as string[] | undefined) || [];
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>首页区块内容</strong><span>区块是否显示和顺序在“区块开关与排序”里控制，这里填写区块内容。</span></div>
    <Field label="轮播图片 URL（每行一张）" block>
      <Input.TextArea rows={3} value={bannerImages.join('\n')} placeholder={'https://.../banner1.jpg\nhttps://.../banner2.jpg'} onChange={(e) => updateSectionData('banner', { images: e.target.value.split('\n').map((v) => v.trim()).filter(Boolean) })} />
      <div style={{ marginTop: 8 }}>
        <ImageUploadButton slot="home-banner" onUpload={onImageUpload} onUploaded={(url) => updateSectionData('banner', { images: [...bannerImages, url] })} />
      </div>
    </Field>
    <Field label="图文内容" block>
      <Input.TextArea rows={4} value={String(richText?.data?.content || '')} placeholder="例如：本店主打本地生活精选团购，到店核销更省心。" onChange={(e) => updateSectionData('richText', { content: e.target.value })} />
    </Field>
    <SectionNav config={config} onChange={onChange} />
  </div>;
}

function PageSectionEditor({ pageKey, config, onChange }: { pageKey: PageKey; config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  const page = asRecord(asRecord(config.pages)[pageKey]);
  const sections = ((page.sections as PageSection[] | undefined) || PAGE_SECTION_DEFAULTS[pageKey])
    .slice()
    .sort((left, right) => left.order - right.order);

  function write(nextSections: PageSection[]) {
    onChange(updateConfig(config, `pages.${pageKey}.sections`, nextSections.map((section, index) => ({ ...section, order: index + 1 }))));
  }
  function toggle(index: number, visible: boolean) {
    const section = sections[index];
    if (!section || section.locked) return;
    write(sections.map((item, i) => i === index ? { ...item, visible } : item));
  }
  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[index], next[target]] = [next[target], next[index]];
    write(next);
  }
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>区块开关与排序</strong><span>只能在模板内开关和调整顺序；核心交易区块会锁定，避免商家误删导致小程序不可用。</span></div>
    <div className="app-config-page-sections">
      {sections.map((section, index) => (
        <div key={section.key} className={`app-config-page-section ${section.visible ? '' : 'is-muted'}`}>
          <div>
            <div className="app-config-page-section-title">
              <Tag color={section.visible ? 'blue' : 'default'}>{index + 1}</Tag>
              <strong>{section.label}</strong>
              {section.locked && <Tag color="gold">核心</Tag>}
            </div>
            <p>{section.description}</p>
          </div>
          <Space>
            <Switch checked={section.visible} disabled={section.locked} onChange={(checked) => toggle(index, checked)} />
            <Button type="text" size="small" icon={<UpOutlined />} disabled={index === 0} onClick={() => move(index, -1)} />
            <Button type="text" size="small" icon={<DownOutlined />} disabled={index === sections.length - 1} onClick={() => move(index, 1)} />
          </Space>
        </div>
      ))}
    </div>
  </div>;
}

function TextFieldsForm({ fields, config, onChange, onImageUpload }: { fields: TextField[]; config: JsonRecord; onChange: (c: JsonRecord) => void; onImageUpload?: UploadImage }) {
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>页面文案与图片</strong><span>商家改的是模板配置项，小程序启动后读取这些文案动态渲染。</span></div>
    <div className="app-config-field-grid">
      {fields.map((field) => (
        <Field key={field.path} label={field.label}>
          {isImageUrlField(field.path)
            ? <ImageUrlInput value={String(getNested(config, field.path) || '')} placeholder={field.placeholder || 'https://...'} slot={field.path.replace(/\./g, '-')} onUpload={onImageUpload} onChange={(value) => onChange(updateConfig(config, field.path, value))} />
            : <Input value={String(getNested(config, field.path) || '')} placeholder={field.placeholder} onChange={(e) => onChange(updateConfig(config, field.path, e.target.value))} />}
        </Field>
      ))}
    </div>
  </div>;
}

function SwitchFieldsForm({ fields, config, onChange }: { fields: SwitchField[]; config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>功能开关</strong><span>关闭后，小程序端对应入口或按钮会隐藏。</span></div>
    <div className="app-config-switch-grid">
      {fields.map((field) => (
        <label key={field.path} className="app-config-switch-card">
          <div><strong>{field.label}</strong>{field.help && <span>{field.help}</span>}</div>
          <Switch checked={getNested(config, field.path) !== false} onChange={(checked) => onChange(updateConfig(config, field.path, checked))} />
        </label>
      ))}
    </div>
  </div>;
}

function TimeSlotsForm({ config, onChange }: { config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  const slots = (config.timeSlots as Array<{ key: string; label: string }> | undefined) || [];
  function updateSlot(index: number, patch: Partial<{ key: string; label: string }>) {
    onChange(updateConfig(config, 'timeSlots', slots.map((s, i) => i === index ? { ...s, ...patch } : s)));
  }
  function removeSlot(index: number) { onChange(updateConfig(config, 'timeSlots', slots.filter((_, i) => i !== index))); }
  function addSlot() { onChange(updateConfig(config, 'timeSlots', [...slots, { key: '', label: '' }])); }
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>预约时段</strong><span>预约页会读取这里的时间段；最多建议配置 20 个。</span></div>
    {slots.map((slot, index) => (
      <Space key={`${slot.key}-${index}`} className="app-config-inline-row" align="baseline" wrap>
        <Input size="small" placeholder="开始时间 如 10:00" value={slot.key} onChange={(e) => updateSlot(index, { key: e.target.value })} style={{ width: 140 }} />
        <Input size="small" placeholder="显示文案" value={slot.label} onChange={(e) => updateSlot(index, { label: e.target.value })} style={{ width: 180 }} />
        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeSlot(index)} />
      </Space>
    ))}
    <Button size="small" icon={<PlusOutlined />} onClick={addSlot}>添加时段</Button>
  </div>;
}

function CouponsForm({ config, onChange }: { config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  const coupons = (config.coupons as Array<{ id: string; title: string; amountFen: number; thresholdFen: number; validTo: string }> | undefined) || [];
  function updateCoupon(index: number, patch: Partial<{ title: string; amountFen: number; thresholdFen: number; validTo: string }>) {
    onChange(updateConfig(config, 'coupons', coupons.map((item, i) => i === index ? { ...item, ...patch } : item)));
  }
  function removeCoupon(index: number) { onChange(updateConfig(config, 'coupons', coupons.filter((_, i) => i !== index))); }
  function addCoupon() { onChange(updateConfig(config, 'coupons', [...coupons, { id: `coupon-${Date.now()}`, title: '新人优惠券', amountFen: 500, thresholdFen: 0, validTo: '' }])); }
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>首页优惠券展示</strong><span>这是装修展示配置；后续如果接真实领券库存，需要再接营销券接口。</span></div>
    {coupons.map((coupon, index) => (
      <Space key={coupon.id || index} className="app-config-inline-row" align="baseline" wrap>
        <Input size="small" value={coupon.title} placeholder="券名称" onChange={(e) => updateCoupon(index, { title: e.target.value })} style={{ width: 180 }} />
        <InputNumber size="small" min={0} value={Math.round((coupon.amountFen || 0) / 100)} addonBefore="减" addonAfter="元" onChange={(value) => updateCoupon(index, { amountFen: Number(value || 0) * 100 })} />
        <InputNumber size="small" min={0} value={Math.round((coupon.thresholdFen || 0) / 100)} addonBefore="满" addonAfter="元" onChange={(value) => updateCoupon(index, { thresholdFen: Number(value || 0) * 100 })} />
        <Input size="small" value={coupon.validTo} placeholder="有效期至 2026-12-31" onChange={(e) => updateCoupon(index, { validTo: e.target.value })} style={{ width: 170 }} />
        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeCoupon(index)} />
      </Space>
    ))}
    <Button size="small" icon={<PlusOutlined />} onClick={addCoupon}>添加展示券</Button>
  </div>;
}

function FaqForm({ config, onChange }: { config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  const faq = (config.faq as Array<{ question: string; answer: string }> | undefined) || [];
  function updateFaq(index: number, patch: Partial<{ question: string; answer: string }>) {
    onChange(updateConfig(config, 'faq', faq.map((f, i) => i === index ? { ...f, ...patch } : f)));
  }
  function removeFaq(index: number) { onChange(updateConfig(config, 'faq', faq.filter((_, i) => i !== index))); }
  function addFaq() { onChange(updateConfig(config, 'faq', [...faq, { question: '', answer: '' }])); }
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>客服 FAQ</strong><span>客服中心常见问题。</span></div>
    {faq.map((item, index) => (
      <div key={index} className="app-config-faq-card">
        <Space className="app-config-inline-row" align="baseline">
          <Input size="small" placeholder="问题" value={item.question} onChange={(e) => updateFaq(index, { question: e.target.value })} />
          <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeFaq(index)} />
        </Space>
        <Input.TextArea size="small" rows={2} placeholder="答案" value={item.answer} onChange={(e) => updateFaq(index, { answer: e.target.value })} />
      </div>
    ))}
    <Button size="small" icon={<PlusOutlined />} onClick={addFaq}>添加问答</Button>
  </div>;
}

function AssetsForm({ config, onChange, onImageUpload }: { config: JsonRecord; onChange: (c: JsonRecord) => void; onImageUpload?: UploadImage }) {
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>素材配置</strong><span>上传后保存图片 URL，小程序模板会按商家配置动态展示。</span></div>
    <Field label="商品占位图 URL"><ImageUrlInput value={String(getNested(config, 'assets.packagePlaceholder') || '')} slot="package-placeholder" onUpload={onImageUpload} onChange={(value) => onChange(updateConfig(config, 'assets.packagePlaceholder', value))} /></Field>
    <Field label="空状态插画 URL"><ImageUrlInput value={String(getNested(config, 'assets.emptyState') || '')} slot="empty-state" onUpload={onImageUpload} onChange={(value) => onChange(updateConfig(config, 'assets.emptyState', value))} /></Field>
    <Field label="默认头像 URL"><ImageUrlInput value={String(getNested(config, 'assets.defaultAvatar') || '')} slot="default-avatar" onUpload={onImageUpload} onChange={(value) => onChange(updateConfig(config, 'assets.defaultAvatar', value))} /></Field>
    <Alert type="info" showIcon message="生产环境上传走腾讯云 COS 直传。COS 跨域规则需要允许商户端域名发起 PUT，并允许 Content-Type 请求头。" />
  </div>;
}

function LegalForm({ config, onChange }: { config: JsonRecord; onChange: (c: JsonRecord) => void }) {
  const legal = asRecord(config.legal);
  return <div className="app-config-block">
    <div className="app-config-block-title"><strong>隐私政策 / 用户协议</strong><span>每个商家主体不同，正式上线前必须替换成真实主体文本。</span></div>
    <Field label="隐私政策标题"><Input value={String(legal.privacyTitle || '')} onChange={(e) => onChange(updateConfig(config, 'legal.privacyTitle', e.target.value))} /></Field>
    <Field label="用户协议标题"><Input value={String(legal.termsTitle || '')} onChange={(e) => onChange(updateConfig(config, 'legal.termsTitle', e.target.value))} /></Field>
    <Field label="关于我们" block><Input.TextArea rows={4} value={String(legal.aboutContent || '')} onChange={(e) => onChange(updateConfig(config, 'legal.aboutContent', e.target.value))} /></Field>
  </div>;
}

function PageForm({ pageKey, config, onChange, onImageUpload }: { pageKey: PageKey; config: JsonRecord; onChange: (c: JsonRecord) => void; onImageUpload?: UploadImage }) {
  return <div>
    <Alert className="app-config-page-alert" type="info" showIcon message={`${PAGE_LABELS[pageKey]}装修`} description={PAGE_DESCRIPTIONS[pageKey]} />
    <PageSectionEditor pageKey={pageKey} config={config} onChange={onChange} />
    <SwitchFieldsForm fields={PAGE_SWITCH_FIELDS[pageKey]} config={config} onChange={onChange} />
    <TextFieldsForm fields={PAGE_TEXT_FIELDS[pageKey]} config={config} onChange={onChange} onImageUpload={onImageUpload} />
    {pageKey === 'home' && <>
      <SectionDataForm config={config} onChange={onChange} onImageUpload={onImageUpload} />
      <CouponsForm config={config} onChange={onChange} />
    </>}
    {pageKey === 'reservation' && <TimeSlotsForm config={config} onChange={onChange} />}
  </div>;
}

function Overview({ config, merchantName }: { config: JsonRecord; merchantName?: string }) {
  const theme = asRecord(config.theme);
  const primary = String(theme.primaryColor || '#07C160');
  return <div className="app-config-overview">
    <Alert type="success" showIcon message="当前实现方式：配置式页面装修" description="商户端保存一份商家专属 JSON 配置，小程序模板启动时从 /public/miniprogram/bootstrap 读取配置并动态渲染。不会让商家改源码，也不需要像素级拖拽。" />
    <div className="app-config-overview-grid">
      <div className="app-config-overview-card">
        <span>当前商家</span>
        <strong>{merchantName || String(getNested(config, 'merchant.brandName') || '本地生活')}</strong>
      </div>
      <div className="app-config-overview-card">
        <span>主题主色</span>
        <strong style={{ color: primary }}>{primary}</strong>
      </div>
      <div className="app-config-overview-card">
        <span>覆盖页面</span>
        <strong>首页 / 订单 / 预约 / 个人中心 / 详情 / 券包</strong>
      </div>
    </div>
    <div className="app-config-overview-card">
      <span>部署说明</span>
      <p>管理端保存后，后端会保存到 <code>merchant_app_configs.config</code>；小程序模板无需重新发版，用户重新进入或配置轮询刷新后即可看到新装修。</p>
    </div>
  </div>;
}

function PublishPanel({ merchantId, request, merchantName, saved, version, role }: { merchantId: string; request: Request; merchantName?: string; saved: boolean; version: number; role?: Role }) {
  const [status, setStatus] = useState<WechatPublishStatus | null>(null);
  const [releases, setReleases] = useState<MiniProgramRelease[]>([]);
  const [releaseLoadError, setReleaseLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [userVersion, setUserVersion] = useState(`1.0.${version}`);
  const [userDesc, setUserDesc] = useState('SaaS 小程序模板发布：读取商家装修配置动态渲染');
  // 仅平台/代理商可执行发布操作（上传代码/生成二维码/提交审核/发布上线），商家管理员只读查看状态与体验版二维码
  const isPlatform = role === 'PLATFORM_ADMIN' || role === 'AGENCY_ADMIN';

  const latest = releases[0] || status?.latestRelease || null;
  const meta = releaseMeta(latest?.status);
  // 授权状态用 authorizationStatus 判断（authorizerAppId 对非平台角色脱敏隐藏，不能作为依据）
  const authorized = status?.authorizationStatus === 'AUTHORIZED';

  const loadPublishState = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await request<WechatPublishStatus>(`/wechat-platform/status?merchantId=${merchantId}`);
      setStatus(nextStatus);
      try {
        const releasePage = await request<{ items: MiniProgramRelease[] }>(`/wechat-platform/releases?merchantId=${merchantId}`);
        if (!Array.isArray(releasePage.items)) throw new Error('发布记录接口返回格式异常');
        setReleases(releasePage.items);
        setReleaseLoadError('');
      } catch (error) {
        setReleaseLoadError((error as Error).message || '发布记录加载失败');
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [merchantId, request]);

  useEffect(() => { void loadPublishState(); }, [loadPublishState]);
  useEffect(() => { setUserVersion(`1.0.${version}`); }, [version]);

  async function runReleaseAction(label: string, action: () => Promise<MiniProgramRelease>) {
    setBusy(label);
    try {
      const result = await action();
      setReleases((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      message.success(`${label}已完成`);
      await loadPublishState();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return <div className="wechat-publish-panel">
    <Alert
      type={authorized ? (saved ? 'success' : 'warning') : 'warning'}
      showIcon
      message={authorized ? '微信第三方平台发布链路已接入' : '该商户还没有完成小程序授权'}
      description={authorized
        ? '这里不会复制商户代码。平台上传同一套顾客端小程序模板，微信 ext_json 写入 merchantId 与 apiBase，小程序启动后读取商家装修配置动态渲染。'
        : '请先在微信第三方平台完成授权，授权后才能上传模板代码、生成体验版二维码、提交微信审核和发布上线。'}
    />

    <div className="wechat-publish-grid">
      <section className="wechat-publish-card">
        <div className="app-config-block-title"><strong>当前发布版本</strong><span>展示最近一次微信代码发布状态。</span></div>
        <div className="wechat-publish-status">
          <div>
            <span>版本状态</span>
            <strong><Tag color={meta.color}>{meta.label}</Tag>{latest?.userVersion || '尚未上传'}</strong>
          </div>
          <div>
            <span>授权 APPID</span>
            <strong>{role === 'PLATFORM_ADMIN' || role === 'AGENCY_ADMIN' ? (status?.authorizerAppId || '待授权') : '仅平台/代理商可见'}</strong>
          </div>
          <div>
            <span>代码模板 ID</span>
            <strong>{latest?.templateId || '使用服务端默认配置'}</strong>
          </div>
          <div>
            <span>审核单号</span>
            <strong>{latest?.auditId || '-'}</strong>
          </div>
        </div>
        <div className="wechat-publish-steps">
          {['保存装修配置', '上传模板代码', '生成体验版二维码', '提交微信审核', '审核通过', '发布上线'].map((label, index) => (
            <div key={label} className={index <= meta.step ? 'done' : ''}><span>{index <= meta.step ? <CheckOutlined /> : index + 1}</span><b>{label}</b></div>
          ))}
        </div>
        {latest?.errorMessage && <Alert type="error" showIcon message="最近一次微信接口返回失败" description={latest.errorMessage} />}
        {latest?.trialQrUrl && <div className="wechat-publish-qrcode"><img src={latest.trialQrUrl} alt="小程序体验版二维码" /><span>微信扫码打开体验版</span></div>}
      </section>

      {isPlatform && (
        <section className="wechat-publish-card">
          <div className="app-config-block-title"><strong>上传模板代码</strong><span>把平台的小程序模板提交到商户授权的小程序草稿箱。</span></div>
          {!saved && <Alert className="wechat-publish-inline-alert" type="warning" showIcon message="当前装修配置尚未保存" description="请先点击右上角“保存配置”，再上传代码，避免微信体验版读取到旧配置。" />}
          <div className="app-config-field-grid">
            <Field label="微信代码模板 ID"><InputNumber min={1} precision={0} value={templateId} onChange={(value) => setTemplateId(typeof value === 'number' ? value : null)} placeholder="不填则用服务端环境变量" style={{ width: '100%' }} /></Field>
            <Field label="版本号"><Input value={userVersion} onChange={(event) => setUserVersion(event.target.value)} placeholder="例如 1.0.1" /></Field>
          </div>
          <Field label="版本说明" block><Input.TextArea rows={3} value={userDesc} onChange={(event) => setUserDesc(event.target.value)} /></Field>
          <Space wrap>
            <Button type="primary" disabled={!authorized || !saved} loading={busy === '上传模板代码'} onClick={() => void runReleaseAction('上传模板代码', () => request<MiniProgramRelease>(`/wechat-platform/releases/commit?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ templateId: templateId || undefined, userVersion, userDesc }) }))}>上传模板代码</Button>
            <Button disabled={!latest || latest.status === 'DRAFT' || latest.status === 'FAILED'} loading={busy === '生成体验版二维码'} onClick={() => void runReleaseAction('生成体验版二维码', () => request<MiniProgramRelease>(`/wechat-platform/releases/trial-qrcode?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ releaseId: latest?.id }) }))}>生成体验版二维码</Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadPublishState()}>刷新发布状态</Button>
          </Space>
        </section>
      )}

      <section className="wechat-publish-card wechat-publish-card--wide">
        <div className="app-config-block-title"><strong>操作记录</strong><span>每次调用微信接口都会落库，便于追查失败原因。提交微信审核与发布上线由代理商在「小程序注册授权」页面完成。</span></div>
        {releaseLoadError && <Alert type="error" showIcon message="发布记录加载失败" description={releases.length ? `当前保留上次成功加载的记录：${releaseLoadError}` : releaseLoadError} action={<Button size="small" onClick={() => void loadPublishState()}>重试</Button>} />}
        <div className="wechat-publish-history">
          {(latest?.jobs || []).map((job) => <div key={job.id} className="wechat-publish-history-row">
            <span>{RELEASE_JOB_LABELS[job.type] || job.type}</span>
            <Tag color={job.status === 'SUCCEEDED' ? 'green' : 'red'}>{job.status === 'SUCCEEDED' ? '成功' : '失败'}</Tag>
            <small>{formatDateTime(job.createdAt)}</small>
            {job.errorMessage && <em>{job.errorMessage}</em>}
          </div>)}
          {!latest?.jobs?.length && <div className="wechat-publish-empty">暂无发布操作记录</div>}
        </div>
      </section>
    </div>
  </div>;
}

function visibleSections(config: JsonRecord, pageKey: PageKey) {
  const page = asRecord(asRecord(config.pages)[pageKey]);
  return ((page.sections as PageSection[] | undefined) || PAGE_SECTION_DEFAULTS[pageKey])
    .filter((item) => item.visible !== false)
    .sort((left, right) => left.order - right.order);
}

function isSectionVisible(config: JsonRecord, pageKey: PageKey, key: string): boolean {
  return visibleSections(config, pageKey).some((section) => section.key === key);
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function formatFen(value: unknown, fallback = '9.90'): string {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const yuan = amount / 100;
  return yuan % 1 === 0 ? yuan.toFixed(0) : yuan.toFixed(2);
}

function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return `rgba(7, 193, 96, ${alpha})`;
  const [, r, g, b] = match;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}

function MiniIcon({ name }: { name: string }) {
  const icons: Record<string, string> = {
    home: '⌂',
    order: '▣',
    time: '◷',
    profile: '●',
    wallet: '▰',
    location: '⌖',
    call: '☎',
    service: '♧',
    lock: '▣',
    file: '▤',
    search: '⌕',
    chevron: '›',
  };
  return <span className="mini-icon">{icons[name] || '•'}</span>;
}

function MiniStatus() {
  return <>
    <div className="mini-status"><span>20:00</span><span>▱ ▰</span></div>
    <div className="mini-capsule"><span>•••</span><span>○</span></div>
  </>;
}

function MiniTabbar({ active, texts, onNavigate }: { active: PageKey; texts: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const items: Array<{ key: PageKey; icon: string; label: string }> = [
    { key: 'home', icon: 'home', label: String(texts.tabHome || '首页') },
    { key: 'orders', icon: 'order', label: String(texts.tabOrders || '订单') },
    { key: 'reservation', icon: 'time', label: String(texts.tabReservation || '预约') },
    { key: 'profile', icon: 'profile', label: String(texts.tabProfile || '我的') },
  ];
  return <div className="tabbar">
    {items.map((item) => (
      <button key={item.key} type="button" className={`tabbar__item ${active === item.key ? 'tabbar__item--active' : ''}`} onClick={() => onNavigate(item.key)}>
        <span className="tabbar__icon"><MiniIcon name={item.icon} /></span>
        <span className="tabbar__text">{item.label}</span>
      </button>
    ))}
  </div>;
}

function MiniEditable({ children, onClick, className = '' }: { children: ReactNode; onClick: () => void; className?: string }) {
  return <div className={`mini-editable ${className}`} role="button" tabIndex={0} onClick={onClick} onKeyDown={(event) => { if (event.key === 'Enter') onClick(); }}>
    {children}
  </div>;
}

function MiniPackageCard({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const assets = asRecord(config.assets);
  const packages = arrayOfRecords(config.packages);
  const pkg = packages[0] || {};
  const title = String(pkg.title || '示例到店核销套餐');
  const price = formatFen(pkg.priceFen, '9.90');
  const original = formatFen(pkg.originalPriceFen, '19.90');
  const cover = String(pkg.coverImageUrl || assets.packagePlaceholder || '/images/illustrations/package-placeholder.jpg');
  return <MiniEditable className="pkg-card fade-in-up" onClick={() => onNavigate('home')}>
    <div className="pkg-card__cover">
      <img className="pkg-card__img" src={cover} alt="" />
      <span className="pkg-card__discount">5折</span>
      <span className="pkg-card__featured">爆款</span>
    </div>
    <div className="pkg-card__body">
      <div className="pkg-card__title">{title}</div>
      <div className="pkg-card__price-row">
        <div className="pkg-card__price">
          <span className="pkg-card__price-symbol">¥</span>
          <span className="pkg-card__price-main">{price}</span>
          <span className="pkg-card__price-orig">¥{original}</span>
        </div>
        <button type="button" className="pkg-card__buy">立即购</button>
      </div>
    </div>
  </MiniEditable>;
}

function MiniHome({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const merchant = asRecord(config.merchant);
  const hero = asRecord(config.hero);
  const texts = asRecord(config.texts);
  const layout = asRecord(config.layout);
  const brandName = String(merchant.brandName || texts.appTitle || '示例生活馆');
  const actions = arrayOfRecords(layout.actions).filter((item) => SUPPORTED_NAV_ACTION_TYPES.has(String(item.type || item.key || ''))).slice(0, 4);
  return <div className="home">
    <MiniEditable className="home__hero" onClick={() => onNavigate('theme')}>
      <div className="home__hero-mask"></div>
      <div className="home__hero-content">
        <div className="home__brand">
          {merchant.logoUrl
            ? <img className="home__brand-logo" src={String(merchant.logoUrl)} alt="" />
            : <div className="home__brand-logo home__brand-logo--placeholder">{brandName.slice(0, 1)}</div>}
          <div className="home__brand-text">
            <div className="home__brand-name">{brandName}</div>
            <div className="home__brand-sub">
              <span className="home__rating">★ {String(merchant.rating || '5.0')}</span>
              <span className="home__avg">人均 ¥{String(merchant.avgPrice || '59')}</span>
              <span className="home__cat">{String(merchant.category || '本地生活')}</span>
            </div>
          </div>
        </div>
        <div className="home__hero-title">{String(hero.title || brandName)}</div>
        <div className="home__hero-subtitle">{String(hero.subtitle || '本地生活团购 · 到店核销')}</div>
      </div>
    </MiniEditable>
    {getNested(config, 'pages.home.showSearch') !== false && <MiniEditable className="home__search" onClick={() => onNavigate('home')}><div className="wx-search"><MiniIcon name="search" /><span>{String(texts.homeSearchPlaceholder || '搜索团购套餐')}</span></div></MiniEditable>}
    {getNested(config, 'pages.home.showCategoryTabs') !== false && <MiniEditable className="home__categories" onClick={() => onNavigate('home')}><span className="home__category home__category--active">{String(texts.homeSectionAll || '全部')}</span></MiniEditable>}
    {isSectionVisible(config, 'home', 'nav') && <MiniEditable className="home__actions" onClick={() => onNavigate('home')}>
      {(actions.length ? actions : [
        { type: 'reservation', label: '预约', icon: 'time' },
        { type: 'vouchers', label: '券包', icon: 'wallet' },
        { type: 'location', label: '门店', icon: 'location' },
      ]).map((action, index) => <div className="home__action" key={`${String(action.type || action.label)}-${index}`}><MiniIcon name={String(action.icon || 'time')} /><span>{String(action.label || '入口')}</span></div>)}
    </MiniEditable>}
    <MiniEditable className="home__section-title" onClick={() => onNavigate('home')}>
      <span>{String(texts.homeSectionTitle || layout.packageSectionTitle || '超值团购')}</span>
      <span className="home__section-sub">{String(layout.bannerSubtitle || texts.homeSectionSub || '示例数据 · 接入后由商家配置')}</span>
    </MiniEditable>
    <div className="home__list">
      <MiniPackageCard config={config} onNavigate={onNavigate} />
      <MiniPackageCard config={config} onNavigate={onNavigate} />
    </div>
  </div>;
}

function MiniOrders({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const texts = asRecord(config.texts);
  const assets = asRecord(config.assets);
  return <div className="orders">
    <MiniEditable className="orders__header" onClick={() => onNavigate('orders')}><div className="orders__title">{String(texts.ordersTitle || '我的订单')}</div></MiniEditable>
    {getNested(config, 'pages.orders.showTabs') !== false && isSectionVisible(config, 'orders', 'tabs') && <MiniEditable className="orders__tabs" onClick={() => onNavigate('orders')}>
      {[texts.ordersTabAll || '全部', texts.ordersTabPending || '待支付', texts.ordersTabPaid || '待使用', texts.ordersTabUsed || '已完成', texts.ordersTabRefund || '退款'].map((tab, index) => <span key={String(tab)} className={`orders__tab ${index === 0 ? 'orders__tab--active' : ''}`}>{String(tab)}</span>)}
    </MiniEditable>}
    <MiniEditable className="orders__empty" onClick={() => onNavigate('orders')}>
      <div className="empty-state">
        <img src={String(assets.emptyState || '/images/illustrations/empty-state.png')} alt="" />
        <strong>{String(texts.ordersEmpty || '暂无相关订单')}</strong>
        <p>去看看超值团购套餐</p>
        <button type="button">去逛逛</button>
      </div>
    </MiniEditable>
  </div>;
}

function MiniReservation({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const texts = asRecord(config.texts);
  const stores = arrayOfRecords(config.stores);
  const store = stores[0] || {};
  const timeSlots = arrayOfRecords(config.timeSlots).slice(0, 4);
  const dates = ['今天\n08/01', '明天\n08/02', '周一\n08/03', '周二\n08/04'];
  return <div className="reservation">
    <MiniEditable className="reservation__header" onClick={() => onNavigate('reservation')}>
      <div className="reservation__title">{String(texts.reservationTitle || '预约到店')}</div>
      <div className="reservation__sub">{String(texts.reservationSub || '选择门店与时间，到店享受服务')}</div>
    </MiniEditable>
    {isSectionVisible(config, 'reservation', 'store') && <MiniEditable className="reservation__section" onClick={() => onNavigate('reservation')}>
      <div className="reservation__section-title">{String(texts.reservationSectionStore || '选择门店')}</div>
      <div className="reservation__store">
        <div className="reservation__store-info">
          <div className="reservation__store-name">{String(store.name || '示例生活馆旗舰店')}</div>
          <div className="reservation__store-addr">{String(store.address || '示例地址')}</div>
          <div className="reservation__store-hours">营业时间：{String(store.businessHours || '10:00 - 21:00')}</div>
        </div>
        <MiniIcon name="chevron" />
      </div>
      {getNested(config, 'pages.reservation.showStoreActions') !== false && <div className="reservation__store-actions"><span className="reservation__store-action">☎ <span>{String(texts.detailBtnCall || '电话')}</span></span><span className="reservation__store-action">⌖ <span>{String(texts.detailBtnLocation || '门店')}</span></span></div>}
    </MiniEditable>}
    {isSectionVisible(config, 'reservation', 'date') && <MiniEditable className="reservation__section" onClick={() => onNavigate('reservation')}>
      <div className="reservation__section-title">{String(texts.reservationSectionDate || '选择日期')}</div>
      <div className="reservation__dates">{dates.map((date, index) => {
        const [weekday, day] = date.split('\n');
        return <span key={date} className={`reservation__date ${index === 0 ? 'reservation__date--active' : ''}`}><span className="reservation__date-weekday">{weekday}</span><span className="reservation__date-day">{day}</span></span>;
      })}</div>
    </MiniEditable>}
    {isSectionVisible(config, 'reservation', 'time') && <MiniEditable className="reservation__section" onClick={() => onNavigate('reservation')}>
      <div className="reservation__section-title">{String(texts.reservationSectionTime || '选择时间段')}</div>
      <div className="reservation__times">{(timeSlots.length ? timeSlots : [{ key: '10:00', label: '10:00 - 11:00' }, { key: '14:00', label: '14:00 - 15:00' }, { key: '16:00', label: '16:00 - 17:00' }, { key: '19:00', label: '19:00 - 20:00' }]).map((slot) => <span className="reservation__time" key={String(slot.key || slot.label)}>{String(slot.label || slot.key)}</span>)}</div>
    </MiniEditable>}
    {isSectionVisible(config, 'reservation', 'contact') && <MiniEditable className="reservation__section wx-cell-group" onClick={() => onNavigate('reservation')}>
      <div className="reservation__section-title">联系信息</div>
      <p className="wx-cell"><b>{String(texts.reservationPhone || '手机号')}</b><span>授权后用于到店核销通知</span><button className="reservation__phone-btn" type="button">授权手机号</button></p>
      {getNested(config, 'pages.reservation.enableRemark') !== false && <p className="wx-cell"><b>{String(texts.reservationRemark || '备注')}</b><span>{String(texts.reservationRemarkPlaceholder || '选填，备注特殊需求')}</span></p>}
    </MiniEditable>}
  </div>;
}

function MiniProfile({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const merchant = asRecord(config.merchant);
  const texts = asRecord(config.texts);
  const assets = asRecord(config.assets);
  const brandName = String(merchant.brandName || texts.appTitle || '示例生活馆');
  return <div className="profile">
    {isSectionVisible(config, 'profile', 'hero') && <MiniEditable className="profile__hero" onClick={() => onNavigate('profile')}>
      <div className="profile__hero-bg"></div>
      <div className="profile__hero-content">
        <div className="profile__avatar">
          {merchant.logoUrl ? <img className="profile__avatar-img" src={String(merchant.logoUrl)} alt="" /> : <img className="profile__avatar-img" src={String(assets.defaultAvatar || '/images/illustrations/default-avatar.jpg')} alt="" />}
        </div>
        <div className="profile__welcome">
          <div className="profile__hi">{String(texts.profileHi || 'Hi，欢迎')}<br />来到{brandName}</div>
          <div className="profile__sub">{String(texts.profileSubGuest || '绑定手机号后即可下单')}</div>
        </div>
        {getNested(config, 'pages.profile.showBindPhone') !== false && <button className="profile__bind-btn" type="button">{String(texts.profileUnbind || '点击授权手机号')}</button>}
      </div>
    </MiniEditable>}
    {isSectionVisible(config, 'profile', 'orders') && <MiniEditable className="profile__orders-entry" onClick={() => onNavigate('profile')}>
      {getNested(config, 'pages.profile.showOrderShortcut') !== false && <div className="profile__orders-item"><MiniIcon name="order" /><span>{String(texts.profileItemOrders || '我的订单')}</span></div>}
      {getNested(config, 'pages.profile.showVoucherShortcut') !== false && <div className="profile__orders-item"><MiniIcon name="wallet" /><span>{String(texts.profileItemVouchers || '我的券包')}</span></div>}
      {getNested(config, 'pages.profile.showReservationShortcut') !== false && <div className="profile__orders-item"><MiniIcon name="time" /><span>{String(texts.profileItemReservation || '我的预约')}</span></div>}
    </MiniEditable>}
    {isSectionVisible(config, 'profile', 'service') && <MiniEditable className="profile__section wx-cell-group" onClick={() => onNavigate('profile')}>
      <p className="wx-cell wx-cell--arrow"><MiniIcon name="call" /><b>{String(texts.detailBtnCall || '电话')}</b><span>{String(merchant.servicePhone || '400-000-0000')}</span><MiniIcon name="chevron" /></p>
      <p className="wx-cell wx-cell--arrow"><MiniIcon name="service" /><b>{String(texts.profileItemSupport || '客服中心')}</b><span></span><MiniIcon name="chevron" /></p>
      <p className="wx-cell wx-cell--arrow"><MiniIcon name="location" /><b>{String(texts.detailBtnLocation || '门店')}</b><span></span><MiniIcon name="chevron" /></p>
    </MiniEditable>}
    {isSectionVisible(config, 'profile', 'legal') && <MiniEditable className="profile__section wx-cell-group" onClick={() => onNavigate('legal')}>
      <p className="wx-cell wx-cell--arrow"><MiniIcon name="lock" /><b>{String(texts.profileItemPrivacy || '隐私政策')}</b><span></span><MiniIcon name="chevron" /></p>
      <p className="wx-cell wx-cell--arrow"><MiniIcon name="file" /><b>{String(texts.profileItemTerms || '用户协议')}</b><span></span><MiniIcon name="chevron" /></p>
    </MiniEditable>}
    {isSectionVisible(config, 'profile', 'contact') && <MiniEditable className="profile__section wx-cell-group profile__contact-btn" onClick={() => onNavigate('profile')}>
      <p className="wx-cell wx-cell--arrow"><MiniIcon name="service" /><b>{String(texts.supportContactMessage || '在线客服')}</b><span></span><MiniIcon name="chevron" /></p>
    </MiniEditable>}
  </div>;
}

function MiniDetail({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const texts = asRecord(config.texts);
  return <>
    <MiniEditable className="mini-page-header mini-page-header--primary" onClick={() => onNavigate('productDetail')}><h2>{String(texts.detailTitle || '套餐详情')}</h2></MiniEditable>
    <MiniPackageCard config={config} onNavigate={() => onNavigate('productDetail')} />
    {['detailSectionContents', 'detailSectionIntro', 'detailSectionRules'].map((key) => <MiniEditable key={key} className="mini-detail-panel" onClick={() => onNavigate('productDetail')}><strong>{String(texts[key] || key)}</strong><p>{key === 'detailSectionContents' ? '商品内容清单。' : key === 'detailSectionIntro' ? '商品描述。' : '购买/使用规则。'}</p></MiniEditable>)}
  </>;
}

function MiniVouchers({ config, onNavigate }: { config: JsonRecord; onNavigate: (tab: TabKey) => void }) {
  const texts = asRecord(config.texts);
  const assets = asRecord(config.assets);
  return <>
    <MiniEditable className="mini-page-header mini-page-header--primary" onClick={() => onNavigate('vouchers')}><h2>{String(texts.vouchersTitle || '我的券包')}</h2></MiniEditable>
    {getNested(config, 'pages.vouchers.showTabs') !== false && <MiniEditable className="mini-status-tabs" onClick={() => onNavigate('vouchers')}>
      {[texts.vouchersTabUnused || '未使用', texts.vouchersTabUsed || '已使用', texts.vouchersTabExpired || '已过期', texts.vouchersTabRefund || '退款'].map((tab, index) => <span key={String(tab)} className={index === 0 ? 'is-active' : ''}>{String(tab)}</span>)}
    </MiniEditable>}
    <MiniEditable className="mini-empty" onClick={() => onNavigate('vouchers')}>
      <img src={String(assets.emptyState || '/images/illustrations/empty-state.png')} alt="" />
      <strong>{String(texts.vouchersEmptyUnused || '暂无未使用的团购券')}</strong>
      <p>{String(texts.vouchersCodeTip || '到店核销时出示券码')}</p>
    </MiniEditable>
  </>;
}

function Preview({ config, activeTab, onNavigate }: { config: JsonRecord; activeTab: TabKey; onNavigate: (tab: TabKey) => void }) {
  const previewPage: PageKey = (['home', 'orders', 'reservation', 'profile', 'productDetail', 'vouchers'] as TabKey[]).includes(activeTab) ? activeTab as PageKey : 'home';
  const texts = asRecord(config.texts);
  const theme = asRecord(config.theme);
  const primary = String(theme.primaryColor || '#07C160');
  const accent = String(theme.accentColor || '#FF5A5F');
  const bg = String(theme.backgroundColor || '#F5F5F7');
  const previewStyle = {
    '--mini-primary': primary,
    '--mini-primary-dark': primary,
    '--mini-primary-light': hexToRgba(primary, 0.12),
    '--mini-accent': accent,
    '--mini-bg': bg,
    '--mini-card': '#FFFFFF',
    '--mini-text': '#1A1A1A',
    '--mini-text-sub': '#555555',
    '--mini-text-muted': '#999999',
    '--mini-border': '#ECECEF',
  } as CSSProperties;
  const renderPage: Record<PageKey, ReactNode> = {
    home: <MiniHome config={config} onNavigate={onNavigate} />,
    orders: <MiniOrders config={config} onNavigate={onNavigate} />,
    reservation: <MiniReservation config={config} onNavigate={onNavigate} />,
    profile: <MiniProfile config={config} onNavigate={onNavigate} />,
    productDetail: <MiniDetail config={config} onNavigate={onNavigate} />,
    vouchers: <MiniVouchers config={config} onNavigate={onNavigate} />,
  };
  return <aside className="app-config-preview">
    <div className="app-config-preview-title">
      <strong>真实模板预览</strong>
      <span>{PAGE_LABELS[previewPage]}</span>
    </div>
    <div className="mini-phone" style={previewStyle}>
      <div className={`mini-screen mini-screen--${previewPage}`}>
        <MiniStatus />
        <div className="mini-scroll wx-mini">{renderPage[previewPage]}</div>
        {(['home', 'orders', 'reservation', 'profile'] as PageKey[]).includes(previewPage) && <MiniTabbar active={previewPage} texts={texts} onNavigate={onNavigate} />}
      </div>
    </div>
  </aside>;
}

export default function AppConfigEditor({ merchantId, request, merchantName, role }: { merchantId: string; request: Request; merchantName?: string; role?: Role }) {
  const [config, setConfig] = useState<JsonRecord | null>(null);
  const [version, setVersion] = useState(1);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await request<{ configVersion: number; config: JsonRecord; saved: boolean }>(`/merchants/${merchantId}/app-config`);
        setConfig(mergeConfig(merchantName || '', result.config));
        setVersion(result.configVersion);
        setSaved(result.saved);
      } catch (error) {
        message.error((error as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [merchantId, request, merchantName]);

  const tabs = useMemo<Array<{ key: TabKey; label: string }>>(() => [
    { key: 'overview', label: '装修总览' },
    { key: 'theme', label: '主题/商家' },
    { key: 'home', label: '首页' },
    { key: 'orders', label: '订单' },
    { key: 'reservation', label: '预约' },
    { key: 'profile', label: '个人中心' },
    { key: 'productDetail', label: '商品详情' },
    { key: 'vouchers', label: '券包' },
    { key: 'assets', label: '素材' },
    { key: 'faq', label: '客服 FAQ' },
    { key: 'legal', label: '法律文本' },
    { key: 'publish', label: '同步小程序' },
  ], []);

  function changeConfig(next: JsonRecord) {
    setConfig(next);
    setSaved(false);
  }

  async function uploadImage(file: File, slot: string): Promise<string> {
    const ticket = await request<ImageUploadTicket>(`/merchants/${merchantId}/app-config/upload-url`, {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        slot,
      }),
    });
    const response = await fetch(ticket.uploadUrl, {
      method: ticket.method || 'PUT',
      headers: ticket.headers || { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) throw new Error(`图片上传失败（${response.status}）`);
    return ticket.publicUrl;
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      const result = await request<{ configVersion: number }>(`/merchants/${merchantId}/app-config`, { method: 'PUT', body: JSON.stringify({ config: syncHomeLayout(config) }) });
      setVersion(result.configVersion);
      setSaved(true);
      message.success('页面装修已保存，小程序端重新进入或刷新配置后生效');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !config) {
    return <section className="app-config-editor"><Button loading icon={<ReloadOutlined />}>加载页面装修配置中…</Button></section>;
  }

  return <div className="app-config-editor">
    <section className="app-config-toolbar">
      <div><strong>小程序页面装修</strong><span>{merchantName || ''} · 配置版本 v{version} {saved ? <Tag color="green" style={{ marginLeft: 4 }}>已保存</Tag> : <Tag color="orange" style={{ marginLeft: 4 }}>未保存</Tag>}</span></div>
      <Space>
        <Button onClick={handleSave} loading={saving} icon={<SaveOutlined />}>保存草稿</Button>
        <Button type="primary" onClick={() => void handleSave()} loading={saving} icon={<CheckOutlined />}>保存配置</Button>
      </Space>
    </section>
    <Divider style={{ margin: '12px 0' }} />
    <div className="app-config-layout">
      <aside className="app-config-tabs">
        {tabs.map((tab) => <button key={tab.key} className={activeTab === tab.key ? 'active' : ''} onClick={() => setActiveTab(tab.key)}>{tab.label}</button>)}
      </aside>
      <main className="app-config-form">
        {activeTab === 'overview' && <Overview config={config} merchantName={merchantName} />}
        {activeTab === 'theme' && <ThemeForm config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'home' && <PageForm pageKey="home" config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'orders' && <PageForm pageKey="orders" config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'reservation' && <PageForm pageKey="reservation" config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'profile' && <PageForm pageKey="profile" config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'productDetail' && <PageForm pageKey="productDetail" config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'vouchers' && <PageForm pageKey="vouchers" config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'assets' && <AssetsForm config={config} onChange={changeConfig} onImageUpload={uploadImage} />}
        {activeTab === 'faq' && <FaqForm config={config} onChange={changeConfig} />}
        {activeTab === 'legal' && <LegalForm config={config} onChange={changeConfig} />}
        {activeTab === 'publish' && <PublishPanel merchantId={merchantId} request={request} merchantName={merchantName} saved={saved} version={version} role={role} />}
      </main>
      <Preview config={config} activeTab={activeTab} onNavigate={setActiveTab} />
    </div>
  </div>;
}
