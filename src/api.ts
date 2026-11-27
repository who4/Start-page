import {
  API_URLS,
  FINANCE_ASSETS,
  getNewsSource,
  hostOfUrl,
  INTERVALS,
  type AssetUnit,
  type FinanceAssetId,
  type MarketProviderId
} from './constants';
import type { NewsSettings } from './types';

// Toman assets carry Rial-formatted `price` (for backwards compatibility with
// existing history/currency conversion) plus normalized `numericValue` (in Toman
// for Toman assets, or USD for crypto spot assets).

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function normalizeDigits(text: string): string {
  // Includes U+066C (Arabic thousands separator ٬) mapped to ASCII comma.
  return text.replace(/[۰-۹٠-٩٬]/g, (ch) => {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p !== -1) return String(p);
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a !== -1) return String(a);
    return ',';
  });
}

function toPositiveNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const cleaned = normalizeDigits(raw).replace(/,/g, '').replace(/[^\d.]/g, '');
    const n = parseFloat(cleaned);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export interface PriceData {
  price: string;
  numericValue?: number;
  unit: AssetUnit;
  trend: 'up' | 'down' | 'flat';
  changePercent?: number;
  source?: string;
}

export interface RssFeedItem {
  title: string;
  link: string;
  pubDate: number;
  description?: string;
}

export interface NewsArticle {
  title: string;
  url: string;
  sourceName: string;
  sourceDomain: string;
  matchedKeyword?: string;
  noKeywordMatch?: boolean;
}

// api.tgju.org summary-table-data?length=1 → newest daily OHLC row.
type TgjuRow = [string, string, string, string, string, string, string, string];
interface TgjuSummaryResponse {
  data?: TgjuRow[];
}

interface TgjuAjaxItem {
  p?: string;
  dp?: number | string;
  dt?: string;
}

interface NobitexStat {
  latest?: string;
  dayChange?: string;
}

interface WallexSymbol {
  stats?: {
    lastPrice?: string;
    '24h_ch'?: number | string;
  };
}

interface BinanceTicker {
  symbol?: string;
  lastPrice?: string;
  priceChangePercent?: string;
}

interface CachedPrice {
  value: PriceData;
  timestamp: number;
}

function parseDateSafe(raw: string | null | undefined): number {
  if (!raw) return 0;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  let normalized = raw.trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) normalized += 'Z';
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanHeadline(raw: string, sourceName?: string): string {
  const txt = raw.replace(/\s+/g, ' ').trim();
  if (!sourceName) return txt;
  const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return txt.replace(new RegExp(`\\s*[-–|]\\s*${escaped}$`, 'i'), '').trim() || txt;
}

function stripHtmlTags(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface IranMonitorEvent {
  id?: string;
  title?: string;
  summary?: string;
  event_timestamp?: string;
  category?: string;
  tags?: string[];
  source_urls?: string[];
  source_details?: Array<{ url?: string; display_name?: string }>;
}

function parseJsonFeed(rawText: string, feedUrl: string): { title: string; items: RssFeedItem[] } | null {
  const trimmed = rawText.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { data?: IranMonitorEvent[] } | IranMonitorEvent[];
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
    if (rows.length === 0) return null;

    const fallbackUrl = feedUrl.includes('iranmonitor.org')
      ? 'https://www.iranmonitor.org'
      : feedUrl;

    const items: RssFeedItem[] = [];
    for (const ev of rows) {
      const title = typeof ev.title === 'string' ? ev.title.trim() : '';
      if (!title) continue;
      const link =
        ev.source_urls?.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) ||
        ev.source_details?.find((s) => typeof s.url === 'string' && /^https?:\/\//i.test(s.url))?.url ||
        fallbackUrl;
      const metaParts = [
        ev.summary || '',
        ev.category || '',
        ...(Array.isArray(ev.tags) ? ev.tags : [])
      ].filter(Boolean);
      items.push({
        title,
        link,
        pubDate: parseDateSafe(ev.event_timestamp),
        description: metaParts.join(' ')
      });
    }

    return items.length > 0 ? { title: 'Iran Monitor', items } : null;
  } catch {
    return null;
  }
}

