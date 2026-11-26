// Direct-Site Favicon Fetcher + Clean Ordered-Halftone Post-Processing Engine.
// Captures native SVG/PNG icons directly from each website (or Chrome's native /_favicon/ in extension mode),
// extracts the icon's dominant brand color, and renders crisp 44x44 (2x Retina) icons with zero noisy dirt.

import type { BookmarkIconStyle } from './types';

const FAVICON_KEY = 'faviconCacheV4';
const PROCESSED_KEY = 'faviconProcessedV5';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CANVAS_SIZE = 44; // Exact 2x Retina for 22x22 CSS display (zero nearest-neighbor aliasing)
const MAX_CONCURRENT_FETCHES = 2;

// Normalized 4x4 Bayer ordered dithering threshold matrix (values in 0..1)
const BAYER_4X4 = [
  [0 / 16, 8 / 16, 2 / 16, 10 / 16],
  [12 / 16, 4 / 16, 14 / 16, 6 / 16],
  [3 / 16, 11 / 16, 1 / 16, 9 / 16],
  [15 / 16, 7 / 16, 13 / 16, 5 / 16]
];

interface CacheEntry {
  dataUrl: string;
  fetchedAt: number;
}

type FaviconCache = Record<string, CacheEntry>;

const memoryCache = new Map<string, string | null>();
const inflightFetches = new Map<string, Promise<string | null>>();

let rawCacheData: FaviconCache | null = null;
let processedCacheData: FaviconCache | null = null;
let cachesLoadPromise: Promise<void> | null = null;
let flushTimer: number | undefined;
let rawDirty = false;
let processedDirty = false;

// Simple concurrency limiter so uncached favicon fetches never flood Chrome's network stack
let activeFetches = 0;
const fetchWaiters: Array<() => void> = [];

async function withFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    await new Promise<void>((resolve) => fetchWaiters.push(resolve));
  }
  activeFetches++;
  try {
    return await fn();
  } finally {
    activeFetches--;
    const next = fetchWaiters.shift();
    if (next) next();
  }
}

function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.id === 'string' &&
    chrome.runtime.id.length > 0
  );
}

function ensureCachesLoaded(): Promise<void> {
  if (rawCacheData && processedCacheData) return Promise.resolve();
  if (cachesLoadPromise) return cachesLoadPromise;

  cachesLoadPromise = new Promise<void>((resolve) => {
    try {
      chrome.storage.local.get([FAVICON_KEY, PROCESSED_KEY], (result) => {
        rawCacheData = (result?.[FAVICON_KEY] as FaviconCache | undefined) ?? {};
        processedCacheData = (result?.[PROCESSED_KEY] as FaviconCache | undefined) ?? {};
        resolve();
      });
    } catch {
      rawCacheData = {};
      processedCacheData = {};
      resolve();
    }
  });
  return cachesLoadPromise;
}

function scheduleCacheFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    const payload: Record<string, FaviconCache> = {};
    if (rawDirty && rawCacheData) {
      payload[FAVICON_KEY] = rawCacheData;
      rawDirty = false;
    }
    if (processedDirty && processedCacheData) {
      payload[PROCESSED_KEY] = processedCacheData;
      processedDirty = false;
    }
    if (Object.keys(payload).length > 0) {
      try {
        chrome.storage.local.set(payload);
      } catch {
        // storage unavailable
      }
    }
  }, 400);
}

export function domainOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function fetchViaBackgroundFavicon(domain: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'GET_FAVICON', domain }, (response) => {
        if (chrome.runtime.lastError || !response?.success || typeof response.data !== 'string') {
          resolve(null);
          return;
        }
        resolve(response.data);
      });
    } catch {
      resolve(null);
    }
  });
}

