import { Card, Empty, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TransactionPage } from './workspace-model';

export type TablePaging = {
  transactionPage: TransactionPage;
  onChange: (current: number, pageSize: number) => void;
};

export function DataTable<T extends { id: string }>({ data, columns, paging }: { data: T[]; columns: ColumnsType<T>; paging?: TablePaging }) {
  return <Card className="data-panel" variant="borderless">{data.length ? <Table<T>
    rowKey="id"
    columns={columns}
    dataSource={data}
    pagination={paging ? {
      current: paging.transactionPage.current,
      pageSize: paging.transactionPage.pageSize,
      total: paging.transactionPage.total,
      showSizeChanger: true,
      pageSizeOptions: [10, 25, 50, 100],
      showTotal: (total) => `共 ${total} 条`,
      onChange: paging.onChange,
    } : { pageSize: 10, showSizeChanger: false }}
    scroll={{ x: 780 }}
  /> : <Empty description="暂无数据" />}</Card>;
}
