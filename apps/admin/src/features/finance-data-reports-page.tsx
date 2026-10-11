import { FileExcelOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input } from 'antd';
import { useMemo, useState } from 'react';

const REPORTS = [
  { group: '商品相关', name: '商品列表', description: '展示商户的所有商品信息', page: 'packages' },
  { group: '商品相关', name: '库存分布统计', description: '查询各门店商品库存分布', page: 'inventoryStock' },
  { group: '商品相关', name: '积分商品兑换记录', description: '会员兑换积分商品的日志记录', page: 'pointsExchanges' },
  { group: '会员相关', name: '会员列表', description: '查看会员档案、等级和余额', page: 'members' },
  { group: '会员相关', name: '余额日志', description: '会员余额充值与变动记录', page: 'memberRecharge' },
  { group: '会员相关', name: '积分日志', description: '会员积分兑换与变动记录', page: 'pointsExchanges' },
  { group: '经营相关', name: '门店经营分析', description: '订单、支付、退款与核销分析', page: 'reports' },
  { group: '经营相关', name: '支付流水', description: '支付事件与处理状态记录', page: 'paymentTransactions' },
  { group: '经营相关', name: '退款流水', description: '退款申请、支付与重试记录', page: 'refundTransactions' },
];

export default function FinanceDataReportsPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [keyword, setKeyword] = useState('');
  const rows = useMemo(() => REPORTS.filter((row) => !keyword.trim() || `${row.name} ${row.description}`.toLowerCase().includes(keyword.trim().toLowerCase())), [keyword]);
  const groups = [...new Set(rows.map((row) => row.group))];
  return <div className="finance-data-reports"><section className="report-catalog-search"><Input allowClear prefix={<SearchOutlined />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按报表名称搜索" /></section>{groups.map((group) => <section className="report-catalog-group" key={group}><h3>{group}</h3><div>{rows.filter((row) => row.group === group).map((row) => <article key={row.name}><div><FileExcelOutlined /><strong>{row.name}</strong></div><footer><span>{row.description}</span><Button type="primary" ghost onClick={() => onNavigate(row.page)}>点击预览</Button></footer></article>)}</div></section>)}</div>;
}
