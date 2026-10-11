import { Descriptions, FormInstance, Modal, Space, Tag, Typography, message } from 'antd';
import { useCallback, useState } from 'react';
import type { EditorFormValues, Merchant, MerchantExitReadiness, ModalKind } from './workspace-model';

type WorkspaceRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type ExitModalKind = Extract<ModalKind, 'exitRequest' | 'exitFulfillment' | 'exitPrepareExport' | 'exitDataConfirm' | 'exitAuthorizationConfirm'>;

export function useFinanceExitOperations({ form, merchantId, request, refresh: _refresh, setModal }: {
  form: FormInstance<EditorFormValues>;
  merchantId: string;
  request: WorkspaceRequest;
  refresh: () => Promise<void>;
  setModal: (kind: ModalKind) => void;
}) {
  const [exitCaseMerchantId, setExitCaseMerchantId] = useState('');

  const resetFinanceExitOperations = useCallback(() => {
    setExitCaseMerchantId('');
  }, []);

  function openExitAction(kind: ExitModalKind) {
    if (!merchantId) return message.error('请先选择商家');
    form.resetFields();
    setExitCaseMerchantId(merchantId);
    setModal(kind);
  }

  async function openExitReadiness(merchant: Merchant) {
    try {
      const readiness = await request<MerchantExitReadiness>(`/merchants/${merchant.id}/exit-readiness`);
      const entries: Array<[string, number]> = [
        ['待支付订单', readiness.blockers.pendingOrders],
        ['待履约或退款中的券', readiness.blockers.activeVouchers],
        ['待确认退款', readiness.blockers.unresolvedRefunds],
        ['未结售后', readiness.blockers.openSupportTickets],
        ['未结月结账单', readiness.blockers.unsettledBills],
      ];
      Modal.info({
        title: `${merchant.brandName} · 离场检查`, width: 520,
        content: <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 12 }}><Tag color={readiness.readyToClose ? 'green' : 'volcano'}>{readiness.readyToClose ? '可正式关闭' : '仍需完成收尾'}</Tag><Descriptions size="small" column={1}>{entries.map(([label, count]) => <Descriptions.Item key={label} label={label}>{count ? <Typography.Text type="danger">{count}</Typography.Text> : <Typography.Text type="success">已完成</Typography.Text>}</Descriptions.Item>)}</Descriptions></Space>,
      });
    } catch (error) { message.error((error as Error).message); }
  }

  return {
    exitCaseMerchantId, resetFinanceExitOperations, openExitAction, openExitReadiness,
  };
}
