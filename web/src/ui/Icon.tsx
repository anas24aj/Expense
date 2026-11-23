// Stroke icons in the spirit of SF Symbols (24px grid, 1.8 stroke, round caps).
import { useState } from 'react';
const P: Record<string, string> = {
  home: 'M3.5 10.5 12 3.8l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z',
  activity: 'M4 6.5h16M4 12h16M4 17.5h10',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-6 9c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.7 3 2.6 3 5.2',
  plan: 'M4 19.5V10m5.3 9.5V5m5.4 14.5v-7m5.3 7V8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  wifiOff: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.4-1.8M2 9.3a15 15 0 0 1 4.3-2.8M22 9.3A15 15 0 0 0 11 5.1M12 20h.01',
  plus: 'M12 5v14M5 12h14',
  share: 'M12 3.5v11M8 7.2l4-3.7 4 3.7M8.5 10.5H7A1.5 1.5 0 0 0 5.5 12v7A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5',
  addSquare: 'M6 3.5h12A2.5 2.5 0 0 1 20.5 6v12a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5zM12 8v8M8 12h8',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17.5 19 7',
  chevR: 'M9 5l7 7-7 7',
  chevL: 'M15 5l-7 7 7 7',
  chevD: 'M5 9l7 7 7-7',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8',
  split: 'M7 4v5a5 5 0 0 0 5 5 5 5 0 0 1 5 5v1M17 4v5a5 5 0 0 1-2 4M4 7l3-3 3 3M14 7l3-3 3 3',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8.5c0-3.6 3.1-6 7-6s7 2.4 7 6',
  briefcase: 'M4 8h16v11H4zM9 8V5.5h6V8M4 13h16',
  transfer: 'M4 8h14l-3.5-3.5M20 16H6l3.5 3.5',
  tag: 'M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0zM8 8h.01',
  eyeOff: 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9 6-.3.8-1.2 2.3-2.6 3.6M6.6 7.5C4.6 8.8 3.4 10.8 3 12c.5 1.5 4 6 9 6 1.5 0 2.8-.4 4-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  note: 'M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5',
  bank: 'M3.5 9.5 12 4.5l8.5 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20h17',
  card: 'M3 6.5h18v11H3zM3 10.5h18M6.5 14.5h4',
  wallet: 'M4 7.5V18a1.5 1.5 0 0 0 1.5 1.5h14V9h-14A1.5 1.5 0 0 1 4 7.5 1.5 1.5 0 0 1 5.5 6H17M16 14.3h.01',
  building: 'M5 20.5V4.5h9v16M14 9.5h5v11M3.5 20.5h17M8 8h3M8 11.5h3M8 15h3',
  car: 'M5 16.5h14M4 16.5V13l2-5h12l2 5v3.5M4 16.5V19h3v-2.5M17 16.5V19h3v-2.5M7.5 13h.01M16.5 13h.01',
  chart: 'M4 19.5h16M7 16l3.5-4 3 2.5L19 8',
  upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4.5',
  phone: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2',
  sparkle: 'M12 3.5c.6 4.2 2.3 6 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.5 5.9-2.3 6.5-6.5zM18.5 15.5c.3 1.7 1 2.4 2.5 2.7-1.5.3-2.2 1-2.5 2.6-.3-1.6-1-2.3-2.5-2.6 1.5-.3 2.2-1 2.5-2.7z',
  house: 'M4 20.5v-9l8-6.5 8 6.5v9M9.5 20.5v-6h5v6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.4 7.4 0 0 1-2.2 1.3l-.3 2h-4l-.3-2a7.4 7.4 0 0 1-2.2-1.3l-1.9.7-2-3.4 1.6-1.2a7.6 7.6 0 0 1 0-3L2.2 9.3l2-3.4 1.9.7a7.4 7.4 0 0 1 2.2-1.3l.3-2h4l.3 2a7.4 7.4 0 0 1 2.2 1.3l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 0 1 0 3z',
  key: 'M14.5 13a4.5 4.5 0 1 0-4.3-3.2L3.5 16.5V20h3.5v-2h2v-2h2l1.2-1.2A4.5 4.5 0 0 0 14.5 13zM16 8.5h.01',
  logout: 'M14 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h8M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5',
  copy: 'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  bell: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  warn: 'M12 4 21 19.5H3zM12 10v4M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  calendar: 'M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4',
  repeat: 'M17 3.5 20 6.5l-3 3M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5 4 17.5l3-3M20 12.5v1a4 4 0 0 1-4 4H4',
  heart: 'M12 20s-8-4.6-8-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 8 2.5C20 15.4 12 20 12 20z',
  shield: 'M12 3.5 19.5 6v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z',
  school: 'M2.5 9 12 4.5 21.5 9 12 13.5zM6.5 11v5c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-5M21.5 9v5',
  bolt: 'M13 3 5 13.5h6.5L11 21l8-10.5h-6.5z',
  tv: 'M3.5 6h17v11h-17zM8 20.5h8',
  receipt: 'M6 3.5h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5zM9 8h6M9 12h6M9 16h3',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  mail: 'M3.5 6h17v12h-17zM3.5 7l8.5 6.5L20.5 7',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13',
  filter: 'M4 6h16M7 12h10M10 18h4',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM14.8 9.2c-.6-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.9-2.8 2.1 0 2.9 5.6 1.4 5.6 4.3 0 1.2-1.2 2.1-2.8 2.1-1.2 0-2.3-.6-2.9-1.5M12 6v1.8M12 16.3V18',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
  stack: 'M12 3.5 21 8l-9 4.5L3 8zM3 12.5l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  fuel: 'M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5v15.5M3.5 20.5h12M5 10h9M14 8l3 2.5V17a1.5 1.5 0 0 0 3 0V8.5L17.5 6',
  cart: 'M3 4h2.5l2.2 10.5h10.5L20.5 7H6.5M9 19.5h.01M17 19.5h.01',
  fork: 'M7 3.5v6a2 2 0 0 0 4 0v-6M9 9.5v11M16.5 20.5v-17c-2 1-3 3.5-3 7h3',
  bag: 'M5 8h14l-1 12.5H6zM9 8V6.5a3 3 0 0 1 6 0V8',
  plane: 'M10.5 13.5 3 11l1.5-1.5 7.5 1L16.5 6c1-1 2.5-1.5 3-1 .5.5 0 2-1 3l-4.5 4.5 1 7.5L13.5 21 11 13.5',
  pill: 'M10.5 20.5a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 7zM7 10l7 7',
  family: 'M7 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c0-2.5 1.8-4 4-4s4 1.5 4 4v6.5H3zM13 14c0-2.5 1.8-4 4-4s4 1.5 4 4v6.5h-8z',
  bubble: 'M4 5.5h16v10.5H9l-5 4z',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
};

