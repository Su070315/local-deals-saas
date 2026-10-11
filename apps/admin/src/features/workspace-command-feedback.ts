import dayjs from 'dayjs';
import type { ModalKind } from './workspace-model';

const SUCCESS_MESSAGES: Partial<Record<Exclude<ModalKind, null>, string>> = {
  exceptionRefundApprove: '异常退款已批准，需由另一名财务账号执行',
  exceptionRefundReject: '异常退款申请已驳回',
  exitRequest: '退出申请已提交，等待平台确认停售',
  exitFulfillment: '已进入既有券履约阶段',
  exitPrepareExport: '离场数据交付已开放',
  exitDataConfirm: '已确认数据交付',
  exitAuthorizationConfirm: '已记录授权撤销确认',
  supervisorPassword: '密码已重置，目标账号的所有设备已退出',
  exceptionRefund: '异常退款申请已提交',
  exceptionRefundExecution: '退款已执行，券已失效并完成结案',
  supportReply: '回复已发送，工单保持处理中',
  supportResolution: '工单已完成处理',
  voucherTransfer: '券已转至替代门店',
  template: '品牌主页已发布',
};

export function workspaceCommandSuccess(modal: ModalKind, result: unknown): string {
  if (modal === 'stepUp') return `身份确认完成，有效至 ${dayjs((result as { expiresAt: string }).expiresAt).format('HH:mm')}`;
  return modal ? SUCCESS_MESSAGES[modal] || '已保存' : '已保存';
}
