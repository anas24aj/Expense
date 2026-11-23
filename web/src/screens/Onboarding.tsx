import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Me } from '../api/types';
import { toMinor } from '../lib/format';
import { AmountInput, Icon, Tile } from '../ui';

const DAYS = [1, 25, 27, 28, 30];

export default function Onboarding() {
  const me = useApi<Me>('/auth/me');
  const cur = me.data?.household.base_currency || 'SAR';
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState('');
  const [payday, setPayday] = useState(27);
  const save = useWrite('PUT', '/settings');
  const nav = useNavigate();
  const done = (to = '/') => { try { localStorage.setItem('onboarded', '1'); } catch { /* private mode */ } nav(to, { replace: true }); };

  const next = async () => {
    if (step === 1 && amount) await save.mutateAsync({ salary_minor: toMinor(Number(amount), cur), salary_currency: cur, salary_day: payday });
    if (step < 2) setStep(step + 1); else done();
  };
  const slides = [
    { tile: <Tile icon="bank" color="#0a84ff" />, title: 'Start with your accounts', text: 'Add your Saudi and Indian banks, cards and loans, then bring in their history. Every expense is tagged to the account it came from.',
      body: (
        <div className="stack-sm">
          <button className="btn secondary block" onClick={() => done('/accounts')}><Icon name="bank" />Add accounts</button>
          <button className="btn secondary block" onClick={() => done('/more/import')}><Icon name="upload" />Import statements</button>
          <button className="link-btn" onClick={() => done('/more/devices')}>Or connect your phone for bank SMS</button>
        </div>
      ) },
    { tile: <Tile icon="coin" color="#30d158" />, title: 'What lands each month?', text: 'Your salary is all we need to tell you what’s free to spend.',
      body: (
        <div className="stack">
          <AmountInput value={amount} onChange={setAmount} currency={cur} label="Monthly salary" />
          <div className="stack-sm" style={{ alignItems: 'center' }}>
            <span className="caption">Paid on day</span>
            <div className="chips" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              {DAYS.map(d => <button key={d} type="button" className="chip" aria-pressed={payday === d} onClick={() => setPayday(d)}>{d === 1 ? '1st' : d}</button>)}
            </div>
          </div>
        </div>
      ) },
    { tile: <Tile icon="family" color="#ff375f" />, title: 'Bring the household in', text: 'Family can add their own cards; parents can be members without a login. A roommate who shares costs goes in too.',
      body: <button className="btn secondary block" onClick={() => done('/more/household')}><Icon name="mail" />Add family</button> },
  ];
  const s = slides[step];
  return (
    <div className="auth">
      <div className="glass glass-strong auth-card page-enter" key={step} style={{ textAlign: 'center' }}>
        <div className="between" style={{ marginBottom: 8 }}>
          <span className="caption">Step {step + 1} of 3</span>
          <button className="link-btn" onClick={() => done()}>Skip</button>
        </div>
        <div style={{ display: 'grid', placeItems: 'center', margin: '8px 0 14px', transform: 'scale(1.5)' }}>{s.tile}</div>
        <h1 style={{ fontSize: 26 }}>{s.title}</h1>
        <p className="lede">{s.text}</p>
        {s.body}
        <div className="onb-dots" style={{ marginTop: 22 }}>{slides.map((_, i) => <i key={i} className={i === step ? 'on' : ''} />)}</div>
        <button className="btn block" onClick={next} disabled={save.isPending}>{step === 2 ? 'Done' : step === 1 && !amount ? 'Later' : 'Continue'}</button>
      </div>
    </div>
  );
}