function parseRssXml(xmlText: string): { title: string; items: RssFeedItem[] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    return { title: '', items: [] };
  }

  const channelTitle =
    doc.querySelector('channel > title')?.textContent?.trim() ||
    doc.querySelector('feed > title')?.textContent?.trim() ||
    '';

  const items: RssFeedItem[] = [];

  // RSS 2.0 / RDF <item>
  const rssNodes = Array.from(doc.querySelectorAll('item'));
  if (rssNodes.length > 0) {
    for (const node of rssNodes) {
      const title = node.querySelector('title')?.textContent?.trim() || '';
      const link =
        node.querySelector('link')?.textContent?.trim() ||
        node.querySelector('guid')?.textContent?.trim() ||
        '';
      const pubRaw =
        node.querySelector('pubDate')?.textContent ||
        node.querySelector('date')?.textContent ||
        '';
      const description = stripHtmlTags(node.querySelector('description')?.textContent);
      if (title && link) {
        items.push({ title, link, pubDate: parseDateSafe(pubRaw), description });
      }
    }
    return { title: channelTitle, items };
  }

  // Atom <entry>
  const atomNodes = Array.from(doc.querySelectorAll('entry'));
  for (const node of atomNodes) {
    const title = node.querySelector('title')?.textContent?.trim() || '';
    const linkEl =
      node.querySelector('link[rel="alternate"]') || node.querySelector('link[href]');
    const link = linkEl?.getAttribute('href')?.trim() || '';
    const pubRaw =
      node.querySelector('published')?.textContent ||
      node.querySelector('updated')?.textContent ||
      '';
    const description = stripHtmlTags(
      node.querySelector('summary')?.textContent || node.querySelector('content')?.textContent
    );
    if (title && link) {
      items.push({ title, link, pubDate: parseDateSafe(pubRaw), description });
    }
  }

  return { title: channelTitle, items };
}

