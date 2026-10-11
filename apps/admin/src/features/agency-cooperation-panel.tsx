import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, message } from 'antd';
import React, { useEffect, useState } from 'react';
import type { Agency } from './workspace-model';

type CooperationForm = {
  cooperationPlan: 'PER_PUBLISH' | 'ANNUAL_UNLIMITED';
  publicationQuotaRemaining?: number;
  cooperationStartsAt?: string;
  cooperationEndsAt?: string;
  cooperationReference?: string;
};

export function AgencyCooperationPanel({ agency, request, onClose, onSaved }: { agency: Agency; request: <T>(path: string, init?: RequestInit) => Promise<T>; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm<CooperationForm>();
  const [submitting, setSubmitting] = useState(false);
  const plan = Form.useWatch('cooperationPlan', form);
  useEffect(() => {
    form.setFieldsValue({
      cooperationPlan: agency.cooperationPlan || 'PER_PUBLISH', publicationQuotaRemaining: agency.publicationQuotaRemaining || 0,
      cooperationStartsAt: agency.cooperationStartsAt ? String(agency.cooperationStartsAt).slice(0, 10) : undefined,
      cooperationEndsAt: agency.cooperationEndsAt ? String(agency.cooperationEndsAt).slice(0, 10) : undefined,
      cooperationReference: agency.cooperationReference || '',
    });
  }, [agency, form]);
  async function save(values: CooperationForm) {
    setSubmitting(true);
    try {
      await request(`/agencies/${agency.id}/cooperation`, { method: 'PATCH', body: JSON.stringify({ ...values, publicationQuotaRemaining: values.cooperationPlan === 'PER_PUBLISH' ? Number(values.publicationQuotaRemaining || 0) : 0, cooperationStartsAt: values.cooperationPlan === 'ANNUAL_UNLIMITED' ? values.cooperationStartsAt : null, cooperationEndsAt: values.cooperationPlan === 'ANNUAL_UNLIMITED' ? values.cooperationEndsAt : null }) });
      message.success('代理合作授权已更新'); onSaved(); onClose();
    } catch (error) { message.error((error as Error).message); }
    finally { setSubmitting(false); }
  }
  return <Modal open title={`维护合作授权 · ${agency.name}`} footer={null} onCancel={onClose} destroyOnClose>
    <Alert type="info" showIcon message="合作费用在线下对公结算" description="这里只维护代理可提交的商家小程序开通额度；不记录收款金额、账户信息，也不发起扣费或结算。" style={{ marginBottom: 16 }} />
    <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
      <Form.Item name="cooperationPlan" label="合作模式" rules={[{ required: true }]}><Select options={[{ value: 'PER_PUBLISH', label: '单商家小程序开通（按次）' }, { value: 'ANNUAL_UNLIMITED', label: '年度合作（不限商家开通）' }]} /></Form.Item>
      {plan === 'PER_PUBLISH' ? <Form.Item name="publicationQuotaRemaining" label="当前可开通商家名额" rules={[{ required: true }]} extra="代理提交一家商家的小程序开通资料时占用 1 个；审核失败会自动归还。既有商家不受影响。"><InputNumber min={0} max={1_000_000} precision={0} style={{ width: '100%' }} /></Form.Item> : <><Form.Item name="cooperationStartsAt" label="年度合作开始日" rules={[{ required: true }]}><Input type="date" /></Form.Item><Form.Item name="cooperationEndsAt" label="年度合作截止日" rules={[{ required: true }]}><Input type="date" /></Form.Item></>}
      <Form.Item name="cooperationReference" label="线下合作参考号"><Input maxLength={120} placeholder="合同号、审批编号或线下登记号" /></Form.Item>
      <Space style={{ display: 'flex', justifyContent: 'flex-end' }}><Button onClick={onClose}>取消</Button><Button type="primary" htmlType="submit" loading={submitting}>保存授权</Button></Space>
    </Form>
  </Modal>;
}
