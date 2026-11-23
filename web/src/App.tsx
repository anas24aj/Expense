import { useEffect, useLayoutEffect, useRef } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useApi } from './api/client';
import type { Me } from './api/types';
import { Boundary, Icon, PageSkeleton, useOnline } from './ui';
import { ForgotPage, JoinPage, ResetPage, SignInPage, SignUpPage } from './screens/Auth';
import Onboarding from './screens/Onboarding';
import HomePage from './screens/Home';
import ActivityPage, { ReviewPage } from './screens/Activity';
import PeoplePage from './screens/People';
import PlanPage from './screens/Plan';
import { TripPage, TripsPage } from './screens/Trips';
import { AccountPage, CoveragePage, FlowsPage } from './screens/Flows';
import { AccountsPage, AssetPage, AssetsPage, ClaudePage, DevicesPage, HouseholdPage, ImportPage, MorePage, ProfilePage, SettingsPage } from './screens/More';

// Five tabs at most (iOS and Material guidance); People lives under More.
const TABS = [
  { to: '/', label: 'Home', icon: 'home', also: [] as string[] },
  { to: '/activity', label: 'Activity', icon: 'activity', also: [] },
  { to: '/plan', label: 'Plan', icon: 'plan', also: [] },
  { to: '/assets', label: 'Assets', icon: 'building', also: [] },
  { to: '/more', label: 'More', icon: 'more', also: ['/people'] },
];
const tabOf = (path: string) => Math.max(0, TABS.findIndex((t, i) => (i === 0 ? path === '/' : [t.to, ...t.also].some(p => path.startsWith(p)))));

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const { pathname, search } = useLocation();
  const active = tabOf(pathname);
  const online = useOnline();
  // each tab reopens where you left it (its last URL, then its scroll position); tapping the current tab goes to its top
  const lastUrl = useRef<Record<number, string>>({});
  const scroll = useRef<Record<string, number>>({});
  const here = pathname + search;
  lastUrl.current[active] = here;
  const to = (i: number) => (i === active ? TABS[i].to : lastUrl.current[i] || TABS[i].to);
  const key = useRef(pathname);
  useEffect(() => {
    window.history.scrollRestoration = 'manual'; // restored below, per screen
    const save = () => { scroll.current[key.current] = window.scrollY; };
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, []);
  useLayoutEffect(() => {
    key.current = pathname; // scroll is kept per screen, not per filter
    const y = scroll.current[pathname] || 0;
    let n = 0, raf = 0;
    const go = () => { window.scrollTo(0, y); if (Math.abs(window.scrollY - y) > 2 && ++n < 30) raf = requestAnimationFrame(go); }; // wait for the list to render
    go();
    const stop = () => cancelAnimationFrame(raf);
    window.addEventListener('touchstart', stop, { once: true }); window.addEventListener('wheel', stop, { once: true });
    return () => { stop(); window.removeEventListener('touchstart', stop); window.removeEventListener('wheel', stop); };
  }, [pathname]);
  return (
    <div className="shell">
      <a href="#main" className="sr-only">Skip to content</a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><img src="/icon.svg" alt="" />Ledger</div>
        {TABS.map((t, i) => (
          <NavLink key={t.to} to={to(i)} end={t.to === '/'} aria-current={i === active ? 'page' : undefined}><Icon name={t.icon} />{t.label}</NavLink>
        ))}
        <div className="grow" />
        <div className="hh">{me.household.name}<br /><span className="footnote">{me.user.email}</span></div>
      </nav>
      {!online && <div className="offline-bar" role="status"><Icon name="wifiOff" size={16} />Offline · nothing new until you reconnect</div>}
      <main id="main" className="main"><Boundary key={pathname}>{children}</Boundary></main>
      <nav className="tabbar" aria-label="Tabs">
        <span className="lens" style={{ transform: `translateX(${active * 100}%)` }} aria-hidden />
        {TABS.map((t, i) => (
          <NavLink key={t.to} to={to(i)} end={t.to === '/'} aria-current={i === active ? 'page' : undefined}><Icon name={t.icon} />{t.label}</NavLink>
        ))}
      </nav>
    </div>
  );
}

function Redirect({ to }: { to: (id: string) => string }) {
  const { id = '' } = useParams();
  return <Navigate to={to(id)} replace />;
}

function Authed() {
  const me = useApi<Me>('/auth/me');
  const loc = useLocation();
  if (me.isLoading) return <main className="main" style={{ paddingTop: 80 }}><PageSkeleton /></main>;
  if (me.error?.status === 401 || me.error?.status === 409 || !me.data)
    return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (loc.pathname === '/welcome') return <Onboarding />;
  return (
    <Shell me={me.data}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/activity/review" element={<ReviewPage />} />
        <Route path="/people" element={<PeoplePage me={me.data} />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/more" element={<MorePage me={me.data} />} />
        <Route path="/more/accounts" element={<AccountsPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/assets/:id" element={<AssetPage />} />
        <Route path="/more/assets" element={<Navigate to="/assets" replace />} />
        <Route path="/more/assets/:id" element={<Redirect to={id => `/assets/${id}`} />} />
        <Route path="/more/import" element={<ImportPage />} />
        <Route path="/more/devices" element={<DevicesPage />} />
        <Route path="/more/claude" element={<ClaudePage />} />
        <Route path="/more/household" element={<HouseholdPage me={me.data} />} />
        <Route path="/more/profile" element={<ProfilePage me={me.data} />} />
        <Route path="/more/settings" element={<SettingsPage me={me.data} />} />
        <Route path="/more/accounts/:id" element={<AccountPage />} />
        <Route path="/more/coverage" element={<CoveragePage />} />
        <Route path="/more/flows" element={<FlowsPage />} />
        <Route path="/more/trips" element={<TripsPage />} />
        <Route path="/more/trips/:id" element={<TripPage />} />
        {/* paths the backend uses in Home alerts */}
        <Route path="/plan/lookahead" element={<Navigate to="/plan#lookahead" replace />} />
        <Route path="/plan/commitments/:id" element={<Redirect to={id => `/plan?commitment=${id}`} />} />
        <Route path="/plan/claims/:id" element={<Redirect to={id => `/people?tab=claims&claim=${id}`} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="*" element={<Authed />} />
    </Routes>
  );
}
