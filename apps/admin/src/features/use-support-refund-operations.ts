import type { FormInstance } from 'antd';
import { message } from 'antd';
import { useCallback, useState } from 'react';
import type {
  EditorFormValues,
  ModalKind,
  Paginated,
  RefundVoucherOption,
  SupportReply,
  SupportTicket,
} from './workspace-model';

type WorkspaceRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export function useSupportRefundOperations({ form, merchantId, request, refresh, setModal }: {
  form: FormInstance<EditorFormValues>;
  merchantId: string;
  request: WorkspaceRequest;
  refresh: () => Promise<void>;
  setModal: (kind: ModalKind) => void;
}) {
  const [refundVoucherOptions, setRefundVoucherOptions] = useState<RefundVoucherOption[]>([]);
  const [supportTicketToResolve, setSupportTicketToResolve] = useState<SupportTicket | null>(null);
  const [supportReplies, setSupportReplies] = useState<SupportReply[]>([]);

  const resetSupportRefundOperations = useCallback(() => {
    setRefundVoucherOptions([]);
    setSupportTicketToResolve(null);
    setSupportReplies([]);
  }, []);

  async function openExceptionRefund() {
    try {
      const page = await request<Paginated<RefundVoucherOption>>(`/vouchers?merchantId=${merchantId}&page=1&pageSize=100`);
      const options = page.items.filter((voucher) => voucher.status === 'UNUSED');
      if (!options.length) { message.info('当前没有可申请异常退款的券'); return; }
      form.resetFields();
      setRefundVoucherOptions(options);
      setModal('exceptionRefund');
    } catch (error) { message.error((error as Error).message); }
  }

  async function retryVoucherRefund(voucherId: string) {
    try {
      await request(`/vouchers/${voucherId}/retry-refund`, { method: 'POST', body: JSON.stringify({}) });
      message.success('退款已重新提交确认');
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  async function refundClosedStoreVoucher(voucherId: string) {
    try {
      await request(`/vouchers/${voucherId}/store-closure-refund`, { method: 'POST', body: '{}' });
      message.success('停业补偿退款已提交');
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  async function openSupportTicketModal(ticket: SupportTicket, kind: Extract<ModalKind, 'supportReply' | 'supportResolution'>) {
    try {
      form.resetFields();
      const replies = await request<SupportReply[]>(`/support-tickets/${ticket.id}/replies`);
      setSupportTicketToResolve(ticket);
      setSupportReplies(replies);
      setModal(kind);
    } catch (error) { message.error((error as Error).message); }
  }

  function openSupportResolution(ticket: SupportTicket) { void openSupportTicketModal(ticket, 'supportResolution'); }
  function openSupportReply(ticket: SupportTicket) { void openSupportTicketModal(ticket, 'supportReply'); }
  function openExceptionRefundReview(ticket: SupportTicket, approved: boolean) { form.resetFields(); setSupportTicketToResolve(ticket); setModal(approved ? 'exceptionRefundApprove' : 'exceptionRefundReject'); }
  function openExceptionRefundExecution(ticket: SupportTicket) { form.resetFields(); setSupportTicketToResolve(ticket); setModal('exceptionRefundExecution'); }

  return {
    refundVoucherOptions, supportTicketToResolve, supportReplies, resetSupportRefundOperations,
    openExceptionRefund, retryVoucherRefund, refundClosedStoreVoucher,
    openSupportResolution, openSupportReply, openExceptionRefundReview, openExceptionRefundExecution,
  };
}
