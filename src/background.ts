import type {
  BackgroundRequest,
  BackgroundResponse,
  ErrorResponse,
  FetchRssRequest,
  FetchSuggestionsRequest,
  GetFaviconRequest,
  ProxyFetchRequest,
  SuccessResponse
} from './types';
import { FINANCE_ASSETS } from './constants';

type Handler = (
  request: never, // narrowed by registry wrapper below
  sendResponse: (response: BackgroundResponse) => void
) => void;

// Only the newest suggestion request's response is delivered; stale fetches
// still complete but their results are discarded.
let suggestionGeneration = 0;

function extractFirstIconFromHtml(html: string, baseUrl: string): string[] {
  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 24000);
  const tags = head.match(/<link\b[^>]*>/gi) || [];
  const scored: Array<{ url: string; score: number }> = [];

  for (const tag of tags) {
    const relM = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const hrefM = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!relM || !hrefM) continue;
    const rel = (relM[1] || relM[2] || relM[3] || '').toLowerCase();
    const rawHref = (hrefM[1] || hrefM[2] || hrefM[3] || '').trim();
    if (!rawHref || rawHref.startsWith('data:')) continue;
    if (!/\b(icon|apple-touch-icon|fluid-icon|shortcut)\b/.test(rel) || rel.includes('mask-icon')) continue;
    try {
      const resolved = new URL(rawHref, baseUrl).toString();
      const score =
        /\.svg(\?|$)/i.test(resolved) || /svg/i.test(tag)
          ? 100
          : rel.includes('apple-touch-icon')
            ? 82
            : /\.png(\?|$)/i.test(resolved)
              ? 76
              : 50;
      scored.push({ url: resolved, score });
    } catch {
      // ignore invalid href
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return Array.from(new Set(scored.map((s) => s.url))).slice(0, 4);
}

