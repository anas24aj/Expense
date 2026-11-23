import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

/* Home Screen install: Android Chrome's beforeinstallprompt is caught at startup (it fires once, early); iPhone has no
   prompt, so the guide shows Safari's Share → Add to Home Screen. Nothing shows once the app runs installed. */
type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: PromptEvent | null = null;
const subs = new Set<() => void>();
const ping = () => subs.forEach(f => f());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as PromptEvent; ping(); });
  window.addEventListener('appinstalled', () => { deferred = null; ping(); });
}

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export function platformOf(ua = navigator.userAgent): 'ios' | 'android' | 'desktop' {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'; // iPadOS reports a Mac
  return /Android/.test(ua) ? 'android' : 'desktop';
}

export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(n => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return {
    standalone: isStandalone(),
    platform: platformOf(),
    canPrompt: !!deferred,
    /** Shows Chrome's own install dialog; true when the person accepted. */
    prompt: async () => {
      const d = deferred;
      if (!d) return false;
      deferred = null;
      await d.prompt();
      const { outcome } = await d.userChoice;
      ping();
      return outcome === 'accepted';
    },
  };
}

const KEY = 'install-banner-dismissed';
/** One-time "add to Home Screen" card. Drop it at the top of a screen; it hides itself once dismissed or installed. */
export function InstallBanner({ to = '/install' }: { to?: string }) {
  const { standalone, platform, canPrompt, prompt } = useInstall();
  const [gone, setGone] = useState(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  if (gone || standalone || (platform === 'desktop' && !canPrompt)) return null;
  const dismiss = () => { setGone(true); try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked: hidden for this visit */ } };
  return (
    <div className="glass install-banner" role="region" aria-label="Install Ledger">
      <img src="/apple-touch-icon.png" alt="" />
      <div className="body">
        <b>Put Ledger on your Home Screen</b>
        <p className="caption">Opens full screen, like an app</p>
      </div>
      {canPrompt ? <button className="btn small" onClick={async () => { if (await prompt()) dismiss(); }}>Install</button>
        : <Link className="btn small" to={to}>How</Link>}
      <button className="x" onClick={dismiss} aria-label="Dismiss"><Icon name="close" size={14} /></button>
    </div>
  );
}
