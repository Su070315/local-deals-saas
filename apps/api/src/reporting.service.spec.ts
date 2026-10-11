import { reportBusinessDaySql } from './reporting.service';

describe('report business-day SQL', () => {
  it('keeps the embedded expression compatible with pg-mem', () => {
    expect(reportBusinessDaySql('order.createdAt', true)).toBe("to_char(order.createdAt, 'YYYY-MM-DD')");
  });

  it('converts legacy UTC wall timestamps to the Shanghai business day on PostgreSQL', () => {
    expect(reportBusinessDaySql('entry.occurredAt', false)).toBe("to_char(entry.occurredAt AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')");
  });

  it('rejects dynamic SQL identifiers', () => {
    expect(() => reportBusinessDaySql('entry.occurredAt); DROP TABLE orders;--', false)).toThrow('报表日期列标识无效');
  });
});
