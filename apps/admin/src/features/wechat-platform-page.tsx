import { CheckCircleFilled, CheckCircleOutlined, CopyOutlined, DownloadOutlined, EditOutlined, InfoCircleOutlined, PlusOutlined, QrcodeOutlined, ReloadOutlined, UploadOutlined, WarningFilled } from '@ant-design/icons';
import { Alert, Avatar, Badge, Button, Card, Cascader, DatePicker, Descriptions, Divider, Drawer, Form, Image, Input, Modal, QRCode, Select, Space, Tag, message } from 'antd';
import { QRCodeSVG } from 'qrcode.react';
import dayjs from 'dayjs';
import type { Role } from './workspace-model';
import { APPROVAL_TYPE_OPTIONS, CERT_TYPE_OPTIONS, PROVINCE_REGIONS, RESPONSIBLE_ID_TYPE_OPTIONS, SERVICE_CONTENT_OPTIONS } from './wechat-regions';

/** 上传后返回代理访问路径（存进备案表单，展示时由 usePrivateFileUrl 换取签名 URL） */
function filingProxyUrl(merchantId: string, value: string): string {
  const raw = String(value || '').trim();
  const objectKey = raw.includes('merchant-assets/') ? raw.match(/merchant-assets\/[^?#]+/)?.[0] || raw : raw;
  if (!objectKey) return '';
  return `/api/v1/merchants/${merchantId}/filing-files?key=${encodeURIComponent(objectKey)}`;
}

/** 从 COS 直链 URL、代理路径或 objectKey 提取 objectKey（merchant-assets/... 之后的部分） */
function extractFilingObjectKey(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // 代理路径：/api/.../filing-files?key=merchant-assets%2F...
  const qIndex = raw.indexOf('filing-files?key=');
  if (qIndex > -1) {
    const keyParam = raw.slice(qIndex + 'filing-files?key='.length);
    const decoded = decodeURIComponent(keyParam.split('&')[0]);
    if (decoded.startsWith('merchant-assets/')) return decoded;
  }
  // COS 直链或原始 objectKey
  const m = raw.match(/merchant-assets\/[^?#]+/);
  return m ? m[0] : (raw.startsWith('merchant-assets/') ? raw : '');
}

/** 签名 URL 缓存：key=objectKey → { url, expiresAt }，10 分钟过期自动重新获取 */
const privateFileUrlCache = new Map<string, { url: string; expiresAt: number }>();
const PRIVATE_FILE_URL_TTL_MS = 9 * 60 * 1000; // 略小于 COS 签名 10 分钟，留余量

/** 用登录态换取备案私有文件的临时签名 URL（COS 私有对象无法直接匿名访问）。 */
function usePrivateFileUrl(merchantId: string, request: Request, rawUrl: string): string {
  const [signedUrl, setSignedUrl] = useState<string>('');
  const objectKey = extractFilingObjectKey(rawUrl);

  useEffect(() => {
    if (!objectKey) { setSignedUrl(''); return; }
    let active = true;
    const load = async () => {
      const cached = privateFileUrlCache.get(objectKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (active) setSignedUrl(cached.url);
        return;
      }
      try {
        const result = await request<{ url: string }>(`/merchants/${merchantId}/filing-files?key=${encodeURIComponent(objectKey)}`);
        if (!result?.url) return;
        privateFileUrlCache.set(objectKey, { url: result.url, expiresAt: Date.now() + PRIVATE_FILE_URL_TTL_MS });
        if (active) setSignedUrl(result.url);
      } catch { if (active) setSignedUrl(''); }
    };
    void load();
    // 到期前自动续期
    const timer = window.setInterval(load, PRIVATE_FILE_URL_TTL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [merchantId, request, objectKey]);

  return signedUrl;
}
import { PublishManagement } from './wechat-publish-management';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type WechatStatus = {
  merchantName: string;
  merchantLegalName: string;
  servicePhone: string;
  onboardingStatus?: string;
  syncStatus?: string;
  lastSyncError?: string;
  registrationStatus?: string;
  registrationNote?: string;
  registrationFailureReason?: string;
  filingVerified?: boolean;
  filingLicenseDataUrl?: string;
  filingData?: Record<string, unknown>;
  certified?: boolean;
  savedCategoryCount?: number;
  currentStep?: { key: string; label: string };
  publicationEntitlementStatus: string;
  componentAppId: string;
  authorizerAppId: string;
  authorizationStatus: string | null;
  authorizedAt: string | null;
  componentReady: boolean;
  cosReady: boolean;
  configuredCount: number;
  totalCount: number;
  eventCallbackUrl: string;
  messageCallbackTemplate: string;
  authorizationDomain: string;
  cosRegion: string;
  cosBucket: string;
  ticketReceived: boolean;
  ticketUpdatedAt: string | null;
  checks?: Array<{ key: string; label: string; configured: boolean }>;
  requirements?: Array<{ key: string; label: string; configured: boolean }>;
  steps?: Array<{ key: string; label: string; state: 'complete' | 'current' | 'pending'; status?: string; syncStatus?: string }>;
  lastSyncAt?: string | null;
  actions?: { canStartAuthorization: boolean; canManageFiling: boolean; canUploadMaterials: boolean };
};

type IcpVerifyTask = {
  id: string;
  taskId: string;
  verifyUrl: string;
  alongWithAuth: boolean;
  status: 'PENDING' | 'FAILED' | 'SUCCEEDED';
  isFinish: boolean;
  faceStatus: number | null;
  alongWithAuthResult: number | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
};

type RegistrationProfile = {
  stage: string;
  stageLabel: string;
  status: string;
  statusLabel: string;
  statusTone: 'success' | 'processing' | 'warning' | 'error' | 'default';
  activeStepKey: string;
  stepIndex: number;
  alertMessage: string;
  alertTone: 'success' | 'info' | 'warning' | 'error';
  title: string;
  subtitle: string;
  buttons: Array<{ key: string; label: string; type?: 'primary' | 'default' | 'dashed'; danger?: boolean; disabled?: boolean }>;
  badges: Array<{ key: string; label: string }>;
};

type BasicInfoForm = {
  nickname: string;
  introduction: string;
  avatarUrl?: string;
  merchantName?: string;
  legalName?: string;
  servicePhone?: string;
};

type FilingForm = {
  subjectNature: string;
  subjectName: string;
  filingRegion: string[];
  communicationAddress: string;
  certificateType: string;
  certificateNo: string;
  certificateAddress: string;
  certificateStartAt: string;
  certificateEndAt: string;
  certificateFront: string;
  certificateBack: string;
  responsibleName: string;
  responsiblePhone: string;
  responsibleEmail: string;
  /** 微信认证联系人邮箱（wxaauth contact_info.email 必填，审核沟通用） */
  verifyContactEmail?: string;
  emergencyContact: string;
  responsibleIdType: string;
  responsibleIdNo: string;
  responsibleIdStartAt: string;
  responsibleIdEndAt: string;
  responsibleFront: string;
  responsibleBack: string;
  serviceContentType: string[];
  serviceDescription: string;
  serviceDescription2: string;
  approvalType: string;
  approvalNo: string;
  approvalMaterial: string;
  businessCategory: string[];
  /** 小程序负责人授权书（签名+盖章图片，COS URL） */
  authorizationLetter?: string;
  /** 小程序负责人（=小程序管理员）信息：微信备案要求小程序负责人为管理员本人，独立于主体负责人填写 */
  appletPrincipalName?: string;
  appletPrincipalPhone?: string;
  appletPrincipalEmail?: string;
  appletPrincipalEmergency?: string;
  appletPrincipalIdNo?: string;
  appletPrincipalIdStartAt?: string;
  appletPrincipalIdEndAt?: string;
  appletPrincipalFront?: string;
  appletPrincipalBack?: string;
  /** icp_materials 其他备案媒体材料（微信官方字段，均为 COS URL；subject/applets 其它附件可逗号分隔多个） */
  commitmentLetter?: string;
  businessNameChangeLetter?: string;
  partyBuildingConfirmationLetter?: string;
  promiseVideo?: string;
  authenticityResponsibilityLetter?: string;
  authenticityCommitmentLetter?: string;
  websiteConstructionProposal?: string;
  subjectOtherMaterials?: string;
  appletsOtherMaterials?: string;
  holdingCertificatePhoto?: string;
};

type CategoryRow = { id: string; first: string; second: string; status: string; reason: string; note: string };
type ApprovalItem = { id: string; approvalType: string; approvalNo: string; approvalMaterial: string };
type PageTab = 'overview' | 'basic' | 'filing' | 'category' | 'auth' | 'publish' | 'config';
type ProgressStepKey = 'materials' | 'registration' | 'authorization' | 'basicInfo' | 'categories' | 'filing' | 'publishable';

/** 微信认证任务进度（后端 /wechat-platform/wechat-verify 与 /query 返回结构） */
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

/** 认证任务流程状态中文映射（官方 task_status 0-15） */
const VERIFY_TASK_STATUS_META: Record<number, { label: string; tone: string }> = {
  0: { label: '资料校验成功，等待管理员授权', tone: 'processing' },
  1: { label: '任务超时（24 小时）', tone: 'warning' },
  2: { label: '用户拒绝授权', tone: 'error' },
  3: { label: '用户已同意授权', tone: 'processing' },
  4: { label: '发起人脸核验', tone: 'processing' },
  5: { label: '人脸认证失败', tone: 'error' },
  6: { label: '人脸认证通过', tone: 'processing' },
  7: { label: '已下发手机验证码', tone: 'processing' },
  8: { label: '手机验证失败', tone: 'error' },
  9: { label: '手机验证成功', tone: 'processing' },
  11: { label: '创建认证审核单失败', tone: 'error' },
  12: { label: '认证审核单创建成功', tone: 'processing' },
  14: { label: '验证失败', tone: 'error' },
  15: { label: '等待支付', tone: 'processing' },
};

/** 认证审核单状态中文映射（官方 apply_status 0-5） */
const VERIFY_APPLY_STATUS_META: Record<number, { label: string; tone: string }> = {
  0: { label: '审核单不存在', tone: 'default' },
  1: { label: '待支付', tone: 'processing' },
  2: { label: '审核中', tone: 'processing' },
  3: { label: '打回重填', tone: 'warning' },
  4: { label: '认证通过', tone: 'success' },
  5: { label: '认证最终失败', tone: 'error' },
};

const DEFAULT_BASIC_INFO: BasicInfoForm = {
  nickname: '我的店铺',
  introduction: '本小程序主要提供到店服务、在线预约、会员管理、订单核销与售后服务。',
};

/** 微信 ICP 备案状态映射（get_icp_entrance_info.info.status） */
const ICP_STATUS_META: Record<number, { label: string; color: string }> = {
  2: { label: '平台审核中', color: 'processing' },
  3: { label: '平台审核驳回', color: 'error' },
  4: { label: '管局审核中', color: 'processing' },
  5: { label: '管局审核驳回', color: 'error' },
  6: { label: '已备案', color: 'success' },
  1024: { label: '未备案', color: 'default' },
  1025: { label: '未备案（小程序信息未填）', color: 'default' },
  1026: { label: '未备案（小程序类目未填）', color: 'default' },
  1027: { label: '未备案（信息与类目未填）', color: 'default' },
  1028: { label: '未备案（小程序未认证）', color: 'default' },
  1029: { label: '未备案（信息未填且未认证）', color: 'default' },
  1030: { label: '未备案（类目未填且未认证）', color: 'default' },
  1031: { label: '未备案（信息、类目未填且未认证）', color: 'default' },
};

/** 备案驳回原因条目（info.audit_data[]） */
type IcpAuditItem = { key?: string; key_name?: string; error?: string; suggest?: string };

/** 从 get_icp_entrance_info 原始响应解析备案状态文案（组件内外共用，避免依赖 useMemo 声明顺序） */
function icpStatusLabelOf(raw: Record<string, unknown> | null | undefined): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const info = raw.info && typeof raw.info === 'object' && !Array.isArray(raw.info) ? raw.info as Record<string, unknown> : {};
  const status = Number(info.status ?? -1);
  const meta = ICP_STATUS_META[status];
  return meta?.label ?? (status >= 1024 ? '未备案' : status >= 0 ? `未知状态(${status})` : undefined);
}

/** 备案其他媒体材料（icp_materials，微信官方 apply_icp_filing 字段）——上传配置 */
const ICP_MATERIALS_CONFIG: Array<{ key: string; label: string; accept: string; video?: boolean; hint?: string }> = [
  { key: 'commitmentLetter', label: '互联网信息服务承诺书', accept: 'image/*', hint: '广东等省份备案必填，其余省份可选' },
  { key: 'businessNameChangeLetter', label: '主体更名函', accept: 'image/*', hint: '非个人主体且发生过更名时需上传' },
  { key: 'partyBuildingConfirmationLetter', label: '党建确认函', accept: 'image/*' },
  { key: 'promiseVideo', label: '承诺视频', accept: 'video/mp4', video: true, hint: 'MP4 格式，不超过 100MB' },
  { key: 'authenticityResponsibilityLetter', label: '网站备案信息真实性责任告知书', accept: 'image/*' },
  { key: 'authenticityCommitmentLetter', label: '小程序备案信息真实性承诺书', accept: 'image/*' },
  { key: 'websiteConstructionProposal', label: '小程序建设方案书', accept: 'image/*' },
  { key: 'subjectOtherMaterials', label: '主体其它附件', accept: 'image/*', hint: '最多 10 个，多个用逗号分隔' },
  { key: 'appletsOtherMaterials', label: '小程序其它附件', accept: 'image/*', hint: '最多 10 个，多个用逗号分隔' },
  { key: 'holdingCertificatePhoto', label: '手持证件照', accept: 'image/*' },
];

const DEFAULT_FILING_FORM: FilingForm = {
  subjectNature: 'ENTERPRISE',
  subjectName: '',
  filingRegion: [],
  communicationAddress: '',
  certificateType: 'LICENSE',
  certificateNo: '',
  certificateAddress: '',
  certificateStartAt: '',
  certificateEndAt: '',
  certificateFront: '',
  certificateBack: '',
  responsibleName: '',
  responsiblePhone: '',
  responsibleEmail: '',
  emergencyContact: '',
  responsibleIdType: 'CN_ID',
  responsibleIdNo: '',
  responsibleIdStartAt: '',
  responsibleIdEndAt: '',
  responsibleFront: '',
  responsibleBack: '',
  serviceContentType: ['LIFE_SERVICE', 'BEAUTY'],
  serviceDescription: '本小程序主要提供到店服务、在线预约、会员管理、订单核销与售后服务。',
  serviceDescription2: '支持商户按自身经营范围补充服务说明与资质材料。',
  approvalType: 'NONE',
  approvalNo: '',
  approvalMaterial: '无需上传材料',
  businessCategory: ['生活服务', '丽人服务'],
};

const CATEGORY_ROWS: CategoryRow[] = [
  { id: '1', first: '生活服务', second: '丽人服务', status: '审核通过', reason: '-', note: '可直接保存' },
  { id: '2', first: '餐饮服务', second: '点餐平台', status: '审核不通过', reason: '需要提供《增值电信业务经营许可证》', note: '需补充资质' },
  { id: '3', first: '工具', second: '记账', status: '审核通过', reason: '-', note: '无需额外材料' },
  { id: '4', first: '工具', second: '预约/报名', status: '审核通过', reason: '-', note: '支持纯预约类' },
];

const APPROVAL_ITEMS: ApprovalItem[] = [
  { id: '1', approvalType: '以上都不涉及', approvalNo: '选择以上都不涉及后无需填写', approvalMaterial: '无需上传材料' },
];

const TAB_BY_URL: Record<string, PageTab> = {
  overview: 'overview',
  basicInfo: 'basic',
  filing: 'filing',
  category: 'category',
  auth: 'auth',
  publish: 'publish',
  config: 'config',
};

const DEFAULT_WORKFLOW_STEPS: NonNullable<WechatStatus['steps']> = [
  { key: 'materials', label: '商户资料', state: 'complete' },
  { key: 'registration', label: '小程序注册', state: 'complete' },
  { key: 'authorization', label: '平台授权', state: 'complete' },
  { key: 'basicInfo', label: '基础信息', state: 'complete' },
  { key: 'categories', label: '服务类目', state: 'complete' },
  { key: 'filing', label: '微信认证/备案', state: 'complete' },
  { key: 'publishable', label: '可发布', state: 'current' },
];

const DEFAULT_ACTIONS: NonNullable<WechatStatus['actions']> = {
  canStartAuthorization: false,
  canManageFiling: true,
  canUploadMaterials: false,
};

export default function WechatPlatformPage({ merchantId, request, onNavigate, role, onRequireStepUp }: { merchantId: string; request: Request; onNavigate: (page: string) => void; role?: Role; onRequireStepUp: () => void }) {
  const isPlatformAdmin = role === 'PLATFORM_ADMIN';
  // AppID 可见范围：平台/代理商（代理商只能看到自己名下商家，服务端已做数据隔离）；商家经营端不展示
  const canViewAppId = isPlatformAdmin || role === 'AGENCY_ADMIN';
  const [plainAppId, setPlainAppId] = useState('');
  const [plainAppIdLoading, setPlainAppIdLoading] = useState(false);
  const [status, setStatus] = useState<WechatStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [activeTab, setActiveTab] = useState<PageTab>('overview');
  const [basicInfo, setBasicInfo] = useState<BasicInfoForm>(DEFAULT_BASIC_INFO);
  const [filingForm, setFilingForm] = useState<FilingForm>(DEFAULT_FILING_FORM);
  const [categoryRows] = useState<CategoryRow[]>(CATEGORY_ROWS);
  const [categoryOptions, setCategoryOptions] = useState<Array<{ id: number; name: string; children?: Array<{ id: number; name: string }> }>>([]);
  const [selectedFirst, setSelectedFirst] = useState<number | undefined>(undefined);
  const [selectedSecond, setSelectedSecond] = useState<number | undefined>(undefined);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [approvalItems] = useState<ApprovalItem[]>(APPROVAL_ITEMS);
  const [showFastRegisterModal, setShowFastRegisterModal] = useState(false);
  const [fastRegisterSubmitting, setFastRegisterSubmitting] = useState(false);
  const [fastRegisterForm] = Form.useForm();
  const [showFastRegisterResultModal, setShowFastRegisterResultModal] = useState(false);
  const [fastRegisterResult, setFastRegisterResult] = useState<{ taskid: string; authorizeUrl: string; statusLabel: string } | null>(null);
  const [showAuthorizationModal, setShowAuthorizationModal] = useState(false);
  const [showFilingModal, setShowFilingModal] = useState(false);
  const [showFilingPreview, setShowFilingPreview] = useState(false);
  const [filingPreviewData, setFilingPreviewData] = useState<FilingForm>(DEFAULT_FILING_FORM);
  const [showBasicDrawer, setShowBasicDrawer] = useState(false);
  const [showCategoryDrawer, setShowCategoryDrawer] = useState(false);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [showVerifyQrModal, setShowVerifyQrModal] = useState(false);
  const [verifyTask, setVerifyTask] = useState<IcpVerifyTask | null>(null);
  const [verifySubmitting, setVerifySubmitting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrMode, setQrMode] = useState<'official' | 'trial' | 'not-released' | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [submittingProfile, setSubmittingProfile] = useState(false);
  const [profileResults, setProfileResults] = useState<Array<{ field: string; ok: boolean; message: string }> | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<{ verified: boolean; namingVerified: boolean; principalName: string; accountType: number; annualReview: boolean; annualReviewBeginAt: number | null; annualReviewEndAt: number | null } | null>(null);
  const [verifyStatusLoading, setVerifyStatusLoading] = useState(false);
  const [wechatVerifyTask, setWechatVerifyTask] = useState<WechatVerifyStatus | null>(null);
  const [wechatVerifyLoading, setWechatVerifyLoading] = useState(false);
  const [wechatVerifySubmitting, setWechatVerifySubmitting] = useState(false);
  const [wechatVerifyQr, setWechatVerifyQr] = useState<{ taskid: string; authUrl: string; feeFen: number } | null>(null);
  const [icpFilingStatus, setIcpFilingStatus] = useState<Record<string, unknown> | null>(null);
  const [icpStatusLoading, setIcpStatusLoading] = useState(false);
  const [submittingIcpFiling, setSubmittingIcpFiling] = useState(false);
  const [cancelingIcpFiling, setCancelingIcpFiling] = useState(false);
  const [icpServiceTypes, setIcpServiceTypes] = useState<Array<{ type: number; name: string; parentType: number; parentName: string }>>([]);
  const [icpDistricts, setIcpDistricts] = useState<Array<{ value: string; label: string; children?: Array<{ value: string; label: string }> }>>([]);
  const [selectedProgressStep, setSelectedProgressStep] = useState<ProgressStepKey>('filing');
  const [basicForm] = Form.useForm();
  const [filingFormState] = Form.useForm();
  const watchedSubjectNature = Form.useWatch('subjectNature', filingFormState);
  const certTypeOptions = watchedSubjectNature === 'INDIVIDUAL'
    ? CERT_TYPE_OPTIONS.filter((option) => option.value === 'INDIVIDUAL_LICENSE')
    : CERT_TYPE_OPTIONS.filter((option) => option.value === 'LICENSE');
  const watchedCertificateFront = Form.useWatch('certificateFront', filingFormState);
  const watchedResponsibleFront = Form.useWatch('responsibleFront', filingFormState);
  const watchedResponsibleBack = Form.useWatch('responsibleBack', filingFormState);
  const watchedAuthorizationLetter = Form.useWatch('authorizationLetter', filingFormState);
  // 备案私有照片：用登录态换取临时签名 URL 供 <Image> 展示（COS 私有对象无法直接匿名访问）
  const certFrontSrc = usePrivateFileUrl(merchantId, request, filingPreviewData.certificateFront);
  const respFrontSrc = usePrivateFileUrl(merchantId, request, filingPreviewData.responsibleFront);
  const respBackSrc = usePrivateFileUrl(merchantId, request, filingPreviewData.responsibleBack);
  const watchedCertFrontSrc = usePrivateFileUrl(merchantId, request, watchedCertificateFront);
  const watchedRespFrontSrc = usePrivateFileUrl(merchantId, request, watchedResponsibleFront);
  const watchedRespBackSrc = usePrivateFileUrl(merchantId, request, watchedResponsibleBack);
  const watchedAppletFront = Form.useWatch('appletPrincipalFront', filingFormState);
  const watchedAppletBack = Form.useWatch('appletPrincipalBack', filingFormState);
  const watchedAppletFrontSrc = usePrivateFileUrl(merchantId, request, watchedAppletFront);
  const watchedAppletBackSrc = usePrivateFileUrl(merchantId, request, watchedAppletBack);
  const watchedAuthLetterSrc = usePrivateFileUrl(merchantId, request, watchedAuthorizationLetter);
  // 其他备案材料（icp_materials）：refs 容器 + watcher 值（展示已上传状态，不做图片预览避免 10 个签名 hook）
  const icpMaterialsRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const watchedIcpMaterials = ICP_MATERIALS_CONFIG.reduce((acc, m) => {
    acc[m.key] = Form.useWatch(m.key, filingFormState);
    return acc;
  }, {} as Record<string, string | undefined>);
  // 微信认证费用按主体类型区分：企业 300 元/年，个体工商户 30 元/年（限时优惠）
  const certificationFeeText = filingForm.subjectNature === 'INDIVIDUAL'
    ? '个体工商户认证 30 元/年（限时优惠，原价 300 元/年）'
    : '企业认证 300 元/年';
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const certFrontRef = useRef<HTMLInputElement>(null);
  const respFrontRef = useRef<HTMLInputElement>(null);
  const respBackRef = useRef<HTMLInputElement>(null);
  const appletFrontRef = useRef<HTMLInputElement>(null);
  const appletBackRef = useRef<HTMLInputElement>(null);
  const authLetterRef = useRef<HTMLInputElement>(null);
  const [avatarDataUrl, setAvatarDataUrl] = useState(basicInfo.avatarUrl || '');

  function handleFilePick(ref: React.RefObject<HTMLInputElement>) {
    ref.current?.click();
  }

  /** 上传其他备案材料（图片/视频）到 COS，成功后写回表单字段 */
  function uploadIcpMaterial(file: File, key: string, label: string) {
    if (key === 'promiseVideo' && !/^video\/mp4$/i.test(file.type)) {
      message.error('承诺视频仅支持 MP4 格式');
      return;
    }
    void uploadFilingImage(file).then((url) => {
      const prev = String(filingFormState.getFieldValue(key) || '');
      // 其它附件支持多个（逗号分隔），其余字段直接覆盖
      const next = (key === 'subjectOtherMaterials' || key === 'appletsOtherMaterials') && prev ? `${prev},${url}` : url;
      filingFormState.setFieldsValue({ [key]: next });
      message.success(`${label}已上传`);
    }).catch((e) => message.error(`${label}上传失败：${(e as Error).message}`));
  }

  function readFileAsDataUrl(file: File, onDone: (dataUrl: string) => void) {
    const reader = new FileReader();
    reader.onload = () => onDone(String(reader.result));
    reader.onerror = () => message.error('图片读取失败');
    reader.readAsDataURL(file);
  }

  /** 备案照片真实上传到腾讯云 COS，随后把对象设为私有，返回登录鉴权的代理访问路径（存进备案表单） */
  async function uploadFilingImage(file: File): Promise<string> {
    const ticket = await request<{ method?: string; uploadUrl: string; objectKey: string; headers?: Record<string, string> }>(`/merchants/${merchantId}/app-config/upload-url`, {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size, slot: 'filing' }),
    });
    const response = await fetch(ticket.uploadUrl, {
      method: ticket.method || 'PUT',
      headers: ticket.headers || { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) throw new Error(`图片上传失败（${response.status}）`);
    // 设为私有：公开 URL 不再可匿名访问
    if (ticket.objectKey) {
      try { await request(`/merchants/${merchantId}/filing-files/make-private`, { method: 'POST', body: JSON.stringify({ key: ticket.objectKey }) }); } catch { /* 私有化失败不阻断保存，代理接口仍鉴权 */ }
    }
    return ticket.objectKey ? filingProxyUrl(merchantId, ticket.objectKey) : '';
  }

  /** 生成小程序负责人授权书模板（商家信息已预填），打印签名盖章后拍照上传 */
  function downloadAuthLetterTemplate() {
    const values = { ...filingForm, ...filingFormState.getFieldsValue(true) };
    const text = [
      '小程序负责人授权书',
      '',
      `兹授权 ${values.responsibleName || '________（负责人姓名）________'}，身份证号：${values.responsibleIdNo || '____________________'}，`,
      `担任 ${values.subjectName || '________（小程序名称）________'} 的负责人，负责该小程序的日常运营管理及备案相关事宜。`,
      '',
      '特此授权。',
      '',
      '授权人（法定代表人/经营者）：________________（签名，个体工商户加按手印）',
      `单位名称（盖章）：${values.subjectName || '________________'}`,
      '日期：____年__月__日',
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '小程序负责人授权书.txt';
    a.click();
    URL.revokeObjectURL(url);
    message.success('授权书模板已下载：请由法定代表人/经营者（个体工商户为经营者本人）签名盖章后拍照上传；若负责人本人即法人，则无需授权书');
  }

  function renderFileInput(ref: React.RefObject<HTMLInputElement>, accept: string, onFile: (f: File) => void, sizeLimitMb = 5, allowedTypes?: string[]) {
    return (
      <input ref={ref} type="file" accept={accept} style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            if (file.size > sizeLimitMb * 1024 * 1024) { message.error(`文件不能超过 ${sizeLimitMb}MB`); return; }
            if (allowedTypes && !allowedTypes.includes(file.type)) { message.error(`仅支持 ${allowedTypes.join('/')} 格式`); return; }
            onFile(file);
          }
          if (ref.current) ref.current.value = '';
        }}
      />
    );
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<WechatStatus>(`/wechat-platform/status?merchantId=${merchantId}`);
      setStatus(result);
      setBasicInfo((current) => ({
        ...current,
        nickname: !current.nickname || current.nickname === DEFAULT_BASIC_INFO.nickname ? result.merchantName || DEFAULT_BASIC_INFO.nickname : current.nickname,
        introduction: current.introduction || DEFAULT_BASIC_INFO.introduction,
        merchantName: result.merchantName || current.merchantName || '',
        legalName: result.merchantLegalName || current.legalName || '',
        servicePhone: result.servicePhone || current.servicePhone || '',
      }));
      setFilingForm((current) => ({
        ...current,
        subjectName: current.subjectName || result.merchantLegalName || '',
        responsiblePhone: current.responsiblePhone || result.servicePhone || '',
        emergencyContact: current.emergencyContact || result.servicePhone || '',
        certificateFront: current.certificateFront || result.filingLicenseDataUrl || '',
        // 服务端持久化的备案草稿回填（刷新/换设备后不丢失）
        ...(result.filingData as Partial<FilingForm> | undefined),
      }));
      return result;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [merchantId, request]);

  useEffect(() => { void load(); }, [load]);

  // 微信审核、快速注册和备案均可能在页面关闭期间完成；仅在页面可见且存在处理中事实时轮询本系统状态。
  useEffect(() => {
    const hasProcessingFact = Boolean(status?.steps?.some((step) => ['PROCESSING', 'PENDING'].includes(String(step.status || '').toUpperCase())));
    if (!hasProcessingFact || document.visibilityState !== 'visible') return;
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try { await load(); } finally { running = false; }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [load, status?.steps]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('wechatAuthorization') !== 'success') return;
    message.success('微信小程序授权成功');
    query.delete('wechatAuthorization');
    const suffix = query.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${suffix ? `?${suffix}` : ''}${window.location.hash}`);
  }, []);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (!hash) return;
    const page = hash.split('/')[1] || '';
    if (page in TAB_BY_URL) setActiveTab(TAB_BY_URL[page]);
  }, []);

  const steps = status?.steps?.length ? status.steps : DEFAULT_WORKFLOW_STEPS;
  const profile = useMemo(() => buildProfile(status, icpStatusLabelOf(icpFilingStatus)), [status, icpFilingStatus]);
  const progressSteps = useMemo(() => steps.map((step) => ({ ...step, key: normalizeProgressStepKey(step.key, step.label), state: step.state })), [steps]);
  const requirementItems = status?.requirements ?? [];
  const readyCount = requirementItems.length ? requirementItems.filter((item) => item.configured).length : status?.configuredCount || 0;
  const requirementTotal = requirementItems.length || status?.totalCount || 0;
  const actions = status?.actions ?? DEFAULT_ACTIONS;
  // AppID 属敏感信息：平台/代理商可见（默认脱敏，点"查看明文"获取完整值）；商家经营端不展示。
  // 注意：只显示商家小程序自己的 AppID（status.authorizerAppId），未授权时明确提示"待授权后同步"，
  // 不回退显示第三方平台组件 AppID（componentAppId）以免误导。
  const displayAppId = canViewAppId ? (status?.authorizerAppId || '待授权后同步') : '';
  const displayOriginalId = canViewAppId && status?.authorizerAppId ? '已授权后由微信同步' : '待授权后同步';

  const loadPlainAppId = useCallback(async () => {
    if (plainAppId) return;
    setPlainAppIdLoading(true);
    try {
      const result = await request<{ appid: string }>(`/wechat-platform/appid?merchantId=${merchantId}`, { headers: { 'X-Silent-Errors': '1' } });
      setPlainAppId(result?.appid || '');
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) onRequireStepUp();
      else setPlainAppId('');
    } finally {
      setPlainAppIdLoading(false);
    }
  }, [merchantId, plainAppId, request, onRequireStepUp]);

  /** 一键复制 AppID：若尚未获取明文则先拉取完整 AppID 再复制（代理商配支付用）。 */
  const copyAppId = useCallback(async () => {
    let value = plainAppId;
    if (!value) {
      // 未拿到明文时先尝试拉取（该接口已放行平台/代理商）
      try {
        const result = await request<{ appid: string }>(`/wechat-platform/appid?merchantId=${merchantId}`, { headers: { 'X-Silent-Errors': '1' } });
        value = result?.appid || '';
        if (value) setPlainAppId(value);
      } catch (error) {
        const text = (error as Error).message;
        if (text.includes('身份') || text.includes('密码')) { onRequireStepUp(); return; }
        message.error(text);
        return;
      }
    }
    if (!value) {
      message.warning('尚未获取到 AppID，请先完成小程序授权');
      return;
    }
    const ok = await copyTextToClipboard(value);
    if (ok) message.success('AppID 已复制到剪贴板');
    else message.error('复制失败，请手动选择复制');
  }, [merchantId, plainAppId, request, onRequireStepUp]);

  /** 剪贴板写入：优先 navigator.clipboard，失败降级 execCommand。 */
  async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 降级 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  const appIdCell = canViewAppId ? (
    <Space wrap>
      <span>{plainAppId || displayAppId}</span>
      {!plainAppId && displayAppId !== '待授权后同步' && (
        <Button type="link" size="small" style={{ paddingLeft: 0 }} loading={plainAppIdLoading} onClick={() => void loadPlainAppId()}>查看明文</Button>
      )}
      <Button type="link" size="small" icon={<CopyOutlined />} style={{ paddingLeft: 0 }} disabled={displayAppId === '待授权后同步'} onClick={() => void copyAppId()}>复制</Button>
    </Space>
  ) : null;

  useEffect(() => {
    const current = (progressSteps.find((step) => step.state === 'current') || progressSteps[0])?.key || 'filing';
    setSelectedProgressStep((value) => (progressSteps.some((step) => step.key === value) ? value : current));
  }, [progressSteps]);

  const selectedProgress = useMemo<ProgressDetail | null>(() => {
    if (!status) return null;
    return buildProgressDetail({
      key: selectedProgressStep,
      steps: progressSteps,
      status,
      profile,
      canViewAppId,
      displayAppId,
      displayOriginalId,
      basicInfo,
      filingForm,
      categoryRows,
      approvalItems,
      readyCount,
      requirementTotal,
      actions,
      canWriteWechat: role === 'AGENCY_ADMIN',
      onNavigate,
      setActiveTab,
      openAuthorizationModal,
      openBasicDrawer,
      openCategoryDrawer,
      openFilingDrawer,
      openAuditModal,
      markVerificationStarted,
      checkVerificationResult,
      load,
      saveFilingDraft,
    });
  }, [
    actions,
    approvalItems,
    basicInfo,
    categoryRows,
    displayAppId,
    displayOriginalId,
    filingForm,
    load,
    openAuditModal,
    openAuthorizationModal,
    openBasicDrawer,
    openCategoryDrawer,
    openFilingDrawer,
    onNavigate,
    profile,
    progressSteps,
    readyCount,
    requirementTotal,
    saveFilingDraft,
    selectedProgressStep,
    status,
  ]);

  const loadQrCode = useCallback(async () => {
    if (status?.authorizationStatus !== 'AUTHORIZED') return;
    setQrLoading(true);
    try {
      const result = await request<{ qrDataUrl: string; mode?: 'official' | 'trial' | 'not-released' }>(`/wechat-platform/mini-program-code?merchantId=${merchantId}`, { method: 'POST' });
      setQrDataUrl(result?.qrDataUrl || '');
      setQrMode(result?.mode ?? (result?.qrDataUrl ? 'official' : 'not-released'));
    } catch {
      // 生成失败时保留占位，不阻塞页面
      setQrDataUrl('');
      setQrMode('not-released');
    } finally {
      setQrLoading(false);
    }
  }, [merchantId, request, status?.authorizationStatus]);

  useEffect(() => {
    if (status?.authorizationStatus === 'AUTHORIZED') void loadQrCode();
  }, [loadQrCode, status?.authorizationStatus]);

  const loadVerifyStatus = useCallback(async () => {
    if (status?.authorizationStatus !== 'AUTHORIZED') return;
    setVerifyStatusLoading(true);
    try {
      const result = await request<{ verified: boolean; namingVerified: boolean; principalName: string; accountType: number; annualReview: boolean; annualReviewBeginAt: number | null; annualReviewEndAt: number | null }>(`/wechat-platform/verify-status?merchantId=${merchantId}`);
      setVerifyStatus(result);
    } catch {
      // 查询失败不阻塞页面
    } finally {
      setVerifyStatusLoading(false);
    }
  }, [merchantId, request, status?.authorizationStatus]);

  useEffect(() => {
    if (status?.authorizationStatus === 'AUTHORIZED') void loadVerifyStatus();
  }, [loadVerifyStatus]);

  /** 查询微信认证任务进度（queryauth），8 秒静默轮询直到进入终态 */
  const loadWechatVerifyTask = useCallback(async (silent = false) => {
    if (status?.authorizationStatus !== 'AUTHORIZED') return;
    if (!silent) setWechatVerifyLoading(true);
    try {
      const result = await request<WechatVerifyStatus>(`/wechat-platform/wechat-verify/query?merchantId=${merchantId}`, { method: 'POST' });
      setWechatVerifyTask(result);
      if (result.applyStatus === 4) void loadVerifyStatus();
    } catch {
      if (!silent) setWechatVerifyTask(null);
    } finally {
      if (!silent) setWechatVerifyLoading(false);
    }
  }, [merchantId, request, status?.authorizationStatus, loadVerifyStatus]);

  useEffect(() => {
    if (!status || status.authorizationStatus !== 'AUTHORIZED') return;
    if (status.certified) return;
    void loadWechatVerifyTask(true);
    const timer = window.setInterval(() => {
      void loadWechatVerifyTask(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [status?.authorizationStatus, status?.certified, loadWechatVerifyTask]);

  /** 代发起微信认证（wxaauth），成功后弹出授权二维码 */
  async function startWechatVerify() {
    setWechatVerifySubmitting(true);
    try {
      const result = await request<{ taskid: string; authUrl: string; feeFen: number; customerType: number }>(`/wechat-platform/wechat-verify?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ payType: 2 }) });
      setWechatVerifyQr({ taskid: result.taskid, authUrl: result.authUrl, feeFen: result.feeFen });
      setWechatVerifyTask({ taskid: result.taskid, authUrl: result.authUrl, taskStatus: 0, applyStatus: 0, orderId: null, refillReason: '', failReason: '', feeFen: result.feeFen, customerType: result.customerType, payType: 2, submittedAt: '', expired: false, rejected: false });
      message.success('认证任务已发起，请商家管理员扫码完成授权与支付');
    } catch (error) {
      message.error(`发起认证失败：${(error as Error).message}`);
    } finally {
      setWechatVerifySubmitting(false);
    }
  }

  /** 认证被打回重填后重新提审（微信不重复收费） */
  async function reauthWechatVerify() {
    setWechatVerifySubmitting(true);
    try {
      const result = await request<{ taskid: string; authUrl: string; feeFen: number; customerType: number }>(`/wechat-platform/wechat-verify/reauth?merchantId=${merchantId}`, { method: 'POST' });
      setWechatVerifyQr({ taskid: result.taskid, authUrl: result.authUrl, feeFen: result.feeFen });
      message.success('已重新提交认证审核，无需重复缴费');
      void loadWechatVerifyTask(true);
    } catch (error) {
      message.error(`重新提审失败：${(error as Error).message}`);
    } finally {
      setWechatVerifySubmitting(false);
    }
  }

  /** 认证费用文案（分 → 元） */
  function verifyFeeText(feeFen: number | undefined): string {
    const fen = Number(feeFen ?? 0);
    return fen ? `${(fen / 100).toFixed(0)} 元` : '以微信官方实际收费为准';
  }

  const loadIcpFilingStatus = useCallback(async () => {
    if (status?.authorizationStatus !== 'AUTHORIZED') return;
    setIcpStatusLoading(true);
    try {
      const result = await request<{ icpStatus: Record<string, unknown> }>(`/wechat-platform/icp-filing/status?merchantId=${merchantId}`);
      setIcpFilingStatus(result.icpStatus);
    } catch {
      setIcpFilingStatus(null);
    } finally {
      setIcpStatusLoading(false);
    }
  }, [merchantId, request, status?.authorizationStatus]);

  /** 从 get_icp_entrance_info 原始响应中解析结构化备案状态（status/available/驳回原因），供前端友好展示 */
  const icpStatusInfo = useMemo(() => {
    const raw = icpFilingStatus && typeof icpFilingStatus === 'object' ? icpFilingStatus as Record<string, unknown> : {};
    const info = raw.info && typeof raw.info === 'object' && !Array.isArray(raw.info) ? raw.info as Record<string, unknown> : {};
    const status = Number(info.status ?? -1);
    const meta = ICP_STATUS_META[status];
    const audit = Array.isArray(info.audit_data) ? info.audit_data as IcpAuditItem[] : [];
    return {
      status,
      label: icpStatusLabelOf(icpFilingStatus) ?? (status >= 1024 ? '未备案' : `未知状态(${status})`),
      color: meta?.color ?? 'default',
      available: Number(info.available ?? 1),
      isCanceling: Boolean(info.is_canceling),
      audit,
    };
  }, [icpFilingStatus]);

  useEffect(() => {
    if (status?.authorizationStatus === 'AUTHORIZED') void loadIcpFilingStatus();
  }, [loadIcpFilingStatus]);

  const loadIcpDistricts = useCallback(async () => {
    if (status?.authorizationStatus !== 'AUTHORIZED') return;
    try {
      const items = await request<Array<{ value: string; label: string; children?: Array<{ value: string; label: string }> }>>(`/wechat-platform/icp-filing/districts?merchantId=${merchantId}`);
      setIcpDistricts(items || []);
    } catch {
      // 拉取失败用内置省级市级数据
    }
  }, [merchantId, request, status?.authorizationStatus]);

  const loadIcpServiceTypes = useCallback(async () => {
    if (status?.authorizationStatus !== 'AUTHORIZED') return;
    try {
      const items = await request<Array<{ type: number; name: string; parentType: number; parentName: string }>>(`/wechat-platform/icp-filing/service-types?merchantId=${merchantId}`);
      setIcpServiceTypes(items || []);
    } catch {
      // 拉取失败不阻塞
    }
  }, [merchantId, request, status?.authorizationStatus]);

  // 服务内容类型：一级 → 二级 级联树
  const serviceTypeTree = useMemo(() => {
    const groups = new Map<number, { value: number; label: string; children: Array<{ value: number; label: string }> }>();
    icpServiceTypes.forEach((item) => {
      if (!groups.has(item.parentType)) groups.set(item.parentType, { value: item.parentType, label: item.parentName || String(item.parentType), children: [] });
      groups.get(item.parentType)!.children.push({ value: item.type, label: item.name || String(item.type) });
    });
    return [...groups.values()];
  }, [icpServiceTypes]);

  function serviceTypeLabel(value: string): string {
    const custom = SERVICE_CONTENT_OPTIONS.find((item) => item.value === value)?.label;
    if (custom) return custom;
    const real = icpServiceTypes.find((item) => String(item.type) === value);
    if (real) return real.parentName ? `${real.parentName} / ${real.name}` : real.name;
    return value;
  }

  async function cancelIcpFilingToWechat() {
    setCancelingIcpFiling(true);
    try {
      await request<{ canceled: boolean }>(`/wechat-platform/icp-filing/cancel?merchantId=${merchantId}`, { method: 'POST' });
      message.success('已取消未完结的备案申请，可重新提交');
      void loadIcpFilingStatus();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCancelingIcpFiling(false);
    }
  }

  async function submitIcpFilingToWechat() {
    setSubmittingIcpFiling(true);
    try {
      const result = await request<{ submitted: boolean; wechat: Record<string, unknown> }>(`/wechat-platform/icp-filing/submit?merchantId=${merchantId}`, { method: 'POST' });
      message.success('备案申请已提交到微信，等待管局审核');
      void loadIcpFilingStatus();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmittingIcpFiling(false);
    }
  }

  async function copy(value: string, label = '内容') {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    message.success(`已复制${label}`);
  }

  /** 打开微信授权二维码窗口；是否可执行由后端真实注册事实和角色权限决定 */
  async function openAuthorizationWindow() {
    setAuthorizing(true);
    try {
      const result = await request<{ url: string }>(`/wechat-platform/authorization-url?merchantId=${merchantId}`, { method: 'POST' });
      const target = new URL(result.url);
      if (target.protocol !== 'https:' || target.hostname !== 'mp.weixin.qq.com') throw new Error('服务器返回的微信授权地址无效');
      // 通过中转页在新窗口打开，确保微信要求的"授权入口页域名"一致，同时不破坏当前登录会话
      const launchUrl = `${window.location.origin}/auth-launch.html?url=${encodeURIComponent(target.toString())}`;
      window.open(launchUrl, '_blank', 'noopener,noreferrer');
      setAuthorizing(false);
      message.success('微信授权窗口已打开，请用商户微信扫码完成授权');
    } catch (error) {
      message.error((error as Error).message);
      setAuthorizing(false);
    }
  }

  async function startAuthorization() {
    if (!status?.actions?.canStartAuthorization) {
      message.warning('当前未满足微信注册事实或当前账号没有开户写权限，请先完成真实注册并刷新状态。');
      setShowAuthorizationModal(false);
      return;
    }
    await openAuthorizationWindow();
  }

  /** 昵称本地规则检测（对齐微信 setnickname 规则，非假检测）：不支持"小程序"关键字；名称长度 4-30 字 */
  function checkNicknameLocal() {
    const nickname = (basicInfo.nickname || '').trim();
    if (!nickname) { message.error('请先输入昵称'); return; }
    if (nickname.includes('小程序')) { message.error('微信昵称不支持包含"小程序"字样'); return; }
    const len = [...nickname].length;
    if (len < 4 || len > 30) { message.error(`昵称长度需为 4-30 个字符（当前 ${len} 个）`); return; }
    message.success('昵称通过本地规则检测（最终以微信审核结果为准）');
  }

  async function saveBasicInfo(values?: BasicInfoForm) {
    const info = values || basicInfo;
    setBasicInfo(info);
    persistBasicDraft(info);
    setShowBasicDrawer(false);
    // 保存商户名称/主体名称/联系电话到后端，刷新后不丢失
    try {
      await request(`/merchants/${merchantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          brandName: (info.merchantName || status?.merchantName || '').trim(),
          legalName: (info.legalName || status?.merchantLegalName || '').trim(),
          servicePhone: (info.servicePhone || status?.servicePhone || '').trim(),
        }),
      });
      message.success('基础资料已保存');
      void load();
    } catch (error) {
      message.error(`保存失败：${(error as Error).message}`);
    }
    // 有改动的头像/昵称/简介同步提交微信（昵称/简介有改动才提交，避免浪费修改额度）
    void submitProfileToWechat({ nickname: info.nickname, introduction: info.introduction }, { silentWhenNoChange: true });
  }

  async function submitProfileToWechat(overrides?: { nickname?: string; introduction?: string }, opts?: { silentWhenNoChange?: boolean }) {
    if (status?.authorizationStatus !== 'AUTHORIZED') {
      if (!opts?.silentWhenNoChange) message.warning('请先完成小程序授权再提交资料');
      return;
    }
    setSubmittingProfile(true);
    setProfileResults(null);
    try {
      const nickname = overrides && overrides.nickname !== undefined ? overrides.nickname : basicInfo.nickname;
      const introduction = overrides && overrides.introduction !== undefined ? overrides.introduction : basicInfo.introduction;
      // 微信官方规则：昵称不支持包含"小程序"关键字（setnickname 会拒绝）。提交前本地拦截，避免浪费改名配额。
      if (nickname && nickname.includes('小程序')) {
        if (!opts?.silentWhenNoChange) message.error('微信昵称不支持包含"小程序"字样，请修改后重试');
        return;
      }
      const payload: Record<string, unknown> = { subjectNature: filingForm.subjectNature || 'ENTERPRISE' };
      // 头像：仅当本次新选择了头像才提交（避免浪费每年 5 次修改额度）
      if (avatarDataUrl) payload.avatarDataUrl = avatarDataUrl;
      // 昵称/简介：已放开"有改动才提交"限制，有值即提交微信（不再与上次提交值比对）
      if (nickname) payload.nickname = nickname;
      if (introduction) payload.introduction = introduction;
      const license = filingForm.certificateFront || status.filingLicenseDataUrl || '';
      if (license) payload.licenseDataUrl = license;
      if (!payload.avatarDataUrl && !payload.nickname && !payload.introduction) {
        if (!opts?.silentWhenNoChange) message.info('没有需要提交到微信的改动（头像、昵称、简介均未修改）');
        return;
      }
      const result = await request<{ results: Array<{ field: string; ok: boolean; message: string }>; licenseSaved: boolean }>(`/wechat-platform/account-profile?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify(payload) });
      setProfileResults(result.results);
      const allOk = result.results.length > 0 && result.results.every((item) => item.ok);
      if (allOk) message.success('资料已提交微信'); else message.warning('部分字段提交微信失败，请查看下方结果');
      result.results.forEach((item) => {
        if (item.ok && item.field === 'avatar') {
          const picked = avatarDataUrl;
          if (picked) { setBasicInfo((current) => ({ ...current, avatarUrl: picked })); setAvatarDataUrl(''); }
        }
      });
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmittingProfile(false);
    }
  }

  function profileFieldLabel(field: string) { return ({ nickname: '昵称', avatar: '头像', introduction: '简介' } as Record<string, string>)[field] || field; }

  async function persistFilingDataToBackend(values: FilingForm) {
    await request(`/wechat-platform/filing-data?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify(values) });
  }

  async function submitFiling() {
    const values = filingFormState.getFieldsValue(true) as FilingForm;
    setFilingForm((current) => ({ ...current, ...values }));
    persistFilingDraft({ ...filingForm, ...values });
    try {
      await persistFilingDataToBackend(values);
    } catch (error) {
      message.error(`备案资料保存失败，已停止提交微信：${(error as Error).message}`);
      return;
    }
    // 资料保存成功后才提交微信；不再以本地开户状态推进代替真实提交。
    // 资料保存成功后直接调微信提交接口；若微信校验拦截（86202 等）错误信息会展示给用户。
    setShowFilingModal(false);
    await submitIcpFilingToWechat();
  }

  async function saveFilingDraft() {
    const values = filingFormState.getFieldsValue(true) as FilingForm;
    setFilingForm((current) => ({ ...current, ...values }));
    persistFilingDraft({ ...filingForm, ...values });
    try {
      await persistFilingDataToBackend(values);
      message.success('备案草稿已保存到服务器');
    } catch (error) {
      message.error(`备案草稿保存失败：${(error as Error).message}`);
    }
  }

  /** 快速注册企业小程序：平台代创建，返回授权二维码，法人 24h 内扫码验证（人脸+手机号） */
  async function submitFastRegister() {
    if (role !== 'AGENCY_ADMIN') {
      message.warning('只有代理管理员可以发起微信小程序真实注册。');
      return;
    }
    const values = await fastRegisterForm.validateFields();
    setFastRegisterSubmitting(true);
    try {
      const result = await request(`/wechat-platform/fast-register?merchantId=${merchantId}`, {
        method: 'POST',
        body: JSON.stringify(values),
      }) as { taskid: string; authorizeUrl: string; status: number };
      setFastRegisterResult({ taskid: result.taskid, authorizeUrl: result.authorizeUrl, statusLabel: '等待法人扫码验证' });
      setShowFastRegisterModal(false);
      setShowFastRegisterResultModal(true);
      void load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setFastRegisterSubmitting(false);
    }
  }

  /** 查询快速注册任务状态（法人扫码验证进度） */
  async function refreshFastRegisterStatus() {
    if (!fastRegisterResult?.taskid) return;
    setFastRegisterSubmitting(true);
    try {
      const result = await request(`/wechat-platform/fast-register/query?merchantId=${merchantId}`, {
        method: 'POST',
      }) as { status: number; statusLabel: string; authorizeUrl?: string };
      setFastRegisterResult((prev) => ({
        taskid: prev?.taskid || '',
        authorizeUrl: result.authorizeUrl || prev?.authorizeUrl || '',
        statusLabel: result.statusLabel,
      }));
      if (result.statusLabel === '创建成功') {
        message.success('快速注册创建成功，小程序已创建并授权');
        // authorized 事件回调（含 appid+auth_code）与前端查询存在时序差：
        // 立即刷新一次页面状态；若 AppID 尚未同步，则最多再轮询 5 次（每次 3 秒）直到同步完成。
        void syncAppIdAfterFastRegister(0);
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setFastRegisterSubmitting(false);
    }
  }

  /** 快速注册创建成功后轮询刷新 status，直到 authorizerAppId 同步显示（或超时）。 */
  async function syncAppIdAfterFastRegister(attempt: number) {
    const fresh = await load();
    if (fresh?.authorizerAppId) return;
    if (attempt < 5) {
      setTimeout(() => void syncAppIdAfterFastRegister(attempt + 1), 3000);
    } else {
      message.warning('小程序已创建，但 AppID 尚未同步，请稍后点击「刷新状态」重试');
    }
  }

  async function submitCategory() {
    if (!selectedFirst || !selectedSecond) {
      message.warning('请先选择一级和二级类目');
      return;
    }
    try {
      const result = await request<{ saved: boolean; simulated?: boolean; message?: string }>('/wechat-platform/categories?merchantId=' + merchantId, {
        method: 'POST',
        body: JSON.stringify({ categories: [{ firstId: selectedFirst, secondId: selectedSecond }] }),
      });
      message.success(result.simulated ? '类目设置已保存（模拟环境）' : '类目设置已提交微信审核');
      setShowCategoryDrawer(false);
    } catch (error) {
      message.error(`保存类目失败：${(error as Error).message}`);
    }
  }

  function openAuthorizationModal() {
    setShowAuthorizationModal(true);
  }

  function openBasicDrawer() {
    // 用后端 status 数据回填商户名称/主体名称/电话，保证抽屉里能编辑
    const prefilled: BasicInfoForm = {
      ...basicInfo,
      merchantName: status?.merchantName || basicInfo.merchantName || '',
      legalName: status?.merchantLegalName || basicInfo.legalName || '',
      servicePhone: status?.servicePhone || basicInfo.servicePhone || '',
    };
    basicForm.setFieldsValue(prefilled);
    setBasicInfo(prefilled);
    setShowBasicDrawer(true);
  }

  async function loadCategoryOptions() {
    setCategoryLoading(true);
    try {
      const options = await request<Array<{ id: number; name: string; children?: Array<{ id: number; name: string }> }>>(`/wechat-platform/categories?merchantId=${merchantId}`);
      setCategoryOptions(options);
    } catch (error) {
      message.error(`加载类目失败：${(error as Error).message}`);
    } finally {
      setCategoryLoading(false);
    }
  }

  function openCategoryDrawer() {
    if (!categoryOptions.length) void loadCategoryOptions();
    setShowCategoryDrawer(true);
  }

  function openFilingDrawer() {
    filingFormState.setFieldsValue(filingForm);
    if (!icpServiceTypes.length) void loadIcpServiceTypes();
    if (!icpDistricts.length) void loadIcpDistricts();
    setShowFilingModal(true);
  }

  function openFilingPreview() {
    // 合并当前表单最新值，保证预览的是刚填的内容
    setFilingPreviewData({ ...filingForm, ...filingFormState.getFieldsValue(true) });
    setShowFilingPreview(true);
  }

  function filingPreviewText(): string {
    const data = filingPreviewData;
    const lines = [
      '【主体信息】',
      `主体性质：${data.subjectNature === 'INDIVIDUAL' ? '个体工商户' : '企业'}`,
      `主体名称：${data.subjectName || '-'}`,
      `统一社会信用代码：${data.certificateNo || '-'}`,
      `备案地区：${(data.filingRegion || []).join(' ')}`,
      `通讯地址：${data.communicationAddress || '-'}`,
      `注册地址：${data.certificateAddress || '-'}`,
      `营业执照营业期限：${data.certificateStartAt || '-'} 至 ${data.certificateEndAt || '-'}`,
      `营业执照照片：${data.certificateFront || '-'}`,
      '',
      '【主体负责人（企业=法定代表人，个体工商户=经营者）】',
      `负责人姓名：${data.responsibleName || '-'}`,
      `负责人手机号：${data.responsiblePhone || '-'}`,
      `负责人邮箱：${data.responsibleEmail || '-'}`,
      `应急联系电话：${data.emergencyContact || '-'}`,
      `负责人证件类型：${RESPONSIBLE_ID_TYPE_OPTIONS.find((item) => item.value === data.responsibleIdType)?.label || data.responsibleIdType || '-'}`,
      `负责人证件号码：${data.responsibleIdNo || '-'}`,
      `证件有效期：${data.responsibleIdStartAt || '-'} 至 ${data.responsibleIdEndAt || '-'}`,
      `身份证正面：${data.responsibleFront || '-'}`,
      `身份证背面：${data.responsibleBack || '-'}`,
      '',
      '【小程序信息】',
      `服务内容类型：${(data.serviceContentType || []).map((v) => serviceTypeLabel(v)).join('、')}`,
      `经营内容说明：${data.serviceDescription || '-'}`,
      `前置审批：${APPROVAL_TYPE_OPTIONS.find((item) => item.value === data.approvalType)?.label || data.approvalType || '以上都不涉及'}`,
      `审批编号：${data.approvalNo || '-'}`,
      `审批材料：${data.approvalMaterial || '-'}`,
      `补充说明：${data.serviceDescription2 || '-'}`,
    ];
    return lines.join('\n');
  }

  async function copyFilingSummary() {
    await navigator.clipboard.writeText(filingPreviewText());
    message.success('备案材料文本已复制');
  }

  function openAuditModal() {
    setShowAuditModal(true);
  }

  function selectSection(tab: PageTab, step?: ProgressStepKey) {
    setActiveTab(tab);
    if (step) setSelectedProgressStep(step);
  }

  function runProfileAction(action: string) {
    if (action === 'save') {
      saveFilingDraft();
      return;
    }
    if (action === 'verify') {
      void markVerificationStarted();
      return;
    }
    if (action === 'result') {
      void checkVerificationResult();
      return;
    }
    // FIX: 「提交备案申请」应直接提交微信（此前只打开编辑抽屉，未发生任何提交）
    if (action === 'submit') { void submitIcpFilingToWechat(); return; }
    if (action === 'registration') setActiveTab('basic');
  }

  async function markVerificationStarted() {
    setVerifySubmitting(true);
    try {
      const task = await request<IcpVerifyTask>(`/wechat-platform/icp-verify-task?merchantId=${merchantId}`, {
        method: 'POST',
        // along_with_auth 由后端按小程序认证状态自动决定：已认证→纯备案核身（false，微信向管理员发通知），未认证→二合一（true）
        body: JSON.stringify({ alongWithAuth: true }),
      });
      setVerifyTask(task);
      setShowVerifyQrModal(true);
      message.success('已发起微信官方人脸核身，请小程序管理员完成核验');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setVerifySubmitting(false);
    }
  }

  async function checkVerificationResult() {
    try {
      const task = await request<IcpVerifyTask>(`/wechat-platform/icp-verify-task?merchantId=${merchantId}`);
      setVerifyTask(task);
      if (task.status === 'SUCCEEDED') {
        message.success(task.message || '微信官方人脸核身成功');
        setShowVerifyQrModal(false);
      } else if (task.status === 'FAILED') {
        message.error(task.message || '微信官方人脸核身失败，请重新发起');
      } else {
        message.info(task.message || '微信官方核身处理中，请稍后再查');
      }
    } catch (error) {
      message.info((error as Error).message || '尚未发起身份核验，请先点击"发起人脸核身"');
    }
  }

  function persistBasicDraft(info: BasicInfoForm) {
    try { localStorage.setItem(`wechat_basic_${merchantId}`, JSON.stringify(info)); } catch { /* noop */ }
  }

  function persistFilingDraft(form: FilingForm) {
    try { localStorage.setItem(`wechat_filing_${merchantId}`, JSON.stringify(form)); } catch { /* noop */ }
  }

  function persistCategoryDraft(rows: CategoryRow[]) {
    try { localStorage.setItem(`wechat_category_${merchantId}`, JSON.stringify(rows)); } catch { /* noop */ }
  }

  function loadPersistedDrafts() {
    try {
      const basic = localStorage.getItem(`wechat_basic_${merchantId}`);
      if (basic) setBasicInfo((prev) => ({ ...prev, ...JSON.parse(basic) as BasicInfoForm }));
      const filing = localStorage.getItem(`wechat_filing_${merchantId}`);
      if (filing) setFilingForm((prev) => ({ ...prev, ...JSON.parse(filing) as FilingForm }));
    } catch { /* noop */ }
  }

  function userRole(): Role { return role || 'MERCHANT_ADMIN'; }

  if (!status) {
    return <section className="wechat-platform-page"><Button loading={loading} icon={<ReloadOutlined />} onClick={() => void load()}>加载微信平台状态</Button></section>;
  }

  const progressDetail = selectedProgress ?? buildProgressDetail({
    key: selectedProgressStep,
    steps: progressSteps,
    status,
    profile,
    canViewAppId,
    displayAppId,
    displayOriginalId,
    basicInfo,
    filingForm,
    categoryRows,
    approvalItems,
    readyCount,
    requirementTotal,
    actions,
    canWriteWechat: role === 'AGENCY_ADMIN',
    onNavigate,
    setActiveTab,
    openAuthorizationModal,
    openBasicDrawer,
    openCategoryDrawer,
    openFilingDrawer,
    openAuditModal,
    markVerificationStarted,
    checkVerificationResult,
    load,
    saveFilingDraft,
  });

  return (
    <div className="wechat-platform-page">
      <section className="wechat-mini-header">
        <div className="wechat-mini-header-left">
          <Avatar size={52} src="/favicon.ico">示</Avatar>
          <div>
            <span>{profile.stageLabel}</span>
            <h2>{profile.title}</h2>
            <p>{profile.subtitle}</p>
          </div>
        </div>
        <div className="wechat-mini-header-actions">
          <Tag color={status.componentReady ? 'green' : 'gold'}>{status.componentReady ? '第三方平台已就绪' : '配置待补齐'}</Tag>
          {role === 'AGENCY_ADMIN' && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowFastRegisterModal(true)}>快速注册小程序</Button>
          )}
          <Button onClick={() => onNavigate('registration')}>主体进度</Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新状态</Button>
        </div>
      </section>

      <section className="wechat-workspace-shell">
        <aside className="wechat-side-nav">
          <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => selectSection('overview', 'registration')}>注册/授权</button>
          <button className={activeTab === 'basic' ? 'active' : ''} onClick={() => selectSection('basic', 'basicInfo')}>基础资料</button>
          <button className={activeTab === 'filing' ? 'active' : ''} onClick={() => selectSection('filing', 'filing')}>备案资料</button>
          <button className={activeTab === 'category' ? 'active' : ''} onClick={() => selectSection('category', 'categories')}>类目设置</button>
          <button className={activeTab === 'publish' ? 'active' : ''} onClick={() => selectSection('publish', 'publishable')}>发布管理</button>
          <button className={activeTab === 'auth' ? 'active' : ''} onClick={() => selectSection('auth', 'authorization')}>授权/平台</button>
          <button className={activeTab === 'config' ? 'active' : ''} onClick={() => selectSection('config', 'publishable')}>其他设置</button>
        </aside>

        <main className="wechat-page-body">
          <section className="wechat-flow-banner">
            <div className="wechat-flow-banner-copy">
              <span>当前流程</span>
              <h3>{profile.title}</h3>
              <p>{profile.alertMessage}</p>
            </div>
            <div className="wechat-flow-banner-tags">
              {profile.badges.map((badge) => <Tag key={badge.key} color="default">{badge.label}</Tag>)}
            </div>
          </section>

          <section className="wechat-step-panel">
            <div className="wechat-clickable-steps">
              {progressSteps.map((step, index) => {
                const isSelected = step.key === selectedProgressStep;
                const isComplete = step.state === 'complete';
                const isCurrent = step.state === 'current';
                return (
                  <button
                    key={`${step.key}-${index}`}
                    type="button"
                    className={`wechat-clickable-step ${isSelected ? 'selected' : ''} ${step.state}`}
                    onClick={() => setSelectedProgressStep(step.key)}
                    aria-current={isSelected ? 'step' : undefined}
                  >
                    <span className="wechat-clickable-step-icon">{isComplete ? <CheckCircleFilled /> : isCurrent ? index + 1 : index + 1}</span>
                    <span className="wechat-clickable-step-copy">
                      <strong>{step.label}</strong>
                      <small>{progressStateLabel(step.state)}</small>
                    </span>
                    {index < progressSteps.length - 1 ? <i /> : null}
                  </button>
                );
              })}
            </div>
            <div className="wechat-step-alert">{profile.alertTone === 'success' ? <CheckCircleFilled /> : profile.alertTone === 'warning' ? <WarningFilled /> : <InfoCircleOutlined />}<span>{profile.alertMessage}</span></div>
            <Card className="wechat-step-detail-card" variant="borderless">
              <div className="wechat-step-detail-heading">
                <div>
                  <Tag color={progressDetail.tone === 'success' ? 'green' : progressDetail.tone === 'processing' ? 'blue' : 'gold'}>{progressDetail.stateLabel}</Tag>
                  <strong>{progressDetail.label}</strong>
                  <span>{progressDetail.summary}</span>
                  <p>{progressDetail.description}</p>
                </div>
                <Space wrap>
                  {progressDetail.actions.map((action) => (
                    <Button key={action.key} type={action.type} danger={action.danger} onClick={action.onClick}>{action.label}</Button>
                  ))}
                </Space>
              </div>
              <div className="wechat-step-detail-grid">
                {progressDetail.fields.map((field) => (
                  <div key={field.label}>
                    <span>{field.label}</span>
                    <strong>{field.value}</strong>
                  </div>
                ))}
              </div>
            </Card>
          </section>

          {activeTab === 'overview' && (
            <>
              <section className="wechat-action-panel">
                <div>
                  <strong>当前操作</strong>
                  <span>页面只弹出当前步骤组件，完成后刷新进度进入下一步。</span>
                </div>
                <Space wrap>
                  {profile.buttons.map((button) => (
                    <Button
                      key={button.key}
                      type={button.type}
                      danger={button.danger}
                      disabled={button.disabled}
                      onClick={() => runProfileAction(button.key)}
                    >
                      {button.label}
                    </Button>
                  ))}
                </Space>
              </section>

              <section className="wechat-status-grid">
                <Card className="wechat-summary-card" variant="borderless">
                  <span>状态</span>
                  <strong>{onboardingStatusText(status)}</strong>
                  <small>{status.lastSyncError || '微信真实事实自动计算，页面仅展示当前状态'}</small>
                </Card>
                <Card className="wechat-summary-card" variant="borderless">
                  <span>AppID</span>
                  <strong>{appIdCell}</strong>
                  <small>授权方 / 第三方平台识别码</small>
                </Card>
                <Card className="wechat-summary-card" variant="borderless">
                  <span>审核状态</span>
                  <strong>{status.authorizationStatus || '未开始'}</strong>
                  <small>{status.authorizedAt ? dayjs(status.authorizedAt).format('YYYY-MM-DD HH:mm') : '暂无授权时间'}</small>
                </Card>
                <Card className="wechat-summary-card" variant="borderless">
                  <span>已完成项</span>
                  <strong>{readyCount}/{requirementTotal}</strong>
                  <small>主体 / 认证 / 备案 / 资质</small>
                </Card>
              </section>

              <section className="wechat-card-grid">
                <Card className="wechat-preview-card" title="小程序注册" extra={<Tag color={status.authorizationStatus ? 'green' : 'default'}>{onboardingStatusText(status)}</Tag>}>
                  <div className="wechat-preview-media">
                    {qrDataUrl ? (
                      <>
                        <img alt="小程序码" src={qrDataUrl} className="wechat-qr-code" />
                        <Tag color={qrMode === 'trial' ? 'blue' : 'green'}>{qrMode === 'trial' ? '体验版' : '正式版'}</Tag>
                      </>
                    ) : (
                      <>
                        <img alt="小程序码" src="/favicon.ico" className="wechat-qr-placeholder" />
                        <span className="wechat-qr-hint">正式版未发布，暂无预览码；请先通过「同步小程序」上传模板代码生成体验版二维码</span>
                      </>
                    )}
                    {status?.authorizationStatus === 'AUTHORIZED' && <Button type="link" size="small" loading={qrLoading} onClick={() => void loadQrCode()}>刷新二维码</Button>}
                  </div>
                  <div className="wechat-preview-meta">
                    <Descriptions column={1} size="small" bordered>
                      {canViewAppId && <Descriptions.Item label="授权 AppID">{appIdCell}</Descriptions.Item>}
                      <Descriptions.Item label="小程序名称">{basicInfo.merchantName || status.merchantName}</Descriptions.Item>
                      <Descriptions.Item label="主体名称">{basicInfo.legalName || status.merchantLegalName}</Descriptions.Item>
                      <Descriptions.Item label="认证类型">微信认证</Descriptions.Item>
                      <Descriptions.Item label="账号类型">普通小程序</Descriptions.Item>
                    </Descriptions>
                    <Space wrap>
                      {role === 'AGENCY_ADMIN' && <Button type="primary" onClick={() => setShowFastRegisterModal(true)}>快速注册小程序</Button>}
                      {role === 'AGENCY_ADMIN' && <Button onClick={openAuthorizationModal}>打开微信授权</Button>}
                      <Button onClick={openBasicDrawer}>基础资料</Button>
                    </Space>
                  </div>
                </Card>

                <Card className="wechat-preview-card" title="当前操作" extra={<Badge status={actions.canManageFiling ? 'success' : 'warning'} text={actions.canManageFiling ? '可继续' : '待前序完成'} />}>
                  <Alert
                    showIcon
                    type={onboardingStatusValue(status) === 'FAILED' ? 'error' : 'info'}
                    message={status.registrationFailureReason || '页面只弹出当前步骤组件，完成后刷新进度进入下一步。'}
                    description="提交前建议先完成法人身份核验。"
                    className="wechat-inline-alert"
                  />
                  <Descriptions column={2} size="small" bordered>
                    <Descriptions.Item label="当前步骤">{profile.stageLabel}</Descriptions.Item>
                    <Descriptions.Item label="小程序">{status.merchantName}</Descriptions.Item>
                    {canViewAppId && <Descriptions.Item label="AppID">{appIdCell}</Descriptions.Item>}
                    <Descriptions.Item label="最近同步">{status.ticketUpdatedAt ? dayjs(status.ticketUpdatedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
                  </Descriptions>
                </Card>

                <Card className="wechat-preview-card" title="微信认证" extra={verifyStatus ? <Tag color={verifyStatus.verified ? 'green' : 'orange'}>{verifyStatus.verified ? '已认证' : '未认证'}</Tag> : <Tag>查询中</Tag>}>
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="认证主体">{verifyStatus?.principalName || basicInfo.legalName || status?.merchantLegalName || '-'}</Descriptions.Item>
                    <Descriptions.Item label="认证状态">{verifyStatus ? (verifyStatus.verified ? '已完成微信认证' : '未认证') : '查询中…'}</Descriptions.Item>
                    <Descriptions.Item label="名称认证">{verifyStatus ? (verifyStatus.namingVerified ? '已认证' : '未认证') : '-'}</Descriptions.Item>
                    {wechatVerifyTask && wechatVerifyTask.taskid && (
                      <>
                        <Descriptions.Item label="认证任务">{VERIFY_TASK_STATUS_META[wechatVerifyTask.taskStatus]?.label || `任务状态 ${wechatVerifyTask.taskStatus}`}</Descriptions.Item>
                        <Descriptions.Item label="审核单">
                          <Tag color={VERIFY_APPLY_STATUS_META[wechatVerifyTask.applyStatus]?.tone || 'default'}>{VERIFY_APPLY_STATUS_META[wechatVerifyTask.applyStatus]?.label || `状态 ${wechatVerifyTask.applyStatus}`}</Tag>
                        </Descriptions.Item>
                        {wechatVerifyTask.applyStatus === 3 && wechatVerifyTask.refillReason && <Descriptions.Item label="打回原因">{wechatVerifyTask.refillReason}</Descriptions.Item>}
                        {wechatVerifyTask.applyStatus === 5 && wechatVerifyTask.failReason && <Descriptions.Item label="失败原因">{wechatVerifyTask.failReason}</Descriptions.Item>}
                      </>
                    )}
                  </Descriptions>
                  {verifyStatus && !verifyStatus.verified && (
                    <Alert
                      showIcon
                      type="warning"
                      className="wechat-inline-alert"
                      message="未认证的小程序仅部分商业类目可用，且无法开通微信支付"
                      description={`系统代发起认证（${certificationFeeText}）：发起后请商家负责人微信扫码，在微信内完成授权并支付，审核 1-3 个工作日。费用不可退。`}
                    />
                  )}
                  <Space wrap style={{ marginTop: 12 }}>
                    {verifyStatus && !verifyStatus.verified && wechatVerifyTask?.applyStatus !== 4 && wechatVerifyTask?.applyStatus !== 2 && wechatVerifyTask?.applyStatus !== 1 && (
                      <Button type="primary" disabled={status?.authorizationStatus !== 'AUTHORIZED'} loading={wechatVerifySubmitting} onClick={() => void startWechatVerify()}>{wechatVerifyTask?.taskid ? '重新发起认证' : '发起微信认证'}</Button>
                    )}
                    {wechatVerifyTask?.taskid && (
                      <>
                        {wechatVerifyTask.authUrl && <Button onClick={() => setWechatVerifyQr({ taskid: wechatVerifyTask.taskid, authUrl: wechatVerifyTask.authUrl, feeFen: wechatVerifyTask.feeFen })}>查看授权二维码</Button>}
                        {wechatVerifyTask.applyStatus === 3 && <Button type="primary" loading={wechatVerifySubmitting} onClick={() => void reauthWechatVerify()}>重新提审</Button>}
                        <Button loading={wechatVerifyLoading} onClick={() => void loadWechatVerifyTask()}>刷新认证进度</Button>
                      </>
                    )}
                    <Button loading={verifyStatusLoading} onClick={() => void loadVerifyStatus()}>刷新认证状态</Button>
                  </Space>
                </Card>
              </section>
            </>
          )}

          {activeTab === 'basic' && (
            <Card className="wechat-detail-card" title="基本资料" extra={<Space><Button onClick={openBasicDrawer}>编辑</Button>{role === 'AGENCY_ADMIN' && <Button type="primary" onClick={() => setShowFastRegisterModal(true)}>发起快速注册</Button>}</Space>}>
              <section className="wechat-subsection">
                <div className="wechat-subsection-heading">
                  <div>
                    <strong>小程序资料</strong>
                    <span>按顺序完善头像、昵称和简介，提交后以微信侧审核结果为准。昵称提交后进入微信审核，头像/简介即时生效。</span>
                  </div>
                  <div className="wechat-inline-badges">
                    <Tag color="green">微信认证</Tag>
                    {icpFilingStatus && <Tag color={icpStatusInfo.color}>{icpStatusInfo.label}</Tag>}
                    <Button type="primary" icon={<UploadOutlined />} loading={submittingProfile} onClick={() => void submitProfileToWechat()}>提交资料到微信</Button>
                  </div>
                </div>
                <div className="wechat-basic-layout">
                  <div className="wechat-avatar-block">
                    <span>编辑头像</span>
                    <div className="wechat-avatar-row">
                      <Avatar shape="square" size={112} src={avatarDataUrl || basicInfo.avatarUrl || '/favicon.ico'} />
                      <Space direction="vertical">
                        <small>当前头像</small>
                        <Button type="primary" icon={<UploadOutlined />} onClick={() => handleFilePick(avatarInputRef)}>选择并裁剪头像</Button>
                      </Space>
                    </div>
                  </div>
                  <div className="wechat-basic-form-card">
                    <span>编辑昵称</span>
                    <Descriptions column={1} size="small">
                      <Descriptions.Item label="当前昵称">{basicInfo.nickname}</Descriptions.Item>
                    </Descriptions>
                    <Space.Compact className="wechat-inline-input">
                      <Input value={basicInfo.nickname} onChange={(event) => setBasicInfo((current) => ({ ...current, nickname: event.target.value }))} placeholder="请输入新的小程序昵称" />
                      <Button onClick={() => checkNicknameLocal()}>检测昵称</Button>
                      <Button onClick={() => setBasicInfo(DEFAULT_BASIC_INFO)}>重置</Button>
                    </Space.Compact>
                  </div>
                </div>
                <div className="wechat-intro-card">
                  <span>编辑简介</span>
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="当前简介">{basicInfo.introduction}</Descriptions.Item>
                  </Descriptions>
                  <Input.TextArea value={basicInfo.introduction} onChange={(event) => setBasicInfo((current) => ({ ...current, introduction: event.target.value }))} rows={4} maxLength={120} showCount />
                  <Space>
                    <Button type="primary" onClick={() => saveBasicInfo(basicInfo)}>保存简介</Button>
                    <Button onClick={() => setBasicInfo(DEFAULT_BASIC_INFO)}>重置</Button>
                  </Space>
                </div>
                {profileResults && (
                  <Alert
                    showIcon
                    type={profileResults.every((item) => item.ok) ? 'success' : 'warning'}
                    message={profileResults.every((item) => item.ok) ? '资料已提交微信' : '部分字段提交微信失败'}
                    description={
                      <div className="wechat-profile-results">
                        {profileResults.map((item) => (
                          <div key={item.field}>
                            <Tag color={item.ok ? 'green' : 'red'}>{profileFieldLabel(item.field)}</Tag>
                            <span>{item.message}</span>
                          </div>
                        ))}
                      </div>
                    }
                  />
                )}
              </section>
              <Divider />
              <section className="wechat-subsection">
                <div className="wechat-subsection-heading">
                  <div>
                    <strong>基础信息</strong>
                    <span>展示小程序码、授权 AppID、主体名称与认证状态。</span>
                  </div>
                </div>
                <div className="wechat-basic-info-grid">
                  <InfoField label="小程序码" value={status.authorizationStatus === 'AUTHORIZED' ? '已生成' : '待授权后生成'} extra={<Avatar shape="square" size={82} src="/favicon.ico" />} />
                  {canViewAppId && <InfoField label="授权 AppID" value={plainAppId || displayAppId} copyValue={plainAppId || (displayAppId === '待授权后同步' ? undefined : displayAppId)} extra={!plainAppId && displayAppId !== '待授权后同步' ? <Button type="link" size="small" loading={plainAppIdLoading} onClick={() => void loadPlainAppId()}>查看明文</Button> : undefined} />}
                  <InfoField label="小程序名称" value={basicInfo.merchantName || status.merchantName} />
                  <InfoField label="原始 ID" value={displayOriginalId} />
                  <InfoField label="主体名称" value={basicInfo.legalName || status.merchantLegalName} />
                  <InfoField label="认证类型" value="微信认证" />
                  <InfoField label="账号类型" value="普通小程序" />
                </div>
              </section>
            </Card>
          )}

          {activeTab === 'filing' && (
            <Card className="wechat-detail-card" title="备案资料与申请" extra={<Space><Button onClick={openFilingPreview}>预览备案材料</Button><Button onClick={openFilingDrawer}>编辑备案</Button><Button type="primary" disabled={!status.certified} loading={submittingIcpFiling} onClick={() => void submitIcpFilingToWechat()}>提交微信备案</Button></Space>}>
              <section className="wechat-subsection">
                <div className="wechat-subsection-heading">
                  <div>
                    <strong>当前阶段：{icpFilingStatus ? icpStatusInfo.label : '备案资料填写中'}</strong>
                    <span>保存草稿后可多次回到这里继续完善，提交前建议先完成人脸核验。</span>
                  </div>
                  <div className="wechat-inline-badges">
                    {icpFilingStatus && <Tag color={icpStatusInfo.color}>{icpStatusInfo.label}</Tag>}
                    <Tag color="green">认证 微信认证</Tag>
                  </div>
                </div>
                <div className="wechat-action-row">
                  <Button onClick={() => runProfileAction('save')}>保存草稿</Button>
                  <Button loading={verifySubmitting} onClick={() => runProfileAction('verify')}>发起人脸核身</Button>
                  <Button onClick={() => runProfileAction('result')}>查询核身结果</Button>
                  <Button type="primary" disabled={!status.certified} loading={submittingIcpFiling} onClick={() => void submitIcpFilingToWechat()}>提交微信备案</Button>
                </div>
                <Alert type="info" showIcon message="操作步骤：资料准备 » 法人身份核验 » 微信认证 » 提交备案 » 管局审核" />
              </section>
              <Divider />
              <section className="wechat-subsection">
                <div className="wechat-subsection-heading">
                  <div>
                    <strong>微信备案提交流程</strong>
                    <span>必须先完成微信认证，认证通过后才能提交备案到微信管局。</span>
                  </div>
                </div>
                <Alert
                  type={status.certified ? 'success' : 'warning'}
                  showIcon
                  message={status.certified ? '已通过微信认证，可以提交微信备案' : '未完成微信认证，暂不能提交备案'}
                  description={status.certified
                    ? '微信认证已完成。确认备案资料无误后，点击「提交微信备案」，系统会自动上传营业执照与负责人证件并提交到微信管局审核（3-20 个工作日）。'
                    : `微信小程序备案要求先完成微信认证（${certificationFeeText}）。点击「发起微信认证」，系统代发起认证后由商家负责人扫码在微信内完成授权与支付。`}
                />
                <div className="wechat-action-row">
                  {!status.certified && <Button type="primary" disabled={status?.authorizationStatus !== 'AUTHORIZED'} loading={wechatVerifySubmitting} onClick={() => void startWechatVerify()}>发起微信认证</Button>}
                  {!status.certified && wechatVerifyTask?.taskid && <Button onClick={() => void loadWechatVerifyTask()}>刷新认证进度</Button>}
                  <Button type="primary" disabled={!status.certified} loading={submittingIcpFiling} onClick={() => void submitIcpFilingToWechat()}>提交微信备案</Button>
                  <Button danger loading={cancelingIcpFiling} onClick={() => void cancelIcpFilingToWechat()}>取消备案</Button>
                  <Button loading={icpStatusLoading} onClick={() => void loadIcpFilingStatus()}>查询管局审核状态</Button>
                </div>
                {icpFilingStatus && (
                  <div style={{ marginTop: 16 }}>
                    <Descriptions bordered column={2} size="small">
                      <Descriptions.Item label="备案状态">
                        <Tag color={icpStatusInfo.color}>{icpStatusInfo.label}</Tag>
                        {icpStatusInfo.isCanceling && <Tag color="warning">注销中</Tag>}
                      </Descriptions.Item>
                      <Descriptions.Item label="备案入口">
                        {icpStatusInfo.available === 1 ? '开放' : <span style={{ color: '#cf1322' }}>未开放</span>}
                      </Descriptions.Item>
                    </Descriptions>
                    {icpStatusInfo.audit.length > 0 && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginTop: 12 }}
                        message="备案被驳回，原因如下（请按建议修改后重新提交）"
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {icpStatusInfo.audit.map((item, idx) => (
                              <li key={idx} style={{ marginBottom: 6 }}>
                                <strong>{item.key_name || '材料问题'}</strong>：{item.error || ''}
                                {item.suggest ? <div style={{ color: '#8c6d1f' }}>建议：{item.suggest}</div> : null}
                              </li>
                            ))}
                          </ul>
                        }
                      />
                    )}
                  </div>
                )}
              </section>
              <section className="wechat-filing-grid">
                <div className="wechat-filing-column">
                  <h4>主体必填信息</h4>
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="主体性质">{filingForm.subjectNature === 'ENTERPRISE' ? '企业' : '个体工商户'}</Descriptions.Item>
                    <Descriptions.Item label="备案地区">{filingForm.filingRegion.join(' / ')}</Descriptions.Item>
                    <Descriptions.Item label="主体名称">{filingForm.subjectName}</Descriptions.Item>
                    <Descriptions.Item label="通讯地址">{filingForm.communicationAddress}</Descriptions.Item>
                  </Descriptions>
                </div>
                <div className="wechat-filing-column">
                  <h4>{filingForm.subjectNature === 'INDIVIDUAL' ? '个体工商户营业执照信息' : '企业营业执照信息'}</h4>
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="统一社会信用代码">{filingForm.certificateNo}</Descriptions.Item>
                    <Descriptions.Item label="注册地址">{filingForm.certificateAddress}</Descriptions.Item>
                    <Descriptions.Item label="营业执照有效期">{filingForm.certificateStartAt} 至 {filingForm.certificateEndAt}</Descriptions.Item>
                    <Descriptions.Item label="营业执照照片">{filingForm.certificateFront ? '已上传' : '未上传'}</Descriptions.Item>
                  </Descriptions>
                </div>
                <div className="wechat-filing-column">
                  <h4>主体负责人信息（法人/经营者）</h4>
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="负责人姓名">{filingForm.responsibleName}</Descriptions.Item>
                    <Descriptions.Item label="负责人手机">{filingForm.responsiblePhone}</Descriptions.Item>
                    <Descriptions.Item label="负责人邮箱">{filingForm.responsibleEmail}</Descriptions.Item>
                    <Descriptions.Item label="应急联系方式">{filingForm.emergencyContact}</Descriptions.Item>
                    <Descriptions.Item label="负责人证件号码">{filingForm.responsibleIdNo}</Descriptions.Item>
                    <Descriptions.Item label="负责人证件有效期">{filingForm.responsibleIdStartAt} 至 {filingForm.responsibleIdEndAt}</Descriptions.Item>
                  </Descriptions>
                </div>
                <div className="wechat-filing-column">
                  <h4>小程序必填信息</h4>
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="服务内容类型">{filingForm.serviceContentType.join(' / ')}</Descriptions.Item>
                    <Descriptions.Item label="经营内容说明">{filingForm.serviceDescription}</Descriptions.Item>
                    <Descriptions.Item label="补充说明">{filingForm.serviceDescription2}</Descriptions.Item>
                    <Descriptions.Item label="前置审批">{approvalText(filingForm.approvalType)}</Descriptions.Item>
                  </Descriptions>
                </div>
              </section>
              <Divider />
              <section className="wechat-subsection">
                <h4>互联网信息服务前置审批项</h4>
                <div className="wechat-approval-list">
                  {approvalItems.map((item) => (
                    <Card key={item.id} size="small" className="wechat-approval-item">
                      <Descriptions column={1} size="small" bordered>
                        <Descriptions.Item label="审批类型">{item.approvalType}</Descriptions.Item>
                        <Descriptions.Item label="审批编号">{item.approvalNo}</Descriptions.Item>
                        <Descriptions.Item label="审批材料">{item.approvalMaterial}</Descriptions.Item>
                      </Descriptions>
                      <Button icon={<EditOutlined />} onClick={openAuditModal}>编辑审批项</Button>
                    </Card>
                  ))}
                </div>
              </section>
            </Card>
          )}

          {activeTab === 'category' && (
            <Card className="wechat-detail-card" title="类目设置" extra={<Space><Button onClick={openCategoryDrawer}>编辑类目</Button><Button type="primary" onClick={openCategoryDrawer}>保存类目设置</Button></Space>}>
              <Alert type="info" showIcon message="本周期总次数：5，剩余次数：5，最多可设置类目数：5" style={{ marginBottom: 16 }} />
              <section className="wechat-subsection">
                <h4>已设置类目</h4>
                <table className="wechat-simple-table">
                  <thead>
                    <tr>
                      <th>一级类目</th>
                      <th>二级类目</th>
                      <th>审核状态</th>
                      <th>审核原因</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.first}</td>
                        <td>{row.second}</td>
                        <td><Tag color={row.status === '审核通过' ? 'green' : 'red'}>{row.status}</Tag></td>
                        <td>{row.reason}</td>
                        <td><Button type="link">编辑资质</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <Divider />
              <section className="wechat-subsection">
                <h4>类目配置</h4>
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="选择类目"><Input placeholder="请选择一级 / 二级类目" /></Descriptions.Item>
                  <Descriptions.Item label="资质信息">当前没有资质项，可直接保存类目。</Descriptions.Item>
                </Descriptions>
                <Space style={{ marginTop: 16 }}>
                  <Button type="primary" onClick={submitCategory}>保存类目设置</Button>
                  <Button>刷新类目</Button>
                </Space>
              </section>
            </Card>
          )}

          {activeTab === 'auth' && (
            <Card className="wechat-detail-card" title="微信认证状态" extra={<Space><Button onClick={openAuthorizationModal}>打开微信授权</Button>{!verifyStatus?.verified && <Button type="primary" disabled={status?.authorizationStatus !== 'AUTHORIZED'} loading={wechatVerifySubmitting} onClick={() => void startWechatVerify()}>发起微信认证</Button>}</Space>}>
              <section className="wechat-auth-card">
                <div className="wechat-auth-head">
                  <div>
                    <strong>微信认证</strong>
                    <p>{verifyStatus ? (verifyStatus.verified ? '当前小程序已完成微信认证。' : '当前小程序未完成微信认证。') : '正在查询微信侧认证状态…'}</p>
                  </div>
                  <div className="wechat-inline-badges">
                    {verifyStatus ? (
                      <>
                        <Tag color={verifyStatus.verified ? 'green' : 'orange'}>{verifyStatus.verified ? '已认证' : '未认证'}</Tag>
                        {verifyStatus.verified && <Tag>已完成认证</Tag>}
                      </>
                    ) : <Tag>查询中</Tag>}
                  </div>
                </div>
                <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
                  <Descriptions.Item label="状态">{verifyStatus ? (verifyStatus.verified ? '已认证' : '未认证') : '查询中…'}</Descriptions.Item>
                  <Descriptions.Item label="认证主体">{verifyStatus?.principalName || status?.merchantLegalName || '-'}</Descriptions.Item>
                  <Descriptions.Item label="名称认证">{verifyStatus ? (verifyStatus.namingVerified ? '已认证' : '未认证') : '-'}</Descriptions.Item>
                  <Descriptions.Item label="审核状态">{verifyStatus ? (verifyStatus.verified ? '认证通过' : '未认证') : '-'}</Descriptions.Item>
                  {verifyStatus?.annualReview && verifyStatus.annualReviewEndAt ? (
                    <Descriptions.Item label="年审截止">
                      {dayjs(verifyStatus.annualReviewEndAt * 1000).format('YYYY-MM-DD')}
                      {Date.now() > verifyStatus.annualReviewEndAt * 1000 ? '（已过期，需重新认证）' : ''}
                    </Descriptions.Item>
                  ) : <Descriptions.Item label="年审">无需年审</Descriptions.Item>}
                  <Descriptions.Item label="刷新"><Button type="link" size="small" loading={verifyStatusLoading} onClick={() => void loadVerifyStatus()} style={{ paddingLeft: 0 }}>刷新认证状态</Button></Descriptions.Item>
                </Descriptions>
              </section>
              {wechatVerifyTask?.taskid && (
                <section className="wechat-subsection">
                  <h4>系统代发起的认证任务</h4>
                  <Alert
                    showIcon
                    type={wechatVerifyTask.applyStatus === 4 ? 'success' : wechatVerifyTask.applyStatus === 3 || wechatVerifyTask.applyStatus === 5 ? 'warning' : 'info'}
                    style={{ marginBottom: 12 }}
                    message={`认证费用：${verifyFeeText(wechatVerifyTask.feeFen)}（${wechatVerifyTask.payType === 1 ? '平台代缴' : '商家自付'}，费用不可退，以微信官方实际收费为准）`}
                    description={
                      <div>
                        <p style={{ margin: '0 0 8px' }}>任务状态：{VERIFY_TASK_STATUS_META[wechatVerifyTask.taskStatus]?.label || `任务状态 ${wechatVerifyTask.taskStatus}`}｜审核单：{VERIFY_APPLY_STATUS_META[wechatVerifyTask.applyStatus]?.label || `状态 ${wechatVerifyTask.applyStatus}`}{wechatVerifyTask.orderId ? `｜订单号 ${wechatVerifyTask.orderId}` : ''}</p>
                        {wechatVerifyTask.applyStatus === 3 && wechatVerifyTask.refillReason && <p style={{ margin: 0, color: '#a8071a' }}>打回原因：{wechatVerifyTask.refillReason}</p>}
                        {wechatVerifyTask.applyStatus === 5 && wechatVerifyTask.failReason && <p style={{ margin: 0, color: '#a8071a' }}>失败原因：{wechatVerifyTask.failReason}</p>}
                      </div>
                    }
                  />
                  <Space wrap>
                    {wechatVerifyTask.authUrl && <Button onClick={() => setWechatVerifyQr({ taskid: wechatVerifyTask.taskid, authUrl: wechatVerifyTask.authUrl, feeFen: wechatVerifyTask.feeFen })}>查看授权二维码</Button>}
                    {wechatVerifyTask.applyStatus === 3 && <Button type="primary" loading={wechatVerifySubmitting} onClick={() => void reauthWechatVerify()}>重新提审（不重复收费）</Button>}
                    <Button loading={wechatVerifyLoading} onClick={() => void loadWechatVerifyTask()}>刷新认证进度</Button>
                  </Space>
                </section>
              )}
              <Divider />
              <section className="wechat-subsection">
                <h4>授权流程相关</h4>
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label="登录授权的发起页域名">域名：{status.authorizationDomain || 'example.com'}</Descriptions.Item>
                  <Descriptions.Item label="授权事件接收配置">{status.eventCallbackUrl}</Descriptions.Item>
                  <Descriptions.Item label="授权后实现业务">消息校验 Token、消息加解密 Key、消息与事件接收配置</Descriptions.Item>
                </Descriptions>
              </section>
              <Divider />
              <section className="wechat-subsection">
                <h4>授权后实现业务</h4>
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label="消息校验Token">{secretStatusText(status, 'messageCrypto')}</Descriptions.Item>
                  <Descriptions.Item label="消息加解密Key">{secretStatusText(status, 'messageCrypto')}</Descriptions.Item>
                  <Descriptions.Item label="消息与事件接收配置">{status.messageCallbackTemplate}</Descriptions.Item>
                </Descriptions>
              </section>
              <Divider />
              <section className="wechat-subsection">
                <h4>其他</h4>
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label="白名单IP地址列表">203.0.113.10 <Button type="link" onClick={() => void copy('203.0.113.10', '白名单IP')}>修改</Button></Descriptions.Item>
                  <Descriptions.Item label="授权测试账号列表"><Button type="link">修改</Button></Descriptions.Item>
                  <Descriptions.Item label="API安全配置">通过设置API密钥，可在请求平台关键API时，对请求信息进行加密，阻止网络监听、木马病毒等手段窃取信息 <Button type="link">开始配置</Button></Descriptions.Item>
                </Descriptions>
              </section>
            </Card>
          )}

          {activeTab === 'config' && (
            <Card className="wechat-detail-card" title="第三方平台配置" extra={<Space><Button onClick={() => void load()}>刷新状态</Button><Button type="primary" onClick={openAuthorizationModal}>发起授权</Button></Space>}>
              <Alert
                showIcon
                type={status.componentReady ? 'success' : 'warning'}
                message={status.componentReady ? '第三方平台配置已就绪' : '第三方平台配置尚未完整'}
                description="页面只展示脱敏后的 AppID、域名、回调地址与配置状态；Secret 仅从服务器环境变量读取。"
                style={{ marginBottom: 16 }}
              />
              <section className="wechat-config-grid-2">
                <Card size="small" title="基本配置">
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="平台名称">{status.merchantName}</Descriptions.Item>
                    <Descriptions.Item label="类型">平台型</Descriptions.Item>
                    <Descriptions.Item label="APPID">{displayAppId}</Descriptions.Item>
                    <Descriptions.Item label="秘密应用">已脱敏</Descriptions.Item>
                  </Descriptions>
                </Card>
                <Card size="small" title="授权流程相关">
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="登录授权的发起页域名">{status.authorizationDomain || '未配置'}</Descriptions.Item>
                    <Descriptions.Item label="授权事件接收配置">{status.eventCallbackUrl}</Descriptions.Item>
                    <Descriptions.Item label="消息与事件接收配置">{status.messageCallbackTemplate}</Descriptions.Item>
                  </Descriptions>
                </Card>
                <Card size="small" title="授权后实现业务">
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="消息校验Token">{secretStatusText(status, 'messageCrypto')}</Descriptions.Item>
                    <Descriptions.Item label="消息加解密Key">{secretStatusText(status, 'messageCrypto')}</Descriptions.Item>
                  </Descriptions>
                </Card>
                <Card size="small" title="其他">
                  <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="白名单IP地址列表">203.0.113.10</Descriptions.Item>
                    <Descriptions.Item label="服务器地域">{status.cosRegion || 'ap-guangzhou'}</Descriptions.Item>
                    <Descriptions.Item label="COS桶">{status.cosBucket || '未配置'}</Descriptions.Item>
                  </Descriptions>
                </Card>
              </section>
            </Card>
          )}

          {activeTab === 'publish' && (
            <PublishManagement merchantId={merchantId} request={request} role={role} />
          )}
        </main>
      </section>

      <Modal
        open={showFastRegisterModal}
        title="快速注册小程序（平台代创建）"
        width={640}
        onCancel={() => setShowFastRegisterModal(false)}
        onOk={() => void submitFastRegister()}
        confirmLoading={fastRegisterSubmitting}
        okText="发起快速注册"
      >
        <Alert type="info" showIcon message="平台代商家创建小程序：填写企业名称与统一社会信用代码后，微信将返回授权二维码，由商家法人扫码完成验证（人脸识别+手机号，24 小时内有效），全程无需邮箱。代理商不能代替法人验证。" style={{ marginBottom: 16 }} />
        <Form layout="vertical" form={fastRegisterForm} initialValues={{
          name: filingForm.subjectName || status?.merchantLegalName || '',
          code: filingForm.certificateNo || '',
        }}>
          <Form.Item label="企业名称（与营业执照一致）" name="name" rules={[{ required: true, message: '请填写企业名称' }]}><Input placeholder="如：示例市某某百货店" /></Form.Item>
          <Form.Item label="统一社会信用代码" name="code" rules={[{ required: true, message: '请填写统一社会信用代码' }, { pattern: /^[0-9A-HJ-NPQRTUWXY]{18}$/i, message: '应为 18 位统一社会信用代码' }]}><Input placeholder="18 位统一社会信用代码" maxLength={18} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        open={showFastRegisterResultModal}
        title="法人授权验证"
        width={480}
        onCancel={() => setShowFastRegisterResultModal(false)}
        footer={null}
      >
        <Alert type="info" showIcon message="请将下方二维码发送给商家，由商家法人使用微信扫码完成验证（人脸识别+手机号验证码，24 小时内有效）。" style={{ marginBottom: 16 }} />
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          {fastRegisterResult?.authorizeUrl ? (
            <QRCodeSVG value={fastRegisterResult.authorizeUrl} size={280} includeMargin />
          ) : (
            <div style={{ padding: 24, color: '#999' }}>二维码生成中...</div>
          )}
          <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>
            任务状态：{fastRegisterResult?.statusLabel || '未知'}（任务号 {fastRegisterResult?.taskid || '-'}）
          </div>
          <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>法人验证通过后，小程序将自动创建并完成授权绑定，无需额外操作。</div>
        </div>
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <Button loading={fastRegisterSubmitting} onClick={() => void refreshFastRegisterStatus()}>查询任务状态</Button>
        </div>
      </Modal>

      <Modal
        open={Boolean(wechatVerifyQr)}
        title="微信认证授权与支付"
        width={480}
        onCancel={() => setWechatVerifyQr(null)}
        footer={[
          <Button key="refresh" loading={wechatVerifyLoading} onClick={() => { setWechatVerifyQr(null); void loadWechatVerifyTask(); }}>刷新认证进度</Button>,
          <Button key="close" type="primary" onClick={() => setWechatVerifyQr(null)}>关闭</Button>,
        ]}
      >
        <Alert type="info" showIcon message="请将下方二维码发送给商家负责人（小程序管理员），由其使用微信扫码。在微信内完成授权确认并支付认证审核费（费用不可退），24 小时内有效。" style={{ marginBottom: 16 }} />
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          {wechatVerifyQr?.authUrl ? (
            <QRCodeSVG value={wechatVerifyQr.authUrl} size={280} includeMargin />
          ) : (
            <div style={{ padding: 24, color: '#999' }}>二维码生成中...</div>
          )}
          <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>
            认证费用：{verifyFeeText(wechatVerifyQr?.feeFen)}（任务号 {wechatVerifyQr?.taskid || '-'}）
          </div>
          <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>扫码后在微信官方页面完成授权与支付，系统会自动同步认证状态，无需回到公众平台操作。</div>
        </div>
      </Modal>

      <Modal
        open={showAuthorizationModal}
        title="完成授权"
        width={760}
        onCancel={() => setShowAuthorizationModal(false)}
        footer={null}
      >
        <Alert type="info" showIcon message="点击下方按钮打开微信授权页面，授权完成后回到这里刷新进度。" style={{ marginBottom: 18 }} />
        <Space>
          <Button type="primary" onClick={() => void startAuthorization()} loading={authorizing}>打开微信授权</Button>
          <Button onClick={() => void load()}>刷新进度</Button>
        </Space>
      </Modal>

      <Modal
        open={showFilingPreview}
        title="备案材料预览（用于微信小程序备案）"
        width={820}
        onCancel={() => setShowFilingPreview(false)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={() => void copyFilingSummary()}>复制备案文本</Button>,
          <Button key="close" type="primary" onClick={() => setShowFilingPreview(false)}>关闭</Button>,
        ]}
      >
        <Alert type="info" showIcon message="以下为已填写的备案材料清单，可在 mp.weixin.qq.com 填写小程序备案时对照使用。" style={{ marginBottom: 16 }} />
        <section className="wechat-filing-preview">
          <h4>主体信息</h4>
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="主体性质">{filingPreviewData.subjectNature === 'INDIVIDUAL' ? '个体工商户' : '企业'}</Descriptions.Item>
            <Descriptions.Item label="主体名称">{filingPreviewData.subjectName || '-'}</Descriptions.Item>
            <Descriptions.Item label="统一社会信用代码">{filingPreviewData.certificateNo || '-'}</Descriptions.Item>
            <Descriptions.Item label="备案地区">{(filingPreviewData.filingRegion || []).join(' ')}</Descriptions.Item>
            <Descriptions.Item label="通讯地址">{filingPreviewData.communicationAddress || '-'}</Descriptions.Item>
            <Descriptions.Item label="注册地址">{filingPreviewData.certificateAddress || '-'}</Descriptions.Item>
            <Descriptions.Item label="营业执照营业期限">{filingPreviewData.certificateStartAt || '-'} 至 {filingPreviewData.certificateEndAt || '-'}</Descriptions.Item>
          </Descriptions>
          <div className="wechat-filing-preview-images">
            <span>营业执照照片：</span>
            {filingPreviewData.certificateFront
              ? <Image src={certFrontSrc} width={180} height={118} style={{ objectFit: 'cover', borderRadius: 8 }} />
              : <span className="wechat-filing-photo-empty">未上传</span>}
          </div>
        </section>
        <section className="wechat-filing-preview">
          <h4>主体负责人（企业=法定代表人，个体工商户=经营者）</h4>
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="负责人姓名">{filingPreviewData.responsibleName || '-'}</Descriptions.Item>
            <Descriptions.Item label="负责人手机号">{filingPreviewData.responsiblePhone || '-'}</Descriptions.Item>
            <Descriptions.Item label="负责人邮箱">{filingPreviewData.responsibleEmail || '-'}</Descriptions.Item>
            <Descriptions.Item label="应急联系电话">{filingPreviewData.emergencyContact || '-'}</Descriptions.Item>
            <Descriptions.Item label="证件类型">{RESPONSIBLE_ID_TYPE_OPTIONS.find((item) => item.value === filingPreviewData.responsibleIdType)?.label || filingPreviewData.responsibleIdType || '-'}</Descriptions.Item>
            <Descriptions.Item label="证件号码">{filingPreviewData.responsibleIdNo || '-'}</Descriptions.Item>
            <Descriptions.Item label="证件有效期">{filingPreviewData.responsibleIdStartAt || '-'} 至 {filingPreviewData.responsibleIdEndAt || '-'}</Descriptions.Item>
          </Descriptions>
          <div className="wechat-filing-preview-images">
            <span>身份证正面：</span>
            {filingPreviewData.responsibleFront
              ? <Image src={respFrontSrc} width={150} height={94} style={{ objectFit: 'cover', borderRadius: 8 }} />
              : <span className="wechat-filing-photo-empty">未上传</span>}
            <span>身份证背面：</span>
            {filingPreviewData.responsibleBack
              ? <Image src={respBackSrc} width={150} height={94} style={{ objectFit: 'cover', borderRadius: 8 }} />
              : <span className="wechat-filing-photo-empty">未上传</span>}
          </div>
        </section>
        <section className="wechat-filing-preview">
          <h4>小程序信息</h4>
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="服务内容类型">{(filingPreviewData.serviceContentType || []).map((v) => serviceTypeLabel(v)).join('、') || '-'}</Descriptions.Item>
            <Descriptions.Item label="经营内容说明">{filingPreviewData.serviceDescription || '-'}</Descriptions.Item>
            <Descriptions.Item label="前置审批">{APPROVAL_TYPE_OPTIONS.find((item) => item.value === filingPreviewData.approvalType)?.label || filingPreviewData.approvalType || '以上都不涉及'}</Descriptions.Item>
            <Descriptions.Item label="审批编号">{filingPreviewData.approvalNo || '-'}</Descriptions.Item>
            <Descriptions.Item label="审批材料">{filingPreviewData.approvalMaterial || '-'}</Descriptions.Item>
            <Descriptions.Item label="补充说明">{filingPreviewData.serviceDescription2 || '-'}</Descriptions.Item>
          </Descriptions>
        </section>
      </Modal>

      <Modal
        open={showVerifyQrModal}
        title="微信官方法人扫码核验"
        width={520}
        onCancel={() => setShowVerifyQrModal(false)}
        footer={[
          <Button key="copy" disabled={!verifyTask?.verifyUrl} onClick={() => verifyTask?.verifyUrl && void copy(verifyTask.verifyUrl, '核验链接')}>复制链接</Button>,
          <Button key="open" disabled={!verifyTask?.verifyUrl} onClick={() => verifyTask?.verifyUrl && window.open(verifyTask.verifyUrl, '_blank', 'noopener,noreferrer')}>打开链接</Button>,
          <Button key="query" type="primary" onClick={() => void checkVerificationResult()}>查询核验结果</Button>,
        ]}
      >
        <div className="wechat-verify-modal">
          {verifyTask?.verifyUrl ? (
            <QRCode value={verifyTask.verifyUrl} size={240} bordered />
          ) : (
            <div className="wechat-verify-placeholder"><CheckCircleOutlined style={{ color: '#52c41a', fontSize: 48 }} /></div>
          )}
          <strong>{verifyTask?.verifyUrl ? '请小程序管理员使用手机微信扫码，在微信官方页面完成人脸核验' : '已向小程序管理员微信发送备案核身通知'}</strong>
          <p>{verifyTask?.message || (verifyTask?.verifyUrl ? '微信返回核验链接后在此展示二维码。' : '请小程序管理员在微信内点击通知完成人脸核身，完成后点击「查询核验结果」。')}</p>
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="微信任务 ID">{verifyTask?.taskId || '-'}</Descriptions.Item>
            <Descriptions.Item label="当前状态">{verifyTask ? icpVerifyStatusText(verifyTask) : '-'}</Descriptions.Item>
            <Descriptions.Item label="最近查询">{verifyTask?.lastCheckedAt ? dayjs(verifyTask.lastCheckedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}</Descriptions.Item>
          </Descriptions>
        </div>
      </Modal>

      <Drawer
        title="基本资料"
        open={showBasicDrawer}
        onClose={() => setShowBasicDrawer(false)}
        width={760}
      >
        <Form layout="vertical" form={basicForm} initialValues={basicInfo} onFinish={saveBasicInfo}>
          <section className="wechat-drawer-section">
            <h4>商户资料</h4>
            <Form.Item label="商户名称（小程序名称）" name="merchantName" rules={[{ required: true, message: '请填写商户名称' }]}><Input maxLength={80} placeholder="如：花时间花艺" /></Form.Item>
            <Form.Item label="主体名称（营业执照公司全称）" name="legalName" rules={[{ required: true, message: '请填写主体名称' }]}><Input maxLength={200} placeholder="如：广州花时间生活服务有限公司" /></Form.Item>
            <Form.Item label="联系电话" name="servicePhone"><Input maxLength={40} placeholder="请输入联系电话" /></Form.Item>
          </section>
          <Divider />
          <section className="wechat-drawer-section">
            <h4>小程序资料</h4>
            <div className="wechat-avatar-row">
              <Avatar shape="square" size={120} src={avatarDataUrl || basicInfo.avatarUrl || '/favicon.ico'} />
              <Button type="primary" icon={<UploadOutlined />} onClick={() => handleFilePick(avatarInputRef)}>选择并裁剪头像</Button>
            </div>
            <Form.Item label="小程序昵称" name="nickname" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item label="小程序简介" name="introduction" rules={[{ required: true }]}><Input.TextArea rows={4} maxLength={120} showCount /></Form.Item>
          </section>
          <Divider />
          <section className="wechat-drawer-section">
            <h4>基础信息（只读）</h4>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="小程序码">已生成</Descriptions.Item>
              {canViewAppId && <Descriptions.Item label="授权 AppID">{appIdCell}</Descriptions.Item>}
              <Descriptions.Item label="原始 ID">{displayOriginalId}</Descriptions.Item>
              <Descriptions.Item label="认证类型">微信认证</Descriptions.Item>
              <Descriptions.Item label="账号类型">普通小程序</Descriptions.Item>
            </Descriptions>
          </section>
          <Space style={{ marginTop: 16 }}>
            <Button type="primary" htmlType="submit">保存修改</Button>
            <Button onClick={() => setShowBasicDrawer(false)}>取消</Button>
          </Space>
        </Form>
      </Drawer>

      <Drawer
        title="类目设置"
        open={showCategoryDrawer}
        onClose={() => setShowCategoryDrawer(false)}
        width={820}
      >
        <Alert type="info" showIcon message="从微信服务类目中选择，保存后提交微信审核。" style={{ marginBottom: 16 }} />
        <Alert type="warning" showIcon message="当前小程序未完成微信认证，仅部分商业类目可设置。若保存报「主体类型不允许」，请选择已生效的类目（如 生活服务/丽人服务）或先完成微信认证。" style={{ marginBottom: 16 }} />
        <Form layout="vertical">
          <Form.Item label="一级类目" required>
            <Select
              showSearch
              placeholder="请选择一级类目"
              loading={categoryLoading}
              value={selectedFirst}
              onChange={(v) => { setSelectedFirst(v); setSelectedSecond(undefined); }}
              options={categoryOptions.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item label="二级类目" required>
            <Select
              showSearch
              placeholder="请选择二级类目"
              disabled={!selectedFirst}
              value={selectedSecond}
              onChange={setSelectedSecond}
              options={(categoryOptions.find((c) => c.id === selectedFirst)?.children || []).map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item label="资质信息">当前没有资质项，可直接保存类目。</Form.Item>
        </Form>
        <Space>
          <Button type="primary" disabled={!selectedFirst || !selectedSecond} onClick={() => void submitCategory()}>保存类目设置</Button>
          <Button loading={categoryLoading} onClick={() => void loadCategoryOptions()}>刷新类目</Button>
        </Space>
      </Drawer>

      <Drawer
        title="备案资料与申请"
        open={showFilingModal}
        onClose={() => setShowFilingModal(false)}
        width={1040}
      >
        <section className="wechat-drawer-section">
          <div className="wechat-stage-card">
            <strong>当前阶段：{icpFilingStatus ? icpStatusInfo.label : '备案资料填写中'}</strong>
            <p>保存草稿后可多次回到这里继续完善，提交前建议先完成人脸核验。</p>
            <div className="wechat-inline-badges">
              {icpFilingStatus && <Tag color={icpStatusInfo.color}>{icpStatusInfo.label}</Tag>}
              <Tag color="green">认证 微信认证</Tag>
            </div>
            {icpStatusInfo.audit.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message="备案被驳回，原因如下（请按建议修改后重新提交）"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {icpStatusInfo.audit.map((item, idx) => (
                      <li key={idx} style={{ marginBottom: 6 }}>
                        <strong>{item.key_name || '材料问题'}</strong>：{item.error || ''}
                        {item.suggest ? <div style={{ color: '#8c6d1f' }}>建议：{item.suggest}</div> : null}
                      </li>
                    ))}
                  </ul>
                }
              />
            )}
          </div>
          <div className="wechat-action-row">
            <Button onClick={saveFilingDraft}>保存草稿</Button>
            <Button loading={verifySubmitting} onClick={() => runProfileAction('verify')}>发起人脸核身</Button>
            <Button onClick={() => runProfileAction('result')}>查询核身结果</Button>
            <Button type="primary" loading={submittingIcpFiling} onClick={() => void submitFiling()}>提交微信备案</Button>
          </div>
          <Alert type="info" showIcon message="操作步骤：资料准备 » 管理员人脸核验 » 备案资料提交" style={{ marginTop: 16 }} />
        </section>
        <Divider />
        <Form layout="vertical" form={filingFormState} initialValues={filingForm}>
          <section className="wechat-filing-form">
            <h4>主体必填信息</h4>
            <div className="wechat-filing-grid">
              <Form.Item label="主体性质（必填）" name="subjectNature"><Select options={[{ value: 'ENTERPRISE', label: '企业' }, { value: 'INDIVIDUAL', label: '个体工商户' }]} /></Form.Item>
              <Form.Item label="主体名称（必填）" name="subjectName"><Input placeholder="与营业执照一致的完整单位名称" /></Form.Item>
              <Form.Item label="统一社会信用代码（必填）" name="certificateNo"><Input placeholder="营业执照上的统一社会信用代码（18 位）" /></Form.Item>
              <Form.Item label="备案地区（必填）" name="filingRegion"><Cascader options={icpDistricts.length ? icpDistricts : PROVINCE_REGIONS} placeholder="请选择省/市/区" allowClear /></Form.Item>
              <Form.Item label="通讯地址（必填）" name="communicationAddress"><Input placeholder="实际通讯地址，精确到门牌号" /></Form.Item>
            </div>
          </section>
          <Divider />
          <section className="wechat-filing-form">
            <h4>{watchedSubjectNature === 'INDIVIDUAL' ? '个体工商户营业执照信息' : '企业营业执照信息（主体证件）'}</h4>
            <Alert type="info" showIcon message={'营业执照大多为长期（营业期限栏显示「长期」），营业期限一般无需填写；仅当执照载有固定营业期限时才填。'} style={{ marginBottom: 16 }} />
            <div className="wechat-filing-grid">
              <Form.Item label="主体证件类型（必填）" name="certificateType"><Select options={certTypeOptions} /></Form.Item>
              <Form.Item label="注册地址（证件住所，必填）" name="certificateAddress"><Input placeholder="营业执照上的注册地址" /></Form.Item>
              <Form.Item label="营业执照营业期限开始（选填）" name="certificateStartAt"><FilingDatePicker /></Form.Item>
              <Form.Item label="营业执照营业期限结束（选填）" name="certificateEndAt"><FilingDatePicker /></Form.Item>
              <Form.Item label="营业执照照片（必填）" name="certificateFront">
                <div className="wechat-filing-photo">
                  {watchedCertificateFront
                    ? <Image src={watchedCertFrontSrc} width={140} height={92} style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e5eaf1' }} />
                    : <span className="wechat-filing-photo-empty">尚未上传</span>}
                  <Button icon={<UploadOutlined />} onClick={() => handleFilePick(certFrontRef)}>{watchedCertificateFront ? '重新上传' : '上传营业执照'}</Button>
                </div>
              </Form.Item>
            </div>
          </section>
          <Divider />
          <section className="wechat-filing-form">
            <h4>主体负责人信息（企业=法定代表人，个体工商户=经营者）</h4>
            <Alert type="info" showIcon message="单位主体备案：负责人手机与应急联系电话需不同，且均为本人实名。" style={{ marginBottom: 16 }} />
            <div className="wechat-filing-grid">
              <Form.Item label="负责人姓名（必填）" name="responsibleName"><Input placeholder="与营业执照法人/经营者一致" /></Form.Item>
              <Form.Item label="负责人手机号（必填）" name="responsiblePhone"><Input placeholder="本人实名手机号，需接收验证码" /></Form.Item>
              <Form.Item label="负责人邮箱（必填）" name="responsibleEmail"><Input placeholder="负责人本人邮箱" /></Form.Item>
              <Form.Item label="认证联系人邮箱（选填）" name="verifyContactEmail" tooltip="微信认证审核沟通用邮箱；不填则默认使用负责人邮箱发起认证"><Input placeholder="不填则使用负责人邮箱" /></Form.Item>
              <Form.Item label="应急联系电话（必填）" name="emergencyContact"><Input placeholder="与手机号不同" /></Form.Item>
              <Form.Item label="负责人证件类型（必填）" name="responsibleIdType"><Select options={RESPONSIBLE_ID_TYPE_OPTIONS} /></Form.Item>
              <Form.Item label="负责人证件号码（必填）" name="responsibleIdNo"><Input placeholder="身份证号码" /></Form.Item>
              <Form.Item label="负责人证件有效期开始" name="responsibleIdStartAt"><FilingDatePicker /></Form.Item>
              <Form.Item label="负责人证件有效期结束" name="responsibleIdEndAt"><FilingDatePicker /></Form.Item>
              <Form.Item label="负责人证件照片（正面）" name="responsibleFront">
                <div className="wechat-filing-photo">
                  {watchedResponsibleFront
                    ? <Image src={watchedRespFrontSrc} width={120} height={76} style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e5eaf1' }} />
                    : <span className="wechat-filing-photo-empty">尚未上传</span>}
                  <Button icon={<UploadOutlined />} onClick={() => handleFilePick(respFrontRef)}>{watchedResponsibleFront ? '重新上传' : '上传正面'}</Button>
                </div>
              </Form.Item>
              <Form.Item label="负责人证件照片（背面）" name="responsibleBack">
                <div className="wechat-filing-photo">
                  {watchedResponsibleBack
                    ? <Image src={watchedRespBackSrc} width={120} height={76} style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e5eaf1' }} />
                    : <span className="wechat-filing-photo-empty">尚未上传</span>}
                  <Button icon={<UploadOutlined />} onClick={() => handleFilePick(respBackRef)}>{watchedResponsibleBack ? '重新上传' : '上传背面'}</Button>
                </div>
              </Form.Item>
            </div>
          </section>
          <Divider />
          <section className="wechat-filing-form">
            <h4>小程序负责人（管理员）信息</h4>
            <Alert type="info" showIcon message="按微信官方 apply_icp_filing 要求：小程序负责人必须是该小程序的管理员本人（核身由管理员扫码完成）。【条件必填】若管理员实名信息未补充且小程序负责人为法人，微信会自动同步、无需填写；若管理员已实名或负责人非法人，则必须填写下方管理员真实信息。可与主体负责人不同人。" style={{ marginBottom: 16 }} />
            <div className="wechat-filing-grid">
              <Form.Item label="管理员姓名（条件必填）" name="appletPrincipalName"><Input placeholder="小程序管理员姓名（与身份证一致）" /></Form.Item>
              <Form.Item label="管理员手机号（条件必填）" name="appletPrincipalPhone"><Input placeholder="管理员本人实名手机号" /></Form.Item>
              <Form.Item label="管理员邮箱（必填）" name="appletPrincipalEmail" rules={[{ required: true, message: '请填写管理员邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}><Input placeholder="管理员本人邮箱" /></Form.Item>
              <Form.Item label="管理员应急联系电话（必填）" name="appletPrincipalEmergency" rules={[{ required: true, message: '请填写管理员应急联系电话' }, { pattern: /^1\d{10}$/, message: '需为 11 位手机号' }]}><Input placeholder="管理员本人另一手机号（与手机号不同）" /></Form.Item>
              <Form.Item label="管理员证件号码（条件必填）" name="appletPrincipalIdNo"><Input placeholder="管理员身份证号码" /></Form.Item>
              <Form.Item label="管理员证件有效期开始" name="appletPrincipalIdStartAt"><FilingDatePicker /></Form.Item>
              <Form.Item label="管理员证件有效期结束" name="appletPrincipalIdEndAt"><FilingDatePicker /></Form.Item>
              <Form.Item label="管理员证件照片（正面，条件必填）" name="appletPrincipalFront">
                <div className="wechat-filing-photo">
                  {watchedAppletFront
                    ? <Image src={watchedAppletFrontSrc} width={120} height={76} style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e5eaf1' }} />
                    : <span className="wechat-filing-photo-empty">尚未上传</span>}
                  <Button icon={<UploadOutlined />} onClick={() => handleFilePick(appletFrontRef)}>{watchedAppletFront ? '重新上传' : '上传正面'}</Button>
                </div>
              </Form.Item>
              <Form.Item label="管理员证件照片（背面，条件必填）" name="appletPrincipalBack">
                <div className="wechat-filing-photo">
                  {watchedAppletBack
                    ? <Image src={watchedAppletBackSrc} width={120} height={76} style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e5eaf1' }} />
                    : <span className="wechat-filing-photo-empty">尚未上传</span>}
                  <Button icon={<UploadOutlined />} onClick={() => handleFilePick(appletBackRef)}>{watchedAppletBack ? '重新上传' : '上传背面'}</Button>
                </div>
              </Form.Item>
            </div>
          </section>
          <Divider />
          <section className="wechat-filing-form">
            <h4>小程序必填信息</h4>
            <div className="wechat-filing-grid">
              <Form.Item label="服务内容类型（必填）" name="serviceContentType">
                {serviceTypeTree.length
                  ? <ServiceContentCascader options={serviceTypeTree} placeholder="先选一级类目，再选二级类目（可多选）" />
                  : <Select mode="multiple" options={SERVICE_CONTENT_OPTIONS} placeholder="请选择服务内容类型" />}
              </Form.Item>
              <Form.Item label="经营内容说明（必填）" name="serviceDescription"><Input.TextArea rows={3} /></Form.Item>
              <Form.Item label="补充说明" name="serviceDescription2"><Input.TextArea rows={3} /></Form.Item>
              <Form.Item label="前置审批" name="approvalType"><Select options={APPROVAL_TYPE_OPTIONS} placeholder="如涉及前置审批请选择" /></Form.Item>
              <Form.Item label="审批编号" name="approvalNo"><Input /></Form.Item>
              <Form.Item label="审批材料" name="approvalMaterial"><Input /></Form.Item>
            </div>
          </section>
          <Divider />
          <section className="wechat-filing-form">
            <h4>小程序负责人授权书</h4>
            <Alert type="info" showIcon message="按微信备案要求：小程序负责人/主体负责人不是法人（企业为法定代表人，个体工商户为经营者）时，需提供经签名盖章的授权书。个体工商户无公章时由经营者签名+按手印。" style={{ marginBottom: 16 }} />
            <Form.Item label="授权书（签名盖章后上传）" name="authorizationLetter">
              <div className="wechat-filing-photo">
                {watchedAuthorizationLetter
                  ? <Image src={watchedAuthLetterSrc} width={140} height={92} style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e5eaf1' }} />
                  : <span className="wechat-filing-photo-empty">尚未上传</span>}
                <Button icon={<DownloadOutlined />} onClick={downloadAuthLetterTemplate}>下载授权书模板</Button>
                <Button icon={<UploadOutlined />} onClick={() => handleFilePick(authLetterRef)}>{watchedAuthorizationLetter ? '重新上传' : '上传已签署授权书'}</Button>
              </div>
            </Form.Item>
          </section>
          <Divider />
          <section className="wechat-filing-form">
            <h4>其他备案材料（选填）</h4>
            <Alert type="info" showIcon message="按微信官方 apply_icp_filing 接口的 icp_materials 字段提供。带*为条件必填项（如广东备案需互联网信息服务承诺书），其余按管局要求选填；首次提交不能传主体/小程序其它附件，撤回或驳回后再提交才支持。" style={{ marginBottom: 16 }} />
            {ICP_MATERIALS_CONFIG.map((m) => {
              const value = watchedIcpMaterials[m.key];
              return (
                <Form.Item key={m.key} label={m.label} name={m.key} extra={m.hint}>
                  <div className="wechat-filing-photo">
                    {value
                      ? <span style={{ color: '#52c41a', fontSize: 13 }}>✅ 已上传{m.video ? '（视频）' : ''}</span>
                      : <span className="wechat-filing-photo-empty">尚未上传</span>}
                    <Button icon={<UploadOutlined />} onClick={() => icpMaterialsRefs.current[m.key]?.click()}>
                      {value ? '重新上传' : '上传'}{m.video ? '视频' : ''}
                    </Button>
                    {value && (m.key === 'subjectOtherMaterials' || m.key === 'appletsOtherMaterials') && (
                      <Button icon={<UploadOutlined />} onClick={() => icpMaterialsRefs.current[m.key]?.click()}>再传一个</Button>
                    )}
                  </div>
                </Form.Item>
              );
            })}
          </section>
        </Form>
      </Drawer>

      <Modal
        open={showAuditModal}
        title="微信认证状态"
        width={960}
        onCancel={() => setShowAuditModal(false)}
        footer={null}
      >
        <Card variant="borderless" className="wechat-auth-modal-card">
          <div className="wechat-auth-head">
            <div>
              <strong>微信认证</strong>
              <p>{verifyStatus ? (verifyStatus.verified ? '当前小程序已完成微信认证。' : '当前小程序未完成微信认证。') : '正在查询微信侧认证状态…'}</p>
            </div>
            <div className="wechat-inline-badges">
              {verifyStatus ? (
                <>
                  <Tag color={verifyStatus.verified ? 'green' : 'orange'}>{verifyStatus.verified ? '已认证' : '未认证'}</Tag>
                  {verifyStatus.verified && <Tag>已完成认证</Tag>}
                </>
              ) : <Tag>查询中</Tag>}
            </div>
          </div>
          <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
            <Descriptions.Item label="状态">{verifyStatus ? (verifyStatus.verified ? '已认证' : '未认证') : '查询中…'}</Descriptions.Item>
            <Descriptions.Item label="认证主体">{verifyStatus?.principalName || status?.merchantLegalName || '-'}</Descriptions.Item>
            <Descriptions.Item label="名称认证">{verifyStatus ? (verifyStatus.namingVerified ? '已认证' : '未认证') : '-'}</Descriptions.Item>
            <Descriptions.Item label="审核状态">{verifyStatus ? (verifyStatus.verified ? '认证通过' : '未认证') : '-'}</Descriptions.Item>
            {verifyStatus?.annualReview && verifyStatus.annualReviewEndAt ? (
              <Descriptions.Item label="年审截止">
                {dayjs(verifyStatus.annualReviewEndAt * 1000).format('YYYY-MM-DD')}
                {Date.now() > verifyStatus.annualReviewEndAt * 1000 ? '（已过期，需重新认证）' : ''}
              </Descriptions.Item>
            ) : <Descriptions.Item label="年审">无需年审</Descriptions.Item>}
            <Descriptions.Item label="刷新"><Button type="link" size="small" loading={verifyStatusLoading} onClick={() => void loadVerifyStatus()} style={{ paddingLeft: 0 }}>刷新认证状态</Button></Descriptions.Item>
          </Descriptions>
        </Card>
      </Modal>

      {renderFileInput(avatarInputRef, 'image/*', (f) => readFileAsDataUrl(f, (url) => { setAvatarDataUrl(url); setBasicInfo((prev) => ({ ...prev, avatarUrl: url })); message.success('头像已选择'); }))}
      {renderFileInput(certFrontRef, 'image/*', (f) => void uploadFilingImage(f).then((url) => { filingFormState.setFieldsValue({ certificateFront: url }); message.success('营业执照已上传'); }).catch((e) => message.error(`营业执照上传失败：${(e as Error).message}`)))}
      {renderFileInput(respFrontRef, 'image/*', (f) => void uploadFilingImage(f).then((url) => { filingFormState.setFieldsValue({ responsibleFront: url }); message.success('负责人证件正面已上传'); }).catch((e) => message.error(`证件上传失败：${(e as Error).message}`)))}
      {renderFileInput(respBackRef, 'image/*', (f) => void uploadFilingImage(f).then((url) => { filingFormState.setFieldsValue({ responsibleBack: url }); message.success('负责人证件背面已上传'); }).catch((e) => message.error(`证件上传失败：${(e as Error).message}`)))}
      {renderFileInput(appletFrontRef, 'image/*', (f) => void uploadFilingImage(f).then((url) => { filingFormState.setFieldsValue({ appletPrincipalFront: url }); message.success('管理员证件正面已上传'); }).catch((e) => message.error(`证件上传失败：${(e as Error).message}`)))}
      {renderFileInput(appletBackRef, 'image/*', (f) => void uploadFilingImage(f).then((url) => { filingFormState.setFieldsValue({ appletPrincipalBack: url }); message.success('管理员证件背面已上传'); }).catch((e) => message.error(`证件上传失败：${(e as Error).message}`)))}
      {renderFileInput(authLetterRef, 'image/*', (f) => void uploadFilingImage(f).then((url) => { filingFormState.setFieldsValue({ authorizationLetter: url }); message.success('授权书已上传'); }).catch((e) => message.error(`授权书上传失败：${(e as Error).message}`)))}
      {ICP_MATERIALS_CONFIG.map((m) => renderFileInput(
        { get current() { return icpMaterialsRefs.current[m.key]; }, set current(v: HTMLInputElement | null) { icpMaterialsRefs.current[m.key] = v; } } as React.RefObject<HTMLInputElement>,
        m.accept,
        (f) => uploadIcpMaterial(f, m.key, m.label),
        m.video ? 100 : 5,
        m.video ? ['video/mp4'] : ['image/jpeg', 'image/png', 'image/webp'],
      ))}
    </div>
  );
}

function buildProfile(status: WechatStatus | null, icpStatusLabel?: string): RegistrationProfile {
  const registrationStatus = workflowStatus(status);
  if (registrationStatus === 'FAILED') {
    return {
      stage: 'failed',
      stageLabel: '审核失败',
      status: registrationStatus,
      statusLabel: '审核失败',
      statusTone: 'error',
      activeStepKey: 'filing',
      stepIndex: 5,
      alertMessage: status?.registrationFailureReason || '当前提交失败，请按提示修正后重新提交。',
      alertTone: 'error',
      title: '微信备案',
      subtitle: '请完成微信备案',
      buttons: [
        { key: 'save', label: '保存草稿' },
        { key: 'verify', label: '发起人脸核身' },
        { key: 'result', label: '查询核身结果' },
        { key: 'submit', label: '提交微信备案', type: 'primary' },
      ],
      badges: [{ key: 'a', label: '备案资料与申请' }, { key: 'b', label: '认证 微信认证' }, { key: 'c', label: icpStatusLabel || '处理中' }],
    };
  }
  if (registrationStatus === 'PUBLISHABLE') {
    const filingOk = status?.filingVerified === true && status?.certified === true;
    return {
      stage: 'publishable',
      stageLabel: status?.currentStep?.label || '微信认证/备案',
      status: registrationStatus,
      statusLabel: '可发布',
      statusTone: filingOk ? 'success' : 'warning',
      activeStepKey: status?.currentStep?.key || 'filing',
      stepIndex: 6,
      alertMessage: filingOk ? '备案已通过，可继续完成发布前检查。' : '当前显示"可发布"，但微信认证或备案尚未核验通过，请先完成微信认证与备案资料、法人核验。',
      alertTone: filingOk ? 'success' : 'warning',
      title: '微信备案',
      subtitle: '请完成微信备案',
      buttons: [
        { key: 'save', label: '保存草稿' },
        { key: 'verify', label: '发起人脸核身' },
        { key: 'result', label: '查询核身结果' },
        { key: 'submit', label: '提交微信备案', type: 'primary' },
      ],
      badges: filingOk
        ? [{ key: 'a', label: status?.certified ? '已认证' : '认证状态待确认' }, { key: 'b', label: '已完成认证' }, { key: 'c', label: '可发布' }]
        : [{ key: 'a', label: '待备案核验' }, { key: 'b', label: '开户已开通' }, { key: 'c', label: '待发布前检查' }],
    };
  }
  return {
    stage: status?.currentStep?.key || 'filing',
    stageLabel: status?.currentStep?.label || '微信认证/备案',
    status: registrationStatus,
    statusLabel: registrationText(registrationStatus),
    statusTone: 'warning',
    activeStepKey: status?.currentStep?.key || 'filing',
    stepIndex: 5,
    alertMessage: '保存草稿后可多次回到这里继续完善，提交前建议先完成人脸核验。',
    alertTone: 'warning',
    title: '微信备案',
    subtitle: '请完成微信备案',
    buttons: [
      { key: 'save', label: '保存草稿' },
      { key: 'verify', label: '发起人脸核身' },
      { key: 'result', label: '查询核身结果' },
      { key: 'submit', label: '提交微信备案', type: 'primary' },
    ],
    badges: [{ key: 'a', label: '已有小程序直接授权' }, { key: 'b', label: '系统处理中' }, { key: 'c', label: icpStatusLabel || '进行中' }],
  };
}

function InfoField({ label, value, copyValue, extra }: { label: string; value: string; copyValue?: string; extra?: ReactNode }) {
  return (
    <Card size="small" className="wechat-info-field">
      <span>{label}</span>
      <strong>{value}</strong>
      <div className="wechat-info-field-actions">
        {copyValue ? <Button type="link" icon={<CopyOutlined />} onClick={() => void copyInline(copyValue)} /> : null}
        {extra}
      </div>
    </Card>
  );
}

async function copyInline(value: string) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  message.success('已复制');
}

/** 备案表单日期选择：存储为 'YYYY-MM-DD' 字符串，antd Form 注入 value/onChange */
function FilingDatePicker({ value, onChange }: { value?: string; onChange?: (value: string) => void }) {
  return (
    <DatePicker
      value={value ? (dayjs(value).isValid() ? dayjs(value) : undefined) : undefined}
      onChange={(date) => onChange?.(date ? date.format('YYYY-MM-DD') : '')}
      style={{ width: '100%' }}
    />
  );
}

/** 服务内容类型级联：先选一级、再选二级，可多选；Form 里存二级 type 编码（string[]） */
function ServiceContentCascader({ value = [], onChange, options, placeholder }: {
  value?: string[];
  onChange?: (value: string[]) => void;
  options: Array<{ value: number; label: string; children: Array<{ value: number; label: string }> }>;
  placeholder?: string;
}) {
  const paths = (value || []).map((code) => {
    for (const group of options) {
      const child = group.children.find((item) => String(item.value) === code);
      if (child) return [group.value, child.value];
    }
    return [Number(code)];
  });
  return (
    <Cascader
      multiple
      options={options}
      value={paths as number[][]}
      placeholder={placeholder}
      onChange={(next) => {
        const codes = (next as (string | number)[][]).map((path) => String(path[path.length - 1]));
        onChange?.(codes);
      }}
      style={{ width: '100%' }}
    />
  );
}

function registrationText(value: string) {
  return ({ DRAFT: '未开始', PENDING_MATERIALS: '待补资料', SUBMITTED: '已提交', PENDING_CONFIRMATION: '待商户确认', UNDER_REVIEW: '审核中', OPENED: '已注册', AUTHORIZING: '授权中', PUBLISHABLE: '可发布', FAILED: '审核失败' } as Record<string, string>)[value] || value;
}

function onboardingStatusValue(status: WechatStatus | null): string {
  return status?.onboardingStatus || 'ACTION_REQUIRED';
}

function onboardingStatusText(status: WechatStatus | null): string {
  return ({ ACTION_REQUIRED: '待处理', PROCESSING: '处理中', COMPLETE: '可发布', FAILED: '处理失败' } as Record<string, string>)[onboardingStatusValue(status)] || onboardingStatusValue(status);
}

function workflowStatus(status: WechatStatus | null): string {
  const onboarding = onboardingStatusValue(status);
  if (onboarding === 'COMPLETE') return 'PUBLISHABLE';
  if (onboarding === 'FAILED') return 'FAILED';
  const current = status?.currentStep?.key || '';
  if (current === 'registration') return onboarding === 'PROCESSING' ? 'UNDER_REVIEW' : 'DRAFT';
  if (current === 'authorization') return 'AUTHORIZING';
  return onboarding === 'PROCESSING' ? 'UNDER_REVIEW' : 'DRAFT';
}

function approvalText(value: string) {
  return ({ NONE: '以上都不涉及', HEALTH: '卫生许可', INDUSTRY: '行业许可' } as Record<string, string>)[value] || value;
}

function certificateTypeText(value: string) {
  return ({ LICENSE: '营业执照（个人或企业）' } as Record<string, string>)[value] || value;
}

function secretStatusText(status: WechatStatus, key: string) {
  const configured = status.checks?.find((item) => item.key === key)?.configured;
  return configured ? '已配置（服务端环境变量，不在前端展示）' : '待配置（请在服务器环境变量注入）';
}

function normalizeProgressStepKey(value: string, label = ''): ProgressStepKey {
  const hint = `${value} ${label}`;
  if (hint.includes('商户资料') || value === 'materials') return 'materials';
  if (hint.includes('小程序注册') || value === 'registration') return 'registration';
  if (hint.includes('平台授权') || value === 'authorization') return 'authorization';
  if (hint.includes('基础信息') || value === 'basicInfo') return 'basicInfo';
  if (hint.includes('类目') || value === 'categories' || value === 'category') return 'categories';
  if (hint.includes('备案') || hint.includes('认证') || value === 'filing') return 'filing';
  return 'publishable';
}

function progressStateLabel(state: 'complete' | 'current' | 'pending') {
  return ({ complete: '已完成', current: '处理中', pending: '待开始' } as Record<'complete' | 'current' | 'pending', string>)[state];
}

function progressStateTone(state: 'complete' | 'current' | 'pending'): 'success' | 'processing' | 'warning' {
  return ({ complete: 'success', current: 'processing', pending: 'warning' } as Record<'complete' | 'current' | 'pending', 'success' | 'processing' | 'warning'>)[state];
}

function icpVerifyStatusText(task: IcpVerifyTask) {
  if (task.status === 'SUCCEEDED') return '核身成功';
  if (task.status === 'FAILED') return '核身失败';
  if (task.faceStatus === 1) return '等待微信内核身';
  if (task.faceStatus === 0) return '未开始';
  return '处理中';
}

type ProgressDetailAction = { key: string; label: string; type?: 'primary' | 'default' | 'dashed'; danger?: boolean; onClick: () => void };
type ProgressDetailField = { label: string; value: ReactNode };
type ProgressDetail = {
  key: ProgressStepKey;
  label: string;
  state: 'complete' | 'current' | 'pending';
  stateLabel: string;
  tone: 'success' | 'processing' | 'warning';
  summary: string;
  description: string;
  fields: ProgressDetailField[];
  actions: ProgressDetailAction[];
};
type BuildProgressDetailContext = {
  key: ProgressStepKey;
  steps: Array<{ key: string; label: string; state: 'complete' | 'current' | 'pending' }>;
  status: WechatStatus;
  profile: RegistrationProfile;
  canViewAppId: boolean;
  displayAppId: string;
  displayOriginalId: string;
  basicInfo: BasicInfoForm;
  filingForm: FilingForm;
  categoryRows: CategoryRow[];
  approvalItems: ApprovalItem[];
  readyCount: number;
  requirementTotal: number;
  actions: NonNullable<WechatStatus['actions']>;
  canWriteWechat: boolean;
  onNavigate: (page: string) => void;
  setActiveTab: (value: PageTab) => void;
  openAuthorizationModal: () => void;
  openBasicDrawer: () => void;
  openCategoryDrawer: () => void;
  openFilingDrawer: () => void;
  openAuditModal: () => void;
  markVerificationStarted: () => Promise<void>;
  checkVerificationResult: () => Promise<void>;
  load: () => Promise<WechatStatus | null>;
  saveFilingDraft: () => void;
};

function roleCanWriteWechat(ctx: BuildProgressDetailContext): boolean { return ctx.canWriteWechat; }

function buildProgressDetail(ctx: BuildProgressDetailContext): ProgressDetail {
  const findState = (key: ProgressStepKey) => ctx.steps.find((item) => normalizeProgressStepKey(item.key, item.label) === key)?.state || 'pending';
  const state = findState(ctx.key);
  if (ctx.key === 'materials') {
    return {
      key: ctx.key,
      label: '商户资料',
      state,
      stateLabel: progressStateLabel(state),
      tone: progressStateTone(state),
      summary: '核对商户主体、联系电话和平台准备情况。',
      description: '这一项决定后续是否能继续注册和授权，先确认主体资料是否完整。',
      fields: [
        { label: '商户名称', value: ctx.status.merchantName },
        { label: '主体名称', value: ctx.status.merchantLegalName },
        { label: '联系电话', value: ctx.status.servicePhone },
        { label: '已完成项', value: `${ctx.readyCount}/${ctx.requirementTotal}` },
      ],
      actions: [
        { key: 'go-registration', label: '查看主体进度', type: 'primary', onClick: () => ctx.onNavigate('registration') },
        { key: 'open-basic', label: '编辑基础资料', onClick: ctx.openBasicDrawer },
        { key: 'open-config', label: '第三方平台配置', onClick: () => ctx.setActiveTab('config') },
      ],
    };
  }
  if (ctx.key === 'registration') {
    return {
      key: ctx.key,
      label: '小程序注册',
      state,
      stateLabel: progressStateLabel(state),
      tone: progressStateTone(state),
      summary: `注册状态：${onboardingStatusText(ctx.status)}`,
      description: ctx.status.lastSyncError || '提交注册后会生成授权二维码并同步注册结果。',
      fields: [
        { label: '注册状态', value: onboardingStatusText(ctx.status) },
        { label: '同步状态', value: ctx.status.syncStatus || 'UNKNOWN' },
        { label: '同步说明', value: ctx.status.lastSyncError || '暂无错误' },
        ...(ctx.canViewAppId ? [{ label: '授权 AppID', value: ctx.displayAppId }] : []),
      ],
      actions: [
        ...(roleCanWriteWechat(ctx) ? [{ key: 'fast-register', label: '发起快速注册', type: 'primary' as const, onClick: () => ctx.setActiveTab('basic') }] : []),
        ...(roleCanWriteWechat(ctx) ? [{ key: 'open-auth', label: '打开微信授权', onClick: ctx.openAuthorizationModal }] : []),
        { key: 'refresh', label: '刷新状态', onClick: () => void ctx.load() },
      ],
    };
  }
  if (ctx.key === 'authorization') {
    return {
      key: ctx.key,
      label: '平台授权',
      state,
      stateLabel: progressStateLabel(state),
      tone: progressStateTone(state),
      summary: `授权状态：${ctx.status.authorizationStatus || '未开始'}`,
      description: '授权完成后，微信开放平台会回调授权方 AppID，系统再同步到第三方平台记录。',
      fields: [
        { label: '授权状态', value: ctx.status.authorizationStatus || '未开始' },
        { label: '授权时间', value: ctx.status.authorizedAt ? dayjs(ctx.status.authorizedAt).format('YYYY-MM-DD HH:mm') : '暂无' },
        ...(ctx.canViewAppId ? [{ label: '授权 AppID', value: ctx.displayAppId }] : []),
        { label: '事件回调', value: ctx.status.eventCallbackUrl },
      ],
      actions: [
        ...(ctx.canWriteWechat ? [{ key: 'open-auth', label: '打开微信授权', type: 'primary' as const, onClick: ctx.openAuthorizationModal }] : []),
        { key: 'open-config', label: '查看第三方平台配置', onClick: () => ctx.setActiveTab('config') },
        { key: 'refresh', label: '刷新状态', onClick: () => void ctx.load() },
      ],
    };
  }
  if (ctx.key === 'basicInfo') {
    return {
      key: ctx.key,
      label: '基础信息',
      state,
      stateLabel: progressStateLabel(state),
      tone: progressStateTone(state),
      summary: '维护头像、昵称和简介，保证商户端展示一致。',
      description: '基础信息会同步到小程序端和商户端预览，建议先检查再提交。',
      fields: [
        { label: '当前昵称', value: ctx.basicInfo.nickname },
        { label: '当前简介', value: ctx.basicInfo.introduction },
        { label: '小程序码', value: ctx.status.authorizationStatus === 'AUTHORIZED' ? '已生成' : '待授权后生成' },
        { label: '账号类型', value: '普通小程序' },
      ],
      actions: [
        { key: 'open-basic', label: '编辑基础资料', type: 'primary', onClick: ctx.openBasicDrawer },
        { key: 'refresh', label: '刷新状态', onClick: () => void ctx.load() },
      ],
    };
  }
  if (ctx.key === 'categories') {
    const passed = ctx.categoryRows.filter((row) => row.status === '审核通过').length;
    const rejected = ctx.categoryRows.filter((row) => row.status !== '审核通过').length;
    return {
      key: ctx.key,
      label: '服务类目',
      state,
      stateLabel: progressStateLabel(state),
      tone: progressStateTone(state),
      summary: `当前已设置 ${ctx.categoryRows.length} 个类目。`,
      description: '服务类目需在微信备案前选择好；类目决定小程序可用能力，并影响备案与提交审核。',
      fields: [
        { label: '类目总数', value: String(ctx.categoryRows.length) },
        { label: '审核通过', value: String(passed) },
        { label: '审核不通过', value: String(rejected) },
        { label: '本周期剩余次数', value: '5 / 5' },
      ],
      actions: [
        { key: 'open-category', label: '编辑类目', type: 'primary', onClick: ctx.openCategoryDrawer },
        { key: 'submit-category', label: '保存类目设置', onClick: () => ctx.setActiveTab('category') },
      ],
    };
  }
  if (ctx.key === 'filing') {
    return {
      key: ctx.key,
      label: '微信认证/备案',
      state,
      stateLabel: progressStateLabel(state),
      tone: progressStateTone(state),
      summary: `备案状态：${onboardingStatusText(ctx.status)}`,
      description: ctx.status.lastSyncError || '备案要先完成资料准备、法人核验和提交审核。',
      fields: [
        { label: '主体性质', value: ctx.filingForm.subjectNature === 'ENTERPRISE' ? '企业' : '个体工商户' },
        { label: '主体名称', value: ctx.filingForm.subjectName || ctx.status.merchantLegalName },
        { label: '负责人', value: ctx.filingForm.responsibleName || '待填写' },
        { label: '审批项', value: ctx.approvalItems[0]?.approvalType || '以上都不涉及' },
      ],
      actions: [
        { key: 'open-filing', label: '编辑备案', type: 'primary', onClick: ctx.openFilingDrawer },
        { key: 'save-draft', label: '保存草稿', onClick: ctx.saveFilingDraft },
        { key: 'verify', label: '发起人脸核身', onClick: () => void ctx.markVerificationStarted() },
        { key: 'result', label: '查询核身结果', onClick: () => void ctx.checkVerificationResult() },
      ],
    };
  }
  return {
    key: 'publishable',
    label: '可发布',
    state,
    stateLabel: progressStateLabel(state),
    tone: progressStateTone(state),
    summary: `当前已完成 ${ctx.readyCount}/${ctx.requirementTotal} 项，满足后可继续发布前检查。`,
    description: '当第三方平台、回调地址和 COS 配置完整后，就可以进入发布前检查。',
    fields: [
      { label: '已完成项', value: `${ctx.readyCount}/${ctx.requirementTotal}` },
      { label: '第三方平台', value: ctx.status.componentReady ? '已就绪' : '待补齐' },
      { label: 'COS 存储', value: ctx.status.cosReady ? '已就绪' : '待补齐' },
      { label: '授权状态', value: ctx.status.authorizationStatus || '未开始' },
    ],
    actions: [
      { key: 'refresh', label: '刷新状态', type: 'primary', onClick: () => void ctx.load() },
      { key: 'open-auth', label: '发起授权', onClick: ctx.openAuthorizationModal },
      { key: 'open-config', label: '第三方平台配置', onClick: () => ctx.setActiveTab('config') },
    ],
  };
}
