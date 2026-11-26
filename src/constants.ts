// Storage keys — single source of truth
export const STORAGE_KEYS = {
  shortcuts: 'shortcuts',
  stickyNotes: 'stickyNotes',
  settings: 'settings',
  drawerOpen: 'drawerOpen',
  notesVisible: 'notesVisible'
} as const;

// Refresh intervals (ms)
export const INTERVALS = {
  prices: 5 * 60 * 1000, // 5 min
  news: 15 * 60 * 1000, // 15 min
  priceCache: 5 * 60 * 1000, // successful parse cache lifetime
  alarmFetch: 30 * 60 * 1000 // background fetch interval (alarm)
} as const;

// News freshness window
export const NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Suggestion settings
export const SUGGESTIONS = {
  debounceMs: 160,
  maxItems: 8,
  minQueryLength: 1
} as const;

// API endpoints
export const API_URLS = {
  dollarProfile: 'https://www.tgju.org/profile/price_dollar_rl',
  goldProfile: 'https://www.tgju.org/profile/geram18',
  fallbackApi: 'https://brsapi.ir/FreeTether/latest',
  newsRss: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  newsConverter: 'https://api.rss2json.com/v1/api.json'
} as const;

export interface NewsSourceDef {
  id: string;
  name: string;
  domain: string;
  feedUrl: string;
  siteUrl: string;
}

export const NEWS_SOURCES: NewsSourceDef[] = [
  {
    id: 'bbc-world',
    name: 'BBC World',
    domain: 'bbc.com',
    feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    siteUrl: 'https://www.bbc.com/news/world'
  },
  {
    id: 'iranmonitor',
    name: 'Iran Monitor',
    domain: 'www.iranmonitor.org',
    feedUrl: 'https://news.google.com/rss/search?q=site:iranmonitor.org&hl=en-US&gl=US&ceid=US:en',
    siteUrl: 'https://www.iranmonitor.org'
  },
  {
    id: 'reuters',
    name: 'Reuters',
    domain: 'reuters.com',
    feedUrl: 'https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en',
    siteUrl: 'https://www.reuters.com/world/'
  },
  {
    id: 'aljazeera',
    name: 'Al Jazeera',
    domain: 'aljazeera.com',
    feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml',
    siteUrl: 'https://www.aljazeera.com'
  },
  {
    id: 'hackernews',
    name: 'Hacker News',
    domain: 'news.ycombinator.com',
    feedUrl: 'https://hnrss.org/frontpage',
    siteUrl: 'https://news.ycombinator.com'
  },
  {
    id: 'theverge',
    name: 'The Verge',
    domain: 'theverge.com',
    feedUrl: 'https://www.theverge.com/rss/index.xml',
    siteUrl: 'https://www.theverge.com'
  },
  {
    id: 'arstechnica',
    name: 'Ars Technica',
    domain: 'arstechnica.com',
    feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',
    siteUrl: 'https://arstechnica.com'
  }
];

export function getNewsSource(id: string | undefined): NewsSourceDef {
  return NEWS_SOURCES.find((s) => s.id === id) ?? NEWS_SOURCES[0];
}

// Finance assets — TGJU symbols + labels
export type FinanceAssetId = 'usd' | 'gold' | 'eur';

export const FINANCE_ASSETS: Record<
  FinanceAssetId,
  { name: string; code: string; symbol: string; tgju: string; brsapiName: string }
> = {
  usd: { name: 'US Dollar', code: 'USD', symbol: '$', tgju: 'price_dollar_rl', brsapiName: 'usd' },
  gold: { name: 'Gold 18K', code: 'GOLD', symbol: '18K', tgju: 'geram18', brsapiName: 'gold' },
  eur: { name: 'Euro', code: 'EUR', symbol: '€', tgju: 'price_eur', brsapiName: 'eur' }
} as const;

// Curated weather cities
export const WEATHER_CITIES = [
  { city: 'Tehran', lat: 35.6892, lon: 51.3890 },
  { city: 'London', lat: 51.5072, lon: -0.1276 },
  { city: 'New York', lat: 40.7128, lon: -74.0060 },
  { city: 'Berlin', lat: 52.5200, lon: 13.4050 },
  { city: 'Dubai', lat: 25.2048, lon: 55.2708 },
  { city: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { city: 'San Francisco', lat: 37.7749, lon: -122.4194 }
] as const;

// Starter shortcuts shown only on first launch when no shortcuts key exists yet
export const STARTER_SHORTCUTS = [
  { title: 'GitHub', url: 'https://github.com' },
  { title: 'YouTube', url: 'https://youtube.com' },
  { title: 'Wikipedia', url: 'https://en.wikipedia.org' },
  { title: 'Gmail', url: 'https://mail.google.com' }
] as const;

// Price history ring buffer — 720 points × 30min = 15 days
export const PRICE_HISTORY_MAX = 720;
export const PRICE_HISTORY_KEY = 'priceHistory';

export function hostOfUrl(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
