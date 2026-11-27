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
  prices: 3 * 60 * 1000, // 3 min
  news: 15 * 60 * 1000, // 15 min
  priceCache: 3 * 60 * 1000, // persistent quote cache lifetime
  alarmFetch: 30 * 60 * 1000 // background fetch interval (alarm)
} as const;

// News freshness window
export const NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Suggestion settings (local results render at 0ms; network autocomplete debounces at 240ms)
export const SUGGESTIONS = {
  debounceMs: 240,
  maxItems: 8,
  minQueryLength: 1
} as const;

// API endpoints (verified live zero-key endpoints)
export const API_URLS = {
  alanchand: 'https://alanchand.com/',
  nobitexStats: 'https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt,btc,eth&dstCurrency=rls,usdt',
  wallexMarkets: 'https://api.wallex.ir/v1/markets',
  tgjuAjax: 'https://call1.tgju.org/ajax.json',
  binanceTickers: 'https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D',
  newsRss: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  newsConverter: 'https://api.rss2json.com/v1/api.json'
} as const;

// Search engines for the command bar
export type SearchEngineId =
  | 'google'
  | 'duckduckgo'
  | 'bing'
  | 'brave'
  | 'startpage'
  | 'perplexity'
  | 'kagi'
  | 'yandex'
  | 'custom';

export interface SearchEngineDef {
  id: Exclude<SearchEngineId, 'custom'>;
  name: string;
  urlTemplate: string;
  origin: string;
  suggestKind: 'google' | 'duckduckgo';
}

export const SEARCH_ENGINES: SearchEngineDef[] = [
  {
    id: 'google',
    name: 'Google',
    urlTemplate: 'https://www.google.com/search?q=%s',
    origin: 'https://www.google.com',
    suggestKind: 'google'
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    urlTemplate: 'https://duckduckgo.com/?q=%s',
    origin: 'https://duckduckgo.com',
    suggestKind: 'duckduckgo'
  },
  {
    id: 'brave',
    name: 'Brave',
    urlTemplate: 'https://search.brave.com/search?q=%s',
    origin: 'https://search.brave.com',
    suggestKind: 'duckduckgo'
  },
  {
    id: 'bing',
    name: 'Bing',
    urlTemplate: 'https://www.bing.com/search?q=%s',
    origin: 'https://www.bing.com',
    suggestKind: 'google'
  },
  {
    id: 'startpage',
    name: 'Startpage',
    urlTemplate: 'https://www.startpage.com/sp/search?query=%s',
    origin: 'https://www.startpage.com',
    suggestKind: 'duckduckgo'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    urlTemplate: 'https://www.perplexity.ai/search?q=%s',
    origin: 'https://www.perplexity.ai',
    suggestKind: 'google'
  },
  {
    id: 'kagi',
    name: 'Kagi',
    urlTemplate: 'https://kagi.com/search?q=%s',
    origin: 'https://kagi.com',
    suggestKind: 'duckduckgo'
  },
  {
    id: 'yandex',
    name: 'Yandex',
    urlTemplate: 'https://yandex.com/search/?text=%s',
    origin: 'https://yandex.com',
    suggestKind: 'google'
  }
];

export function getSearchEngine(
  id: SearchEngineId | undefined,
  customUrl?: string
): { id: SearchEngineId; name: string; urlTemplate: string; origin: string; suggestKind: 'google' | 'duckduckgo' } {
  if (id === 'custom' && customUrl && customUrl.trim()) {
    const raw = customUrl.trim();
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let origin = 'https://www.google.com';
    let name = 'Custom';
    try {
      const u = new URL(normalized.replace('%s', 'test'));
      origin = u.origin;
      name = u.hostname.replace(/^www\./, '');
    } catch {
      // fallback
    }
    return { id: 'custom', name, urlTemplate: normalized, origin, suggestKind: 'google' };
  }
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0];
}

export function buildSearchUrl(
  id: SearchEngineId | undefined,
  query: string,
  customUrl?: string
): string {
  const engine = getSearchEngine(id, customUrl);
  const encoded = encodeURIComponent(query);
  if (engine.urlTemplate.includes('%s')) {
    return engine.urlTemplate.replace('%s', encoded);
  }
  return `${engine.urlTemplate}${encoded}`;
}

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
    feedUrl: 'https://www.iranmonitor.org/api/events',
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

// Finance providers & assets
export type MarketProviderId = 'auto' | 'alanchand' | 'wallex' | 'tgju';
export type FinanceAssetId = 'usdt' | 'usd' | 'gold' | 'eur' | 'btc' | 'eth';
export type AssetUnit = 'toman' | 'usd';

export interface FinanceAssetDef {
  name: string;
  code: string;
  symbol: string;
  unit: AssetUnit;
  sublabel: string;
  alanchand?: string;
  tgju?: string;
  nobitex?: string;
  wallex?: string;
  binance?: string;
}

export const FINANCE_ASSETS: Record<FinanceAssetId, FinanceAssetDef> = {
  usdt: {
    name: 'Tether (24/7)',
    code: 'USDT',
    symbol: '₮',
    unit: 'toman',
    sublabel: 'USDT / Toman Live (24/7)',
    alanchand: 'x.usdt',
    nobitex: 'usdt-rls',
    wallex: 'USDTTMN'
  },
  usd: {
    name: 'US Dollar',
    code: 'USD',
    symbol: '$',
    unit: 'toman',
    sublabel: 'USD / Toman Exchange',
    alanchand: 'c.usd',
    tgju: 'price_dollar_rl'
  },
  gold: {
    name: 'Gold 18K',
    code: 'GOLD',
    symbol: '18K',
    unit: 'toman',
    sublabel: 'Gold 18K / Toman (1g)',
    alanchand: 'g.18ayar',
    tgju: 'geram18'
  },
  eur: {
    name: 'Euro',
    code: 'EUR',
    symbol: '€',
    unit: 'toman',
    sublabel: 'EUR / Toman Exchange',
    alanchand: 'c.eur',
    tgju: 'price_eur'
  },
  btc: {
    name: 'Bitcoin',
    code: 'BTC',
    symbol: '₿',
    unit: 'usd',
    sublabel: 'BTC / USD Spot',
    alanchand: 'xu.btc',
    nobitex: 'btc-usdt',
    wallex: 'BTCUSDT',
    binance: 'BTCUSDT',
    tgju: 'crypto-bitcoin'
  },
  eth: {
    name: 'Ethereum',
    code: 'ETH',
    symbol: 'Ξ',
    unit: 'usd',
    sublabel: 'ETH / USD Spot',
    alanchand: 'xu.eth',
    nobitex: 'eth-usdt',
    wallex: 'ETHUSDT',
    binance: 'ETHUSDT',
    tgju: 'crypto-ethereum'
  }
};

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
