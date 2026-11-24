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

const NEVER = 'install-banner-dismissed', SEEN = 'install-banner-seen', WEEK = 7 * 864e5;
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: hidden for this visit */ } } };
/** "Add to Home Screen" card: at most once a week, never when the app runs installed, and "Don't show again" hides it for good. */
export function InstallBanner({ to = '/install' }: { to?: string }) {
  const { standalone, platform, canPrompt, prompt } = useInstall();
  const [gone, setGone] = useState(() => store.get(NEVER) === '1' || Date.now() - Number(store.get(SEEN) || 0) < WEEK);
  useEffect(() => { if (!gone && !standalone) store.set(SEEN, String(Date.now())); }, [gone, standalone]); // shown now: next in a week
  if (gone || standalone || (platform === 'desktop' && !canPrompt)) return null;
  const never = () => { setGone(true); store.set(NEVER, '1'); };
  return (
    <div className="glass install-banner" role="region" aria-label="Install Ledger">
      <img src="/apple-touch-icon.png" alt="" />
      <div className="body">
        <b>Put Ledger on your Home Screen</b>
        <p className="caption">Opens full screen, like an app · <button className="link-btn" onClick={never}>Don’t show again</button></p>
      </div>
      {canPrompt ? <button className="btn small" onClick={async () => { if (await prompt()) never(); }}>Install</button>
        : <Link className="btn small" to={to}>How</Link>}
      <button className="x" onClick={() => setGone(true)} aria-label="Not now (shows again in a week)"><Icon name="close" size={14} /></button>
    </div>
  );
}