async function fetchChromeNativeFavicon(fullUrl: string): Promise<string | null> {
  try {
    const nativeUrl = chrome.runtime.getURL(
      `/_favicon/?pageUrl=${encodeURIComponent(fullUrl)}&size=64`
    );
    const resp = await fetch(nativeUrl);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (blob.size < 80) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

async function fetchFaviconDataUrl(domain: string, fullUrl: string): Promise<string | null> {
  if (isExtensionContext()) {
    // 1. Direct website HTML/SVG/PNG icon capture via extension background worker
    const direct = await fetchViaBackgroundFavicon(domain);
    if (direct) return direct;
    // 2. Chrome MV3 built-in local /_favicon/ API (zero 3rd-party dependency)
    const native = await fetchChromeNativeFavicon(fullUrl);
    if (native) return native;
    return null;
  }

  // Web preview: direct website HTML/SVG/PNG discovery via /api/favicon
  try {
    const response = await fetch(`/api/favicon?domain=${encodeURIComponent(domain)}`, {
      credentials: 'omit'
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size < 60) return null;
    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl && !dataUrl.endsWith('AA==')) {
      return dataUrl;
    }
  } catch {
    // fallback handled by monogram
  }
  return null;
}

export async function getFaviconDataUrl(url: string): Promise<string | null> {
  const domain = domainOf(url);
  if (!domain) return null;
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;

  if (memoryCache.has(domain)) {
    return memoryCache.get(domain) ?? null;
  }

  const pending = inflightFetches.get(domain);
  if (pending) return pending;

  const task = (async (): Promise<string | null> => {
    await ensureCachesLoaded();
    const cache = rawCacheData!;
    const entry = cache[domain];
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS && entry.dataUrl) {
      memoryCache.set(domain, entry.dataUrl);
      return entry.dataUrl;
    }

    const dataUrl = await withFetchSlot(() => fetchFaviconDataUrl(domain, fullUrl));
    if (dataUrl) {
      cache[domain] = { dataUrl, fetchedAt: Date.now() };
      rawDirty = true;
      scheduleCacheFlush();
      memoryCache.set(domain, dataUrl);
      return dataUrl;
    }
    memoryCache.set(domain, null);
    return null;
  })();

  inflightFetches.set(domain, task);
  try {
    return await task;
  } finally {
    inflightFetches.delete(domain);
  }
}

// --- Color math & dominant brand color extraction ---

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  ];
}

function isDarkScheme(): boolean {
  return document.documentElement.dataset.colorScheme !== 'light';
}

function extractDominantSolidColor(pixels: Uint8ClampedArray): {
  rgb: [number, number, number];
  isChromatic: boolean;
} {
  const buckets = new Map<
    number,
    { weight: number; rSum: number; gSum: number; bSum: number }
  >();

  let opaqueTotal = 0;
  let chromaticTotal = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 100) continue;
    opaqueTotal++;

    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);

    if (s < 0.16 || l < 0.08 || l > 0.93) continue;
    chromaticTotal++;

    const sector = Math.floor(h * 36) % 36;
    const weight = (a / 255) * (0.25 + s * 2.2) * (1 - Math.abs(l - 0.5) * 0.55);
    const existing = buckets.get(sector);
    if (existing) {
      existing.weight += weight;
      existing.rSum += r * weight;
      existing.gSum += g * weight;
      existing.bSum += b * weight;
    } else {
      buckets.set(sector, { weight, rSum: r * weight, gSum: g * weight, bSum: b * weight });
    }
  }

  const dark = isDarkScheme();
  let best: { weight: number; rSum: number; gSum: number; bSum: number } | null = null;
  for (const b of buckets.values()) {
    if (!best || b.weight > best.weight) best = b;
  }

  if (best && opaqueTotal > 0 && chromaticTotal / opaqueTotal > 0.04) {
    const avgR = best.rSum / best.weight;
    const avgG = best.gSum / best.weight;
    const avgB = best.bSum / best.weight;
    const [h, s, l] = rgbToHsl(avgR, avgG, avgB);
    const calibratedS = Math.min(0.95, Math.max(0.60, s));
    const calibratedL = dark
      ? Math.min(0.70, Math.max(0.55, l))
      : Math.min(0.45, Math.max(0.30, l));
    return { rgb: hslToRgb(h, calibratedS, calibratedL), isChromatic: true };
  }

  return {
    rgb: dark ? [228, 228, 232] : [28, 30, 34],
    isChromatic: false
  };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Compute a razor-clean perceptual density & crisp edge alpha field (0..1).
