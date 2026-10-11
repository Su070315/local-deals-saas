import { Alert, Button, Card, Checkbox, Form, Input, Modal, Radio, Space, Spin, Tag, Typography, message } from 'antd';
import React, { useEffect, useState } from 'react';
import type { Merchant } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type ProfileStatus = 'PENDING' | 'ACTIVE' | 'DISABLED';
type PaymentChannel = 'WECHAT_DIRECT' | 'HUIFU' | 'TIANQUE';

type ChannelOption = {
  provider: PaymentChannel;
  label: string;
  requiresMerchantParam: boolean;
  available: boolean;
  note: string;
};

type Profile = {
  id: string;
  provider: string;
  externalMerchantNo: string;
  providerMerchantId: string | null;
  wxAppletAppId?: string;
  applicationNo: string;
  huifuSysId?: string;
  huifuProductId?: string;
  hasHuifuPrivateKey?: boolean;
  huifuMerchantPublicKeyPreview?: string;
  huifuPublicKeyPreview?: string;
  huifuFeeType?: string;
  tianqueMno?: string;
  tianqueOrgId?: string;
  hasTianquePrivateKey?: boolean;
  tianqueSignAlg?: string;
  wechatMchid?: string;
  wechatAppId?: string;
  hasWechatCredentials?: boolean;
  wechatCertSerialNo?: string;
  wechatPublicKeyPreview?: string;
  status: ProfileStatus;
  version: number;
  verifiedAt: string | null;
  updatedAt: string;
};

type ChannelsView = {
  options: ChannelOption[];
  current: PaymentChannel;
  profile: Profile | null;
  wechatMchid: string | null;
  suggestedExternalMerchantNo: string;
};

type FormValues = {
  provider: PaymentChannel;
  externalMerchantNo: string;
  providerMerchantId?: string;
  wxAppletAppId?: string;
  applicationNo?: string;
  huifuSysId?: string;
  huifuProductId?: string;
  huifuPrivateKey?: string;
  huifuMerchantPublicKey?: string;
  huifuPublicKey?: string;
  huifuFeeType?: string;
  tianqueMno?: string;
  tianqueOrgId?: string;
  tianquePrivateKey?: string;
  tianquePublicKey?: string;
  tianqueSignAlg?: string;
  wechatMchid?: string;
  wechatAppId?: string;
  wechatApiV3Key?: string;
  wechatCertSerialNo?: string;
  wechatPrivateKey?: string;
  wechatPublicKey?: string;
  status: ProfileStatus;
  activationConfirmed: boolean;
};

type Props = { merchant: Merchant; request: Request; canActivate: boolean; onRequireStepUp: () => void; onClose: () => void };

type BindStatus = {
  provider: string;
  configured: boolean;
  wxAppletAppId?: string;
  applyNo: string | null;
  applyStatus: string;
  note: string;
  checkedAt: string;
};

const statusOptions = [
  { value: 'PENDING', label: '待进件 / 待核验' },
  { value: 'ACTIVE', label: '启用收款' },
  { value: 'DISABLED', label: '停用收款' },
] satisfies Array<{ value: ProfileStatus; label: string }>;

/** 汇付绑定审核状态 → 徽章样式 */
const bindStatusMeta: Record<string, { color: string; text: string }> = {
  Y: { color: 'green', text: '已通过' },
  P: { color: 'gold', text: '审核中' },
  N: { color: 'red', text: '已拒绝' },
  F: { color: 'red', text: '处理失败' },
  '': { color: 'default', text: '未提交' },
};

