export interface OperatorIssue {
  problemId: string;
  message: string;
  recommendation: string;
  occurredAt: string;
  method: string;
  path: string;
  status: number | 'NETWORK';
  requestId: string | null;
  apiReleaseId: string | null;
  retryAfterSeconds: number | null;
}

function safePath(path: string) {
  const [pathname, query = ''] = path.split('?');
  const names = [...new URLSearchParams(query).keys()];
  return names.length ? `${pathname}?${[...new Set(names)].map((name) => `${name}=...`).join('&')}` : pathname;
}

function retryAfterSeconds(body: unknown, header: string | null) {
  const bodyValue = body && typeof body === 'object' ? Number((body as { retryAfterSeconds?: unknown }).retryAfterSeconds) : 0;
  const headerValue = header && /^\d+$/.test(header) ? Number(header) : 0;
  const seconds = Math.max(Number.isFinite(bodyValue) ? bodyValue : 0, headerValue);
  return seconds > 0 ? Math.ceil(seconds) : null;
}

function problemId(requestId: string | null) {
  const trace = requestId?.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase();
  return `OPS-${trace || crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

function recoveryAdvice(status: number | 'NETWORK', text: string, retrySeconds: number | null) {
  if (status === 'NETWORK') return '检查当前网络后刷新页面。系统不会自动重放提交操作，未确认结果前不要重复付款、退款或核销。';
  if (text.includes('重新验证当前密码')) return '先完成右上角“身份确认”，再由本人重新发起操作。系统不会自动重放本次请求。';
  if (status === 409 || text.includes('版本')) return '当前数据可能已被他人更新。刷新当前页面核对最新状态后，再决定是否重新提交。';
  if (status === 403) return '确认当前账号职责和所选商家是否正确；不要尝试通过切换地址绕过权限。';
  if (status === 429) return `停止重复操作，等待${retrySeconds ? `约 ${retrySeconds} 秒` : '限制窗口结束'}后再由本人发起一次。`;
  if (status === 503) return '停止重复提交并刷新当前页面；若仍失败，由平台人员检查 API、数据库和 Worker 健康状态。';
  if (typeof status === 'number' && status >= 500) return '保留问题编号并联系平台技术人员；在确认服务端结果前不要重复资金或券状态操作。';
  if (status === 400) return '核对表单字段和当前业务状态，修正后再提交；若内容无误仍失败，请提供问题编号。';
  return '刷新当前页面核对最新状态后再操作；持续失败时将问题编号提供给平台技术人员。';
}

export function httpOperatorIssue(response: Response, body: unknown, path: string, method: string): OperatorIssue {
  const text = body && typeof body === 'object' && 'message' in body
    ? Array.isArray((body as { message?: unknown }).message) ? String((body as { message: unknown[] }).message.join('；')) : String((body as { message?: unknown }).message || '操作失败')
    : '操作失败';
  const requestId = response.headers.get('x-request-id');
  const retrySeconds = retryAfterSeconds(body, response.headers.get('retry-after'));
  return {
    problemId: problemId(requestId), message: `${text}${retrySeconds ? `，请 ${retrySeconds} 秒后重试` : ''}`,
    recommendation: recoveryAdvice(response.status, text, retrySeconds), occurredAt: new Date().toISOString(),
    method: method.toUpperCase(), path: safePath(path), status: response.status, requestId,
    apiReleaseId: response.headers.get('x-release-id'), retryAfterSeconds: retrySeconds,
  };
}

export function networkOperatorIssue(path: string, method: string): OperatorIssue {
  return {
    problemId: problemId(null), message: '无法连接到服务，请检查网络或稍后重试',
    recommendation: recoveryAdvice('NETWORK', '', null), occurredAt: new Date().toISOString(),
    method: method.toUpperCase(), path: safePath(path), status: 'NETWORK', requestId: null, apiReleaseId: null, retryAfterSeconds: null,
  };
}

export class OperatorRequestError extends Error {
  constructor(public readonly issue: OperatorIssue) {
    super(`${issue.message}（问题编号：${issue.problemId}）`);
    this.name = 'OperatorRequestError';
  }
}

export function operatorIssueDiagnostics(issue: OperatorIssue) {
  return [`问题编号: ${issue.problemId}`, `发生时间: ${issue.occurredAt}`, `操作: ${issue.method} ${issue.path}`, `状态: ${issue.status}`, `请求 ID: ${issue.requestId || '-'}`, `服务版本: ${issue.apiReleaseId || '-'}`, `错误: ${issue.message}`, `处理建议: ${issue.recommendation}`].join('\n');
}
