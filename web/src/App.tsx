import { useEffect, useLayoutEffect, useRef } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApi } from './api/client';
import type { Me } from './api/types';
import { Boundary, Icon, PageSkeleton, useOnline } from './ui';
import { ForgotPage, JoinPage, ResetPage, SignInPage, SignUpPage } from './screens/Auth';
import Onboarding from './screens/Onboarding';
import HomePage from './screens/Home';
import ActivityPage, { ReviewPage } from './screens/Activity';
import PeoplePage, { PersonPage } from './screens/People';
import PlanPage from './screens/Plan';
import MoneyPage from './screens/Money';
import MonthPage, { CategoryMonthPage, PayoffPage } from './screens/Month';
import RecurringPage from './screens/Recurring';
import WealthPage from './screens/Wealth';
import { TripPage, TripsPage } from './screens/Trips';
import { AccountPage, AccountsPage, CoveragePage } from './screens/Accounts';
import { AssetPage, ClaudePage, DevicesPage, HouseholdPage, ImportPage, MorePage, ProfilePage, SettingsPage } from './screens/More';

// Five tabs (iOS and Material guidance): Home, Activity, Recurring, Plan and Wealth (assets & liabilities). People, trips,
// More and settings open from Home (its tiles and the top-right profile button).
const TABS = [
  { to: '/', label: 'Home', icon: 'home', also: ['/more', '/people', '/trips'] },
  { to: '/activity', label: 'Activity', icon: 'activity', also: ['/month'] },
  { to: '/recurring', label: 'Recurring', icon: 'repeat', also: [] as string[] },
  { to: '/plan', label: 'Plan', icon: 'plan', also: ['/payoff'] },
  { to: '/wealth', label: 'Wealth', icon: 'chart', also: ['/accounts', '/assets', '/money'] },
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
  const nav = useNavigate();
  useEffect(() => { // old-app style links (#/people, #/trips/…) open the same screen
    const go = () => { if (location.hash.startsWith('#/')) nav(location.hash.slice(1), { replace: true }); };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [nav]);
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
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/people/:kind/:id" element={<PersonPage />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/payoff" element={<PayoffPage />} />
        <Route path="/recurring" element={<RecurringPage />} />
        <Route path="/wealth" element={<WealthPage />} />
        <Route path="/month" element={<MonthPage />} />
        <Route path="/month/:ym" element={<MonthPage />} />
        <Route path="/month/:ym/:category" element={<CategoryMonthPage />} />
        <Route path="/money" element={<MoneyPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/accounts/coverage" element={<CoveragePage />} />
        <Route path="/accounts/:id" element={<AccountPage />} />
        <Route path="/assets/:id" element={<AssetPage />} />
        <Route path="/trips" element={<TripsPage />} />
        <Route path="/trips/:id" element={<TripPage />} />
        <Route path="/more" element={<MorePage me={me.data} />} />
        <Route path="/more/import" element={<ImportPage />} />
        <Route path="/more/devices" element={<DevicesPage />} />
        <Route path="/more/claude" element={<ClaudePage />} />
        <Route path="/more/household" element={<HouseholdPage me={me.data} />} />
        <Route path="/more/profile" element={<ProfilePage me={me.data} />} />
        <Route path="/more/settings" element={<SettingsPage me={me.data} />} />
        {/* earlier paths, and the ones the backend puts in Home alerts */}
        <Route path="/assets" element={<Navigate to="/accounts" replace />} />
        <Route path="/more/assets" element={<Navigate to="/accounts" replace />} />
        <Route path="/more/assets/:id" element={<Redirect to={id => `/assets/${id}`} />} />
        <Route path="/more/accounts" element={<Navigate to="/accounts" replace />} />
        <Route path="/more/accounts/:id" element={<Redirect to={id => `/accounts/${id}`} />} />
        <Route path="/more/coverage" element={<Navigate to="/accounts/coverage" replace />} />
        <Route path="/more/flows" element={<Navigate to="/money" replace />} />
        <Route path="/more/trips" element={<Navigate to="/trips" replace />} />
        <Route path="/more/trips/:id" element={<Redirect to={id => `/trips/${id}`} />} />
        <Route path="/plan/lookahead" element={<Navigate to="/plan#lookahead" replace />} />
        <Route path="/plan/commitments/:id" element={<Redirect to={id => `/recurring?commitment=${id}`} />} />
        <Route path="/plan/claims/:id" element={<Redirect to={id => `/trips?claim=${id}`} />} />
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
