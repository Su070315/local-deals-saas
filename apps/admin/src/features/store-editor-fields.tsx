import { DeleteOutlined, DownOutlined, UploadOutlined, UpOutlined } from '@ant-design/icons';
import { Button, Form, Image, Input, InputNumber, message, Popconfirm, Space, Switch, Typography, Upload } from 'antd';
import type { FormInstance, UploadProps } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { ModalKind } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * FIX(2026-08-10)：门店头像本地上传（方案 C）
 * - label Form.Item 直接包 Upload（无 Form.Item 嵌套——antd v5 不支持嵌套，此前嵌套导致点击无反应）
 * - Form.useWatch 监听 logoUrl 实时预览；上传成功后写回表单值
 * - customRequest 补调 onSuccess/onError（此前漏调导致 antd 内部状态停在"上传中"）
 */
type StoreBanner = { id: string; url: string; sortOrder: number; isDefault: boolean };

function StoreBannerManager({ form, merchantId, request }: { form: FormInstance; merchantId?: string; request?: Request }) {
  const watchedStoreId = Form.useWatch('id', form) as string | undefined;
  const storeId = String(watchedStoreId || '');
  const [banners, setBanners] = useState<StoreBanner[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const enabled = Boolean(storeId && merchantId && request);
  const endpoint = `/merchants/${merchantId}/stores/${storeId}/banners`;

  const load = useCallback(async () => {
    if (!enabled || !request) return;
    setLoading(true);
    try {
      const result = await request<StoreBanner[]>(endpoint);
      setBanners(Array.isArray(result) ? result.slice().sort((left, right) => left.sortOrder - right.sortOrder) : []);
    } catch (error) {
      message.error((error as Error).message || '首页图片加载失败');
    } finally {
      setLoading(false);
    }
  }, [enabled, endpoint, request]);

  useEffect(() => { void load(); }, [load]);

  async function saveOrder(next: StoreBanner[]) {
    if (!request) return;
    const result = await request<StoreBanner[]>(`${endpoint}/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ ids: next.map((item) => item.id), defaultId: next[0]?.id }),
    });
    setBanners(Array.isArray(result) ? result : next);
  }

  const uploadBanner: UploadProps['customRequest'] = async (options) => {
    const { file, onSuccess, onError } = options;
    if (!enabled || !request) { onError?.(new Error('请先保存门店后再管理首页图片')); return; }
    const image = file as File;
    if (!image || !/^image\/(jpeg|png|webp|gif)$/i.test(image.type || '')) {
      const error = new Error('仅支持 JPG、PNG、WEBP、GIF 图片');
      message.error(error.message);
      onError?.(error);
      return;
    }
    if (image.size > MAX_IMAGE_BYTES) {
      const error = new Error('图片大小不能超过 5MB');
      message.error(error.message);
      onError?.(error);
      return;
    }
    setUploading(true);
    const formData = new FormData();
    formData.append('file', image);
    try {
      const uploaded = await request<{ url: string }>(`/media/images?merchantId=${merchantId}&category=store-banner`, { method: 'POST', body: formData });
      const created = await request<StoreBanner>(endpoint, { method: 'POST', body: JSON.stringify({ url: uploaded.url }) });
      setBanners((current) => [...current, created].sort((left, right) => left.sortOrder - right.sortOrder));
      message.success('首页图片上传成功');
      onSuccess?.(created);
    } catch (error) {
      const err = error as Error;
      message.error(err.message || '首页图片上传失败');
      onError?.(err);
    } finally {
      setUploading(false);
    }
  };

  async function removeBanner(bannerId: string) {
    if (!request) return;
    try {
      await request(`${endpoint}/${bannerId}`, { method: 'DELETE' });
      setBanners((current) => current.filter((item) => item.id !== bannerId));
      message.success('首页图片已删除');
    } catch (error) {
      message.error((error as Error).message || '删除首页图片失败');
    }
  }

  async function moveBanner(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= banners.length) return;
    const next = [...banners];
    [next[index], next[target]] = [next[target], next[index]];
    try {
      await saveOrder(next);
      message.success('图片顺序已更新');
    } catch (error) {
      message.error((error as Error).message || '图片排序失败');
    }
  }

  if (!storeId) return <Typography.Text type="secondary">请先保存门店基础信息，再上传首页图片。</Typography.Text>;
  return <div>
    <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>首页横向图片带：最多 10 张；建议使用统一比例图片。顾客点击图片后可全屏查看同组图片。</Typography.Paragraph>
    <Space wrap style={{ marginBottom: 12 }}>
      <Upload showUploadList={false} accept="image/jpeg,image/png,image/webp,image/gif" customRequest={uploadBanner} disabled={!enabled || banners.length >= 10}>
        <Button icon={<UploadOutlined />} loading={uploading} disabled={!enabled || banners.length >= 10}>{banners.length >= 10 ? '已达 10 张上限' : '上传首页图片'}</Button>
      </Upload>
      <Button onClick={() => void load()} loading={loading} disabled={!enabled}>刷新列表</Button>
    </Space>
    {banners.length > 0 && <div style={{ display: 'grid', gap: 8 }}>
      {banners.map((banner, index) => <div key={banner.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8, border: '1px solid #f0f0f0', borderRadius: 8 }}>
        <Image width={100} height={64} preview={{ src: banner.url }} src={banner.url} style={{ objectFit: 'cover', borderRadius: 4 }} />
        <Typography.Text style={{ flex: 1 }} ellipsis>{index + 1}. {banner.url}</Typography.Text>
        <Button type="text" icon={<UpOutlined />} aria-label="上移图片" disabled={index === 0} onClick={() => void moveBanner(index, -1)} />
        <Button type="text" icon={<DownOutlined />} aria-label="下移图片" disabled={index === banners.length - 1} onClick={() => void moveBanner(index, 1)} />
        <Popconfirm title="删除这张首页图片？" description="仅移除首页展示记录，不会立即删除存储中的原文件。" okText="删除" cancelText="取消" onConfirm={() => void removeBanner(banner.id)}>
          <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除图片" />
        </Popconfirm>
      </div>)}
    </div>}
  </div>;
}

function StoreLogoUpload({ form, merchantId, request }: { form: FormInstance; merchantId?: string; request?: Request }) {
  const logoUrl = (Form.useWatch('logoUrl', form) as string) || '';

  const uploadLogo: UploadProps['customRequest'] = async (options) => {
    const { file, onSuccess, onError } = options;
    if (!merchantId || !request) { message.warning('当前环境不支持本地上传'); onError?.(new Error('缺少上传环境')); return; }
    if (!file) { message.warning('无法读取本地文件'); onError?.(new Error('无法读取本地文件')); return; }
    const fileSize = (file as { size?: number }).size || 0;
    if (fileSize > MAX_IMAGE_BYTES) { message.error('图片大小不能超过 5MB'); onError?.(new Error('图片大小不能超过 5MB')); return; }
    const formData = new FormData();
    formData.append('file', file);
    try {
      const result = await request<{ url: string }>(`/media/images?merchantId=${merchantId}`, { method: 'POST', body: formData });
      form.setFieldValue('logoUrl', result.url);
      message.success('门店头像上传成功');
      onSuccess?.(result);
    } catch (error) {
      const err = error as Error;
      message.error(err?.message || '图片上传失败');
      onError?.(err);
    }
  };

  return (
    <Upload showUploadList={false} accept="image/*" customRequest={uploadLogo}>
      <Button icon={<UploadOutlined />}>{logoUrl ? '更换头像' : '本地上传'}</Button>
    </Upload>
  );
}

export function StoreEditorFields({ kind, canManageFulfillment, merchantId, request, form }: { kind: ModalKind; canManageFulfillment: boolean; merchantId?: string; request?: Request; form: FormInstance }) {
  if (kind !== 'store') return null;

  return <>
    <Form.Item name="id" hidden><Input /></Form.Item>
    <Form.Item name="expectedVersion" hidden><Input /></Form.Item>
    {/* FIX(2026-08-10)：logoUrl 注册为表单字段——antd onFinish 只含注册字段，此前 setFieldValue 写入但未注册导致提交丢失；description 已有可见 Form.Item 注册 */}
    <Form.Item name="logoUrl" hidden><Input /></Form.Item>
    <Form.Item name="name" label="门店名称" rules={[{ required: true }]}><Input /></Form.Item>
    <Form.Item name="address" label="门店地址" rules={[{ required: true }]}><Input /></Form.Item>
    <Space size="middle" style={{ display: 'flex' }}>
      <Form.Item name="latitude" label="纬度"><InputNumber min={-90} max={90} precision={7} style={{ width: '100%' }} /></Form.Item>
      <Form.Item name="longitude" label="经度"><InputNumber min={-180} max={180} precision={7} style={{ width: '100%' }} /></Form.Item>
    </Space>
    <Typography.Text type="secondary">填写准确坐标后，顾客可在小程序直接打开地图导航。</Typography.Text>
    <Form.Item name="phone" label="电话"><Input /></Form.Item>
    <Form.Item name="businessHours" label="营业时间" initialValue="09:00-21:00"><Input placeholder="如 09:00-21:00，多个时段用逗号分隔" /></Form.Item>
    {/* FIX(2026-08-10)：门店头像本地上传（方案 C：无 Form.Item 嵌套，Upload 直接触发文件选择） */}
    <Form.Item label="门店头像">
      <StoreLogoUpload form={form} merchantId={merchantId} request={request} />
    </Form.Item>
    <Form.Item label="首页图片">
      <StoreBannerManager form={form} merchantId={merchantId} request={request} />
    </Form.Item>
    <Form.Item name="description" label="门店简介"><Input.TextArea rows={3} maxLength={2000} placeholder="门店特色、服务说明（显示在小程序门店信息区）" /></Form.Item>
    <Form.Item name="openForSale" label="接受新订单" valuePropName="checked"><Switch checkedChildren="开" unCheckedChildren="停" /></Form.Item>
    {canManageFulfillment && <Form.Item noStyle shouldUpdate={(previous, current) => previous.openForVerification !== current.openForVerification || previous.initialOpenForVerification !== current.initialOpenForVerification}>
      {({ getFieldValue }) => {
        const changed = getFieldValue('openForVerification') !== getFieldValue('initialOpenForVerification');
        return <>
          <Form.Item name="initialOpenForVerification" hidden><Input /></Form.Item>
          <Form.Item name="openForVerification" label="承担已购券履约" valuePropName="checked" extra="关闭后会停止核销、停止新售，并将有效未用券送入平台转店或补偿待办。"><Switch checkedChildren="继续履约" unCheckedChildren="停止履约" /></Form.Item>
          {changed && <Form.Item name="fulfillmentChangeReason" label={getFieldValue('openForVerification') ? '恢复履约说明' : '停止履约说明'} rules={[{ required: true, min: 3, message: '请填写至少 3 个字符的说明' }]}>
            <Input.TextArea rows={3} maxLength={500} placeholder={getFieldValue('openForVerification') ? '例如：门店恢复营业，平台确认可继续履约' : '例如：门店永久闭店，需统一转店或补偿退款'} />
          </Form.Item>}
        </>;
      }}
    </Form.Item>}
  </>;
}
