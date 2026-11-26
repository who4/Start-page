import { defineConfig, type Plugin } from 'vite';
import { crx, defineManifest } from '@crxjs/vite-plugin';

const manifest = defineManifest({
  manifest_version: 3,
  name: 'Start',
  version: '1.1.0',
  description: 'A modern, customizable new tab page with shortcuts and price ticker.',
  permissions: ['storage', 'tabs', 'bookmarks', 'history', 'contextMenus', 'alarms', 'notifications', 'favicon'],
  host_permissions: [
    '*://*.google.com/*',
    '*://*.tgju.org/*',
    '*://brsapi.ir/*',
    '*://api.rss2json.com/*',
    '*://feeds.bbci.co.uk/*',
    '*://www.aljazeera.com/*',
    '*://hnrss.org/*',
    '*://www.theverge.com/*',
    '*://feeds.arstechnica.com/*',
    '*://*.iranmonitor.org/*',
    '*://api.open-meteo.com/*',
    '*://air-quality-api.open-meteo.com/*',
    '*://geocoding-api.open-meteo.com/*',
    '*://photon.komoot.io/*',
    '*://nominatim.openstreetmap.org/*',
    '*://icons.duckduckgo.com/*',
    '*://*.gstatic.com/*',
    'https://*/*'
  ],
  background: {
    service_worker: 'src/background.ts'
  },
  chrome_url_overrides: {
    newtab: 'src/newtab.html'
  },
  action: {
    default_icon: 'src/icon.png'
  },
  icons: {
    '128': 'src/icon.png'
  }
});

const ALLOWED_PROXY_HOSTS = [
  'google.com',
  'tgju.org',
  'brsapi.ir',
  'rss2json.com',
  'open-meteo.com',
  'photon.komoot.io',
  'nominatim.openstreetmap.org',
  'bbci.co.uk',
  'aljazeera.com',
  'hnrss.org',
  'theverge.com',
  'arstechnica.com',
  'iranmonitor.org'
];

function isAllowedHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_PROXY_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function isPublicHttpUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const h = parsed.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h === '0.0.0.0' ||
      h === '::1' ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^\[?(fe80|fc|fd)/i.test(h)
    ) {
      return false;
    }
    return isValidDomain(h);
  } catch {
    return false;
  }
}

function isValidDomain(domain: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain);
}

interface UnifiedGeoResult {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
}

