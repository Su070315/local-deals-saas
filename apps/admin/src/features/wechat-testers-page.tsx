import { ReloadOutlined, TeamOutlined, UserAddOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Popconfirm, Space, Table, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type Tester = { wechatid: string; userstr: string };
type TesterList = { members: Tester[] };

type AddValues = { wechatid: string };

export default function WechatTestersPage({ merchantId, request }: { merchantId: string; request: Request }) {
  const [form] = Form.useForm<AddValues>();
  const [members, setMembers] = useState<Tester[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<TesterList>(`/wechat-platform/testers?merchantId=${merchantId}`);
      setMembers(result.members || []);
    } catch (error) {
      message.error((error as Error).message || '获取体验成员列表失败');
    } finally {
      setLoading(false);
    }
  }, [merchantId, request]);

  useEffect(() => { void load(); }, [load]);

  async function addTester(values: AddValues) {
    setAdding(true);
    try {
      const wechatid = (values.wechatid || '').trim();
      await request<{ message: string }>(`/wechat-platform/testers?merchantId=${merchantId}`, {
        method: 'POST',
        body: JSON.stringify({ wechatid }),
      });
      form.resetFields();
      message.success('已添加体验成员');
      await load();
    } catch (error) {
      message.error((error as Error).message || '添加失败');
    } finally {
      setAdding(false);
    }
  }

  async function removeTester(wechatid: string) {
    setRemoving(wechatid);
    try {
      await request<{ message: string }>(`/wechat-platform/testers?merchantId=${merchantId}&wechatid=${encodeURIComponent(wechatid)}`, {
        method: 'DELETE',
      });
      message.success('已移除体验成员');
      await load();
    } catch (error) {
      message.error((error as Error).message || '移除失败');
    } finally {
      setRemoving('');
    }
  }

  const columns = [
    {
      title: '微信号',
      dataIndex: 'wechatid',
      key: 'wechatid',
      render: (value: string) => <Tag color="blue">{value || '—'}</Tag>,
    },
    {
      title: '用户标识',
      dataIndex: 'userstr',
      key: 'userstr',
      render: (value: string) => value || '—',
    },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_: unknown, record: Tester) => (
        <Popconfirm
          title="确认移除该体验成员？"
          okText="移除"
          cancelText="取消"
          onConfirm={() => void removeTester(record.wechatid)}
        >
          <Button danger size="small" loading={removing === record.wechatid}>移除</Button>
        </Popconfirm>
      ),
    },
  ];

  return <div className="wechat-platform-page">
    <section className="wechat-hero">
      <div>
        <span>微信小程序</span>
        <h2>体验成员管理</h2>
        <p>管理可扫码进入体验版的成员白名单，只有列表中的微信号才能打开体验版</p>
      </div>
      <div className="wechat-hero-actions">
        <Tag color={members.length ? 'green' : 'gold'}>{members.length} 名体验成员</Tag>
        <Button ghost icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新列表</Button>
      </div>
    </section>

    <Alert
      showIcon
      type="info"
      message="说明"
      description="体验版仅限白名单成员扫码进入；不在列表中的微信号扫码会提示无权限。添加的体验成员需使用该微信号登录微信扫码。微信对体验成员数量有上限（普通小程序约 90 人），超过时需先移除再添加。"
    />

    <section className="wechat-config-grid">
      <div className="wechat-config-panel">
        <div className="wechat-section-title">
          <div><strong>当前体验成员</strong><span>来自微信服务器的实时查询结果</span></div>
          <TeamOutlined />
        </div>
        <Table
          rowKey="wechatid"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={members}
          pagination={false}
          locale={{ emptyText: '暂无体验成员' }}
        />
      </div>

      <div className="wechat-config-panel">
        <div className="wechat-section-title">
          <div><strong>添加体验成员</strong><span>填入对方微信号（非昵称）</span></div>
          <UserAddOutlined />
        </div>
        <Form form={form} layout="vertical" onFinish={(values) => void addTester(values)}>
          <Form.Item
            name="wechatid"
            label="微信号"
            rules={[{ required: true, whitespace: true, message: '请填写体验成员的微信号' }]}
            extra="示例：wxid_xxx 或自定义微信号"
          >
            <Input placeholder="请输入微信号" maxLength={64} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={adding} icon={<UserAddOutlined />}>添加成员</Button>
            <Button onClick={() => void load()} disabled={adding}>刷新</Button>
          </Space>
        </Form>
      </div>
    </section>
  </div>;
}
