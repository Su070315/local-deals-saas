import { Alert, Card, Descriptions, Spin, Tag } from 'antd';
import dayjs from 'dayjs';
import React, { useEffect, useState } from 'react';

type AgencyCooperation = {
  name: string;
  active: boolean;
  cooperationPlan: 'PER_PUBLISH' | 'ANNUAL_UNLIMITED';
  publicationQuotaRemaining: number;
  cooperationStartsAt: string | null;
  cooperationEndsAt: string | null;
  cooperationReference: string;
};

export function AgencyCooperationPage({ request }: { request: <T>(path: string, init?: RequestInit) => Promise<T> }) {
  const [agency, setAgency] = useState<AgencyCooperation | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void request<AgencyCooperation>('/agency/cooperation').then((result) => { if (active) setAgency(result); }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [request]);

  if (error) return <Alert type="error" showIcon message="无法读取合作授权" description={error} />;
  if (!agency) return <Card className="data-panel" variant="borderless"><Spin /></Card>;
  const annual = agency.cooperationPlan === 'ANNUAL_UNLIMITED';
  const withinAnnualTerm = annual && agency.cooperationStartsAt && agency.cooperationEndsAt && dayjs().isAfter(dayjs(agency.cooperationStartsAt).startOf('day').subtract(1, 'millisecond')) && dayjs().isBefore(dayjs(agency.cooperationEndsAt).endOf('day').add(1, 'millisecond'));
  const authorized = agency.active && (annual ? withinAnnualTerm : agency.publicationQuotaRemaining > 0);
  return <Card className="data-panel" variant="borderless" title="商家小程序开通授权">
    <Alert showIcon type={authorized ? 'success' : 'warning'} message={authorized ? '当前可提交新商家的小程序开通资料' : '当前不可提交新商家的小程序开通资料'} description={authorized ? '创建商家草稿不消耗授权；提交开通资料时占用 1 个名额，平台确认小程序可发布后记为已使用；审核失败会自动归还。它不影响已开通商家的小程序、套餐销售或核销。' : '请联系平台系统管理员完成线下合作确认、补充单商家开通名额或续期。'} style={{ marginBottom: 16 }} />
    <Descriptions column={{ xs: 1, sm: 2 }}>
      <Descriptions.Item label="代理商">{agency.name}</Descriptions.Item>
      <Descriptions.Item label="账号状态"><Tag color={agency.active ? 'green' : 'default'}>{agency.active ? '启用' : '停用'}</Tag></Descriptions.Item>
      <Descriptions.Item label="合作模式">{annual ? '年度合作（不限商家开通）' : '单商家小程序开通（按次）'}</Descriptions.Item>
      <Descriptions.Item label="可开通商家名额">{annual ? '不限量' : `${agency.publicationQuotaRemaining} 个`}</Descriptions.Item>
      {annual && <Descriptions.Item label="有效期">{agency.cooperationStartsAt} 至 {agency.cooperationEndsAt}</Descriptions.Item>}
      <Descriptions.Item label="线下合作参考">{agency.cooperationReference || '未登记'}</Descriptions.Item>
    </Descriptions>
  </Card>;
}