async function fetchGeocodeWorldwide(query: string): Promise<UnifiedGeoResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const results: UnifiedGeoResult[] = [];
  const addUnique = (item: UnifiedGeoResult): void => {
    if (!item.name || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return;
    const duplicate = results.some(
      (r) =>
        Math.abs(r.latitude - item.latitude) < 0.14 &&
        Math.abs(r.longitude - item.longitude) < 0.14
    );
    if (!duplicate) results.push(item);
  };

  // Run Photon (OSM planet-wide fuzzy search) + Open-Meteo (population-ranked cities) in parallel
  const [photonRes, openMeteoRes] = await Promise.allSettled([
    fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=en`, {
      signal: AbortSignal.timeout(4500)
    }).then((r) => (r.ok ? r.json() : null)),
    fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.split(',')[0].trim())}&count=8&language=en&format=json`,
      { signal: AbortSignal.timeout(4500) }
    ).then((r) => (r.ok ? r.json() : null))
  ]);

  // 1. Open-Meteo top cities (only when query has no comma or matches country/admin)
  const commaParts = q
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (openMeteoRes.status === 'fulfilled' && Array.isArray(openMeteoRes.value?.results)) {
    for (const r of openMeteoRes.value.results as Array<{
      name: string;
      admin1?: string;
      country?: string;
      country_code?: string;
      latitude: number;
      longitude: number;
    }>) {
      if (commaParts.length > 1) {
        const qualifier = commaParts.slice(1).join(' ');
        const haystack = `${r.admin1 || ''} ${r.country || ''} ${r.country_code || ''}`.toLowerCase();
        if (!haystack.includes(qualifier)) continue;
      }
      addUnique({
        name: r.name,
        admin1: r.admin1,
        country: r.country,
        countryCode: r.country_code,
        latitude: Number(r.latitude.toFixed(4)),
        longitude: Number(r.longitude.toFixed(4))
      });
    }
  }

  // 2. Photon OSM results (cities, towns, villages, districts, neighborhoods, islands, worldwide)
  if (photonRes.status === 'fulfilled' && Array.isArray(photonRes.value?.features)) {
    for (const f of photonRes.value.features as Array<{
      properties?: {
        name?: string;
        city?: string;
        county?: string;
        state?: string;
        country?: string;
        countrycode?: string;
        osm_key?: string;
        osm_value?: string;
      };
      geometry?: { coordinates?: [number, number] };
    }>) {
      const props = f.properties;
      const coords = f.geometry?.coordinates;
      if (!props || !coords || coords.length < 2) continue;
      const name = props.name || props.city || props.county || props.state;
      if (!name) continue;
      const admin =
        props.state && props.state !== name
          ? props.state
          : props.county && props.county !== name
            ? props.county
            : undefined;
      addUnique({
        name,
        admin1: admin,
        country: props.country,
        countryCode: props.countrycode,
        latitude: Number(coords[1].toFixed(4)),
        longitude: Number(coords[0].toFixed(4))
      });
    }
  }

  // 3. Nominatim OSM fallback for commas, postal codes, obscure towns, or non-Latin scripts
  if (results.length < 4 || q.includes(',') || /\d/.test(q)) {
    try {
      const nomResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=8&accept-language=en`,
        {
          headers: { 'User-Agent': 'StartNewTab/1.1 (weather-city-picker)' },
          signal: AbortSignal.timeout(4500)
        }
      );
      if (nomResp.ok) {
        const nomData = (await nomResp.json()) as Array<{
          name?: string;
          display_name?: string;
          lat?: string;
          lon?: string;
          address?: {
            city?: string;
            town?: string;
            village?: string;
            municipality?: string;
            suburb?: string;
            county?: string;
            state?: string;
            country?: string;
            country_code?: string;
          };
        }>;
        for (const item of nomData) {
          const lat = parseFloat(item.lat || '');
          const lon = parseFloat(item.lon || '');
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const addr = item.address || {};
          const name =
            item.name ||
            addr.city ||
            addr.town ||
            addr.village ||
            addr.municipality ||
            addr.suburb ||
            addr.county ||
            (item.display_name || '').split(',')[0].trim();
          const admin1 = addr.state && addr.state !== name ? addr.state : addr.county && addr.county !== name ? addr.county : undefined;
          addUnique({
            name,
            admin1,
            country: addr.country,
            countryCode: addr.country_code?.toUpperCase(),
            latitude: Number(lat.toFixed(4)),
            longitude: Number(lon.toFixed(4))
          });
        }
      }
    } catch {
      // ignore fallback failure
    }
  }

  return results.slice(0, 8);
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Well-known auth-redirected web apps where unauthenticated GET redirects to accounts/login
const DIRECT_APP_ICONS: Record<string, string[]> = {
  'mail.google.com': [
    'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
    'https://www.google.com/s2/favicons?domain=mail.google.com&sz=128'
  ],
  'drive.google.com': [
    'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png',
    'https://www.google.com/s2/favicons?domain=drive.google.com&sz=128'
  ],
  'calendar.google.com': [
    'https://calendar.google.com/googlecalendar/images/favicons_2020q4/calendar_31.ico',
    'https://www.google.com/s2/favicons?domain=calendar.google.com&sz=128'
  ],
  'docs.google.com': [
    'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
    'https://www.google.com/s2/favicons?domain=docs.google.com&sz=128'
  ]
};

function parseHtmlIconLinks(html: string, baseUrl: string): string[] {
  const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
  const scan = headMatch ? headMatch[0] : html.slice(0, 32768);
  const linkTags = scan.match(/<link\b[^>]*>/gi) || [];
  const scored: Array<{ url: string; score: number }> = [];

  for (const tag of linkTags) {
    const relMatch = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const hrefMatch = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!relMatch || !hrefMatch) continue;

    const rel = (relMatch[1] || relMatch[2] || relMatch[3] || '').toLowerCase().trim();
    const rawHref = (hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '').trim();
    if (!rawHref || rawHref.startsWith('data:')) continue;
    if (!/\b(icon|apple-touch-icon|fluid-icon|shortcut)\b/.test(rel)) continue;
    if (rel.includes('mask-icon')) continue; // monochrome Safari mask icons often lack fill

    let resolved: string;
    try {
      resolved = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }

    const typeMatch = tag.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const sizesMatch = tag.match(/\bsizes\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const typeVal = (typeMatch?.[1] || typeMatch?.[2] || typeMatch?.[3] || '').toLowerCase();
    const sizesVal = (sizesMatch?.[1] || sizesMatch?.[2] || sizesMatch?.[3] || '').toLowerCase();

    let score = 50;
    if (typeVal.includes('svg') || /\.svg(\?|$)/i.test(resolved)) {
      score = 100; // Native vector SVG — sharpest possible capture
    } else if (rel.includes('apple-touch-icon') || rel.includes('fluid-icon')) {
      score = 82;
    } else if (/\.png(\?|$)/i.test(resolved) || typeVal.includes('png')) {
      score = 76;
    } else if (/\.webp(\?|$)/i.test(resolved)) {
      score = 72;
    } else if (/\.ico(\?|$)/i.test(resolved)) {
      score = 45;
    }

    const sizeNum = parseInt(sizesVal.split('x')[0] || '', 10);
    if (Number.isFinite(sizeNum)) {
      if (sizeNum >= 64 && sizeNum <= 256) score += 16;
      else if (sizeNum >= 32 && sizeNum < 64) score += 8;
      else if (sizeNum > 256) score += 6;
      else if (sizeNum <= 16) score -= 20;
    }

    scored.push({ url: resolved, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const unique: string[] = [];
  for (const item of scored) {
    if (!unique.includes(item.url)) unique.push(item.url);
  }
  return unique.slice(0, 6);
}

async function tryFetchImageUrl(url: string): Promise<{ buf: Uint8Array; contentType: string } | null> {
  if (!isPublicHttpUrl(url)) return null;
  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'image/svg+xml,image/png,image/webp,image/x-icon,image/*;q=0.8,*/*;q=0.5'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (!upstream.ok) return null;
    const rawCt = (upstream.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const buf = new Uint8Array(await upstream.arrayBuffer());
    if (buf.byteLength < 60 || buf.byteLength > 1_500_000) return null;

    // Reject HTML error/challenge pages masquerading as icons
    const headText = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 200)).trimStart();
    if (/^<!doctype\s+html|^<html\b/i.test(headText)) return null;

    let contentType = rawCt;
    if (headText.includes('<svg') || rawCt === 'image/svg+xml' || /\.svg(\?|$)/i.test(url)) {
      if (!headText.includes('<svg')) return null;
      contentType = 'image/svg+xml';
    } else if (!contentType.startsWith('image/')) {
      // Sniff magic bytes for servers that return application/octet-stream for .ico/.png
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        contentType = 'image/png';
      } else if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
        contentType = 'image/x-icon';
      } else if (buf[0] === 0xff && buf[1] === 0xd8) {
        contentType = 'image/jpeg';
      } else {
        return null;
      }
    }

    return { buf, contentType };
  } catch {
    return null;
  }
}

async function fetchFaviconBinary(domain: string): Promise<{ buf: Uint8Array; contentType: string } | null> {
  // 0. Known auth-redirected web apps
  const known = DIRECT_APP_ICONS[domain];
  if (known) {
    for (const url of known) {
      const hit = await tryFetchImageUrl(url);
      if (hit) return hit;
    }
  }

  // 1. Direct website HTML <link rel="icon"> discovery (gets native SVG & crisp high-res PNG directly from the site)
  try {
    const pageResp = await fetch(`https://${domain}/`, {
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(3500)
    });
    if (pageResp.ok) {
      const finalHost = new URL(pageResp.url).hostname.replace(/^www\./, '').toLowerCase();
      const baseHost = domain.replace(/^www\./, '').toLowerCase();
      const isAuthRedirect = /^(accounts|login|signin|auth)\./.test(finalHost) && finalHost !== baseHost;
      if (!isAuthRedirect) {
        const html = (await pageResp.text()).slice(0, 80_000);
        const discovered = parseHtmlIconLinks(html, pageResp.url);
        for (const iconUrl of discovered) {
          const hit = await tryFetchImageUrl(iconUrl);
          if (hit) return hit;
        }
      }
    }
  } catch {
    // proceed to direct well-known paths
  }

  // 2. Direct well-known site paths
  const directPaths = [
    `https://${domain}/favicon.svg`,
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/favicon.ico`
  ];
  for (const url of directPaths) {
    const hit = await tryFetchImageUrl(url);
    if (hit) return hit;
  }

  // 3. Fallback icon indexes only if site blocked direct capture
  const fallbacks = [
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
  ];
  for (const url of fallbacks) {
    const hit = await tryFetchImageUrl(url);
    if (hit) return hit;
  }

  return null;
}

function attachPreviewMiddlewares(middlewares: {
  use: (
    fn: (
      req: { url?: string },
      res: {
        statusCode: number;
        setHeader: (name: string, value: string) => void;
        end: (body?: string | Uint8Array) => void;
      },
      next: () => void
    ) => void
  ) => void;
}): void {
  middlewares.use((req, res, next) => {
    const rawUrl = req.url || '/';

    if (rawUrl === '/' || rawUrl === '/index.html') {
      req.url = '/newtab.html';
      next();
      return;
    }

    if (rawUrl.startsWith('/api/geocode')) {
      const parsed = new URL(rawUrl, 'http://localhost');
      const query = (parsed.searchParams.get('q') || '').trim();
      fetchGeocodeWorldwide(query)
        .then((results) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.end(JSON.stringify(results));
        })
        .catch(() => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end('[]');
        });
      return;
    }

    if (rawUrl.startsWith('/api/favicon')) {
      const parsed = new URL(rawUrl, 'http://localhost');
      const domain = (parsed.searchParams.get('domain') || '').trim().toLowerCase();
      if (!isValidDomain(domain)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Invalid domain');
        return;
      }

      fetchFaviconBinary(domain)
        .then((result) => {
          if (!result) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Favicon unavailable');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', result.contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.end(result.buf);
        })
        .catch(() => {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Favicon fetch failed');
        });
      return;
    }

    if (rawUrl.startsWith('/api/rss')) {
      const parsed = new URL(rawUrl, 'http://localhost');
      const targetUrl = (parsed.searchParams.get('url') || '').trim();
      if (!isPublicHttpUrl(targetUrl)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Invalid feed URL');
        return;
      }

      fetch(targetUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8'
        },
        signal: AbortSignal.timeout(7000)
      })
        .then(async (upstream) => {
          const text = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/xml; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end(text);
        })
        .catch((err: unknown) => {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(err instanceof Error ? err.message : 'RSS fetch failed');
        });
      return;
    }

    if (rawUrl.startsWith('/api/proxy')) {
      const parsed = new URL(rawUrl, 'http://localhost');
      const targetUrl = parsed.searchParams.get('url') || '';
      if (!isAllowedHost(targetUrl)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('URL not in allowlist');
        return;
      }

      fetch(targetUrl)
        .then(async (upstream) => {
          const text = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
          res.end(text);
        })
        .catch((err: unknown) => {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(err instanceof Error ? err.message : 'Upstream fetch failed');
        });
      return;
    }

    if (rawUrl.startsWith('/api/suggestions')) {
      const parsed = new URL(rawUrl, 'http://localhost');
      const query = parsed.searchParams.get('q') || '';
      if (!query) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end('[]');
        return;
      }

      const targetUrl = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;
      fetch(targetUrl)
        .then((upstream) => upstream.json() as Promise<unknown[]>)
        .then((data) => {
          const payload = Array.isArray(data?.[1]) ? data[1] : [];
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(payload));
        })
        .catch(() => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end('[]');
        });
      return;
    }

    next();
  });
}

function webPreviewPlugin(): Plugin {
  return {
    name: 'start-web-preview',
    enforce: 'post',
    configureServer(server) {
      attachPreviewMiddlewares(server.middlewares);
    },
    configurePreviewServer(server) {
      attachPreviewMiddlewares(server.middlewares);
    },
    generateBundle(_options, bundle) {
      const newtab = bundle['newtab.html'];
      if (newtab && newtab.type === 'asset') {
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: newtab.source
        });
      }
    }
  };
}

export default defineConfig(({ mode }) => {
  const isExtension = mode === 'extension';

  if (isExtension) {
    return {
      plugins: [crx({ manifest })],
      build: {
        outDir: 'extension',
        emptyOutDir: true
      }
    };
  }

  return {
    root: 'src',
    plugins: [webPreviewPlugin()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: {
        input: 'src/newtab.html'
      }
    }
  };
});
