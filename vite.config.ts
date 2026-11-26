import { defineConfig, type Plugin } from 'vite';
import { crx, defineManifest } from '@crxjs/vite-plugin';

const manifest = defineManifest({
  manifest_version: 3,
  name: 'Start',
  version: '1.1.0',
  description: 'A modern, customizable new tab page with shortcuts and price ticker.',
  permissions: ['storage', 'tabs', 'bookmarks', 'history', 'contextMenus', 'alarms', 'notifications'],
  host_permissions: [
    '*://*.google.com/*',
    '*://*.tgju.org/*',
    '*://brsapi.ir/*',
    '*://api.rss2json.com/*',
    '*://api.open-meteo.com/*',
    '*://air-quality-api.open-meteo.com/*',
    '*://geocoding-api.open-meteo.com/*',
    '*://photon.komoot.io/*',
    '*://nominatim.openstreetmap.org/*',
    '*://icons.duckduckgo.com/*',
    '*://*.gstatic.com/*'
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
  'nominatim.openstreetmap.org'
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

async function fetchFaviconBinary(domain: string): Promise<{ buf: Uint8Array; contentType: string } | null> {
  const candidates = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
    `https://icon.horse/icon/${encodeURIComponent(domain)}`
  ];

  for (const url of candidates) {
    try {
      const upstream = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 StartNewTab/1.1' },
        signal: AbortSignal.timeout(4500)
      });
      if (!upstream.ok) continue;
      const contentType = upstream.headers.get('content-type') || 'image/png';
      if (!contentType.startsWith('image/')) continue;
      const buf = new Uint8Array(await upstream.arrayBuffer());
      if (buf.byteLength < 80) continue;
      return { buf, contentType };
    } catch {
      // try next provider
    }
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