export function Icon({ name, size, className, title }: { name: keyof typeof P | string; size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size ?? 22} height={size ?? 22} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] || P.info} />
    </svg>
  );
}

const CAT: Record<string, [string, string]> = {
  Groceries: ['cart', '#34c759'], Dining: ['fork', '#ff9500'], Fuel: ['fuel', '#ff6b35'], Transport: ['car', '#5ac8fa'], Shopping: ['bag', '#ff2d55'],
  Rent: ['house', '#5856d6'], Utilities: ['bolt', '#ffcc00'], Subscriptions: ['tv', '#af52de'], Family: ['heart', '#ff375f'], Health: ['pill', '#30b0c7'],
  Education: ['school', '#007aff'], Travel: ['plane', '#32ade6'], 'Fees & interest': ['receipt', '#8e8e93'], 'Loan EMI': ['bank', '#5e5ce6'],
  Salary: ['coin', '#30d158'], Transfer: ['transfer', '#8e8e93'], Transfers: ['transfer', '#8e8e93'], 'Own transfer': ['transfer', '#8e8e93'],
  Food: ['fork', '#ff9500'], 'Bills & Utilities': ['bolt', '#ffcc00'], 'Telecom & Internet': ['phone', '#30b0c7'], 'Rent & EMI': ['house', '#5856d6'],
  'Personal care': ['sparkle', '#ff6482'], 'Government & fees': ['receipt', '#636366'], Insurance: ['shield', '#30b0c7'], Investments: ['chart', '#30d158'],
  Cash: ['coin', '#34c759'], Charity: ['heart', '#ff2d55'], Other: ['tag', '#8e8e93'], Income: ['coin', '#30d158'], Uncategorized: ['tag', '#8e8e93'], Home: ['house', '#a2845e'], Entertainment: ['tv', '#bf5af2'], Ignored: ['eyeOff', '#8e8e93'],
};
const PURPOSE_ICON: Record<string, [string, string]> = {
  transfer: ['transfer', '#8e8e93'], income: ['coin', '#30d158'], lend: ['person', '#ff9f0a'], repaid: ['person', '#30d158'], claim: ['briefcase', '#0a84ff'],
  reimbursement: ['briefcase', '#30d158'], asset: ['building', '#a2845e'], saving: ['target', '#30d158'], loan_payment: ['bank', '#5e5ce6'], support: ['heart', '#ff375f'],
};