// Eliminates anti-aliased fringe dirt and cleanly preserves inner white/dark cutouts
// such as YouTube's white play triangle, Reddit's Snoo, LinkedIn's "in", and Spotify's waves.
function buildCleanInkField(src: Uint8ClampedArray, size: number): {
  density: Float32Array;
  edgeAlpha: Float32Array;
} {
  const n = size * size;
  const lumArr = new Float32Array(n);
  const satArr = new Float32Array(n);
  const whiteArr = new Float32Array(n); // min(r,g,b)/255 — near 0 for vivid brand colors, ~1 for white glyphs
  const alphaArr = new Float32Array(n);

  let opaqueCount = 0;
  let chromaticCount = 0;
  let whiteCount = 0;
  let veryDarkCount = 0;
  let lumSum = 0;
  let minLum = 1;
  let maxLum = 0;

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = src[p + 3] / 255;
    alphaArr[i] = a;
    if (a < 0.08) continue;

    const r = src[p];
    const g = src[p + 1];
    const b = src[p + 2];
    const [, s, l] = rgbToHsl(r, g, b);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const whiteness = Math.min(r, g, b) / 255;
    lumArr[i] = lum;
    satArr[i] = s;
    whiteArr[i] = whiteness;

    if (a > 0.45) {
      opaqueCount++;
      lumSum += lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
      if (s >= 0.18 && l >= 0.12 && l <= 0.90 && whiteness < 0.55) chromaticCount++;
      if (whiteness > 0.68 && lum > 0.78) whiteCount++;
      if (lum < 0.16) veryDarkCount++;
    }
  }

  // Sample inset corners to detect solid white square/rounded-square icon cards
  const inset = 5;
  const corners = [
    inset * size + inset,
    inset * size + (size - 1 - inset),
    (size - 1 - inset) * size + inset,
    (size - 1 - inset) * size + (size - 1 - inset)
  ];
  let opaqueCorners = 0;
  let whiteCorners = 0;
  for (const idx of corners) {
    if (alphaArr[idx] > 0.72) {
      opaqueCorners++;
      if (whiteArr[idx] > 0.78 && lumArr[idx] > 0.84) whiteCorners++;
    }
  }

  const chromaticFrac = opaqueCount > 0 ? chromaticCount / opaqueCount : 0;
  const whiteFrac = opaqueCount > 0 ? whiteCount / opaqueCount : 0;
  const darkFrac = opaqueCount > 0 ? veryDarkCount / opaqueCount : 0;
  const avgLum = opaqueCount > 0 ? lumSum / opaqueCount : 0.5;
  const lumRange = Math.max(0.20, maxLum - minLum);

  const hasWhiteCardBg = whiteCorners >= 3 && opaqueCorners >= 3;
  // Catch even small inner white glyphs like YouTube's play triangle (~1.5-5% of icon area)
  const isColoredBadgeWithWhiteGlyph =
    !hasWhiteCardBg && chromaticFrac > 0.28 && whiteFrac > 0.008 && whiteFrac < 0.58;
  const isColoredBadgeWithDarkGlyph =
    !hasWhiteCardBg &&
    !isColoredBadgeWithWhiteGlyph &&
    chromaticFrac > 0.35 &&
    darkFrac > 0.02 &&
    darkFrac < 0.48;
  const isDarkSilhouette =
    !hasWhiteCardBg && opaqueCorners <= 2 && chromaticFrac < 0.18 && avgLum < 0.38;

  const density = new Float32Array(n);
  const edgeAlpha = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = alphaArr[i];
    if (a < 0.18) continue;

    const lum = lumArr[i];
    const sat = satArr[i];
    const whiteness = whiteArr[i];
    let d = 0;
    let ea = a;

    if (hasWhiteCardBg) {
      // Cleanly drop white outer card so only the emblem renders
      if (whiteness > 0.78 && lum > 0.84) continue;
      const strength = Math.min(1, ((1 - lum) * 1.15 + sat * 0.75) * 1.25);
      d = 0.45 + 0.55 * strength;
      ea = Math.min(1, a * Math.min(1, (0.86 - whiteness) * 5));
    } else if (isColoredBadgeWithWhiteGlyph) {
      // YouTube, Reddit, LinkedIn, etc. — crisp colored badge + razor-sharp negative-space glyph cutout
      if (whiteness > 0.44) {
        d = 0;
        ea = 0;
      } else if (whiteness > 0.24) {
        // Smooth anti-aliased transition right along the triangle/glyph edge
        const t = (0.44 - whiteness) / 0.20;
        d = 0.76 * t;
        ea = a * t;
      } else {
        d = 0.74 + 0.14 * Math.min(1, sat);
      }
    } else if (isColoredBadgeWithDarkGlyph) {
      // Spotify, etc. — crisp colored badge + sharp dark-wave cutout
      if (lum < 0.24 && sat < 0.26) {
        d = 0;
        ea = 0;
      } else {
        d = 0.76 + 0.14 * Math.min(1, sat);
      }
    } else if (isDarkSilhouette) {
      // GitHub, X, Notion, Apple — crisp solid silhouette
      d = 0.78 + 0.16 * (1 - lum);
    } else {
      // Gmail, Google, Wikipedia globe, Figma, Slack
      const stretched = (lum - minLum) / lumRange;
      if (chromaticFrac < 0.15) {
        // Monochrome detailed emblem (e.g., Wikipedia globe): clear highlight vs ink contrast
        d = 0.16 + 0.78 * stretched;
      } else {
        // Multicolored emblem on transparent: also knock out pure white interior highlights
        if (whiteness > 0.72 && lum > 0.82) {
          d = 0;
          ea = 0;
        } else {
          d = 0.66 + 0.24 * (0.45 * stretched + 0.55 * sat);
        }
      }
    }

    density[i] = Math.max(0, Math.min(1, d));
    edgeAlpha[i] = Math.max(0, Math.min(1, ea));
  }

  return { density, edgeAlpha };
}

