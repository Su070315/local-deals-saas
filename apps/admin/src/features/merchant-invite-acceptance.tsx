import React, { useState } from 'react';
import { API } from './workspace-runtime';

export default function MerchantInviteAcceptance({ token, onComplete }: { token: string; onComplete: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) { setError('两次输入的密码不一致'); return; }
    setError(''); setSubmitting(true);
    try {
      const response = await fetch(`${API}/auth/merchant-admin-invites/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const value = body && typeof body === 'object' ? (body as { message?: unknown }).message : null;
        throw new Error(Array.isArray(value) ? value.join('；') : typeof value === 'string' ? value : '邀请已失效或无法使用');
      }
      setAccepted(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '邀请处理失败，请联系运营人员'); }
    finally { setSubmitting(false); }
  }

  return <main className="login"><section className="login-card login-native-card" aria-labelledby="invite-title"><div className="login-brand"><span className="brand-mark" aria-hidden="true">团</span><div><h1 id="invite-title">设置商家管理员密码</h1><p>邻里券多商家团购</p></div></div>{accepted ? <><p role="status">管理员账号已开通，请使用邀请邮件中的账号返回登录。</p><button className="workspace-primary-button login-submit" type="button" onClick={onComplete}>返回登录</button></> : <form onSubmit={submit} noValidate><label htmlFor="invite-password">登录密码</label><input id="invite-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} maxLength={512} required disabled={submitting} /><label htmlFor="invite-confirmation">再次输入密码</label><input id="invite-confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={10} maxLength={512} required disabled={submitting} />{error && <p className="login-error" role="alert">{error}</p>}<button className="workspace-primary-button login-submit" type="submit" disabled={submitting}>{submitting ? '正在开通…' : '开通管理员账号'}</button></form>}</section></main>;
}
