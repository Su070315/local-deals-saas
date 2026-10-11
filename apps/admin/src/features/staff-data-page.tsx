import { useState } from 'react';
import { Button, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { QRCodeSVG } from 'qrcode.react';
import type { ColumnsType } from 'antd/es/table';
import { DataTable } from './data-table-shell';
import type { Store, User } from './workspace-model';
import { roleName } from './workspace-model';

export type StaffDataPageProps = {
  data: unknown[];
  stores: Store[];
  onEdit: (record: User) => void;
  onActiveChange: (id: string, active: boolean) => void;
  onUnbind: (id: string) => void;
  onWechatBind: (id: string) => Promise<{ bindToken: string; expiresInSeconds: number; qrDataUrl?: string } | null>;
};

/** 后端 SafeUser 已返回 wechatOpenid（swagger 生成类型未同步），此处最小类型扩展 */
type StaffRow = User & { wechatOpenid?: string | null };

const VERIFY_URL = 'https://example.com/verify.html';

type BindTarget = { record: StaffRow; bindToken: string; expiresInSeconds: number; qrDataUrl: string };

export default function StaffDataPage(props: StaffDataPageProps) {
  const [entryTarget, setEntryTarget] = useState<User | null>(null);
  const [bindTarget, setBindTarget] = useState<BindTarget | null>(null);
  const [bindLoading, setBindLoading] = useState(false);

  async function openWechatBind(record: StaffRow) {
    setBindLoading(true);
    try {
      const result = await props.onWechatBind(record.id);
      if (result) setBindTarget({ record, bindToken: result.bindToken, expiresInSeconds: result.expiresInSeconds, qrDataUrl: result.qrDataUrl || '' });
    } finally {
      setBindLoading(false);
    }
  }

  const columns: ColumnsType<StaffRow> = [
    { title: '姓名', dataIndex: 'name' },
    { title: '账号', dataIndex: 'email' },
    { title: '角色', dataIndex: 'role', render: (role, record) => roleName(role, record.platformAccessProfile) },
    { title: '授权门店', dataIndex: 'storeIds', render: (ids: string[] | null) => ids?.map((id) => props.stores.find((store) => store.id === id)?.name || id).join('、') || '-' },
    { title: '微信绑定', dataIndex: 'wechatOpenid', render: (openid: string | null) => openid ? <Tag color="green">已绑定</Tag> : <Tag>未绑定</Tag> },
    { title: '状态', dataIndex: 'active', render: (active) => <Tag color={active ? 'green' : 'default'}>{active ? '启用' : '停用'}</Tag> },
    {
      title: '操作',
      render: (_, record) => <Space size={4}>
        <Button size="small" onClick={() => props.onEdit(record)}>编辑/重置密码</Button>
        {record.role === 'STORE_STAFF' && (
          <Button size="small" type="primary" ghost onClick={() => setEntryTarget(record)}>核销入口</Button>
        )}
        {record.role === 'STORE_STAFF' && (
          <Button size="small" loading={bindLoading} disabled={Boolean(record.wechatOpenid)} onClick={() => void openWechatBind(record)}>
            {record.wechatOpenid ? '已绑定' : '绑定微信'}
          </Button>
        )}
        {record.role === 'STORE_STAFF' && (
          <Popconfirm title="确认解绑该核销员？其已登录的核销台将立即失效，需重新扫码登录。" onConfirm={() => props.onUnbind(record.id)}>
            <Button size="small" danger>解绑</Button>
          </Popconfirm>
        )}
        <Popconfirm title={`确认${record.active ? '停用' : '启用'}该员工？`} onConfirm={() => props.onActiveChange(record.id, !record.active)}>
          <Button size="small">{record.active ? '停用' : '启用'}</Button>
        </Popconfirm>
      </Space>,
    },
  ];

  return (
    <>
      <DataTable data={props.data as StaffRow[]} columns={columns} />
      <Modal
        title={`核销入口 · ${entryTarget?.name || ''}`}
        open={Boolean(entryTarget)}
        onCancel={() => setEntryTarget(null)}
        footer={null}
        width={380}
      >
        <div style={{ textAlign: 'center' }}>
          <QRCodeSVG value={VERIFY_URL} size={220} />
          <Typography.Paragraph style={{ marginTop: 16 }}>
            请核销员使用微信扫一扫此二维码进入核销台，用本账号（{entryTarget?.email || ''}）登录后即可扫码核销顾客券码。
          </Typography.Paragraph>
          <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>{VERIFY_URL}</Typography.Text>
        </div>
      </Modal>
      <Modal
        title={`绑定微信 · ${bindTarget?.record.name || ''}`}
        open={Boolean(bindTarget)}
        onCancel={() => setBindTarget(null)}
        footer={null}
        width={380}
      >
        {bindTarget && (
          <div style={{ textAlign: 'center' }}>
            {bindTarget.qrDataUrl ? (
              <img src={bindTarget.qrDataUrl} alt="绑定小程序码" style={{ width: 220, height: 220, objectFit: 'contain' }} />
            ) : (
              <Typography.Text type="warning">小程序码生成失败，请稍后重试</Typography.Text>
            )}
            <Typography.Paragraph style={{ marginTop: 16 }}>
              请核销员使用微信扫一扫此小程序码，确认后即绑定当前微信账号（约 {Math.ceil(bindTarget.expiresInSeconds / 60)} 分钟内有效）。
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              核销员扫码后打开顾客小程序绑定页，点击「确认绑定」即可完成。
            </Typography.Text>
          </div>
        )}
      </Modal>
    </>
  );
}