export default function MerchantPaymentProfilePanel({ merchant, request, canActivate, onRequireStepUp, onClose }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [view, setView] = useState<ChannelsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bindStatus, setBindStatus] = useState<BindStatus | null>(null);
  const [bindStatusLoading, setBindStatusLoading] = useState(false);
  const selectedProvider = Form.useWatch('provider', form) || 'WECHAT_DIRECT';
  const selectedOption = view?.options.find((item) => item.provider === selectedProvider);
  const hasProfile = Boolean(view?.profile);
  const agencyReadOnly = !canActivate && hasProfile && view?.profile?.status !== 'PENDING';

  async function loadBindStatus() {
    setBindStatusLoading(true);
    try {
      const data = await request<BindStatus>(`/merchants/${merchant.id}/huifu-bind-status`);
      setBindStatus(data);
    } catch (error) {
      message.warning(`绑定状态查询失败：${(error as Error).message}`);
    } finally {
      setBindStatusLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    request<ChannelsView>(`/merchants/${merchant.id}/payment-channels`)
      .then((data) => {
        if (!active) return;
        setView(data);
        const provider = data.current || 'WECHAT_DIRECT';
        form.setFieldsValue({
          provider,
          externalMerchantNo: data.profile?.externalMerchantNo || data.suggestedExternalMerchantNo,
          providerMerchantId: data.profile?.providerMerchantId || undefined,
          wxAppletAppId: data.profile?.wxAppletAppId || undefined,
          applicationNo: data.profile?.applicationNo || undefined,
          huifuSysId: data.profile?.huifuSysId || undefined,
          huifuProductId: data.profile?.huifuProductId || undefined,
          huifuFeeType: data.profile?.huifuFeeType || undefined,
          tianqueMno: data.profile?.tianqueMno || undefined,
          tianqueOrgId: data.profile?.tianqueOrgId || undefined,
          tianqueSignAlg: data.profile?.tianqueSignAlg || undefined,
          wechatMchid: data.profile?.wechatMchid || undefined,
          wechatAppId: data.profile?.wechatAppId || undefined,
          wechatCertSerialNo: data.profile?.wechatCertSerialNo || undefined,
          status: data.profile?.status || 'PENDING',
          activationConfirmed: false,
        });
      })
      .catch((error) => { if (active) message.error((error as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [form, merchant.id, request]);

  async function save(values: FormValues) {
    setSaving(true);
    try {
      const saved = await request<ChannelsView>(`/merchants/${merchant.id}/payment-profile`, {
        method: 'PUT',
        body: JSON.stringify({
          provider: values.provider,
          externalMerchantNo: values.externalMerchantNo.trim(),
          providerMerchantId: values.providerMerchantId?.trim() || undefined,
          wxAppletAppId: values.wxAppletAppId?.trim() || undefined,
          applicationNo: values.applicationNo?.trim() || undefined,
          huifuSysId: values.huifuSysId?.trim() || undefined,
          huifuProductId: values.huifuProductId?.trim() || undefined,
          huifuPrivateKey: values.huifuPrivateKey?.trim() || undefined,
          huifuMerchantPublicKey: values.huifuMerchantPublicKey?.trim() || undefined,
          huifuPublicKey: values.huifuPublicKey?.trim() || undefined,
          huifuFeeType: values.huifuFeeType?.trim() || undefined,
          tianqueMno: values.tianqueMno?.trim() || undefined,
          tianqueOrgId: values.tianqueOrgId?.trim() || undefined,
          tianquePrivateKey: values.tianquePrivateKey?.trim() || undefined,
          tianquePublicKey: values.tianquePublicKey?.trim() || undefined,
          tianqueSignAlg: values.tianqueSignAlg?.trim() || undefined,
          wechatMchid: values.wechatMchid?.trim() || undefined,
          wechatAppId: values.wechatAppId?.trim() || undefined,
          wechatApiV3Key: values.wechatApiV3Key?.trim() || undefined,
          wechatCertSerialNo: values.wechatCertSerialNo?.trim() || undefined,
          wechatPrivateKey: values.wechatPrivateKey?.trim() || undefined,
          wechatPublicKey: values.wechatPublicKey?.trim() || undefined,
          status: values.status,
          activationConfirmed: values.activationConfirmed === true,
        }),
      });
      setView(saved);
      form.setFieldValue('activationConfirmed', false);
      message.success(values.status === 'ACTIVE' ? `${channelLabel(values.provider)}已启用` : '支付通道配置已保存');
      if ((saved as { bindNote?: string }).bindNote) {
        message.warning((saved as { bindNote?: string }).bindNote as string, 6);
      }
      // 汇付通道保存后自动刷新绑定审核状态
      if (values.provider === 'HUIFU' && values.wxAppletAppId) {
        void loadBindStatus();
      }
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) onRequireStepUp();
      message.error(text);
    } finally { setSaving(false); }
  }

  function channelLabel(provider: PaymentChannel): string {
    return view?.options.find((item) => item.provider === provider)?.label || provider;
  }

  // 汇付直连参数配置状态（可视化徽章与进度）
  const hfProfile = view?.profile;
  const sysDone = Boolean(hfProfile?.huifuSysId);
  const prodDone = Boolean(hfProfile?.huifuProductId);
  const feeDone = Boolean(hfProfile?.huifuFeeType);
  const keyDone = Boolean(hfProfile?.hasHuifuPrivateKey);
  const mPubDone = Boolean(hfProfile?.huifuMerchantPublicKeyPreview);
  const pubDone = Boolean(hfProfile?.huifuPublicKeyPreview);
  const doneCount = [sysDone, prodDone, feeDone, keyDone, mPubDone, pubDone].filter(Boolean).length;

  return <Modal title={`${merchant.brandName} · 支付通道配置`} open width={680} onCancel={onClose} footer={null} destroyOnClose={false}>
    {loading ? <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div> : view && <Form<FormValues> form={form} layout="vertical" onFinish={(values) => void save(values)}>
      <Alert type="info" showIcon message={canActivate ? '为商家选择收款通道并核对商户号后启用收款。未配置的商家默认使用微信直连。' : agencyReadOnly ? '该支付通道已由平台处理。如需变更，请联系平台财务。' : '选择支付通道并填写对应商户号，平台财务核验后启用收款。'} style={{ marginBottom: 20 }} />
      <Form.Item label="支付通道" name="provider" rules={[{ required: true }]}>
        <Radio.Group style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {view.options.map((option) => (
              <Card key={option.provider} size="small" style={{ width: '100%', borderColor: selectedProvider === option.provider ? '#1677ff' : undefined, background: selectedProvider === option.provider ? '#f5faff' : undefined }}>
                <Radio value={option.provider} disabled={agencyReadOnly}>
                  <Typography.Text strong>{option.label}</Typography.Text>
                  {!option.available && <Tag color="default" style={{ marginLeft: 8 }}>暂未接入</Tag>}
                  {option.provider === 'WECHAT_DIRECT' && view.wechatMchid && <Tag color="blue" style={{ marginLeft: 8 }}>商户号 {view.wechatMchid}</Tag>}
                </Radio>
                <div style={{ marginTop: 8, marginLeft: 24 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{option.note}</Typography.Text>
                  {selectedProvider === option.provider && option.provider === 'WECHAT_DIRECT' && (
                    <div style={{ marginLeft: 24, padding: '10px 12px', border: '1px dashed #d9d9d9', borderRadius: 8, background: '#fcfcfc' }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>微信直连开发参数（每商户独立一套，APIv3 密钥与私钥加密存储）：</Typography.Text>
                      <Form.Item name="wechatMchid" label="微信支付商户号（mchid）" style={{ marginBottom: 8 }} rules={[{ pattern: /^[A-Za-z0-9_-]{6,64}$/, message: '商户号格式不正确' }]}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={64} placeholder="该商户的微信支付商户号" />
                      </Form.Item>
                      <Form.Item name="wechatAppId" label="小程序 APPID" style={{ marginBottom: 8 }} rules={[{ pattern: /^wx[a-f0-9]{16}$/i, message: 'APPID 格式不正确' }]}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={32} placeholder="wx 开头的 18 位" />
                      </Form.Item>
                      <Form.Item name="wechatApiV3Key" label="APIv3 Key（32 位）" style={{ marginBottom: 8 }} rules={[{ min: 16, message: '长度不合法' }]}>
                        <Input.Password disabled={agencyReadOnly || !option.available || Boolean(view.profile?.hasWechatCredentials)} maxLength={128} placeholder={view.profile?.hasWechatCredentials ? '已配置（加密存储）' : '粘贴 APIv3 密钥'} />
                      </Form.Item>
                      <Form.Item name="wechatCertSerialNo" label="商户证书序列号" style={{ marginBottom: 8 }}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={64} placeholder="商户 API 证书序列号" />
                      </Form.Item>
                      <Form.Item name="wechatPrivateKey" label="商户私钥（apiclient_key.pem 内容）" style={{ marginBottom: 8 }} rules={[{ min: 100, message: '私钥长度不合法' }]}>
                        <Input.Password disabled={agencyReadOnly || !option.available || Boolean(view.profile?.hasWechatCredentials)} maxLength={8192} placeholder={view.profile?.hasWechatCredentials ? '已配置（加密存储）' : '粘贴 apiclient_key.pem 全文'} />
                      </Form.Item>
                      <Form.Item name="wechatPublicKey" label="微信支付公钥（回调验签）" style={{ marginBottom: 4 }} rules={[{ min: 40, message: '公钥长度不合法' }]}>
                        <Input disabled={agencyReadOnly || !option.available || Boolean(view.profile?.wechatPublicKeyPreview)} maxLength={4096} placeholder={view.profile?.wechatPublicKeyPreview ? '已配置：' + view.profile.wechatPublicKeyPreview : '粘贴微信支付公钥（pub_key.pem）'} />
                      </Form.Item>
                    </div>
                  )}
                  {selectedProvider === option.provider && option.provider === 'TIANQUE' && (
                    <div style={{ marginLeft: 24, padding: '10px 12px', border: '1px dashed #d9d9d9', borderRadius: 8, background: '#fcfcfc' }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>天阙直连开发参数（每商户独立一套，私钥加密存储）：</Typography.Text>
                      <Form.Item name="tianqueMno" label="天阙商户编号（mno）" style={{ marginBottom: 8 }} rules={[{ pattern: /^[A-Za-z0-9_-]{1,64}$/, message: 'mno 格式不正确' }]}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={64} placeholder="该商户在天阙的商户编号" />
                      </Form.Item>
                      <Form.Item name="tianqueOrgId" label="组织号（orgId）" style={{ marginBottom: 8 }} rules={[{ pattern: /^[A-Za-z0-9_-]{1,64}$/, message: 'orgId 格式不正确' }]}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={64} placeholder="天阙平台机构编号" />
                      </Form.Item>
                      <Form.Item name="tianquePrivateKey" label="商户 RSA 私钥" style={{ marginBottom: 8 }} rules={[{ min: 100, message: '私钥长度不合法' }]}>
                        <Input.Password disabled={agencyReadOnly || !option.available || Boolean(view.profile?.hasTianquePrivateKey)} maxLength={4096} placeholder={view.profile?.hasTianquePrivateKey ? '已配置（加密存储，不回显）' : '粘贴商户私钥（仅首次填写）'} />
                      </Form.Item>
                      <Form.Item name="tianquePublicKey" label="天阙平台 RSA 公钥" style={{ marginBottom: 8 }} rules={[{ min: 40, message: '公钥长度不合法' }]}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={2048} placeholder="粘贴天阙公钥" />
                      </Form.Item>
                      <Form.Item name="tianqueSignAlg" label="签名算法" style={{ marginBottom: 4 }}>
                        <Radio.Group disabled={agencyReadOnly || !option.available}>
                          <Radio value="sha256">sha256</Radio>
                          <Radio value="sha1">sha1</Radio>
                        </Radio.Group>
                      </Form.Item>
                    </div>
                  )}
                  {selectedProvider === option.provider && option.provider === 'HUIFU' && (
                    <div style={{ marginLeft: 24, marginTop: 6 }}>
                      <Form.Item name="providerMerchantId" label="汇付商户号（huifu_id）" rules={[{ pattern: /^[A-Za-z0-9_-]{6,64}$/, message: '商户号格式不正确' }]} style={{ marginBottom: 8 }}>
                        <Input disabled={agencyReadOnly || !option.available} maxLength={64} placeholder="进件审核通过后填写" />
                      </Form.Item>
                      <Alert
                        type="info" showIcon style={{ marginBottom: 10 }}
                        message="商家需提供：汇付直连开发参数"
                        description={
                          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                            以下参数由<b>商家登录其汇付商户后台</b>获取后提供（后台可查看：系统号 / 产品号 / 商户私钥 / 商户公钥 / 汇付公钥 / 费率类型）。<br />
                            · <b>商户公钥</b>已在汇付后台登记，由汇付用于验证商户请求，服务端无需保存；<br />
                            · 服务端只需保存：<b>商户私钥</b>（AES 加密存储，仅首次填写、不回显）+ <b>汇付公钥</b>（验证汇付回调）+ 系统号 / 产品号 / 费率类型。
                          </div>
                        }
                      />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        <Tag color={sysDone ? 'green' : 'orange'}>{sysDone ? '系统号 ✓' : '系统号待配置'}</Tag>
                        <Tag color={prodDone ? 'green' : 'orange'}>{prodDone ? '产品号 ✓' : '产品号待配置'}</Tag>
                        <Tag color={feeDone ? 'green' : 'orange'}>{feeDone ? '费率类型 ✓' : '费率类型待配置'}</Tag>
                        <Tag color={keyDone ? 'green' : 'orange'}>{keyDone ? '商户私钥 ✓（加密存储）' : '商户私钥待配置'}</Tag>
                        <Tag color={mPubDone ? 'green' : 'orange'}>{mPubDone ? '商户公钥 ✓' : '商户公钥待配置'}</Tag>
                        <Tag color={pubDone ? 'green' : 'orange'}>{pubDone ? '汇付公钥 ✓' : '汇付公钥待配置'}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>已配置 {doneCount}/6</Typography.Text>
                      </div>
                      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: '10px 12px', background: '#fff' }}>
                        <div style={{ marginBottom: 4 }}>
                          <Tag color="blue">①</Tag><Typography.Text strong style={{ fontSize: 13 }}>系统号（sys_id）</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>＝ 汇付商户号（直连商户）</Typography.Text>
                        </div>
                        <Form.Item name="huifuSysId" style={{ marginBottom: 10 }} rules={[{ pattern: /^[A-Za-z0-9_-]{6,64}$/, message: '系统号格式不正确' }]}>
                          <Input disabled={agencyReadOnly || !option.available || sysDone} maxLength={32} placeholder={sysDone ? view?.profile?.huifuSysId : '直连时与汇付商户号一致'} />
                        </Form.Item>
                        <div style={{ marginBottom: 4 }}>
                          <Tag color="blue">②</Tag><Typography.Text strong style={{ fontSize: 13 }}>产品号（product_id）</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>汇付分配的产品号，如 EDUSTD</Typography.Text>
                        </div>
                        <Form.Item name="huifuProductId" style={{ marginBottom: 10 }} rules={[{ pattern: /^[A-Za-z0-9_-]{1,32}$/, message: '产品号格式不正确' }]}>
                          <Input disabled={agencyReadOnly || !option.available || prodDone} maxLength={32} placeholder={prodDone ? view?.profile?.huifuProductId : '如 EDUSTD'} />
                        </Form.Item>
                        <div style={{ marginBottom: 4 }}>
                          <Tag color="blue">③</Tag><Typography.Text strong style={{ fontSize: 13 }}>微信业务开通类型（fee_type）</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>02=标准费率线下</Typography.Text>
                        </div>
                        <Form.Item name="huifuFeeType" style={{ marginBottom: 10 }} rules={[{ pattern: /^0[1-9]$/, message: '格式如 02' }]}>
                          <Input disabled={agencyReadOnly || !option.available || feeDone} maxLength={2} placeholder={feeDone ? view?.profile?.huifuFeeType : '02'} />
                        </Form.Item>
                        <div style={{ marginBottom: 4 }}>
                          <Tag color="blue">④</Tag><Typography.Text strong style={{ fontSize: 13 }}>商户 RSA 私钥（PKCS#8）</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>服务端加密存储，仅首次填写</Typography.Text>
                        </div>
                        <Form.Item name="huifuPrivateKey" style={{ marginBottom: 10 }} rules={[{ min: 100, message: '私钥长度不合法' }]}>
                          <Input.Password disabled={agencyReadOnly || !option.available || keyDone} maxLength={4096} placeholder={keyDone ? '已配置（加密存储，不回显）' : '粘贴商户私钥（PKCS#8）'} />
                        </Form.Item>
                        <div style={{ marginBottom: 4 }}>
                          <Tag color="blue">⑤</Tag><Typography.Text strong style={{ fontSize: 13 }}>商户公钥（商户自己的 RSA 公钥）</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>商户后台「商户公钥」项，用于参数完整性核对</Typography.Text>
                        </div>
                        <Form.Item name="huifuMerchantPublicKey" style={{ marginBottom: 10 }} rules={[{ min: 40, message: '公钥长度不合法' }]}>
                          <Input disabled={agencyReadOnly || !option.available || mPubDone} maxLength={2048} placeholder={mPubDone ? '已配置：' + (view?.profile?.huifuMerchantPublicKeyPreview || '') : '粘贴商户公钥'} />
                        </Form.Item>
                        <div style={{ marginBottom: 4 }}>
                          <Tag color="blue">⑥</Tag><Typography.Text strong style={{ fontSize: 13 }}>汇付公钥（回调验签）</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>商户后台「汇付公钥」项</Typography.Text>
                        </div>
                        <Form.Item name="huifuPublicKey" style={{ marginBottom: 4 }} rules={[{ min: 40, message: '公钥长度不合法' }]}>
                          <Input disabled={agencyReadOnly || !option.available || pubDone} maxLength={2048} placeholder={pubDone ? '已配置：' + (view?.profile?.huifuPublicKeyPreview || '') : '粘贴汇付公钥'} />
                        </Form.Item>
                        {view.profile?.huifuPublicKeyPreview && <Typography.Text type="secondary" style={{ fontSize: 11 }}>当前汇付公钥：{view.profile.huifuPublicKeyPreview}</Typography.Text>}
                      </div>
                    </div>
                  )}
                  {selectedProvider === option.provider && option.provider === 'HUIFU' && (
                    <Form.Item name="wxAppletAppId" label="微信小程序 APPID" rules={[{ pattern: /^wx[a-f0-9]{16}$/i, message: 'APPID 格式不正确（wx 开头 + 16 位）' }]} extra="保存时自动调用汇付绑定接口；绑定后该商户才能使用小程序支付（绑定后不支持修改）" style={{ marginTop: 4 }}>
                      <Input disabled={agencyReadOnly || !option.available || Boolean(view.profile?.wxAppletAppId)} maxLength={32} placeholder="wx 开头的 18 位小程序 AppID" />
                    </Form.Item>
                  )}
                  {selectedProvider === option.provider && option.provider === 'HUIFU' && (
                    <div style={{ marginTop: 4, marginBottom: 8, padding: '12px 14px', border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Typography.Text strong style={{ fontSize: 13 }}>汇付绑定审核状态</Typography.Text>
                        <Button size="small" icon={<span>↻</span>} loading={bindStatusLoading} onClick={() => void loadBindStatus()} disabled={!view.profile?.wxAppletAppId}>刷新</Button>
                      </div>
                      {bindStatusLoading ? <Spin size="small" style={{ display: 'block', margin: '8px auto' }} />
                        : !view.profile?.wxAppletAppId
                          ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>填写并保存 APPID 后，此处展示汇付绑定申请审核进度。</Typography.Text>
                          : <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              <Space size={8} wrap>
                                <Tag color={bindStatusMeta[bindStatus?.applyStatus || '']?.color || 'default'}>{bindStatusMeta[bindStatus?.applyStatus || '']?.text || '未知'}</Tag>
                                {bindStatus?.applyStatus === 'Y' && <Tag color="green">小程序支付可用</Tag>}
                                {bindStatus?.applyStatus === 'P' && <Tag color="gold">审核中，请稍后刷新</Tag>}
                              </Space>
                              <Typography.Text style={{ fontSize: 12 }}>小程序 APPID：<code>{view.profile.wxAppletAppId}</code></Typography.Text>
                              {bindStatus?.applyNo && <Typography.Text style={{ fontSize: 12 }}>汇付申请单号：<code>{bindStatus.applyNo}</code></Typography.Text>}
                              <Typography.Text type={bindStatus?.applyStatus === 'N' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{bindStatus?.note || '尚未查询，点击刷新获取审核进度'}</Typography.Text>
                              {bindStatus?.checkedAt && <Typography.Text type="secondary" style={{ fontSize: 11 }}>检查时间：{new Date(bindStatus.checkedAt).toLocaleString('zh-CN', { hour12: false })}</Typography.Text>}
                            </Space>}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </Space>
        </Radio.Group>
      </Form.Item>
      <Form.Item label="外部商户号" name="externalMerchantNo" rules={[{ required: true }, { pattern: /^[A-Za-z0-9_-]{4,64}$/, message: '请输入 4 至 64 位字母、数字、下划线或短横线' }]} extra={view.profile ? '该编号已用于建立商家映射，创建后不可修改。' : '商家在支付平台的外部商户号，用于对账识别。'}>
        <Input disabled={Boolean(view.profile)} maxLength={64} />
      </Form.Item>
      {canActivate ? <Form.Item label="收款状态" name="status" rules={[{ required: true }]}>
        <Radio.Group options={statusOptions} optionType="button" buttonStyle="solid" />
      </Form.Item> : <Form.Item name="status" hidden><Input /></Form.Item>}
      {canActivate && <Form.Item noStyle shouldUpdate={(before, after) => before.status !== after.status || before.provider !== after.provider}>
        {({ getFieldValue }) => getFieldValue('status') === 'ACTIVE' ? <Form.Item name="activationConfirmed" valuePropName="checked" rules={[{ validator: (_, checked) => checked ? Promise.resolve() : Promise.reject(new Error('请先确认商户主体与审核状态')) }]}>
          <Checkbox disabled={!selectedOption?.available}>已核对商家主体一致，且支付通道审核状态允许交易</Checkbox>
        </Form.Item> : null}
      </Form.Item>}
      {view.profile && <Space size="small" style={{ marginBottom: 20 }}><Typography.Text type="secondary">当前版本 {view.profile.version}</Typography.Text><Tag color={view.profile.status === 'ACTIVE' ? 'green' : view.profile.status === 'DISABLED' ? 'default' : 'gold'}>{statusOptions.find((item) => item.value === view.profile?.status)?.label}</Tag>{view.profile.verifiedAt && <Typography.Text type="secondary">核验于 {new Date(view.profile.verifiedAt).toLocaleString('zh-CN', { hour12: false })}</Typography.Text>}</Space>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button onClick={onClose} disabled={saving}>关闭</Button>{!agencyReadOnly && <Button type="primary" htmlType="submit" loading={saving}>{canActivate ? '保存配置' : '提交资料'}</Button>}</div>
    </Form>}
  </Modal>;
}