function renderProcessedIcon(
  img: HTMLImageElement,
  style: Exclude<BookmarkIconStyle, 'off'>
): HTMLCanvasElement {
  const size = CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'shortcut-favicon-canvas' + (style === 'original' ? ' is-original' : '');
  canvas.setAttribute('aria-hidden', 'true');

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Preserve aspect ratio inside a clean centered box with 2px breathing inset
  const maxDim = size - 4;
  const nw = img.naturalWidth || maxDim;
  const nh = img.naturalHeight || maxDim;
  const scale = Math.min(maxDim / nw, maxDim / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);

  // 'original' mode: crisp native captured site icon without color/dither manipulation
  if (style === 'original') {
    return canvas;
  }

  const src = ctx.getImageData(0, 0, size, size).data;
  const dark = isDarkScheme();
  const extracted = extractDominantSolidColor(src);
  const [cr, cg, cb] =
    style === 'monochrome'
      ? (dark ? [228, 228, 232] : [28, 30, 34])
      : extracted.rgb;

  const { density, edgeAlpha } = buildCleanInkField(src, size);
  const out = ctx.createImageData(size, size);
  const dst = out.data;

  if (style === 'solid') {
    // Clean, razor-sharp anti-aliased silhouette in the extracted solid brand color
    for (let i = 0; i < size * size; i++) {
      const ea = edgeAlpha[i];
      if (ea < 0.08) continue;
      const d = density[i];
      if (d < 0.06) continue;
      const alpha = Math.min(1, ea * (0.32 + 0.68 * d));
      const p = i * 4;
      dst[p] = cr;
      dst[p + 1] = cg;
      dst[p + 2] = cb;
      dst[p + 3] = Math.round(alpha * 255);
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  // 'dithered' & 'monochrome':
  // Fine 1px physical-pixel 4x4 Bayer ordered halftone at 2x Retina (44x44 -> 22x22 CSS).
  // Eliminates chunky polka-dot grids while keeping crisp silhouettes and inner cutouts.
  for (let y = 0; y < size; y++) {
    const by = y & 3;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const ea = edgeAlpha[i];
      if (ea < 0.40) continue;

      const d = density[i];
      if (d <= 0.05) continue;

      const bx = x & 3;
      const threshold = BAYER_4X4[by][bx];
      // Calibrated micro-halftone range: fine uniform texture without chunky holes
      const tone = Math.min(0.86, d * 0.94);

      if (tone > threshold) {
        const p = i * 4;
        dst[p] = cr;
        dst[p + 1] = cg;
        dst[p + 2] = cb;
        dst[p + 3] = Math.round(Math.min(1, (ea - 0.30) / 0.55) * 255);
      }
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

// --- Clean geometric monogram fallback if a domain is completely unreachable ---

const FALLBACK_HUES = [14, 210, 155, 38, 340, 265, 188, 92];

function hueFor(domain: string): number {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length];
}

function renderFallbackMonogram(
  domain: string,
  style: Exclude<BookmarkIconStyle, 'off'>
): HTMLCanvasElement {
  const size = CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'shortcut-favicon-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  const dark = isDarkScheme();
  const [cr, cg, cb] =
    style === 'monochrome'
      ? (dark ? [220, 220, 224] : [36, 36, 40])
      : hslToRgb(hueFor(domain) / 360, 0.72, dark ? 0.62 : 0.42);

  ctx.strokeStyle = `rgb(${cr}, ${cg}, ${cb})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
  ctx.font = '600 22px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((domain[0] || '?').toUpperCase(), size / 2, size / 2 + 1);

  if (style === 'solid' || style === 'original') {
    return canvas;
  }

  const src = ctx.getImageData(0, 0, size, size).data;
  const out = ctx.createImageData(size, size);
  const dst = out.data;

  for (let y = 0; y < size; y++) {
    const by = (y >> 1) & 3;
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const a = src[p + 3] / 255;
      if (a < 0.35) continue;
      const threshold = BAYER_4X4[by][(x >> 1) & 3] * 0.7;
      if (a > threshold) {
        dst[p] = cr;
        dst[p + 1] = cg;
        dst[p + 2] = cb;
        dst[p + 3] = Math.round(a * 255);
      }
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

function createCachedImgElement(
  dataUrl: string,
  style: Exclude<BookmarkIconStyle, 'off'>
): HTMLImageElement {
  const img = document.createElement('img');
  img.src = dataUrl;
  img.width = 22;
  img.height = 22;
  img.decoding = 'async';
  img.alt = '';
  img.className = 'shortcut-favicon-canvas' + (style === 'original' ? ' is-original' : '');
  img.setAttribute('aria-hidden', 'true');
  return img;
}

export async function createFaviconElement(
  url: string,
  style: BookmarkIconStyle = 'dithered'
): Promise<HTMLElement | null> {
  if (style === 'off') return null;
  const domain = domainOf(url);
  if (!domain) return null;

  await ensureCachesLoaded();
  const scheme = isDarkScheme() ? 'dark' : 'light';
  const processedKey = `${domain}:${style}:${scheme}`;
  const cachedProcessed = processedCacheData?.[processedKey];
  if (
    cachedProcessed &&
    cachedProcessed.dataUrl &&
    Date.now() - cachedProcessed.fetchedAt < CACHE_TTL_MS
  ) {
    return createCachedImgElement(cachedProcessed.dataUrl, style);
  }

  const dataUrl = await getFaviconDataUrl(url);
  if (dataUrl) {
    const img = await loadImage(dataUrl);
    if (img && img.naturalWidth > 0) {
      const canvas = renderProcessedIcon(img, style);
      try {
        const pngDataUrl = canvas.toDataURL('image/png');
        if (pngDataUrl && processedCacheData) {
          processedCacheData[processedKey] = { dataUrl: pngDataUrl, fetchedAt: Date.now() };
          processedDirty = true;
          scheduleCacheFlush();
        }
      } catch {
        // canvas serialization skipped
      }
      return canvas;
    }
  }

  return renderFallbackMonogram(domain, style);
}
