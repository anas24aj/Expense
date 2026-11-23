import { ReactNode, useState } from 'react';
import { Icon, List, ListRow, Page, Segmented, Tile, useInstall, useToast } from '../ui';

/** Step-by-step "Add to Home Screen" for iPhone Safari, and Chrome's Install button on Android. Hidden once installed. */
export default function InstallPage() {
  const { standalone, platform, canPrompt, prompt } = useInstall();
  const [os, setOs] = useState<'ios' | 'android'>(platform === 'android' ? 'android' : 'ios');
  const toast = useToast();
  if (standalone) return (
    <Page title="Install" back="/more">
      <div className="glass installed-mark">
        <Tile icon="check" color="#30d158" />
        <h3>Ledger is on your Home Screen</h3>
        <p className="muted">You’re using the installed app. Nothing else to do.</p>
      </div>
    </Page>
  );
  return (
    <Page title="Install" back="/more" subtitle="Put Ledger on your Home Screen. It opens full screen, like an app, with no App Store.">
      <Segmented label="Phone" value={os} onChange={setOs} options={[{ value: 'ios', label: 'iPhone' }, { value: 'android', label: 'Android' }]} />
      {os === 'ios' ? (
        <>
          <div className="hscroll steps-carousel" role="list" aria-label="Steps for iPhone">
            <Step n={1} title="Open in Safari, tap Share" text="The square with an arrow, in the bar at the bottom (top right on iPad).">
              <Phone><div className="bar"><Icon name="chevL" /><Icon name="chevR" /><span className="hot"><Icon name="share" /></span><Icon name="stack" /></div></Phone>
            </Step>
            <Step n={2} title="Tap Add to Home Screen" text="Scroll the list down a little if you don’t see it.">
              <Phone><div className="menu"><div>Copy<Icon name="copy" /></div><div>Add to Favourites<Icon name="heart" /></div><div className="hot">Add to Home Screen<Icon name="addSquare" /></div><div>Find on Page<Icon name="search" /></div></div></Phone>
            </Step>
            <Step n={3} title="Tap Add" text="Keep the name Ledger, or change it.">
              <Phone><div className="add-head"><span>Cancel</span><span>Add to Home Screen</span><b className="hot">Add</b></div><div className="add-card"><img src="/apple-touch-icon.png" alt="" />Ledger</div></Phone>
            </Step>
            <Step n={4} title="Open Ledger from your Home Screen" text="Sign in once. It stays signed in, full screen.">
              <Phone><div className="home">{[...Array(6)].map((_, i) => <i key={i} />)}<span className="hot"><img src="/apple-touch-icon.png" alt="Ledger icon" /></span>{[...Array(5)].map((_, i) => <i key={i} />)}</div></Phone>
            </Step>
          </div>
          <p className="footnote" style={{ margin: '0 4px' }}>Swipe for the next step. In Chrome on iPhone, the Share button is at the top right; the rest is the same.</p>
        </>
      ) : (
        <>
          {canPrompt && (
            <div className="glass card stack-sm" style={{ alignItems: 'center', textAlign: 'center' }}>
              <img src="/apple-touch-icon.png" alt="" width={64} height={64} style={{ borderRadius: 15 }} />
              <b>Install Ledger</b>
              <button className="btn block" onClick={async () => { if (await prompt()) toast('Ledger installed'); }}><Icon name="download" />Install</button>
            </div>
          )}
          <List>
            <ListRow icon={<Tile icon="globe" color="#34c759" />} title="Open this page in Chrome" sub="Samsung Internet works the same way" chevron={false} />
            <ListRow icon={<Tile icon="more" color="#5e5ce6" />} title="Tap ⋮ at the top right" sub="The three-dot menu" chevron={false} />
            <ListRow icon={<Tile icon="download" color="#0a84ff" />} title="Tap Install app" sub="Or Add to Home screen, then Install" chevron={false} />
          </List>
        </>
      )}
      <p className="footnote" style={{ margin: '0 4px' }}>Your money data isn’t stored on the phone: the app loads it fresh each time you open it.</p>
    </Page>
  );
}

const Step = ({ n, title, text, children }: { n: number; title: string; text: string; children: ReactNode }) => (
  <div className="glass" role="listitem" aria-label={`Step ${n}: ${title}`}>
    {children}
    <span className="step-n">{n}</span>
    <b>{title}</b>
    <p className="caption">{text}</p>
  </div>
);
const Phone = ({ children }: { children: ReactNode }) => <div className="phone" aria-hidden><div className="scr">{children}</div></div>;
