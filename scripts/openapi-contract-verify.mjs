import { readFile } from 'node:fs/promises';

const [rawContract, generatedTypes, adminBridge, workspaceModel, compatibilityBaselineRaw] = await Promise.all([
  readFile('packages/api-contract/openapi.json', 'utf8'),
  readFile('packages/api-contract/src/generated-openapi.d.ts', 'utf8'),
  readFile('apps/admin/src/api-contract.ts', 'utf8'),
  readFile('apps/admin/src/features/workspace-model.ts', 'utf8'),
  readFile('packages/api-contract/v1-compatibility-baseline.json', 'utf8'),
]);
const document = JSON.parse(rawContract);
const compatibilityBaseline = JSON.parse(compatibilityBaselineRaw);
const paths = document.paths || {};
const schemas = document.components?.schemas || {};
const failures = [];
if (Object.keys(paths).length < 90) failures.push(`OpenAPI 路由仅 ${Object.keys(paths).length} 条，低于当前 90 条覆盖基线`);
if (Object.keys(schemas).length < 40) failures.push(`OpenAPI DTO 仅 ${Object.keys(schemas).length} 个，低于当前 40 个覆盖基线`);
const stableUnversionedPaths = new Set(['/api/payments/webhooks/{provider}']);
for (const path of Object.keys(paths)) if (!path.startsWith('/api/v1/') && !stableUnversionedPaths.has(path)) failures.push(`OpenAPI 包含非权威旧路径 ${path}`);
for (const path of ['/api/v1/public/merchants/{merchantId}/orders', '/api/v1/merchants/{merchantId}/packages', '/api/v1/support-tickets/{ticketId}/execute-exception-refund']) if (!paths[path]) failures.push(`OpenAPI 缺少核心 v1 路由 ${path}`);
if (!paths['/api/payments/webhooks/{provider}'] || paths['/api/v1/payments/webhooks/{provider}']) failures.push('支付 webhook 必须仅保留稳定无版本地址');
const emptySchemas = Object.entries(schemas).filter(([name, schema]) => !name.endsWith('Response') && (!schema?.properties || Object.keys(schema.properties).length === 0)).map(([name]) => name);
if (emptySchemas.length) failures.push(`OpenAPI DTO 缺少字段：${emptySchemas.join(', ')}`);
const createOrder = schemas.CreateOrderDto;
if (createOrder?.properties?.quantity?.type !== 'integer' || createOrder.properties.packageId?.format !== 'uuid') failures.push('CreateOrderDto 未保留下单整数与 UUID 约束');
const savePackage = schemas.SavePackageDto;
if (savePackage?.properties?.storeIds?.items?.format !== 'uuid' || savePackage.properties.status?.enum?.length !== 3) failures.push('SavePackageDto 未保留门店 UUID 与套餐状态枚举');
const queryParameters = (path) => new Map((paths[path]?.get?.parameters || []).filter((parameter) => parameter.in === 'query').map((parameter) => [parameter.name, parameter]));
const orderQueries = queryParameters('/api/v1/orders');
if (orderQueries.get('merchantId')?.schema?.format !== 'uuid' || orderQueries.get('page')?.schema?.type !== 'integer' || orderQueries.get('pageSize')?.schema?.maximum !== 100) failures.push('订单查询未从 TransactionListQueryDto 保留租户、分页与上限约束');
const reportQueries = queryParameters('/api/v1/reports/analytics');
if (reportQueries.get('merchantId')?.schema?.format !== 'uuid' || !reportQueries.get('from')?.schema?.pattern || !reportQueries.get('to')?.schema?.pattern) failures.push('经营报表查询未从 ReportAnalyticsQueryDto 保留商家与日期约束');
const operations = Object.values(paths).flatMap((path) => Object.values(path).filter((operation) => operation?.operationId));
const operationIds = operations.map((operation) => operation.operationId);
const duplicateOperationIds = [...new Set(operationIds.filter((operationId, index) => operationIds.indexOf(operationId) !== index))];
if (duplicateOperationIds.length) failures.push(`OpenAPI operationId 重复：${duplicateOperationIds.join(', ')}`);
if (operationIds.some((operationId) => /\[\d+\]/.test(operationId))) failures.push('OpenAPI operationId 仍包含框架生成的版本数组下标');
const operationSignatures = new Set(Object.entries(paths).flatMap(([path, pathItem]) => Object.entries(pathItem)
  .filter(([, operation]) => operation?.operationId)
  .map(([method, operation]) => `${method.toUpperCase()} ${path} ${operation.operationId}`)));
