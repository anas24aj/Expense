import { FormEvent, ReactNode, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, useApi } from '../api/client';
import type { Me } from '../api/types';
import { Avatar, Field, Icon } from '../ui';

function AuthCard({ title, lede, children, foot }: { title: string; lede?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="auth page-enter">
      <div className="stack" style={{ width: '100%', maxWidth: 420 }}>
        <div className="glass glass-strong auth-card">
          <img className="auth-logo" src="/icon.svg" alt="" />
          <h1>{title}</h1>
          {lede && <p className="lede">{lede}</p>}
          {children}
        </div>
        {foot && <p className="caption" style={{ textAlign: 'center' }}>{foot}</p>}
      </div>
    </div>
  );
}

/** Submit helper: busy flag + human error from the API. */
function useSubmit(fn: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'No connection. Try again.'); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

export function SignInPage() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/login', { method: 'POST', body: { login, password, invite: params.get('invite') || undefined } });
    qc.clear();
    nav(params.get('next') || '/', { replace: true });
  });
  return (
    <AuthCard title={params.get('invite') ? 'Sign in to join' : 'Welcome back'} lede={params.get('invite') ? 'Your account joins the family as soon as you sign in.' : 'Your family’s money, in riyals and rupees.'} foot={<>New here? <Link to="/signup">Create an account</Link></>}>
      <form className="stack" onSubmit={submit}>
        <Field label="Email or username"><input className="input" autoComplete="username" value={login} onChange={e => setLogin(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></Field>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <Link to="/forgot" className="link-btn" style={{ textAlign: 'center', display: 'block', lineHeight: '44px' }}>Forgot password?</Link>
      </form>
    </AuthCard>
  );
}

function SignUpForm({ invite, email: presetEmail }: { invite?: string; email?: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState(presetEmail || '');
  const [password, setPassword] = useState('');
  const nav = useNavigate();
  const qc = useQueryClient();
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/signup', { method: 'POST', body: { name, email, password, invite } });
    qc.clear();
    nav(invite ? '/' : '/welcome', { replace: true });
  });
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Your name"><input className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></Field>
      <Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
      <Field label="Password"><input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required placeholder="At least 8 characters" /></Field>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn block" disabled={busy}>{busy ? 'Creating…' : invite ? 'Join the family' : 'Create account'}</button>
    </form>
  );
}

export function SignUpPage() {
  const [p] = useSearchParams();
  return (
    <AuthCard title="Create your account" lede="Two minutes. No bank passwords, ever." foot={<>Already have one? <Link to="/signin">Sign in</Link></>}>
      <SignUpForm invite={p.get('invite') || undefined} />
    </AuthCard>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, submit } = useSubmit(async () => { await api('/auth/forgot', { method: 'POST', body: { email } }); setSent(true); });
  if (sent) return (
    <AuthCard title="Check your email" lede={<>If <b>{email}</b> has an account, a reset link is on its way. It works for 30 minutes.</>} foot={<Link to="/signin">Back to sign in</Link>}>
      <p className="caption" style={{ textAlign: 'center' }}>No email? Ask the household owner — they can see your link in Household.</p>
    </AuthCard>
  );
  return (
    <AuthCard title="Forgot password" lede="We’ll email you a link to set a new one." foot={<Link to="/signin">Back to sign in</Link>}>
      <form className="stack" onSubmit={submit}>
        <Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></Field>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn block" disabled={busy}>Send link</button>
      </form>
    </AuthCard>
  );
}

export function ResetPage() {
  const [p] = useSearchParams();
  const token = p.get('token') || '';
  const [password, setPassword] = useState('');
  const nav = useNavigate();
  const qc = useQueryClient();
  const { busy, error, submit } = useSubmit(async () => { await api('/auth/reset', { method: 'POST', body: { token, password } }); qc.clear(); nav('/', { replace: true }); });
  if (!token) return <AuthCard title="Link incomplete" lede="Open the link from your email again, or ask for a new one." foot={<Link to="/forgot">Get a new link</Link>}><span /></AuthCard>;
  return (
    <AuthCard title="Set a new password" lede="You’ll be signed in right after.">
      <form className="stack" onSubmit={submit}>
        <Field label="New password"><input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required autoFocus /></Field>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn block" disabled={busy}>Save and sign in</button>
      </form>
    </AuthCard>
  );
}

export function JoinPage() {
  const [p] = useSearchParams();
  const t = p.get('t') || '';
  const preview = useApi<{ household_name: string; invited_by: string; email: string | null }>(t ? `/invites/${encodeURIComponent(t)}/preview` : null);
  const me = useApi<Me>('/auth/me');
  if (preview.isLoading) return <AuthCard title="Opening invite…"><span /></AuthCard>;
  if (!t || preview.error) return <AuthCard title="Invite not found" lede="It may have expired or been used. Ask for a new one." foot={<Link to="/signin">Sign in</Link>}><span /></AuthCard>;
  const v = preview.data!;
  return (
    <AuthCard title={`Join ${v.household_name}`} lede={<><b>{v.invited_by}</b> invited you to share the family’s money — bills, splits and plans.</>}
      foot={me.data ? undefined : <>Have an account? <Link to={`/signin?invite=${encodeURIComponent(t)}`}>Sign in to accept</Link></>}>
      <div className="row-flex" style={{ justifyContent: 'center', marginBottom: 18 }}>
        <Avatar name={v.invited_by} size={44} /><Icon name="link" size={20} className="muted" /><span className="icon-tile" style={{ width: 44, height: 44, background: 'linear-gradient(160deg,#5ac8fa,#0a84ff)' }}><Icon name="family" /></span>
      </div>
      {me.data ? (
        <div className="stack">
          <p className="caption" style={{ textAlign: 'center' }}>Signed in as {me.data.user.email}. Confirm with your password to join.</p>
          <Link className="btn block" to={`/signin?invite=${encodeURIComponent(t)}`}>Accept invite</Link>
        </div>
      ) : <SignUpForm invite={t} email={v.email || undefined} />}
    </AuthCard>
  );
}
