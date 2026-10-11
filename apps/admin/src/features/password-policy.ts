export const PASSWORD_POLICY_HELP = '至少 10 位，且需包含大写字母、小写字母、数字、符号中的至少三类。';

function passwordPolicyError(value: unknown): string | null {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 10 || password.length > 512) return '密码长度需为 10 至 512 位';
  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
  return categories < 3 ? PASSWORD_POLICY_HELP : null;
}

export function validateRequiredPassword(_: unknown, value: unknown) {
  const error = passwordPolicyError(value);
  return error ? Promise.reject(new Error(error)) : Promise.resolve();
}

export function validateOptionalPassword(_: unknown, value: unknown) {
  if (value === undefined || value === null || value === '') return Promise.resolve();
  return validateRequiredPassword(_, value);
}
