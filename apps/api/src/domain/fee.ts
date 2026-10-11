export function calculateServiceFeeFen(verifiedAmountFen: number, rate: string | number): number {
  if (!Number.isSafeInteger(verifiedAmountFen) || verifiedAmountFen < 0) throw new Error('核销金额必须是非负安全整数分');
  const rateText = String(rate).trim();
  const match = /^(0|1)(?:\.(\d{1,4}))?$/.exec(rateText);
  if (!match) throw new Error('服务费率必须是 0 至 1 之间且最多四位小数');
  const basisPoints = Number(match[1]) * 10_000 + Number((match[2] || '').padEnd(4, '0'));
  if (basisPoints > 10_000) throw new Error('服务费率不能超过 1');
  const fee = (BigInt(verifiedAmountFen) * BigInt(basisPoints) + 5_000n) / 10_000n;
  const result = Number(fee);
  if (!Number.isSafeInteger(result)) throw new Error('服务费金额超出安全整数范围');
  return result;
}
