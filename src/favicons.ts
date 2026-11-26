// High-res Favicon Fetcher + Post-Processing Engine (48x48 Retina Canvas).
// Fetches the actual site favicon (Google 128px -> DuckDuckGo -> Icon Horse via /api/favicon),
// extracts the icon's true dominant brand color, and renders it with fine Floyd-Steinberg
// error-diffusion dithering + organic film noise while preserving the exact icon silhouette.

import type { BookmarkIconStyle } from './types';

const FAVICON_KEY = 'faviconCacheV3';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CANVAS_SIZE = 48; // 2x+ Retina detail for 22x22 CSS display

interface CacheEntry {
  dataUrl: string;
  fetchedAt: number;
}

type FaviconCache = Record<string, CacheEntry>;

const memoryCache = new Map<string, string | null>();
const inflightFetches = new Map<string, Promise<string | null>>();

function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.id === 'string' &&
    chrome.runtime.id.length > 0
  );
}

function readCache(): Promise<FaviconCache> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([FAVICON_KEY], (result) => {
        resolve((result?.[FAVICON_KEY] as FaviconCache | undefined) ?? {});
      });
    } catch {
      resolve({});
    }
  });
}

function writeCache(cache: FaviconCache): void {
  try {
    chrome.storage.local.set({ [FAVICON_KEY]: cache });
  } catch {
    // storage unavailable
  }
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

async function fetchFaviconDataUrl(domain: string): Promise<string | null> {
  const endpoints = isExtensionContext()
    ? [
        `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
        `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`
      ]
    : [`/api/favicon?domain=${encodeURIComponent(domain)}`];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { credentials: 'omit' });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size < 80) continue;
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl && !dataUrl.endsWith('AA==')) {
        return dataUrl;
      }
    } catch {
      // try next endpoint
    }
  }
  return null;
}

export async function getFaviconDataUrl(url: string): Promise<string | null> {
  const domain = domainOf(url);
  if (!domain) return null;

  if (memoryCache.has(domain)) {
    return memoryCache.get(domain) ?? null;
  }

  const pending = inflightFetches.get(domain);
  if (pending) return pending;

  const task = (async (): Promise<string | null> => {
    const cache = await readCache();
    const entry = cache[domain];
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS && entry.dataUrl) {
      memoryCache.set(domain, entry.dataUrl);
      return entry.dataUrl;
    }

    const dataUrl = await fetchFaviconDataUrl(domain);
    if (dataUrl) {
      cache[domain] = { dataUrl, fetchedAt: Date.now() };
      writeCache(cache);
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

// Fast deterministic pixel noise in [-1, 1] for subtle analog grain
function pixelNoise(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return ((n >>> 0) / 4294967295) * 2 - 1;
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
    if (a < 64) continue;
    opaqueTotal++;

    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);

    if (s < 0.15 || l < 0.08 || l > 0.94) continue;
    chromaticTotal++;

    const sector = Math.floor(h * 36) % 36;
    const weight = (a / 255) * (0.25 + s * 2.0) * (1 - Math.abs(l - 0.5) * 0.6);
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

  if (best && opaqueTotal > 0 && chromaticTotal / opaqueTotal > 0.05) {
    const avgR = best.rSum / best.weight;
    const avgG = best.gSum / best.weight;
    const avgB = best.bSum / best.weight;
    const [h, s, l] = rgbToHsl(avgR, avgG, avgB);
    const calibratedS = Math.min(0.96, Math.max(0.58, s));
    const calibratedL = dark
      ? Math.min(0.72, Math.max(0.54, l))
      : Math.min(0.46, Math.max(0.30, l));
    return { rgb: hslToRgb(h, calibratedS, calibratedL), isChromatic: true };
  }

  return {
    rgb: dark ? [228, 228, 232] : [32, 34, 38],
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

// Compute a clean perceptual ink density buffer (0..1) that preserves the ACTUAL favicon silhouette:
// - Colored badge + white inner symbol (YouTube, Reddit, LinkedIn) -> solid dithered badge + crisp knockout glyph
// - Colored badge + dark inner symbol (Spotify) -> solid dithered badge + crisp knockout glyph
// - White square card + dark/colored logo -> drops white box, inks the logo
// - Dark silhouette on transparent (GitHub, X, Notion) -> inks the entire silhouette sharply
// - Detailed / multicolored mark on transparent (Gmail, Google, Wikipedia) -> preserves folds & contrast
function buildInkDensityField(src: Uint8ClampedArray, size: number): {
  density: Float32Array;
  mask: Uint8Array;
} {
  const n = size * size;
  const lumArr = new Float32Array(n);
  const satArr = new Float32Array(n);
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
    lumArr[i] = lum;
    satArr[i] = s;

    if (a > 0.35) {
      opaqueCount++;
      lumSum += lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
      if (s >= 0.18 && l >= 0.12 && l <= 0.9) chromaticCount++;
      if (s < 0.14 && lum > 0.84) whiteCount++;
      if (lum < 0.16) veryDarkCount++;
    }
  }

  // Sample inner-corner points (inset by 4px to catch rounded squares)
  const inset = 4;
  const corners = [
    inset * size + inset,
    inset * size + (size - 1 - inset),
    (size - 1 - inset) * size + inset,
    (size - 1 - inset) * size + (size - 1 - inset)
  ];
  let opaqueCorners = 0;
  let whiteCorners = 0;
  for (const idx of corners) {
    if (alphaArr[idx] > 0.7) {
      opaqueCorners++;
      if (satArr[idx] < 0.14 && lumArr[idx] > 0.84) whiteCorners++;
    }
  }

  const chromaticFrac = opaqueCount > 0 ? chromaticCount / opaqueCount : 0;
  const whiteFrac = opaqueCount > 0 ? whiteCount / opaqueCount : 0;
  const darkFrac = opaqueCount > 0 ? veryDarkCount / opaqueCount : 0;
  const avgLum = opaqueCount > 0 ? lumSum / opaqueCount : 0.5;
  const lumRange = Math.max(0.18, maxLum - minLum);

  const hasWhiteCardBg = whiteCorners >= 3 && opaqueCorners >= 3;
  const isColoredBadgeWithWhiteGlyph =
    !hasWhiteCardBg && chromaticFrac > 0.32 && whiteFrac > 0.03 && whiteFrac < 0.52;
  const isColoredBadgeWithDarkGlyph =
    !hasWhiteCardBg && !isColoredBadgeWithWhiteGlyph && chromaticFrac > 0.35 && darkFrac > 0.04 && darkFrac < 0.45;
  const isDarkSilhouette =
    !hasWhiteCardBg && opaqueCorners <= 2 && chromaticFrac < 0.18 && avgLum < 0.36;

  const density = new Float32Array(n);
  const mask = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const a = alphaArr[i];
    if (a < 0.14) continue;

    const lum = lumArr[i];
    const sat = satArr[i];
    let d = 0;

    if (hasWhiteCardBg) {
      // Drop pure-white outer square; keep the logo inside strong and sharp
      const whiteness = (1 - sat) * lum;
      if (whiteness > 0.86) continue;
      d = Math.min(1, ((1 - lum) * 0.95 + sat * 0.55) * 1.15) * a;
    } else if (isColoredBadgeWithWhiteGlyph) {
      // e.g. YouTube red badge + white play triangle, Reddit orange + white alien, LinkedIn blue + white "in"
      const isWhiteGlyph = sat < 0.16 && lum > 0.78;
      if (isWhiteGlyph) {
        // Crisp negative-space knockout so the inner symbol is unmistakably sharp
        d = Math.max(0, (0.94 - lum) * 0.5) * a;
      } else {
        // Finely stippled solid brand-color badge body
        const shade = 0.72 + 0.24 * Math.min(1, sat + (1 - Math.abs(lum - 0.48)));
        d = shade * a;
      }
    } else if (isColoredBadgeWithDarkGlyph) {
      // e.g. Spotify green circle + black sound waves
      if (lum < 0.2 && sat < 0.22) {
        d = lum * 0.4 * a;
      } else {
        d = (0.76 + 0.2 * Math.min(1, sat)) * a;
      }
    } else if (isDarkSilhouette) {
      // e.g. GitHub black octocat, X logo, Notion, Apple on transparent
      d = (0.74 + 0.26 * (1 - lum)) * a;
    } else {
      // e.g. Gmail 'M', Google 'G', Wikipedia 3D globe, Figma, Slack
      const stretched = (lum - minLum) / lumRange;
      if (chromaticFrac < 0.15) {
        // Grayscale detailed icon (like Wikipedia globe): keep bright facets inked, dark ink lines carved out
        d = (0.14 + 0.86 * stretched) * a;
      } else {
        // Multicolored transparent mark (Gmail, Google, Figma): strong uniform readability + fold shading
        d = (0.58 + 0.40 * (0.5 * stretched + 0.5 * sat)) * a;
      }
    }

    mask[i] = 1;
    density[i] = Math.max(0, Math.min(1, d));
  }

  return { density, mask };
}

function renderProcessedIcon(
  img: HTMLImageElement,
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

  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Draw with 2px breathing inset so edge strokes never clip
  ctx.drawImage(img, 2, 2, size - 4, size - 4);

  const src = ctx.getImageData(0, 0, size, size).data;
  const dark = isDarkScheme();
  const extracted = extractDominantSolidColor(src);
  const [cr, cg, cb] =
    style === 'monochrome'
      ? (dark ? [226, 226, 230] : [32, 34, 38])
      : extracted.rgb;

  const { density, mask } = buildInkDensityField(src, size);
  const out = ctx.createImageData(size, size);
  const dst = out.data;

  if (style === 'grain') {
    // Smooth solid-brand-color icon with tactile analog film grain noise (no binary cutoff)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!mask[i]) continue;
        const grain = pixelNoise(x, y) * 0.16;
        const alpha = Math.max(0, Math.min(1, density[i] + grain));
        if (alpha < 0.05) continue;
        const p = i * 4;
        dst[p] = cr;
        dst[p + 1] = cg;
        dst[p + 2] = cb;
        dst[p + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  // Default ('dithered') & 'monochrome':
  // Fine 48x48 Floyd-Steinberg error-diffusion dithering + subtle organic noise
  // Strictly single solid extracted brand color, razor-sharp silhouette, zero halo bleed.
  const buf = new Float32Array(density.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!mask[i]) continue;
      // Add subtle deterministic film grain before error diffusion so solid areas have rich texture
      buf[i] = Math.max(0, Math.min(1, density[i] + pixelNoise(x, y) * 0.08));
    }
  }

  for (let y = 0; y < size; y++) {
    // Serpentine scan alternates left-to-right and right-to-left to eliminate directional streaking
    const leftToRight = (y & 1) === 0;
    const xStart = leftToRight ? 0 : size - 1;
    const xEnd = leftToRight ? size : -1;
    const xStep = leftToRight ? 1 : -1;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const i = y * size + x;
      if (!mask[i]) continue;

      const oldVal = buf[i];
      const newVal = oldVal >= 0.48 ? 1 : 0;
      const err = oldVal - newVal;

      if (newVal === 1) {
        const p = i * 4;
        dst[p] = cr;
        dst[p + 1] = cg;
        dst[p + 2] = cb;
        dst[p + 3] = 255;
      }

      const nx = x + xStep;
      const px = x - xStep;
      const ny = y + 1;

      if (nx >= 0 && nx < size && mask[y * size + nx]) {
        buf[y * size + nx] += err * (7 / 16);
      }
      if (ny < size) {
        if (px >= 0 && px < size && mask[ny * size + px]) {
          buf[ny * size + px] += err * (3 / 16);
        }
        if (mask[ny * size + x]) {
          buf[ny * size + x] += err * (5 / 16);
        }
        if (nx >= 0 && nx < size && mask[ny * size + nx]) {
          buf[ny * size + nx] += err * (1 / 16);
        }
      }
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

// --- Clean fallback monogram with fine grain if a domain has no reachable favicon ---

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

  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(5, 5, size - 10, size - 10);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 24px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((domain[0] || '?').toUpperCase(), size / 2, size / 2 + 1);

  const src = ctx.getImageData(0, 0, size, size).data;
  const out = ctx.createImageData(size, size);
  const dst = out.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const a = src[p + 3] / 255;
      if (a < 0.1) continue;
      const intensity = a + pixelNoise(x, y) * 0.14;
      if (intensity > 0.42) {
        dst[p] = cr;
        dst[p + 1] = cg;
        dst[p + 2] = cb;
        dst[p + 3] = 255;
      }
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

export async function createFaviconElement(
  url: string,
  style: BookmarkIconStyle = 'dithered'
): Promise<HTMLElement | null> {
  if (style === 'off') return null;
  const domain = domainOf(url);
  if (!domain) return null;

  const dataUrl = await getFaviconDataUrl(url);
  if (dataUrl) {
    const img = await loadImage(dataUrl);
    if (img && img.naturalWidth > 0) {
      return renderProcessedIcon(img, style);
    }
  }

  return renderFallbackMonogram(domain, style);
}
