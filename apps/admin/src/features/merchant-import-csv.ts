import type { RequestBody } from '../api-contract';

export type MerchantImportItem = RequestBody<'AppController_merchantBatchImport'>['items'][number];

const requiredHeaders = ['externalRef', 'legalName', 'brandName', 'servicePhone'] as const;
const optionalHeaders = ['contractNumber', 'contractEndsAt', 'rate'] as const;
const allowedHeaders = new Set<string>([...requiredHeaders, ...optionalHeaders]);

function parseCsvRecords(source: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell.trim()); cell = '';
      if (row.some((value) => value !== '')) records.push(row);
      row = [];
    } else cell += character;
  }
  if (quoted) throw new Error('CSV 包含未闭合的引号');
  row.push(cell.trim());
  if (row.some((value) => value !== '')) records.push(row);
  return records;
}

function requiredText(value: string | undefined, label: string, maxLength: number): string {
  const text = value?.trim() || '';
  if (!text || text.length > maxLength) throw new Error(`${label}不能为空且不能超过 ${maxLength} 个字符`);
  return text;
}

export function parseMerchantImportCsv(source: string, allowFinancialTerms: boolean): MerchantImportItem[] {
  if (source.length > 262_144) throw new Error('CSV 文件不能超过 256 KB');
  const records = parseCsvRecords(source.replace(/^\uFEFF/, ''));
  if (records.length < 2) throw new Error('请提供带表头的 CSV，至少包含一行商家');
  const headers = records[0].map((value) => value.trim());
  const positions = new Map(headers.map((header, index) => [header, index]));
  for (const header of requiredHeaders) if (!positions.has(header)) throw new Error(`CSV 缺少必填列：${header}`);
  for (const header of headers) if (!allowedHeaders.has(header)) throw new Error(`CSV 包含不支持的列：${header}`);
  if (!allowFinancialTerms && optionalHeaders.some((header) => positions.has(header))) throw new Error('代理端导入不能包含合同或服务费率列，请由平台配置');
  const seen = new Set<string>();
  const items = records.slice(1).map((record, rowIndex) => {
    const value = (header: string) => record[positions.get(header) ?? -1] || '';
    const externalRef = requiredText(value('externalRef'), `第 ${rowIndex + 2} 行导入标识`, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(externalRef)) throw new Error(`第 ${rowIndex + 2} 行导入标识只能包含字母、数字、下划线和短横线`);
    if (seen.has(externalRef)) throw new Error(`导入标识重复：${externalRef}`);
    seen.add(externalRef);
    const item: MerchantImportItem = {
      externalRef,
      legalName: requiredText(value('legalName'), `第 ${rowIndex + 2} 行商家主体`, 200),
      brandName: requiredText(value('brandName'), `第 ${rowIndex + 2} 行品牌名称`, 80),
      ...(value('servicePhone') ? { servicePhone: requiredText(value('servicePhone'), '服务电话', 40) } : {}),
    };
    const contractNumber = value('contractNumber');
    const contractEndsAt = value('contractEndsAt');
    const rateValue = value('rate');
    if (allowFinancialTerms && contractNumber) item.contractNumber = requiredText(contractNumber, '合同编号', 80);
    if (allowFinancialTerms && contractEndsAt) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(contractEndsAt) || Number.isNaN(Date.parse(`${contractEndsAt}T00:00:00Z`))) throw new Error(`第 ${rowIndex + 2} 行合同到期日格式不正确`);
      item.contractEndsAt = contractEndsAt;
    }
    if (allowFinancialTerms && rateValue) {
      const rate = Number(rateValue);
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`第 ${rowIndex + 2} 行服务费率必须介于 0 和 1 之间`);
      item.rate = rate;
    }
    return item;
  });
  if (items.length < 1 || items.length > 100) throw new Error('一次只能导入 1 至 100 家商家');
  return items;
}

export const merchantImportTemplate = (allowFinancialTerms: boolean) => [
  [...requiredHeaders, ...(allowFinancialTerms ? optionalHeaders : [])].join(','),
  'demo-001,示例餐饮主体,示例餐饮,400-000-0000',
].join('\n');
