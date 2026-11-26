import {
  API_URLS,
  FINANCE_ASSETS,
  getNewsSource,
  hostOfUrl,
  INTERVALS,
  type FinanceAssetId
} from './constants';
import type { NewsSettings } from './types';

// All price sources normalized to Rial internally; Toman conversion happens
// once at render time (script.ts).

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

function toRialNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = parseInt(normalizeDigits(raw).replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export interface PriceData {
  price: string;
  trend: 'up' | 'down' | 'flat';
}

export interface RssFeedItem {
  title: string;
  link: string;
  pubDate: number;
}

export interface NewsArticle {
  title: string;
  url: string;
  sourceName: string;
  sourceDomain: string;
}

interface BrsApiItem {
  name?: string;
  price?: string | number;
}

interface BrsApiResponse {
  currency?: BrsApiItem[];
}

// api.tgju.org summary-table-data?length=1 → newest daily OHLC row.
// Columns: [open, low, high, close, changeAmountHtml, changePercentHtml, gregorianDate, jalaliDate]
type TgjuRow = [string, string, string, string, string, string, string, string];
interface TgjuSummaryResponse {
  data?: TgjuRow[];
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
      if (title && link) {
        items.push({ title, link, pubDate: parseDateSafe(pubRaw) });
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
    if (title && link) {
      items.push({ title, link, pubDate: parseDateSafe(pubRaw) });
    }
  }

  return { title: channelTitle, items };
}

export class ApiClient {
  private static suggestController: AbortController | null = null;

  // In-memory cache — one fetch cycle per tab per interval even with re-renders.
  private static priceCache: Map<FinanceAssetId, CachedPrice> = new Map();

  static clearPriceCache(): void {
    this.priceCache.clear();
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

  // Direct XML RSS/Atom fetch with rss2json fallback
  static async fetchRssFeed(
    feedUrl: string
  ): Promise<{ title: string; items: RssFeedItem[] }> {
    // 1. Direct XML parse (fast, no rate limits, works for Google News & Iran Monitor)
    try {
      const xml = await this.fetchRawRssXml(feedUrl);
      const parsed = parseRssXml(xml);
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
          .map((i: { title: string; link: string; pubDate?: string }) => ({
            title: i.title.trim(),
            link: i.link.trim(),
            pubDate: parseDateSafe(i.pubDate)
          }));
        return { title: data.feed?.title || '', items };
      }
    } catch {
      // both sources failed
    }

    return { title: '', items: [] };
  }

  // --- News ---

  static async fetchNews(newsSettings?: NewsSettings): Promise<NewsArticle | null> {
    const sourceId = newsSettings?.sourceId || 'bbc-world';
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

    try {
      const feed = await this.fetchRssFeed(feedUrl);
      if (feed.items.length > 0) {
        const sorted = [...feed.items].sort((a, b) => b.pubDate - a.pubDate);
        const top = sorted[0];
        return {
          title: cleanHeadline(top.title, sourceName),
          url: top.link,
          sourceName,
          sourceDomain
        };
      }
    } catch (e) {
      console.warn('News Fetch Failed', e);
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

  // --- Suggestions ---

  static async fetchSuggestions(query: string): Promise<string[]> {
    if (!query) return [];

    // Abort the previous in-flight request; one BG roundtrip per settled query.
    this.suggestController?.abort();
    const controller = new AbortController();
    this.suggestController = controller;

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'FETCH_SUGGESTIONS', query }, (response) => {
          if (controller.signal.aborted) return;
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          if (response && response.success) {
            resolve(response.data as string[]);
          } else {
            resolve([]);
          }
        });
      } catch {
        resolve([]);
      }
    });
  }

  // --- Prices ---
  //
  // Source chain per asset:
  //   1. cache (< INTERVALS.priceCache old)
  //   2. TGJU JSON API (~400 bytes, includes change direction)
  //   3. TGJU profile page scrape (heavy fallback)
  //   4. brsapi free endpoint

  static async fetchPrices(): Promise<Record<FinanceAssetId, PriceData>> {
    const ids = Object.keys(FINANCE_ASSETS) as FinanceAssetId[];
    const results = await Promise.all(ids.map((id) => this.fetchAssetPrice(id)));
    const out = {} as Record<FinanceAssetId, PriceData>;
    ids.forEach((id, i) => { out[id] = results[i]; });
    return out;
  }

  static async fetchAssetPrice(asset: FinanceAssetId): Promise<PriceData> {
    const cached = this.priceCache.get(asset);
    if (cached && Date.now() - cached.timestamp < INTERVALS.priceCache) {
      return cached.value;
    }

    const jsonResult = await this.fetchTgjuJson(asset).catch(() => null);
    let result: PriceData = jsonResult ?? { price: 'Error', trend: 'flat' };

    if (result.price === 'Error' && (asset === 'usd' || asset === 'gold')) {
      result = await this.fetchProfileData(asset === 'usd' ? API_URLS.dollarProfile : API_URLS.goldProfile);
    }
    if (result.price === 'Error') {
      result = await this.fetchBrsAsset(asset);
    }

    if (result.price !== 'Error') {
      this.priceCache.set(asset, { value: result, timestamp: Date.now() });
    }
    return result;
  }

  private static async fetchTgjuJson(asset: FinanceAssetId): Promise<PriceData> {
    const symbol = FINANCE_ASSETS[asset].tgju;
    const url = `https://api.tgju.org/v1/market/indicator/summary-table-data/${symbol}?length=1`;
    const text = await this.fetchViaBackground(url);
    const json = JSON.parse(text) as TgjuSummaryResponse;
    const row = json.data?.[0];
    if (!row || !Array.isArray(row)) return { price: 'Error', trend: 'flat' };

    const rial = toRialNumber(row[3]); // close column
    if (rial === null) return { price: 'Error', trend: 'flat' };

    // Change direction: span class "high" → price rose, "low" → fell.
    const changeHtml = row[5] ?? '';
    let trend: PriceData['trend'] = 'flat';
    if (/class="high"/.test(changeHtml)) trend = 'up';
    else if (/class="low"/.test(changeHtml)) trend = 'down';

    return { price: rial.toLocaleString('en-US'), trend };
  }

  static async fetchProfileData(url: string): Promise<PriceData> {
    try {
      const html = await this.fetchViaBackground(url);
      const parsed = this.parseProfilePage(html);
      if (parsed.price !== 'Error') return parsed;
    } catch {
      // fall through
    }
    return { price: 'Error', trend: 'flat' };
  }

  static parseProfilePage(html: string): PriceData {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      let el = doc.querySelector('.info-price-left .value');
      if (el) return { price: this.cleanPrice(el.textContent || ''), trend: 'flat' };

      el = doc.querySelector('.price');
      if (el && /\d/.test(normalizeDigits(el.textContent || ''))) {
        return { price: this.cleanPrice(el.textContent || ''), trend: 'flat' };
      }

      const rows = doc.querySelectorAll('tr');
      for (const row of Array.from(rows)) {
        const rowText = normalizeDigits(row.textContent || '');
        if (rowText.includes('نرخ فعلی') || rowText.includes('Current')) {
          const val = row.querySelector('td:nth-child(2), .value');
          if (val) return { price: this.cleanPrice(val.textContent || ''), trend: 'flat' };
        }
      }
    } catch {
      // scraping error
    }
    return { price: 'Error', trend: 'flat' };
  }

  private static async fetchBrsAsset(asset: FinanceAssetId): Promise<PriceData> {
    try {
      const json = await this.fetchBrsApiJson();
      const brsapiName = FINANCE_ASSETS[asset].brsapiName;
      const item = json.currency?.find((c) => c.name?.toLowerCase() === brsapiName);
      const rial = toRialNumber(item?.price);
      if (rial !== null) {
        return { price: rial.toLocaleString('en-US'), trend: 'flat' };
      }
    } catch {
      // all sources exhausted
    }
    return { price: 'Error', trend: 'flat' };
  }

  // brsapi /FreeTether/latest serves Rial-scale values for usd/gold keys.
  private static async fetchBrsApiJson(): Promise<BrsApiResponse> {
    const responseText = await this.fetchViaBackground(API_URLS.fallbackApi);
    return JSON.parse(responseText) as BrsApiResponse;
  }

  static cleanPrice(text: string): string {
    const normalized = normalizeDigits(text);
    const match = normalized.match(/[\d,]+/);
    return match ? match[0] : 'Error';
  }
}
