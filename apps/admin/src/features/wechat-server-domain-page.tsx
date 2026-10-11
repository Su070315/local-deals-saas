import { CheckCircleFilled, CloudServerOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Form, Input, Space, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type ServerDomains = {
  requestDomain: string[];
  uploadDomain: string[];
  downloadDomain: string[];
};

type FormValues = {
  requestDomain: string;
  uploadDomain: string;
  downloadDomain: string;
};

const toLines = (list?: string[]) => (list && list.length ? list.join('\n') : '');
const splitLines = (value?: string) => (value || '')
  .split(/\r?\n/)
  .map((item) => item.trim())
  .filter(Boolean);

export default function WechatServerDomainPage({ merchantId, request }: { merchantId: string; request: Request }) {
  const [form] = Form.useForm<FormValues>();
  const [current, setCurrent] = useState<ServerDomains | null>(null);
  const [effective, setEffective] = useState<ServerDomains | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const domains = await request<ServerDomains>(`/wechat-platform/server-domains?merchantId=${merchantId}`);
      setCurrent(domains);
      form.setFieldsValue({
        requestDomain: toLines(domains.requestDomain),
        uploadDomain: toLines(domains.uploadDomain),
        downloadDomain: toLines(domains.downloadDomain),
      });
      try {
        setEffective(await request<ServerDomains>(`/wechat-platform/effective-domains?merchantId=${merchantId}`));
      } catch {
        setEffective(null);
      }
    } catch (error) {
      message.error((error as Error).message || '获取服务器域名配置失败');
    } finally {
      setLoading(false);
    }
  }, [merchantId, request, form]);

  useEffect(() => { void load(); }, [load]);

  async function save(values: FormValues) {
    setSaving(true);
    try {
      const result = await request<{ configured: boolean; message: string; domains: ServerDomains }>(
        `/wechat-platform/server-domains?merchantId=${merchantId}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            requestDomain: splitLines(values.requestDomain),
            uploadDomain: splitLines(values.uploadDomain),
            downloadDomain: splitLines(values.downloadDomain),
          }),
        },
      );
      setCurrent(result.domains);
      message.success(result.message || '服务器域名已更新');
    } catch (error) {
      message.error((error as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const requestCount = current?.requestDomain.length || 0;
  const matched = current && requestCount > 0;

  return <div className="wechat-platform-page">
    <section className="wechat-hero">
      <div>
        <span>微信小程序</span>
        <h2>服务器域名配置</h2>
        <p>配置顾客端小程序可访问的合法域名，保存后由平台代设到微信并即时生效</p>
      </div>
      <div className="wechat-hero-actions">
        <Tag color={matched ? 'green' : 'gold'}>{matched ? '已配置 request 域名' : '尚未配置 request 域名'}</Tag>
        <Button ghost icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新当前配置</Button>
      </div>
    </section>

    <Alert
      showIcon
      type="info"
      message="配置说明"
      description="request 域名是小程序发起网络请求的目标域名，必须填写小程序实际请求的地址（如 https://example.com），一个域名一行；upload/download 仅在需要上传/下载文件时填写。域名必须为 https 且不含路径。修改后部分微信客户端存在缓存延迟，建议重新生成体验版二维码并删除旧小程序后扫码验证。"
    />

    <section className="wechat-config-grid">
      <div className="wechat-config-panel">
        <div className="wechat-section-title">
          <div><strong>当前已配置域名</strong><span>来自微信服务器的最新查询结果</span></div>
          <CloudServerOutlined />
        </div>
        {!current ? (
          <Button loading={loading} onClick={() => void load()}>加载当前配置</Button>
        ) : (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="request 域名">
              <DomainList items={current.requestDomain} />
            </Descriptions.Item>
            <Descriptions.Item label="upload 域名">
              <DomainList items={current.uploadDomain} />
            </Descriptions.Item>
            <Descriptions.Item label="download 域名">
              <DomainList items={current.downloadDomain} />
            </Descriptions.Item>
          </Descriptions>
        )}
        <div className="wechat-section-title" style={{ marginTop: 20 }}>
          <div><strong>发布后生效域名</strong><span>微信发布的权威生效列表，可用于校验配置是否真正生效</span></div>
          <CheckCircleFilled />
        </div>
        {!effective ? (
          <div style={{ marginTop: 12 }}><Tag color="default">未获取（可能尚未发布正式版）</Tag></div>
        ) : (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="request 生效"><DomainList items={effective.requestDomain} /></Descriptions.Item>
            <Descriptions.Item label="upload 生效"><DomainList items={effective.uploadDomain} /></Descriptions.Item>
            <Descriptions.Item label="download 生效"><DomainList items={effective.downloadDomain} /></Descriptions.Item>
          </Descriptions>
        )}
      </div>

      <div className="wechat-config-panel">
        <div className="wechat-section-title">
          <div><strong>编辑服务器域名</strong><span>保存后将覆盖微信侧配置（一个域名一行）</span></div>
          <CheckCircleFilled />
        </div>
        <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
          <Form.Item
            name="requestDomain"
            label="request 合法域名（必填）"
            rules={[{ required: true, message: '请至少填写一个 request 域名' }]}
            extra="小程序网络请求的目标域名，必须与代码中的请求地址一致"
          >
            <Input.TextArea rows={3} placeholder={'https://example.com'} />
          </Form.Item>
          <Form.Item name="uploadDomain" label="upload 合法域名（选填）" extra="仅在需要 wx.uploadFile 上传文件时填写">
            <Input.TextArea rows={2} placeholder={'https://example.com'} />
          </Form.Item>
          <Form.Item name="downloadDomain" label="download 合法域名（选填）" extra="仅在需要 wx.downloadFile 下载文件时填写">
            <Input.TextArea rows={2} placeholder={'https://example.com'} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>保存配置</Button>
            <Button onClick={() => void load()} disabled={saving}>重置为当前配置</Button>
          </Space>
        </Form>
      </div>
    </section>
  </div>;
}

function DomainList({ items }: { items: string[] }) {
  if (!items || !items.length) return <Tag color="default">未配置</Tag>;
  return <Space wrap>{items.map((item) => <Tag key={item} color="blue">{item}</Tag>)}</Space>;
}
