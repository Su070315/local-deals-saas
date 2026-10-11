import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Modal, Space, Tag, Typography, message } from 'antd';
import { operatorIssueDiagnostics } from './operator-issue';
import type { OperatorIssue } from './operator-issue';

export function OperatorIssuePanel({ issue, open, onClose, onRefresh }: { issue: OperatorIssue | null; open: boolean; onClose: () => void; onRefresh: () => void }) {
  if (!issue) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(operatorIssueDiagnostics(issue)); message.success('诊断信息已复制'); }
    catch { message.error('复制失败，请手工记录问题编号'); }
  };
  return <Modal title={<Space>问题诊断<Tag color="red">{issue.problemId}</Tag></Space>} open={open} onCancel={onClose} width={620} footer={<Space wrap><Button icon={<CopyOutlined />} onClick={() => void copy()}>复制诊断</Button><Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新当前页面</Button><Button type="primary" onClick={onClose}>关闭</Button></Space>}>
    <Alert type="error" showIcon message={issue.message} description={issue.recommendation} />
    <Descriptions column={1} size="small" bordered style={{ marginTop: 16 }}>
      <Descriptions.Item label="问题编号"><Typography.Text copyable>{issue.problemId}</Typography.Text></Descriptions.Item>
      <Descriptions.Item label="发生时间">{new Date(issue.occurredAt).toLocaleString('zh-CN')}</Descriptions.Item>
      <Descriptions.Item label="请求操作"><Typography.Text code>{issue.method} {issue.path}</Typography.Text></Descriptions.Item>
      <Descriptions.Item label="响应状态">{issue.status}</Descriptions.Item>
      <Descriptions.Item label="请求 ID">{issue.requestId || '未取得'}</Descriptions.Item>
      <Descriptions.Item label="服务版本">{issue.apiReleaseId || '未取得'}</Descriptions.Item>
    </Descriptions>
  </Modal>;
}