const DIRECT_APP_ICONS: Record<string, string> = {
  'mail.google.com': 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
  'drive.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
  'calendar.google.com': 'https://calendar.google.com/googlecalendar/images/favicons_2020q4/calendar_31.ico',
  'docs.google.com': 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico'
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readHtmlHead(resp: Response, maxBytes = 36_000): Promise<string> {
  if (!resp.body) {
    return (await resp.text()).slice(0, maxBytes);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(text)) break;
    }
  } catch {
    // ignore partial stream abort
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return text;
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(url, { redirect: 'follow' }, 3500);
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return null;
    const blob = await resp.blob();
    if (blob.size < 60 || blob.size > 1_500_000) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const handlers: Record<string, Handler> = {
  FETCH_SUGGESTIONS: (request: unknown, sendResponse) => {
    const { query } = request as FetchSuggestionsRequest;
    const generation = ++suggestionGeneration;
    const targetUrl = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;

    fetchWithTimeout(targetUrl, {}, 3500)
      .then((response) => response.json())
      .then((data: unknown[]) => {
        if (generation !== suggestionGeneration) return;
        const payload: string[] = Array.isArray(data[1]) ? data[1] : [];
        const res: SuccessResponse<string[]> = { success: true, data: payload };
        sendResponse(res);
      })
      .catch((error: Error) => {
        if (generation !== suggestionGeneration) return;
        const res: ErrorResponse = { success: false, error: error.message };
        sendResponse(res);
      });
  },

  PROXY_FETCH: (request: unknown, sendResponse) => {
    const { url } = request as ProxyFetchRequest;

    // URL allowlist — only allow hostnames matching host_permissions in manifest
    const ALLOWED_HOSTS = [
      'google.com',
      'tgju.org',
      'brsapi.ir',
      'rss2json.com',
      'bbci.co.uk',
      'aljazeera.com',
      'hnrss.org',
      'theverge.com',
      'arstechnica.com',
      'iranmonitor.org'
    ];
    try {
      const hostname = new URL(url).hostname;
      const allowed = ALLOWED_HOSTS.some(
        (h) => hostname === h || hostname.endsWith('.' + h)
      );
      if (!allowed) {
        sendResponse({ success: false, error: 'URL not in allowlist' } as ErrorResponse);
        return;
      }
    } catch {
      sendResponse({ success: false, error: 'Invalid URL' } as ErrorResponse);
      return;
    }

    fetchWithTimeout(url, {}, 5500)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.statusText);
        const text = await response.text();
        const res: SuccessResponse<string> = { success: true, data: text };
        sendResponse(res);
      })
      .catch((error: Error) => {
        const res: ErrorResponse = { success: false, error: error.message };
        sendResponse(res);
      });
  },

  FETCH_RSS: (request: unknown, sendResponse) => {
    const { url } = request as FetchRssRequest;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        sendResponse({ success: false, error: 'Invalid RSS URL' } as ErrorResponse);
        return;
      }
    } catch {
      sendResponse({ success: false, error: 'Invalid RSS URL' } as ErrorResponse);
      return;
    }

    fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: {
          Accept: 'application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8'
        }
      },
      6000
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(response.statusText);
        const text = await response.text();
        sendResponse({ success: true, data: text } as SuccessResponse<string>);
      })
      .catch((error: Error) => {
        sendResponse({ success: false, error: error.message } as ErrorResponse);
      });
  },

  GET_FAVICON: (request: unknown, sendResponse) => {
    const { domain } = request as GetFaviconRequest;
    const clean = (domain || '').trim().toLowerCase();

    (async () => {
      // 0. Instant direct icon for Google Workspace web apps (avoids accounts.google.com redirect)
      const directAppIcon = DIRECT_APP_ICONS[clean];
      if (directAppIcon) {
        const dataUrl = await fetchImageAsDataUrl(directAppIcon);
        if (dataUrl) {
          sendResponse({ success: true, data: dataUrl } as SuccessResponse<string>);
          return;
        }
      }

      // 1. Direct HTML <head> icon discovery (stops streaming immediately after </head>)
      try {
        const pageResp = await fetchWithTimeout(`https://${clean}/`, { redirect: 'follow' }, 3500);
        if (pageResp.ok) {
          const finalHost = new URL(pageResp.url).hostname.replace(/^www\./, '').toLowerCase();
          const baseHost = clean.replace(/^www\./, '').toLowerCase();
          const isAuthRedirect = /^(accounts|login|signin|auth)\./.test(finalHost) && finalHost !== baseHost;
          if (!isAuthRedirect) {
            const html = await readHtmlHead(pageResp, 36_000);
            const links = extractFirstIconFromHtml(html, pageResp.url);
            for (const link of links) {
              const dataUrl = await fetchImageAsDataUrl(link);
              if (dataUrl) {
                sendResponse({ success: true, data: dataUrl } as SuccessResponse<string>);
                return;
              }
            }
          } else {
            pageResp.body?.cancel().catch(() => undefined);
          }
        }
      } catch {
        // continue to direct paths & fallbacks
      }

      // 2. Direct paths + fallback providers
      const candidates = [
        `https://${clean}/favicon.svg`,
        `https://${clean}/apple-touch-icon.png`,
        `https://${clean}/favicon.ico`,
        `https://icons.duckduckgo.com/ip3/${encodeURIComponent(clean)}.ico`,
        `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(clean)}`
      ];

      for (const candidate of candidates) {
        const dataUrl = await fetchImageAsDataUrl(candidate);
        if (dataUrl) {
          sendResponse({ success: true, data: dataUrl } as SuccessResponse<string>);
          return;
        }
      }

      sendResponse({ success: false, error: 'Favicon unavailable' } as ErrorResponse);
    })();
  }
};

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  const handler = handlers[request?.action];
  if (!handler) return undefined;

  handler(request as never, sendResponse);
  // Returning true keeps the message channel open for the async response.
  return true;
});

// --- Context menu: "Add to Start" ---

const CONTEXT_MENU_ID = 'start-add-shortcut';

if (typeof chrome !== 'undefined' && chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Add to Start',
      contexts: ['link', 'page']
    });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;

    const url = info.linkUrl || info.pageUrl;
    if (!url) return;

    let title: string;
    if (tab?.title) {
      title = tab.title;
    } else {
      try {
        title = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      } catch {
        title = 'Shortcut';
      }
    }
    title = title.charAt(0).toUpperCase() + title.slice(1);

    chrome.storage.local.get(['shortcuts'], (result) => {
      const shortcuts = (result.shortcuts as Array<{ title: string; url: string }> | undefined) || [];
      if (shortcuts.some((s) => s.url === url)) return; // dedupe
      shortcuts.push({ title, url });
      chrome.storage.local.set({ shortcuts });
    });
  });
}