function findMatchingKeyword(item: RssFeedItem, keywords: string[]): string | null {
  const haystack = `${item.title} ${item.description || ''}`.toLowerCase();
  for (const kw of keywords) {
    if (haystack.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

const PRICE_CACHE_STORAGE_KEY = 'priceCacheV3';
const NEWS_CACHE_STORAGE_KEY = 'newsCacheV2';
const NEWS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

interface CachedNewsEntry {
  key: string;
  article: NewsArticle;
  timestamp: number;
}

function newsCacheKey(newsSettings?: NewsSettings): string {
  const sourceId = newsSettings?.sourceId || 'bbc-world';
  const customUrl = (newsSettings?.customUrl || '').trim();
  const keywords = (newsSettings?.keywords || [])
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  return `${sourceId}|${customUrl}|${keywords}`;
}

function trendFromPercent(pct: number | undefined): PriceData['trend'] {
  if (pct === undefined || !Number.isFinite(pct)) return 'flat';
  if (pct > 0.05) return 'up';
  if (pct < -0.05) return 'down';
  return 'flat';
}

export class ApiClient {
  private static suggestController: AbortController | null = null;
  private static suggestionCache: Map<string, { items: string[]; ts: number }> = new Map();

  // In-memory + persistent chrome.storage.local cache keyed by `${provider}:${asset}`
  private static priceCache: Map<string, CachedPrice> = new Map();
  private static priceCacheHydrated = false;
  private static inflightPrice: Map<string, Promise<PriceData>> = new Map();
  private static inflightNews: Map<string, Promise<NewsArticle | null>> = new Map();

  // Short-lived shared batch promises so multi-asset fetches share 1 HTTP request per exchange/source
  private static alanchandBatchPromise: Promise<Partial<Record<FinanceAssetId, PriceData>>> | null = null;
  private static nobitexBatchPromise: Promise<Partial<Record<FinanceAssetId, PriceData>>> | null = null;
  private static wallexBatchPromise: Promise<Partial<Record<FinanceAssetId, PriceData>>> | null = null;
  private static binanceBatchPromise: Promise<Partial<Record<FinanceAssetId, PriceData>>> | null = null;
  private static tgjuAjaxPromise: Promise<Record<string, TgjuAjaxItem>> | null = null;

  static clearPriceCache(): void {
    this.priceCache.clear();
    try {
      chrome.storage.local.remove([PRICE_CACHE_STORAGE_KEY]);
    } catch {
      // ignore
    }
  }

  private static async hydratePriceCache(): Promise<void> {
    if (this.priceCacheHydrated) return;
    this.priceCacheHydrated = true;
    try {
      const stored = await new Promise<Record<string, CachedPrice> | undefined>((resolve) => {
        chrome.storage.local.get([PRICE_CACHE_STORAGE_KEY], (r) =>
          resolve((r as Record<string, Record<string, CachedPrice>>)[PRICE_CACHE_STORAGE_KEY])
        );
      });
      if (stored && typeof stored === 'object') {
        for (const [k, v] of Object.entries(stored)) {
          if (v && v.value && typeof v.timestamp === 'number') {
            this.priceCache.set(k, v);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  private static persistPriceCache(): void {
    try {
      const obj: Record<string, CachedPrice> = {};
      for (const [k, v] of this.priceCache.entries()) {
        obj[k] = v;
      }
      chrome.storage.local.set({ [PRICE_CACHE_STORAGE_KEY]: obj });
    } catch {
      // ignore
    }
  }

  static async getCachedPrices(
    assetIds: FinanceAssetId[] = ['usdt', 'usd', 'gold', 'btc'],
    provider: MarketProviderId = 'auto'
  ): Promise<{ data: Partial<Record<FinanceAssetId, PriceData>>; fresh: boolean }> {
    await this.hydratePriceCache();
    const data: Partial<Record<FinanceAssetId, PriceData>> = {};
    let fresh = true;
    const now = Date.now();
    for (const id of assetIds) {
      const entry = this.priceCache.get(`${provider}:${id}`);
      if (entry) {
        data[id] = entry.value;
        if (now - entry.timestamp >= INTERVALS.priceCache) fresh = false;
      } else {
        fresh = false;
      }
    }
    return { data, fresh };
  }

  static async getCachedNews(
    newsSettings?: NewsSettings
  ): Promise<{ article: NewsArticle | null; fresh: boolean }> {
    const key = newsCacheKey(newsSettings);
    try {
      const stored = await new Promise<CachedNewsEntry | undefined>((resolve) => {
        chrome.storage.local.get([NEWS_CACHE_STORAGE_KEY], (r) =>
          resolve((r as Record<string, CachedNewsEntry>)[NEWS_CACHE_STORAGE_KEY])
        );
      });
      if (stored && stored.key === key && stored.article) {
        return {
          article: stored.article,
          fresh: Date.now() - stored.timestamp < NEWS_CACHE_TTL_MS
        };
      }
    } catch {
      // ignore
    }
    return { article: null, fresh: false };
  }

  // --- Helper: Fetch via Background Script ---
  static async fetchViaBackground(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action: 'PROXY_FETCH', url }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.success) {
            resolve(response.data as string);
          } else {
            reject(new Error((response as { error?: string })?.error || 'Unknown Error'));
          }
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  static async fetchRawRssXml(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action: 'FETCH_RSS', url }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.success) {
            resolve(response.data as string);
          } else {
            reject(new Error((response as { error?: string })?.error || 'RSS fetch failed'));
          }
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  // Direct JSON / XML RSS/Atom fetch with rss2json fallback
  static async fetchRssFeed(
    feedUrl: string
  ): Promise<{ title: string; items: RssFeedItem[] }> {
    // 1. Direct JSON API (e.g. Iran Monitor /api/events) or XML RSS/Atom parse
    try {
      const raw = await this.fetchRawRssXml(feedUrl);
      const jsonParsed = parseJsonFeed(raw, feedUrl);
      if (jsonParsed && jsonParsed.items.length > 0) {
        return jsonParsed;
      }
      const parsed = parseRssXml(raw);
      if (parsed.items.length > 0) {
        return parsed;
      }
    } catch {
      // fall through to rss2json
    }

    // 2. Fallback via rss2json
    try {
      const apiUrl = `${API_URLS.newsConverter}?rss_url=${encodeURIComponent(feedUrl)}`;
      const responseText = await this.fetchViaBackground(apiUrl);
      const data = JSON.parse(responseText);
      if (data.status === 'ok' && Array.isArray(data.items)) {
        const items: RssFeedItem[] = data.items
          .filter((i: { title?: string; link?: string }) => i.title && i.link)
          .map((i: { title: string; link: string; pubDate?: string; description?: string }) => ({
            title: i.title.trim(),
            link: i.link.trim(),
            pubDate: parseDateSafe(i.pubDate),
            description: stripHtmlTags(i.description)
          }));
        return { title: data.feed?.title || '', items };
      }
    } catch {
      // both sources failed
    }

    return { title: '', items: [] };
  }

  // --- News ---

  static async fetchNews(newsSettings?: NewsSettings, forceRefresh = false): Promise<NewsArticle | null> {
    const cacheKey = newsCacheKey(newsSettings);

    if (!forceRefresh) {
      const cached = await this.getCachedNews(newsSettings);
      if (cached.fresh && cached.article) {
        return cached.article;
      }
    }

    const pending = this.inflightNews.get(cacheKey);
    if (pending) return pending;

    const task = this.fetchNewsNetwork(newsSettings, cacheKey);
    this.inflightNews.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.inflightNews.delete(cacheKey);
    }
  }

  private static async fetchNewsNetwork(
    newsSettings: NewsSettings | undefined,
    cacheKey: string
  ): Promise<NewsArticle | null> {
    const sourceId = newsSettings?.sourceId || 'bbc-world';
    const keywords = (newsSettings?.keywords || [])
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    let feedUrl = '';
    let sourceName = '';
    let sourceDomain = '';
    let fallbackSiteUrl = '';

    if (sourceId === 'custom' && newsSettings?.customUrl?.trim()) {
      const raw = newsSettings.customUrl.trim();
      const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      sourceDomain = hostOfUrl(normalized);
      sourceName = sourceDomain || 'Custom Wire';
      fallbackSiteUrl = normalized;

      const looksLikeFeed = /\.(xml|rss|atom)(\?|$)|\/(rss|feed|atom)\b/i.test(normalized);
      feedUrl = looksLikeFeed
        ? normalized
        : `https://news.google.com/rss/search?q=site:${encodeURIComponent(sourceDomain)}&hl=en-US&gl=US&ceid=US:en`;
    } else {
      const source = getNewsSource(sourceId);
      feedUrl = source.feedUrl;
      sourceName = source.name;
      sourceDomain = source.domain;
      fallbackSiteUrl = source.siteUrl;
    }

    const persistNews = (article: NewsArticle): NewsArticle => {
      try {
        chrome.storage.local.set({
          [NEWS_CACHE_STORAGE_KEY]: { key: cacheKey, article, timestamp: Date.now() } as CachedNewsEntry
        });
      } catch {
        // ignore
      }
      return article;
    };

    const pickFromItems = (items: RssFeedItem[]): NewsArticle | null => {
      if (items.length === 0) return null;
      const sorted = [...items].sort((a, b) => b.pubDate - a.pubDate);

      if (keywords.length === 0) {
        const top = sorted[0];
        return {
          title: cleanHeadline(top.title, sourceName),
          url: top.link,
          sourceName,
          sourceDomain
        };
      }

      for (const item of sorted) {
        const hit = findMatchingKeyword(item, keywords);
        if (hit) {
          return {
            title: cleanHeadline(item.title, sourceName),
            url: item.link,
            sourceName,
            sourceDomain,
            matchedKeyword: hit
          };
        }
      }
      return null;
    };

    try {
      const feed = await this.fetchRssFeed(feedUrl);
      const picked = pickFromItems(feed.items);
      if (picked) return persistNews(picked);

      // If keywords were set and a small RSS feed had no match, query Google News
      // scoped to this source domain + keywords (skip for direct JSON breaking feeds like Iran Monitor
      // which already return 200 live breaking events and whose Google News index only lists static pages).
      const isDirectJsonApi = /\/api\/events\b/i.test(feedUrl);
      if (keywords.length > 0 && sourceDomain && !isDirectJsonApi) {
        const kwExpr = keywords
          .map((k) => (/\s/.test(k) ? `"${k}"` : k))
          .join(' OR ');
        const domainQuery = sourceDomain.replace(/^www\./, '');
        const scopedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
          `site:${domainQuery} (${kwExpr})`
        )}&hl=en-US&gl=US&ceid=US:en`;
        const scopedFeed = await this.fetchRssFeed(scopedUrl);
        const scopedPick = pickFromItems(scopedFeed.items);
        if (scopedPick) return persistNews(scopedPick);
      }
    } catch (e) {
      console.warn('News Fetch Failed', e);
    }

    if (keywords.length > 0) {
      return persistNews({
        title: `No headlines matching: ${keywords.join(', ')}`,
        url: fallbackSiteUrl,
        sourceName,
        sourceDomain,
        noKeywordMatch: true
      });
    }

    if (fallbackSiteUrl) {
      return {
        title: `Open ${sourceName} live feed`,
        url: fallbackSiteUrl,
        sourceName,
        sourceDomain
      };
    }

    return null;
  }

  // --- Suggestions (LRU-cached, AbortController-backed, engine-aware) ---

  private static suggestCacheKey(query: string, engine: string): string {
    const kind =
      engine === 'duckduckgo' || engine === 'brave' || engine === 'startpage' || engine === 'kagi'
        ? 'ddg'
        : 'google';
    return `${kind}:${query.trim().toLowerCase()}`;
  }

  static getCachedSuggestions(query: string, engine = 'google'): string[] | null {
    const key = this.suggestCacheKey(query, engine);
    const entry = this.suggestionCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > 5 * 60 * 1000) {
      this.suggestionCache.delete(key);
      return null;
    }
    return entry.items;
  }

  static abortSuggestions(): void {
    this.suggestController?.abort();
    this.suggestController = null;
  }

  static async fetchSuggestions(query: string, engine = 'google'): Promise<string[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const cached = this.getCachedSuggestions(trimmed, engine);
    if (cached) return cached;

    this.suggestController?.abort();
    const controller = new AbortController();
    this.suggestController = controller;

    const saveToCache = (items: string[]): string[] => {
      if (items.length > 0) {
        const key = this.suggestCacheKey(trimmed, engine);
        this.suggestionCache.set(key, { items, ts: Date.now() });
        if (this.suggestionCache.size > 80) {
          const oldest = this.suggestionCache.keys().next().value;
          if (oldest !== undefined) this.suggestionCache.delete(oldest);
        }
      }
      return items;
    };

    const isExtension =
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime?.id === 'string' &&
      chrome.runtime.id.length > 0;

    if (!isExtension) {
      try {
        const resp = await fetch(
          `/api/suggestions?q=${encodeURIComponent(trimmed)}&engine=${encodeURIComponent(engine)}`,
          { signal: controller.signal }
        );
        if (!resp.ok || controller.signal.aborted) return [];
        const data = (await resp.json()) as string[];
        return Array.isArray(data) ? saveToCache(data) : [];
      } catch {
        return [];
      }
    }

    return new Promise((resolve) => {
      const onAbort = (): void => resolve([]);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        chrome.runtime.sendMessage(
          { action: 'FETCH_SUGGESTIONS', query: trimmed, engine },
          (response) => {
            controller.signal.removeEventListener('abort', onAbort);
            if (controller.signal.aborted) return;
            if (chrome.runtime.lastError) {
              resolve([]);
              return;
            }
            if (response && response.success && Array.isArray(response.data)) {
              resolve(saveToCache(response.data as string[]));
            } else {
              resolve([]);
            }
          }
        );
      } catch {
        controller.signal.removeEventListener('abort', onAbort);
        resolve([]);
      }
    });
  }

  // --- Prices (Verified Multi-Provider Engine) ---
  //
  // Live zero-key providers:
  //   • AlanChand (~80ms single batch):   Live Tehran USD, Gold 18K, EUR, USDT, BTC, ETH + 24h %
  //   • Nobitex v2 (1.4 KB single batch): USDT/IRT (24/7), BTC/USD, ETH/USD + 24h %
  //   • Wallex v1 (400ms batch backup):   USDT/TMN (24/7), BTC/USD, ETH/USD + 24h %
  //   • TGJU compact JSON (~200B each):   USD (bazaar), Gold 18K, EUR + TGJU live ajax backup
  //   • Binance public ticker (1.6 KB):   Global BTC/USD & ETH/USD backup

  static async fetchPrices(
    assetIds?: FinanceAssetId[],
    provider: MarketProviderId = 'auto'
  ): Promise<Record<FinanceAssetId, PriceData>> {
    const ids =
      assetIds && assetIds.length > 0
        ? assetIds
        : (Object.keys(FINANCE_ASSETS) as FinanceAssetId[]);
    const results = await Promise.all(ids.map((id) => this.fetchAssetPrice(id, provider)));
    const out = {} as Record<FinanceAssetId, PriceData>;
    ids.forEach((id, i) => {
      out[id] = results[i];
    });
    return out;
  }

  static async fetchAssetPrice(
    asset: FinanceAssetId,
    provider: MarketProviderId = 'auto'
  ): Promise<PriceData> {
    await this.hydratePriceCache();
    const cacheKey = `${provider}:${asset}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < INTERVALS.priceCache) {
      return cached.value;
    }

    const pending = this.inflightPrice.get(cacheKey);
    if (pending) return pending;

    const task = (async (): Promise<PriceData> => {
      const def = FINANCE_ASSETS[asset];
      let result: PriceData | null = null;

      if (provider === 'alanchand') {
        result = (await this.fetchAlanChandBatch())[asset] ?? null;
        if (!result) {
          if (asset === 'usdt') {
            result = (await this.fetchNobitexBatch()).usdt ?? (await this.fetchWallexBatch()).usdt ?? null;
          } else if (asset === 'btc' || asset === 'eth') {
            result = (await this.fetchNobitexBatch())[asset] ?? (await this.fetchBinanceBatch())[asset] ?? null;
          } else {
            result = (await this.fetchTgjuJson(asset).catch(() => null)) ?? (await this.fetchTgjuAjaxAsset(asset)) ?? null;
          }
        }
      } else if (asset === 'usdt') {
        if (provider === 'wallex') {
          result =
            (await this.fetchWallexBatch())[asset] ??
            (await this.fetchNobitexBatch())[asset] ??
            (await this.fetchAlanChandBatch())[asset] ??
            null;
        } else {
          result =
            (await this.fetchNobitexBatch())[asset] ??
            (await this.fetchWallexBatch())[asset] ??
            (await this.fetchAlanChandBatch())[asset] ??
            null;
        }
        if (!result) {
          result = await this.fetchTgjuJson('usd').catch(() => null);
        }
      } else if (asset === 'btc' || asset === 'eth') {
        if (provider === 'tgju') {
          result =
            (await this.fetchTgjuAjaxAsset(asset)) ??
            (await this.fetchAlanChandBatch())[asset] ??
            (await this.fetchNobitexBatch())[asset] ??
            (await this.fetchBinanceBatch())[asset] ??
            null;
        } else if (provider === 'wallex') {
          result =
            (await this.fetchWallexBatch())[asset] ??
            (await this.fetchNobitexBatch())[asset] ??
            (await this.fetchBinanceBatch())[asset] ??
            null;
        } else {
          result =
            (await this.fetchNobitexBatch())[asset] ??
            (await this.fetchWallexBatch())[asset] ??
            (await this.fetchBinanceBatch())[asset] ??
            (await this.fetchAlanChandBatch())[asset] ??
            (await this.fetchTgjuAjaxAsset(asset)) ??
            null;
        }
      } else {
        // Tehran free-market fiat & 18K gold: usd, gold, eur
        if (provider === 'tgju') {
          result =
            (await this.fetchTgjuJson(asset).catch(() => null)) ??
            (await this.fetchTgjuAjaxAsset(asset)) ??
            (await this.fetchAlanChandBatch())[asset] ??
            null;
        } else {
          // 'auto' and 'wallex' prefer AlanChand's single 80ms Tehran free-market batch, falling back to TGJU
          result =
            (await this.fetchAlanChandBatch())[asset] ??
            (await this.fetchTgjuJson(asset).catch(() => null)) ??
            (await this.fetchTgjuAjaxAsset(asset)) ??
            null;
        }
        if (!result && asset === 'usd') {
          result =
            (await this.fetchNobitexBatch()).usdt ??
            (await this.fetchWallexBatch()).usdt ??
            null;
        }
      }

      const finalResult: PriceData = result ?? {
        price: 'Error',
        unit: def.unit,
        trend: 'flat'
      };

      if (finalResult.price !== 'Error') {
        this.priceCache.set(cacheKey, { value: finalResult, timestamp: Date.now() });
        this.persistPriceCache();
      }
      return finalResult;
    })();

    this.inflightPrice.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.inflightPrice.delete(cacheKey);
    }
  }

  private static fetchAlanChandBatch(): Promise<Partial<Record<FinanceAssetId, PriceData>>> {
    if (this.alanchandBatchPromise) return this.alanchandBatchPromise;
    const p = (async (): Promise<Partial<Record<FinanceAssetId, PriceData>>> => {
      const out: Partial<Record<FinanceAssetId, PriceData>> = {};
      try {
        const html = await this.fetchViaBackground(API_URLS.alanchand);
        const entries: ReadonlyArray<readonly [FinanceAssetId, string]> = [
          ['usd', 'c.usd'],
          ['eur', 'c.eur'],
          ['gold', 'g.18ayar'],
          ['usdt', 'x.usdt'],
          ['btc', 'xu.btc'],
          ['eth', 'xu.eth']
        ];

        for (const [assetId, liveKey] of entries) {
          const escaped = liveKey.replace('.', '\\.');
          const re = new RegExp(`<span\\b([^>]*data-live="${escaped}"[^>]*)>([^<]+)<\\/span>([\\s\\S]{0,220})`, 'g');
          let match: RegExpExecArray | null;
          let chosen: { attrs: string; rawVal: number; tail: string } | null = null;

          while ((match = re.exec(html)) !== null) {
            const val = toPositiveNumber(match[2]);
            if (val === null) continue;
            const hasPct = /\([^)%٪]+[%٪]\)/.test(match[3]);
            if (!chosen || hasPct) {
              chosen = { attrs: match[1], rawVal: val, tail: match[3] };
              if (hasPct) break;
            }
          }

          if (!chosen) continue;
          const def = FINANCE_ASSETS[assetId];
          const context = `${chosen.attrs} ${chosen.tail}`;
          let trend: PriceData['trend'] = 'flat';
          if (/\bv4-up\b|▲|i-chevron-up|i-trending-up/i.test(context)) trend = 'up';
          else if (/\bv4-dn\b|\bv4-down\b|▼|i-chevron-down|i-trending-down/i.test(context)) trend = 'down';

          const pctM = normalizeDigits(chosen.tail).match(/\(([^)%٪]+)[%٪]\)/);
          let changePercent: number | undefined;
          if (pctM) {
            const mag = parseFloat(pctM[1].replace(/[^\d.]/g, ''));
            if (Number.isFinite(mag) && mag > 0) {
              changePercent = trend === 'down' ? -mag : mag;
            }
          }

          if (def.unit === 'usd') {
            out[assetId] = {
              price: chosen.rawVal.toLocaleString('en-US', {
                maximumFractionDigits: chosen.rawVal >= 1000 ? 0 : 2
              }),
              numericValue: chosen.rawVal,
              unit: 'usd',
              trend,
              changePercent,
              source: 'AlanChand'
            };
          } else {
            // AlanChand displays Toman directly; store Rial string in `price` for backwards compatibility
            const toman = Math.round(chosen.rawVal);
            out[assetId] = {
              price: (toman * 10).toLocaleString('en-US'),
              numericValue: toman,
              unit: 'toman',
              trend,
              changePercent,
              source: 'AlanChand'
            };
          }
        }
      } catch {
        // AlanChand unreachable — callers fall back to TGJU / Nobitex
      }
      return out;
    })();

    this.alanchandBatchPromise = p;
    void p.finally(() => {
      window.setTimeout(() => {
        if (this.alanchandBatchPromise === p) this.alanchandBatchPromise = null;
      }, 2500);
    });
    return p;
  }

  private static fetchNobitexBatch(): Promise<Partial<Record<FinanceAssetId, PriceData>>> {
    if (this.nobitexBatchPromise) return this.nobitexBatchPromise;
    const p = (async (): Promise<Partial<Record<FinanceAssetId, PriceData>>> => {
      const out: Partial<Record<FinanceAssetId, PriceData>> = {};
      try {
        const text = await this.fetchViaBackground(API_URLS.nobitexStats);
        const json = JSON.parse(text) as { status?: string; stats?: Record<string, NobitexStat> };
        const stats = json.stats;
        if (!stats) return out;

        const usdtRls = toPositiveNumber(stats['usdt-rls']?.latest);
        if (usdtRls !== null) {
          const ch = parseFloat(String(stats['usdt-rls']?.dayChange ?? ''));
          const pct = Number.isFinite(ch) ? ch : undefined;
          out.usdt = {
            price: Math.round(usdtRls).toLocaleString('en-US'),
            numericValue: Math.round(usdtRls / 10),
            unit: 'toman',
            trend: trendFromPercent(pct),
            changePercent: pct,
            source: 'Nobitex'
          };
        }

        for (const [id, key] of [
          ['btc', 'btc-usdt'],
          ['eth', 'eth-usdt']
        ] as const) {
          const val = toPositiveNumber(stats[key]?.latest);
          if (val !== null) {
            const ch = parseFloat(String(stats[key]?.dayChange ?? ''));
            const pct = Number.isFinite(ch) ? ch : undefined;
            out[id] = {
              price: val.toLocaleString('en-US', {
                maximumFractionDigits: val >= 1000 ? 0 : 2
              }),
              numericValue: val,
              unit: 'usd',
              trend: trendFromPercent(pct),
              changePercent: pct,
              source: 'Nobitex'
            };
          }
        }
      } catch {
        // Nobitex unreachable — callers fall through to Wallex / Binance / TGJU
      }
      return out;
    })();

    this.nobitexBatchPromise = p;
    void p.finally(() => {
      window.setTimeout(() => {
        if (this.nobitexBatchPromise === p) this.nobitexBatchPromise = null;
      }, 2500);
    });
    return p;
  }

  private static fetchWallexBatch(): Promise<Partial<Record<FinanceAssetId, PriceData>>> {
    if (this.wallexBatchPromise) return this.wallexBatchPromise;
    const p = (async (): Promise<Partial<Record<FinanceAssetId, PriceData>>> => {
      const out: Partial<Record<FinanceAssetId, PriceData>> = {};
      try {
        const text = await this.fetchViaBackground(API_URLS.wallexMarkets);
        const json = JSON.parse(text) as {
          result?: { symbols?: Record<string, WallexSymbol> };
        };
        const symbols = json.result?.symbols;
        if (!symbols) return out;

        const usdtTmn = toPositiveNumber(symbols.USDTTMN?.stats?.lastPrice);
        if (usdtTmn !== null) {
          const ch = parseFloat(String(symbols.USDTTMN?.stats?.['24h_ch'] ?? ''));
          const pct = Number.isFinite(ch) ? ch : undefined;
          const rial = Math.round(usdtTmn * 10);
          out.usdt = {
            price: rial.toLocaleString('en-US'),
            numericValue: Math.round(usdtTmn),
            unit: 'toman',
            trend: trendFromPercent(pct),
            changePercent: pct,
            source: 'Wallex'
          };
        }

        for (const [id, sym] of [
          ['btc', 'BTCUSDT'],
          ['eth', 'ETHUSDT']
        ] as const) {
          const val = toPositiveNumber(symbols[sym]?.stats?.lastPrice);
          if (val !== null) {
            const ch = parseFloat(String(symbols[sym]?.stats?.['24h_ch'] ?? ''));
            const pct = Number.isFinite(ch) ? ch : undefined;
            out[id] = {
              price: val.toLocaleString('en-US', {
                maximumFractionDigits: val >= 1000 ? 0 : 2
              }),
              numericValue: val,
              unit: 'usd',
              trend: trendFromPercent(pct),
              changePercent: pct,
              source: 'Wallex'
            };
          }
        }
      } catch {
        // Wallex unreachable
      }
      return out;
    })();

    this.wallexBatchPromise = p;
    void p.finally(() => {
      window.setTimeout(() => {
        if (this.wallexBatchPromise === p) this.wallexBatchPromise = null;
      }, 2500);
    });
    return p;
  }

  private static fetchBinanceBatch(): Promise<Partial<Record<FinanceAssetId, PriceData>>> {
    if (this.binanceBatchPromise) return this.binanceBatchPromise;
    const p = (async (): Promise<Partial<Record<FinanceAssetId, PriceData>>> => {
      const out: Partial<Record<FinanceAssetId, PriceData>> = {};
      try {
        const text = await this.fetchViaBackground(API_URLS.binanceTickers);
        const rows = JSON.parse(text) as BinanceTicker[];
        if (!Array.isArray(rows)) return out;
        for (const row of rows) {
          const id: FinanceAssetId | null =
            row.symbol === 'BTCUSDT' ? 'btc' : row.symbol === 'ETHUSDT' ? 'eth' : null;
          if (!id) continue;
          const val = toPositiveNumber(row.lastPrice);
          if (val === null) continue;
          const ch = parseFloat(String(row.priceChangePercent ?? ''));
          const pct = Number.isFinite(ch) ? ch : undefined;
          out[id] = {
            price: val.toLocaleString('en-US', {
              maximumFractionDigits: val >= 1000 ? 0 : 2
            }),
            numericValue: val,
            unit: 'usd',
            trend: trendFromPercent(pct),
            changePercent: pct,
            source: 'Binance'
          };
        }
      } catch {
        // Binance unreachable
      }
      return out;
    })();

    this.binanceBatchPromise = p;
    void p.finally(() => {
      window.setTimeout(() => {
        if (this.binanceBatchPromise === p) this.binanceBatchPromise = null;
      }, 2500);
    });
    return p;
  }

  private static async fetchTgjuJson(asset: FinanceAssetId): Promise<PriceData | null> {
    const def = FINANCE_ASSETS[asset];
    if (!def.tgju) return null;
    const url = `https://api.tgju.org/v1/market/indicator/summary-table-data/${def.tgju}?length=1`;
    const text = await this.fetchViaBackground(url);
    const json = JSON.parse(text) as TgjuSummaryResponse;
    const row = json.data?.[0];
    if (!row || !Array.isArray(row)) return null;

    const rawNum = toPositiveNumber(row[3]);
    if (rawNum === null) return null;

    const changeHtml = row[5] ?? '';
    let trend: PriceData['trend'] = 'flat';
    if (/class="high"/.test(changeHtml)) trend = 'up';
    else if (/class="low"/.test(changeHtml)) trend = 'down';

    const pctMatch = normalizeDigits(changeHtml).replace(/<[^>]+>/g, '').match(/[\d.]+/);
    let changePercent: number | undefined;
    if (pctMatch) {
      const mag = parseFloat(pctMatch[0]);
      if (Number.isFinite(mag) && mag > 0) {
        changePercent = trend === 'down' ? -mag : mag;
      }
    }

    if (def.unit === 'usd') {
      return {
        price: rawNum.toLocaleString('en-US', { maximumFractionDigits: rawNum >= 1000 ? 0 : 2 }),
        numericValue: rawNum,
        unit: 'usd',
        trend,
        changePercent,
        source: 'TGJU'
      };
    }

    return {
      price: Math.round(rawNum).toLocaleString('en-US'),
      numericValue: Math.round(rawNum / 10),
      unit: 'toman',
      trend,
      changePercent,
      source: 'TGJU'
    };
  }

  private static fetchTgjuAjaxBatch(): Promise<Record<string, TgjuAjaxItem>> {
    if (this.tgjuAjaxPromise) return this.tgjuAjaxPromise;
    const p = (async (): Promise<Record<string, TgjuAjaxItem>> => {
      try {
        const text = await this.fetchViaBackground(API_URLS.tgjuAjax);
        const json = JSON.parse(text) as { current?: Record<string, TgjuAjaxItem> };
        return json.current ?? {};
      } catch {
        return {};
      }
    })();

    this.tgjuAjaxPromise = p;
    void p.finally(() => {
      window.setTimeout(() => {
        if (this.tgjuAjaxPromise === p) this.tgjuAjaxPromise = null;
      }, 2500);
    });
    return p;
  }

  private static async fetchTgjuAjaxAsset(asset: FinanceAssetId): Promise<PriceData | null> {
    const def = FINANCE_ASSETS[asset];
    if (!def.tgju) return null;
    const current = await this.fetchTgjuAjaxBatch();
    const item = current[def.tgju];
    if (!item) return null;
    const rawNum = toPositiveNumber(item.p);
    if (rawNum === null) return null;

    const dpNum = parseFloat(String(item.dp ?? ''));
    let trend: PriceData['trend'] = 'flat';
    if (item.dt === 'high') trend = 'up';
    else if (item.dt === 'low') trend = 'down';

    const changePercent =
      Number.isFinite(dpNum) && dpNum !== 0
        ? trend === 'down'
          ? -Math.abs(dpNum)
          : Math.abs(dpNum)
        : undefined;

    if (def.unit === 'usd') {
      return {
        price: rawNum.toLocaleString('en-US', { maximumFractionDigits: rawNum >= 1000 ? 0 : 2 }),
        numericValue: rawNum,
        unit: 'usd',
        trend,
        changePercent,
        source: 'TGJU'
      };
    }

    return {
      price: Math.round(rawNum).toLocaleString('en-US'),
      numericValue: Math.round(rawNum / 10),
      unit: 'toman',
      trend,
      changePercent,
      source: 'TGJU'
    };
  }

  static cleanPrice(text: string): string {
    const normalized = normalizeDigits(text);
    const match = normalized.match(/[\d,]+/);
    return match ? match[0] : 'Error';
  }
}