/** A colored rounded-square symbol, like Settings.app rows. */
export function Tile({ icon, color }: { icon: string; color: string }) {
  return <span className="icon-tile" style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${color} 82%, white), ${color})` }}><Icon name={icon} /></span>;
}
// Well-known merchants get a brand-colored monogram tile; the real logo comes through our own /api/logo, so no third party sees your brands.
// [pattern, label, background, text color]
const BRANDS: [RegExp, string, string, string][] = [
  [/netflix/i, 'N', '#000', '#e50914'], [/youtube/i, '▶', '#ff0000', '#fff'], [/google ?play/i, '▶', '#fff', '#01875f'], [/google/i, 'G', '#fff', '#4285f4'],
  [/apple|itunes|icloud/i, '', '#000', '#fff'], [/spotify/i, '♫', '#1db954', '#000'], [/amazon|amzn/i, 'a', '#232f3e', '#ff9900'],
  [/shahid/i, 'S', '#00a95c', '#fff'], [/osn/i, 'OSN', '#000', '#fff'], [/disney|hotstar/i, 'D+', '#0e3a8c', '#fff'], [/anghami/i, 'A', '#8d1ee8', '#fff'],
  [/openai|chatgpt/i, 'AI', '#10a37f', '#fff'], [/anthropic|claude/i, 'A', '#d97757', '#fff'], [/microsoft|office 365|xbox/i, '⊞', '#fff', '#00a4ef'],
  [/\bstc\b|stc pay|stc bank/i, 'stc', '#4f008c', '#fff'], [/mobily/i, 'M', '#00a3e0', '#fff'], [/\bzain\b/i, 'Z', '#000', '#00b5a7'],
  [/ooredoo/i, 'O', '#ed1c24', '#fff'], [/\bjio\b/i, 'Jio', '#0f3cc9', '#fff'], [/airtel/i, 'a', '#e40000', '#fff'], [/asianet/i, 'A', '#e30613', '#fff'],
  [/careem/i, 'C', '#00e784', '#000'], [/\buber\b/i, 'U', '#000', '#fff'], [/jahez/i, 'J', '#e4002b', '#fff'], [/hunger ?station/i, 'H', '#ffcc00', '#000'],
  [/keeta/i, 'K', '#ffd100', '#000'], [/talabat/i, 't', '#ff5a00', '#fff'], [/snoonu/i, 'S', '#e30c17', '#fff'], [/\bnoon\b/i, 'n', '#feee00', '#000'],
  [/zomato/i, 'z', '#e23744', '#fff'], [/swiggy/i, 'S', '#fc8019', '#fff'], [/starbucks/i, '★', '#00704a', '#fff'], [/mcdonald/i, 'M', '#da291c', '#ffc72c'],
  [/\bkfc\b/i, 'KFC', '#a3080c', '#fff'], [/bazooka/i, 'B', '#d71920', '#fff'], [/carrefour/i, 'C', '#004e9f', '#fff'], [/lulu/i, 'L', '#00843d', '#fff'],
  [/panda/i, 'P', '#00a651', '#fff'], [/danube/i, 'D', '#e30613', '#fff'], [/tamimi/i, 'T', '#e31b23', '#fff'], [/ikea/i, 'IKEA', '#0058a3', '#ffdb00'],
  [/xiaomi|\bmi store/i, 'mi', '#ff6900', '#fff'], [/jarir/i, 'J', '#e31e24', '#fff'], [/tamara/i, 't', '#000', '#f5c2a8'], [/tabby/i, 't', '#3bffc1', '#000'],
  [/saudia/i, 'S', '#006c35', '#fff'], [/flynas/i, 'nas', '#00244e', '#fff'], [/air ?india ?express/i, 'IX', '#e31837', '#fff'], [/qatar airways/i, 'QR', '#5c0632', '#fff'],
  [/phonepe/i, 'Pe', '#5f259f', '#fff'], [/paytm/i, 'P', '#00baf2', '#fff'], [/al ?rajhi/i, 'R', '#0d3b8f', '#fff'], [/urpay/i, 'ur', '#00b1a9', '#fff'],
  [/sab|saudi british|saudi awwal/i, 'SAB', '#e30613', '#fff'], [/hdfc/i, 'H', '#004c8f', '#fff'], [/canara/i, 'C', '#0091d5', '#ffcc00'],
  [/federal/i, 'F', '#1a3d8f', '#f7b500'], [/sbi ?card/i, 'SBI', '#1a4b8c', '#fff'], [/sbi|state bank/i, 'SBI', '#22409a', '#fff'],
  [/axis/i, 'A', '#97144d', '#fff'], [/tiqmo/i, 't', '#6c2bd9', '#fff'], [/one ?card/i, '1', '#111', '#fff'], [/barq/i, 'B', '#0a1f44', '#fff'],
  [/nissan|patrol/i, 'N', '#c3002f', '#fff'], [/shriram/i, 'SP', '#7a1f2b', '#fff'],
];
/** Brand → its website, for the real logo (favicon). The monogram above stays underneath as the fallback.
 * The server serves only these domains: keep api/logo.py DOMAINS in step (tests/test_v3_logo.py checks). */
const DOMAINS: [RegExp, string][] = [
  [/netflix/i, 'netflix.com'], [/youtube/i, 'youtube.com'], [/google ?play/i, 'play.google.com'], [/google/i, 'google.com'], [/apple|itunes|icloud/i, 'apple.com'],
  [/spotify/i, 'spotify.com'], [/amazon|amzn/i, 'amazon.com'], [/shahid/i, 'shahid.mbc.net'], [/disney|hotstar/i, 'hotstar.com'], [/anghami/i, 'anghami.com'],
  [/openai|chatgpt/i, 'openai.com'], [/anthropic|claude/i, 'anthropic.com'], [/microsoft|office 365|xbox/i, 'microsoft.com'], [/stc bank/i, 'stcbank.com.sa'],
  [/\bstc\b|stc pay/i, 'stc.com.sa'], [/mobily/i, 'mobily.com.sa'], [/\bzain\b/i, 'sa.zain.com'], [/ooredoo/i, 'ooredoo.qa'], [/\bjio\b/i, 'jio.com'],
  [/airtel/i, 'airtel.in'], [/careem/i, 'careem.com'], [/\buber\b/i, 'uber.com'], [/jahez/i, 'jahez.net'], [/hunger ?station/i, 'hungerstation.com'],
  [/talabat/i, 'talabat.com'], [/snoonu/i, 'snoonu.com'], [/\bnoon\b/i, 'noon.com'], [/zomato/i, 'zomato.com'], [/swiggy/i, 'swiggy.com'],
  [/starbucks/i, 'starbucks.com'], [/mcdonald/i, 'mcdonalds.com'], [/\bkfc\b/i, 'kfc.com'], [/carrefour/i, 'carrefourksa.com'], [/lulu/i, 'luluhypermarket.com'],
  [/panda/i, 'panda.com.sa'], [/danube/i, 'danube.sa'], [/tamimi/i, 'tamimimarkets.com'], [/ikea/i, 'ikea.com'], [/xiaomi|\bmi store/i, 'mi.com'],
  [/jarir/i, 'jarir.com'], [/tamara/i, 'tamara.co'], [/tabby/i, 'tabby.ai'], [/saudia/i, 'saudia.com'], [/flynas/i, 'flynas.com'],
  [/air ?india ?express/i, 'airindiaexpress.com'], [/qatar airways/i, 'qatarairways.com'], [/phonepe/i, 'phonepe.com'], [/paytm/i, 'paytm.com'],
  [/al ?rajhi/i, 'alrajhibank.com.sa'], [/urpay/i, 'urpay.com.sa'], [/\bsab\b|saudi british|saudi awwal/i, 'sab.com'], [/hdfc/i, 'hdfcbank.com'],
  [/canara/i, 'canarabank.com'], [/federal/i, 'federalbank.co.in'], [/sbi ?card/i, 'sbicard.com'], [/\bsbi\b|state bank/i, 'sbi.co.in'], [/axis/i, 'axisbank.com'],
  [/tiqmo/i, 'tiqmo.com'], [/one ?card/i, 'getonecard.app'], [/nissan|patrol/i, 'nissan-global.com'], [/shriram/i, 'shriramproperties.com'],
];
export function logoOf(name?: string | null) {
  const d = name && DOMAINS.find(([rx]) => rx.test(name));
  return d ? `/api/logo/${d[1]}` : undefined;
}
/** A brand tile: the real logo when it loads, its monogram underneath otherwise. */
export function BrandTile({ name, size }: { name: string; size?: number }) {
  const b = brandOf(name), logo = logoOf(name);
  const [label, bg, fg] = b ? [b[1], b[2], b[3]] : [name.slice(0, 1).toUpperCase(), '#8e8e93', '#fff'];
  const box = size ? { width: size, height: size, borderRadius: size * .26 } : {};
  return (
    <span className="icon-tile brand-tile" aria-hidden style={{ background: bg, color: fg, fontSize: label.length > 2 ? 10 : 17, position: 'relative', overflow: 'hidden', ...box }}>
      {label}
      {logo && <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#fff', padding: '14%' }} />}
    </span>
  );
}
export function brandOf(merchant?: string | null) {
  return merchant ? BRANDS.find(([rx]) => rx.test(merchant)) : undefined;
}
export function CategoryTile({ category, purpose, merchant }: { category: string | null; purpose?: string; merchant?: string | null }) {
  if (!purpose && merchant && (brandOf(merchant) || logoOf(merchant))) return <BrandTile name={merchant} />;
  const [icon, color] = (purpose && PURPOSE_ICON[purpose]) || (category && CAT[category]) || ['tag', '#8e8e93'];
  return <Tile icon={icon} color={color} />;
}
export function Avatar({ name, size = 40, photo }: { name: string; size?: number; photo?: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);  // a photo that fails to load falls back to initials
  if (photo && broken !== photo) return <img className="avatar" src={photo} alt="" aria-hidden onError={() => setBroken(photo)} style={{ width: size, height: size, objectFit: 'cover' }} />;
  const hues = [211, 262, 340, 28, 145, 190, 300];
  const h = hues[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % hues.length];
  const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return <span className="avatar" aria-hidden style={{ width: size, height: size, fontSize: size * .38, background: `linear-gradient(160deg, hsl(${h} 80% 66%), hsl(${h} 70% 48%))` }}>{initials}</span>;
}
