import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Segmented } from 'antd';
import { useMemo, useState } from 'react';
import type { TablePaging } from './data-table-shell';
import SupportDataPage from './support-data-page';
import type { SupportTicket, User } from './workspace-model';

type Props = {
  data: SupportTicket[];
  user: User;
  paging: TablePaging;
  onReply: (ticket: SupportTicket) => void;
  onResolve: (ticket: SupportTicket) => void;
  onExceptionRefundReview: (ticket: SupportTicket, approved: boolean) => void;
  onExceptionRefundExecute: (ticket: SupportTicket) => void;
};

export default function MerchantAfterSalesPage(props: Props) {
  const [keyword, setKeyword] = useState('');
  const [submittedKeyword, setSubmittedKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const filtered = useMemo(() => props.data.filter((ticket) => {
    const approval = String(ticket.exceptionRefundApprovalStatus || '');
    const ticketStatus = String(ticket.status);
    const matchesStatus = status === 'ALL'
      || status === 'PENDING' && ticketStatus === 'OPEN' && approval !== 'REJECTED'
      || status === 'APPROVED' && ticketStatus === 'RESOLVED'
      || status === 'REJECTED' && approval === 'REJECTED'
      || status === 'CANCELLED' && ticketStatus === 'CANCELLED';
    const text = `${ticket.id} ${ticket.voucherId || ''} ${ticket.content || ''} ${ticket.resolutionNote || ''}`.toLowerCase();
    return matchesStatus && (!submittedKeyword || text.includes(submittedKeyword.toLowerCase()));
  }), [props.data, status, submittedKeyword]);
  const options = [
    { value: 'ALL', label: `全部(${props.data.length})` },
    { value: 'PENDING', label: `待审核(${props.data.filter((item) => item.status === 'OPEN').length})` },
    { value: 'APPROVED', label: `审核通过(${props.data.filter((item) => item.status === 'RESOLVED').length})` },
    { value: 'REJECTED', label: `审核驳回(${props.data.filter((item) => item.exceptionRefundApprovalStatus === 'REJECTED').length})` },
    { value: 'CANCELLED', label: '用户撤销(0)' },
  ];
  function reset() { setKeyword(''); setSubmittedKeyword(''); setStatus('ALL'); }
  return <div className="merchant-after-sales-page">
    <section className="after-sales-filter"><Input allowClear prefix={<SearchOutlined />} value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => setSubmittedKeyword(keyword.trim())} placeholder="申请单ID、关联券或问题描述" /><Button type="primary" icon={<SearchOutlined />} onClick={() => setSubmittedKeyword(keyword.trim())}>搜索</Button><Button icon={<ReloadOutlined />} onClick={reset}>重置</Button></section>
    <section className="after-sales-tabs"><Segmented value={status} options={options} onChange={(value) => setStatus(String(value))} /></section>
    <SupportDataPage {...props} data={filtered} />
  </div>;
}