for (const signature of compatibilityBaseline.operations || []) if (!operationSignatures.has(signature)) failures.push(`v1 消费者兼容基线缺少操作：${signature}`);

function resolveSchema(schema) {
  let current = schema;
  const seen = new Set();
  while (current?.$ref?.startsWith('#/components/schemas/')) {
    const name = current.$ref.slice('#/components/schemas/'.length);
    if (seen.has(name)) return null;
    seen.add(name);
    current = schemas[name];
  }
  return current;
}

function retainsRequiredField(schema, fieldPath) {
  let current = resolveSchema(schema);
  for (const segment of fieldPath.split('.')) {
    if (segment === '[]') {
      current = resolveSchema(current?.items);
      if (!current) return false;
      continue;
    }
    const arrayItem = segment.endsWith('[]');
    const name = arrayItem ? segment.slice(0, -2) : segment;
    if (!current?.required?.includes(name) || !current?.properties?.[name]) return false;
    current = resolveSchema(current.properties[name]);
    if (arrayItem) current = resolveSchema(current?.items);
    if (!current) return false;
  }
  return true;
}

if (compatibilityBaseline.contractVersion !== 'v1' || compatibilityBaseline.legacyAliasesSupportedThrough !== '2027-07-21') failures.push('v1 消费者兼容基线缺少明确版本或旧路径支持期');
for (const [schemaName, fields] of Object.entries(compatibilityBaseline.requiredFields || {})) {
  if (!schemas[schemaName]) {
    failures.push(`v1 消费者兼容基线缺少 schema：${schemaName}`);
    continue;
  }
  for (const field of fields) if (!retainsRequiredField(schemas[schemaName], field)) failures.push(`v1 消费者兼容字段被删除或改为可选：${schemaName}.${field}`);
}
const responsesWithoutContent = operations.flatMap((operation) => Object.entries(operation.responses || {}).filter(([status, response]) => /^2\d\d$/.test(status) && !response?.content).map(() => operation.operationId));
if (responsesWithoutContent.length) failures.push(`OpenAPI 成功响应缺少内容 schema：${responsesWithoutContent.join(', ')}`);
const responseSchema = (name) => schemas[`${name}Response`];
if (!responseSchema('AppController_orders')?.properties?.items?.items?.properties?.orderNo || !responseSchema('AppController_orders')?.properties?.total) failures.push('订单分页响应契约缺少明细或总数');
if (!responseSchema('AppController_reportAnalytics')?.properties?.summary?.properties?.verificationRate || !responseSchema('AppController_reportAnalytics')?.properties?.alerts?.items?.properties?.severity) failures.push('经营报表响应契约缺少核销率或异常级别');
if (!responseSchema('PublicController_createOrder')?.properties?.paymentExpiresAt || !responseSchema('AppController_executeExceptionRefund')?.properties?.refund) failures.push('下单或异常退款核心响应契约不完整');
if (responseSchema('AuthController_login')?.properties?.user?.properties?.sessionVersion || responseSchema('AuthController_me')?.properties?.sessionVersion) failures.push('运营账号响应契约泄露内部会话版本');
if (responseSchema('AppController_verifications')?.properties?.items?.items?.properties?.idempotencyKey || responseSchema('AppController_verify')?.properties?.idempotencyKey) failures.push('核销响应契约泄露内部幂等键');
if (paths['/api/v1/exports/{exportJobId}/download']?.get?.responses?.['200']?.content?.['text/csv']?.schema?.type !== 'string') failures.push('导出下载响应未声明 text/csv');
if (!generatedTypes.includes('export interface paths') || !generatedTypes.includes('CreateOrderDto') || !generatedTypes.includes('SavePackageDto') || !generatedTypes.includes('AppController_reportAnalyticsResponse')) failures.push('前端 OpenAPI 请求或响应类型产物不完整');
if (!adminBridge.includes("from '@local-deals/api-contract'") || !adminBridge.includes('contractJson') || !adminBridge.includes('QueryParams') || !adminBridge.includes('contractQuery') || !adminBridge.includes('ResponseBody') || !adminBridge.includes('ResponseItem')) failures.push('管理端未接入生成的请求、查询与响应契约');
if (!workspaceModel.includes("ResponseBody<'AppController_reportAnalytics'>") || !workspaceModel.includes("ResponseItem<'AppController_vouchers'>")) failures.push('管理端关键报表和券类型未消费生成的响应契约');
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else console.log(`PASS OpenAPI 契约覆盖 ${Object.keys(paths).length} 条路由、${operations.length} 个成功响应和 ${Object.keys(schemas).length} 个 schema，管理端已消费生成类型`);