// --- Price history alarm ---

const PRICE_ALARM = 'fetch-prices';
const ALARM_MINUTES = 30;

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(PRICE_ALARM, {
      periodInMinutes: ALARM_MINUTES,
      delayInMinutes: 1 // first run after install
    });
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== PRICE_ALARM) return;

    // Fetch enabled assets and store history points
    try {
      const settingsResult = await chrome.storage.local.get(['settings']);
      const settings = settingsResult.settings as { finance?: { assets?: string[]; alerts?: Array<{ asset: string; above?: number; below?: number; enabled: boolean }> } } | undefined;
      const assets = settings?.finance?.assets || ['usd', 'gold'];

      for (const assetId of assets) {
        const assetDef = FINANCE_ASSETS[assetId as keyof typeof FINANCE_ASSETS];
        if (!assetDef) continue;
        const symbol = assetDef.tgju;
        try {
          const resp = await fetch(`https://api.tgju.org/v1/market/indicator/summary-table-data/${symbol}?length=1`);
          const json = await resp.json();
          const row = json.data?.[0];
          if (!row || !Array.isArray(row)) continue;

          const priceStr = String(row[3]).replace(/[^\d]/g, '');
          const price = parseInt(priceStr, 10);
          if (!Number.isFinite(price) || price <= 0) continue;

          // NOTE: Trend detection depends on TGJU's HTML class="high"/"low" on the change cell.
          // Fallback: if neither class matches, check for direction text (up/down) in the HTML
          // before defaulting to flat.
          const changeHtml = String(row[5] ?? '');
          let trend: 'up' | 'down' | 'flat' = 'flat';
          if (/class="high"/.test(changeHtml)) {
            trend = 'up';
          } else if (/class="low"/.test(changeHtml)) {
            trend = 'down';
          } else if (/\b(up|rising|▲|⬆)/i.test(changeHtml)) {
            trend = 'up';
          } else if (/\b(down|falling|▼|⬇)/i.test(changeHtml)) {
            trend = 'down';
          }

          const historyKey = 'priceHistory';
          const historyResult = await chrome.storage.local.get([historyKey]);
          const store = (historyResult[historyKey] || {}) as Record<string, Array<{ t: number; p: number; trend: string }>>;
          const arr = store[assetId] || [];
          arr.push({ t: Date.now(), p: price, trend });
          if (arr.length > 720) arr.splice(0, arr.length - 720);
          store[assetId] = arr;
          await chrome.storage.local.set({ [historyKey]: store });

          // Check threshold alerts
          const alerts = settings?.finance?.alerts || [];
          for (const alert of alerts) {
            if (!alert.enabled || alert.asset !== assetId) continue;
            const toman = price / 10;
            if (alert.above && toman >= alert.above) {
              const aboveId = `alert-${assetId}-above-${Date.now()}`;
              chrome.notifications.create(aboveId, {
                type: 'basic',
                title: `${assetId.toUpperCase()} Alert`,
                message: `${assetId.toUpperCase()} is above ${alert.above.toLocaleString()} Toman (${toman.toLocaleString()})`,
                priority: 2
              } as chrome.notifications.NotificationCreateOptions);
            }
            if (alert.below && toman <= alert.below) {
              const belowId = `alert-${assetId}-below-${Date.now()}`;
              chrome.notifications.create(belowId, {
                type: 'basic',
                title: `${assetId.toUpperCase()} Alert`,
                message: `${assetId.toUpperCase()} is below ${alert.below.toLocaleString()} Toman (${toman.toLocaleString()})`,
                priority: 2
              } as chrome.notifications.NotificationCreateOptions);
            }
          }
        } catch {
          // individual asset fetch failed — skip, try next
        }
      }
    } catch {
      // settings read failed — skip cycle
    }
  });
}
