import { Descriptions, Form, Input, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import type { ModalKind, RefundVoucherOption, SupportReply, SupportTicket } from './workspace-model';
import { money, statusText } from './workspace-model';

type SupportEditorFieldsProps = {
  kind: ModalKind;
  refundVoucherOptions: RefundVoucherOption[];
  ticket: SupportTicket | null;
  replies: SupportReply[];
};

export function SupportEditorFields({ kind, refundVoucherOptions, ticket, replies }: SupportEditorFieldsProps) {
  return <>
    {kind === 'exceptionRefund' && <>
      <Form.Item name="voucherId" label="关联券" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={refundVoucherOptions.map((voucher) => ({ value: voucher.id, label: `${voucher.code} · ${statusText(voucher.status)} · ${money(voucher.faceValueFen)}` }))} /></Form.Item>
      <Form.Item name="content" label="申请说明" rules={[{ required: true, min: 5 }]}><Input.TextArea rows={4} maxLength={1000} /></Form.Item>
    </>}
    {(kind === 'exceptionRefundApprove' || kind === 'exceptionRefundReject') && <>
      <Descriptions size="small" column={1}><Descriptions.Item label="关联券">{ticket?.voucherId ? String(ticket.voucherId).slice(0, 8) : '-'}</Descriptions.Item><Descriptions.Item label="商家申请">{ticket?.content || '-'}</Descriptions.Item></Descriptions>
      <Typography.Paragraph type={kind === 'exceptionRefundApprove' ? 'warning' : 'secondary'}>{kind === 'exceptionRefundApprove' ? '审批通过后不能由当前账号执行退款，必须由另一名平台财务独立发起支付操作。' : '驳回将结束当前申请，不调用支付适配器；商家可在补充材料后重新提交。'}</Typography.Paragraph>
      <Form.Item name="note" label={kind === 'exceptionRefundApprove' ? '审批意见' : '驳回说明'} rules={[{ required: true, min: 3 }]} extra="仅供平台内部留痕，不向商家或代理商展示。"><Input.TextArea rows={4} maxLength={1000} placeholder={kind === 'exceptionRefundApprove' ? '例如：已核对门店停业记录、券状态和补偿依据，批准退款。' : '例如：当前材料不足以支持异常退款，请补充停业或履约证明。'} /></Form.Item>
    </>}
    {(kind === 'supportReply' || kind === 'supportResolution') && <>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="工单类型">{ticket?.type === 'EXCEPTION_REFUND' ? '异常退款申请' : '顾客售后'}</Descriptions.Item>
        <Descriptions.Item label="关联券">{ticket?.voucherId ? String(ticket.voucherId).slice(0, 8) : '-'}</Descriptions.Item>
        <Descriptions.Item label="首次响应">{ticket?.type !== 'GENERAL' ? '-' : ticket?.firstRespondedAt ? dayjs(ticket.firstRespondedAt).format('YYYY-MM-DD HH:mm') : ticket?.firstResponseDueAt ? `截止 ${dayjs(ticket.firstResponseDueAt).format('YYYY-MM-DD HH:mm')}` : '-'}</Descriptions.Item>
      </Descriptions>
      <div className="support-thread">{replies.length ? replies.map((reply) => <div key={reply.id} className="support-thread-item"><Typography.Text strong>{reply.authorRole === 'PLATFORM_ADMIN' ? '平台回复' : reply.authorRole === 'MERCHANT_ADMIN' ? '商家回复' : '代理运营回复'}</Typography.Text><Typography.Text type="secondary">{dayjs(reply.createdAt).format('MM-DD HH:mm')}</Typography.Text><Typography.Paragraph>{reply.content}</Typography.Paragraph></div>) : <Typography.Text type="secondary">暂无处理回复</Typography.Text>}</div>
    </>}
    {kind === 'supportReply' && <Form.Item name="content" label="回复顾客" rules={[{ required: true, min: 3 }]} extra="发送后工单保持处理中，顾客可在小程序查看。"><Input.TextArea rows={4} maxLength={1000} placeholder="说明当前处理进展、下一步和预计时间" /></Form.Item>}
    {kind === 'supportResolution' && <Form.Item name="note" label="结案回复" rules={[{ required: true, min: 3 }]} extra="该内容会同步给顾客，并作为最后一条处理记录。"><Input.TextArea rows={4} maxLength={1000} placeholder="填写已完成的处理结论或驳回理由" /></Form.Item>}
    {kind === 'exceptionRefundExecution' && <>
      <Descriptions size="small" column={1}><Descriptions.Item label="关联券">{ticket?.voucherId ? String(ticket.voucherId).slice(0, 8) : '-'}</Descriptions.Item><Descriptions.Item label="申请说明">{ticket?.content || '-'}</Descriptions.Item></Descriptions>
      <Typography.Paragraph type="warning">确认后会调用当前支付适配器退款，券将立即失效并自动结案。审批人与执行人必须不同；执行备注仅供平台内部审计。</Typography.Paragraph>
      <Form.Item name="note" label="执行备注" rules={[{ required: true, min: 3 }]}><Input.TextArea rows={4} maxLength={1000} placeholder="记录实际执行时间、支付确认或补偿说明" /></Form.Item>
    </>}
  </>;
}
