import './chrome-shim';
import { ApiClient, type NewsArticle, type PriceData } from './api';
import { attachPasteCapture, getEmptyStateResults } from './chrome-providers';
import { ActionRegistry, CommandBarEngine, type BarResult } from './commandbar';
import {
  buildSearchUrl,
  FINANCE_ASSETS,
  getNewsSource,
  getSearchEngine,
  hostOfUrl,
  INTERVALS,
  STARTER_SHORTCUTS,
  STORAGE_KEYS,
  SUGGESTIONS,
  type FinanceAssetId,
  type MarketProviderId
} from './constants';
import {
  ensureFaviconCachesLoaded,
  getCachedFaviconElementSync,
  LazyFaviconBatchLoader,
  type LazyIconTask
} from './favicons';
import { BentoGrid, registry } from './grid';
import { t } from './i18n';
import { formatJalaliDate } from './jalali';
import { SpatialScratchpad } from './scratchpad';
import { SettingsUI, type SettingsSectionId } from './settings-ui';
import { storage } from './storage';
import { applyTheme, THEME_PRESETS } from './themes';
import type { NoteData, Settings, Shortcut } from './types';
import { createCalendarWidget } from './widget-calendar';
import { appendPricePoint, createFinanceWidget } from './widget-finance';
import { createRssWidget } from './widget-rss';
import {
  aqiDescriptor,
  createWeatherWidget,
  fetchWeatherData,
  formatTemp,
  getCachedWeather,
  type WeatherSnapshot
} from './widget-weather';

// Activate Google Fonts asynchronously without blocking first paint (MV3 CSP-safe)
const fontsLink = document.getElementById('google-fonts-link') as HTMLLinkElement | null;
if (fontsLink && fontsLink.media !== 'all') {
  const activateFonts = (): void => {
    fontsLink.media = 'all';
  };
  if (fontsLink.sheet) {
    activateFonts();
  } else {
    fontsLink.addEventListener('load', activateFonts, { once: true });
    window.setTimeout(activateFonts, 60);
  }
}

// --- Helpers ---
const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);
const ensureUrl = (url: string): string => (isHttpUrl(url) ? url : `https://${url}`);

function scheduleIdle(fn: () => void, timeoutMs = 240): void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn, { timeout: timeoutMs });
  } else {
    window.setTimeout(fn, 60);
  }
}

const preconnectedOrigins = new Set<string>();
function preconnectUrl(url: string): void {
  try {
    const origin = new URL(url).origin;
    if (!origin.startsWith('http') || preconnectedOrigins.has(origin) || preconnectedOrigins.size >= 16) return;
    preconnectedOrigins.add(origin);
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    document.head.appendChild(link);
  } catch {
    // ignore invalid URL
  }
}

// --- Global runtime state ---
let settings!: Settings;
let settingsUI: SettingsUI | null = null;
let deckGrid: BentoGrid | null = null;
let deckInitialized = false;
let deckInitPromise: Promise<void> | null = null;
let deckNeedsRefresh = false;
let scratchpad: SpatialScratchpad | null = null;
let drawerOpen = false;
let shortcutsCache: Shortcut[] = [];
let persistSettingsFn: ((updated: Settings) => Promise<void>) | null = null;

// --- Toast system (non-blocking, with optional Undo) ---
let toastTimer: number | undefined;

function showToast(message: string, onUndo?: () => void): void {
  const existing = document.getElementById('undo-toast');
  existing?.remove();
  window.clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.id = 'undo-toast';
  toast.className = 'undo-toast';
  toast.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (onUndo) {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'undo-btn';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => {
      toast.remove();
      window.clearTimeout(toastTimer);
      onUndo();
    });
    toast.appendChild(undoBtn);
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  toastTimer = window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), 220);
  }, onUndo ? 5000 : 2800);
}

// --- Clock & Dual Date ---
let lastDateCacheKey = '';
let lastDateDisplay = '';

const updateTime = (): void => {
  const now = new Date();
  const timeEl = document.getElementById('time-display');
  if (timeEl) {
    const use24 = settings?.general.clock24h ?? true;
    const showSec = settings?.general.showSeconds ?? true;
    timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: showSec ? '2-digit' : undefined,
      hour12: !use24
    });
  }

  const dateEl = document.getElementById('date-display');
  if (!dateEl) return;

  const calMode = settings?.general.calendar ?? 'gregorian';
  const showDual = settings?.general.showDualDate ?? true;
  const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}|${calMode}|${showDual ? 1 : 0}`;
  if (dateKey !== lastDateCacheKey) {
    lastDateCacheKey = dateKey;
    const gregStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    const jalaliStr = formatJalaliDate(now);
    if (showDual) {
      lastDateDisplay =
        calMode === 'jalali' ? `${jalaliStr}  ·  ${gregStr}` : `${gregStr}  ·  ${jalaliStr}`;
    } else {
      lastDateDisplay = calMode === 'jalali' ? jalaliStr : gregStr;
    }
    dateEl.textContent = lastDateDisplay;
  }
};

let clockTimer: number | undefined;
function startClock(): void {
  window.clearInterval(clockTimer);
  lastDateCacheKey = '';
  updateTime();
  clockTimer = window.setInterval(updateTime, 1000);
}

// --- Modular Workspace Drawer (Lazy-mounted on first open) ---
const drawerEl = document.getElementById('workspace-drawer')!;
const drawerBackdrop = document.getElementById('drawer-backdrop')!;
const deckHandleBtn = document.getElementById('deck-handle-btn');
const drawerCloseBtn = document.getElementById('drawer-close-btn');
const drawerCustomizeBtn = document.getElementById('drawer-customize-btn');

let deckModulesRegistered = false;
function registerDeckModules(): void {
  if (deckModulesRegistered) return;
  deckModulesRegistered = true;

  registry.register(
    createFinanceWidget({
      getSettings: () => settings,
      onUpdateAlerts: async (alerts) => {
        if (!persistSettingsFn) return;
        const next = structuredClone(settings);
        next.finance.alerts = alerts;
        await persistSettingsFn(next);
      }
    })
  );

  registry.register(
    createWeatherWidget({
      getSettings: () => settings,
      onUpdateLocation: async (loc) => {
        if (!persistSettingsFn) return;
        const next = structuredClone(settings);
        next.weather = { ...loc, unit: next.weather.unit ?? 'c' };
        await persistSettingsFn(next);
      }
    })
  );

  registry.register(createCalendarWidget({ getSettings: () => settings }));
  registry.register(createRssWidget());
}

async function ensureDeckInitialized(): Promise<void> {
  if (deckInitialized) return;
  if (deckInitPromise) return deckInitPromise;

  deckInitPromise = (async () => {
    registerDeckModules();
    const bentoContainer = document.getElementById('bento-container')!;
    const deckShelf = document.getElementById('deck-shelf');
    deckGrid = new BentoGrid({
      container: bentoContainer,
      shelfContainer: deckShelf
    });
    await deckGrid.init();
    deckInitialized = true;
    deckNeedsRefresh = false;
  })();

  return deckInitPromise;
}

async function openSettingsModal(section: SettingsSectionId = 'search'): Promise<void> {
  registerDeckModules();
  if (!settingsUI) {
    settingsUI = new SettingsUI(settings, {
      onChange: async (updated) => {
        if (persistSettingsFn) await persistSettingsFn(updated);
      },
      onModulesChange: async () => {
        if (deckInitialized && drawerOpen) {
          await deckGrid?.refresh();
        } else {
          deckNeedsRefresh = true;
        }
      },
      onToast: (msg) => showToast(msg)
    });
  }
  await settingsUI.open(section);
}

function setDrawerOpen(open: boolean, persist = true): void {
  drawerOpen = open;
  drawerEl.classList.toggle('is-open', open);
  drawerBackdrop.classList.toggle('is-open', open);
  drawerEl.setAttribute('aria-hidden', String(!open));
  drawerBackdrop.setAttribute('aria-hidden', String(!open));
  deckHandleBtn?.setAttribute('aria-expanded', String(open));
  deckHandleBtn?.classList.toggle('is-open', open);

  if (open) {
    requestAnimationFrame(() => {
      void ensureDeckInitialized().then(() => {
        if (deckNeedsRefresh) {
          deckNeedsRefresh = false;
          return deckGrid?.refresh();
        }
      });
    });
  }

  if (persist && settings?.general.rememberDrawerState) {
    void storage.setDrawerOpen(open);
  }
}

deckHandleBtn?.addEventListener('click', () => setDrawerOpen(!drawerOpen));
drawerCloseBtn?.addEventListener('click', () => setDrawerOpen(false));
drawerBackdrop.addEventListener('click', () => setDrawerOpen(false));

drawerCustomizeBtn?.addEventListener('click', () => {
  if (!deckGrid) return;
  const active = deckGrid.toggleCustomize();
  drawerCustomizeBtn.classList.toggle('is-active', active);
  drawerCustomizeBtn.textContent = active ? 'Done' : 'Customize';
});

// --- Command Bar ---
const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
const commandSlotEl = searchInput?.closest('.command-slot') as HTMLElement | null;
const suggestionsEl = document.getElementById('search-suggestions');
const modeIndicator = document.getElementById('command-mode-indicator');

let barEngine: CommandBarEngine | null = null;
const actionRegistry = new ActionRegistry();
let debounceTimer: number | undefined;
let currentResults: BarResult[] = [];
let currentResultsQuery = '';
let highlightedIndex = -1;
let userSelectedIndex = false;
let isLoadingSuggestions = false;
let searchSeq = 0;

function setSuggestionsLoading(loading: boolean): void {
  isLoadingSuggestions = loading;
  commandSlotEl?.classList.toggle('is-loading', loading);
  if (suggestionsEl) {
    suggestionsEl.setAttribute('aria-busy', String(loading));
  }
}

function syncSearchEngineUi(): void {
  if (!searchInput || !settings) return;
  const engine = getSearchEngine(settings.general.searchEngine, settings.general.customSearchUrl);
  searchInput.placeholder = `Search ${engine.name}...`;
}

function preconnectSearchEngine(): void {
  if (!settings) return;
  const engine = getSearchEngine(settings.general.searchEngine, settings.general.customSearchUrl);
  preconnectUrl(engine.origin);
  preconnectUrl(
    engine.suggestKind === 'duckduckgo'
      ? 'https://duckduckgo.com'
      : 'https://suggestqueries.google.com'
  );
}

function getShortcutCache(): Shortcut[] {
  return shortcutsCache;
}

function updateModeIndicator(query: string): void {
  if (!modeIndicator) return;
  if (query.startsWith('!')) {
    modeIndicator.textContent = '!';
    modeIndicator.dataset.mode = 'bang';
  } else if (query.startsWith('>')) {
    modeIndicator.textContent = '>';
    modeIndicator.dataset.mode = 'cmd';
  } else if (/\d/.test(query) && /[+\-*/%^×÷]|sqrt|sin|cos|tan|log|ln/i.test(query)) {
    modeIndicator.textContent = '=';
    modeIndicator.dataset.mode = 'calc';
  } else if (/\b(usdt|tether|usd|gold|dollar|toman|irt)\b|\$/i.test(query)) {
    modeIndicator.textContent = '⇄';
    modeIndicator.dataset.mode = 'money';
  } else {
    modeIndicator.textContent = '>';
    modeIndicator.dataset.mode = 'default';
  }
}

function renderBarResults(results: BarResult[]): void {
  if (!suggestionsEl) return;
  if (results.length === 0 && !isLoadingSuggestions) {
    clearBar();
    return;
  }

  const fragment = document.createDocumentFragment();
  const listWrap = document.createElement('div');
  listWrap.className = 'suggestions-list';

  results.forEach((r, index) => {
    const item = document.createElement('div');
    item.className = 'suggestion-item' + (index === highlightedIndex ? ' highlighted' : '');
    item.dataset.resultId = r.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === highlightedIndex));

    const iconSpan = document.createElement('span');
    iconSpan.className = `bar-icon bar-icon-${r.icon ?? 'search'}`;
    iconSpan.textContent =
      r.icon === 'calc' ? '=' :
      r.icon === 'money' ? '⇄' :
      r.icon === 'action' ? '▸' :
      r.icon === 'bang' ? '!' :
      r.icon === 'shortcut' ? '⌘' :
      r.icon === 'tab' ? '⧉' :
      r.icon === 'bookmark' ? '★' :
      r.icon === 'history' ? '↺' :
      r.icon === 'topsite' ? '▲' :
      r.icon === 'clipboard' ? '⎘' : '⌕';

    const textWrap = document.createElement('span');
    textWrap.className = 'bar-text-wrap';

    const title = document.createElement('span');
    title.className = 'bar-title';
    title.textContent = r.title;
    textWrap.appendChild(title);

    if (r.hint) {
      const hint = document.createElement('span');
      hint.className = 'bar-hint';
      hint.textContent = r.hint;
      textWrap.appendChild(hint);
    }

    item.append(iconSpan, textWrap);

    if (r.kbd) {
      const kbd = document.createElement('kbd');
      kbd.className = 'bar-kbd';
      kbd.textContent = r.kbd;
      item.appendChild(kbd);
    }

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      executeResult(r);
    });
    listWrap.appendChild(item);
  });

  if (isLoadingSuggestions) {
    const skeletonWidths = ['54%', '38%', '64%'];
    for (const width of skeletonWidths) {
      const skRow = document.createElement('div');
      skRow.className = 'suggestion-skeleton-row';
      skRow.setAttribute('aria-hidden', 'true');

      const skIcon = document.createElement('span');
      skIcon.className = 'skeleton-icon';

      const skText = document.createElement('span');
      skText.className = 'bar-text-wrap skeleton-text-wrap';

      const skTitle = document.createElement('span');
      skTitle.className = 'skeleton-line skeleton-line--title';
      skTitle.style.width = width;

      const skHint = document.createElement('span');
      skHint.className = 'skeleton-line skeleton-line--hint';

      skText.append(skTitle, skHint);
      skRow.append(skIcon, skText);
      listWrap.appendChild(skRow);
    }
  }

  const footer = document.createElement('div');
  footer.className = 'suggestions-footer';
  if (isLoadingSuggestions) {
    footer.innerHTML =
      '<span class="suggestions-loading-label">Loading suggestions…</span><span><kbd>↵</kbd> search now</span>';
  } else {
    footer.innerHTML =
      '<span><kbd>!g</kbd> <kbd>!gh</kbd> bangs</span><span><kbd>&gt;</kbd> commands</span><span><kbd>100 usd</kbd> convert</span><span><kbd>↑↓</kbd> <kbd>↵</kbd></span>';
  }

  fragment.append(listWrap, footer);
  suggestionsEl.replaceChildren(fragment);
  suggestionsEl.classList.add('visible');
  clampSuggestionsHeight();

  const activeEl = listWrap.querySelector<HTMLElement>('.suggestion-item.highlighted');
  activeEl?.scrollIntoView({ block: 'nearest' });
}

function clampSuggestionsHeight(): void {
  if (!suggestionsEl || !suggestionsEl.classList.contains('visible')) return;
  const listWrap = suggestionsEl.querySelector<HTMLElement>('.suggestions-list');
  const slot = searchInput?.closest('.command-slot');
  if (!listWrap || !slot) return;
  const rect = slot.getBoundingClientRect();
  // Keep dropdown cleanly above the bottom edge of the viewport (with margin for bottom controls)
  const availableBelow = window.innerHeight - rect.bottom - 20;
  const footerHeight = suggestionsEl.querySelector<HTMLElement>('.suggestions-footer')?.offsetHeight || 30;
  const maxListHeight = Math.max(96, Math.min(230, availableBelow - footerHeight - 12));
  listWrap.style.maxHeight = `${Math.floor(maxListHeight)}px`;
}

window.addEventListener('resize', clampSuggestionsHeight);

function clearBar(): void {
  window.clearTimeout(debounceTimer);
  ApiClient.abortSuggestions();
  setSuggestionsLoading(false);
  suggestionsEl?.replaceChildren();
  suggestionsEl?.classList.remove('visible');
  currentResults = [];
  currentResultsQuery = '';
  highlightedIndex = -1;
  userSelectedIndex = false;
}

function runProgressiveSearch(query: string): void {
  if (!searchInput || !barEngine) return;
  const seq = ++searchSeq;
  window.clearTimeout(debounceTimer);
  ApiClient.abortSuggestions();

  if (query.length < SUGGESTIONS.minQueryLength) {
    clearBar();
    return;
  }

  // Phase 1 (0ms synchronous): render instant search/URL/bang/calc/shortcut results immediately
  const instant = barEngine.searchInstant(query);
  const engineId = settings?.general.searchEngine ?? 'google';
  const willFetchNetwork = !instant.exclusive && query.length >= 2;
  const cachedSugg = willFetchNetwork ? ApiClient.getCachedSuggestions(query, engineId) : null;
  const needsDebouncedFetch = willFetchNetwork && !cachedSugg;

  setSuggestionsLoading(needsDebouncedFetch);

  let instantList = instant.results;
  let localList: BarResult[] = [];
  let netList: BarResult[] = [];

  const applyMerged = (): void => {
    if (seq !== searchSeq || !barEngine) return;
    const prevSelectedId =
      userSelectedIndex && highlightedIndex >= 0 ? currentResults[highlightedIndex]?.id : undefined;
    const merged = instant.exclusive
      ? instantList
      : barEngine.mergeLists([instantList, localList, netList]);
    currentResults = merged;
    currentResultsQuery = query;
    if (prevSelectedId) {
      const preserved = merged.findIndex((r) => r.id === prevSelectedId);
      highlightedIndex = preserved >= 0 ? preserved : 0;
    } else {
      highlightedIndex = merged.length > 0 ? 0 : -1;
    }
    renderBarResults(merged);
  };

  applyMerged();
  if (instant.exclusive) return;

  // Phase 2a (local async — tabs, bookmarks, history, currency — zero network wait)
  void barEngine.searchLocalAsync(query).then((res) => {
    if (seq !== searchSeq || res.length === 0) return;
    localList = res;
    applyMerged();
  });

  // Phase 2b (network autocomplete — 0ms if LRU cached, otherwise debounced with skeleton state)
  if (willFetchNetwork) {
    const runNet = (): void => {
      if (seq !== searchSeq || !barEngine) return;
      void barEngine
        .searchNetworkSuggestions(query)
        .then((res) => {
          if (seq !== searchSeq) return;
          netList = res;
        })
        .finally(() => {
          if (seq !== searchSeq) return;
          setSuggestionsLoading(false);
          applyMerged();
        });
    };

    if (cachedSugg) {
      runNet();
    } else {
      debounceTimer = window.setTimeout(runNet, SUGGESTIONS.debounceMs);
    }
  }
}

function executeResult(r: BarResult): void {
  activeFaviconLoader?.cancelPending();
  clearBar();
  if (searchInput) {
    searchInput.value = '';
    updateModeIndicator('');
  }
  r.run();
}

async function showEmptyState(): Promise<void> {
  if (!suggestionsEl) return;
  setSuggestionsLoading(false);
  const results = await getEmptyStateResults(
    getShortcutCache(),
    settings?.privacy.clipboardHistory ?? false
  );
  // Also offer top quick commands in empty state
  const quickCmds: BarResult[] = [
    {
      id: 'quick:deck',
      title: drawerOpen ? 'Close Workspace Deck' : 'Open Workspace Deck',
      hint: 'Markets, Weather, Calendar & RSS',
      kbd: 'Tab',
      icon: 'action',
      score: 8,
      run: () => setDrawerOpen(!drawerOpen)
    },
    {
      id: 'quick:note',
      title: 'New Scratchpad Note',
      hint: 'Create floating hardware card',
      kbd: '⌘.',
      icon: 'action',
      score: 7,
      run: () => void scratchpad?.createNote()
    }
  ];
  const combined = [...results, ...quickCmds];
  if (combined.length === 0) return;
  currentResults = combined;
  currentResultsQuery = '';
  highlightedIndex = -1;
  userSelectedIndex = false;
  renderBarResults(combined);
}

if (searchInput && suggestionsEl) {
  attachPasteCapture(searchInput, () => settings?.privacy.clipboardHistory ?? false);

  searchInput.addEventListener('focus', () => {
    preconnectSearchEngine();
    if (searchInput.value.trim().length === 0) {
      void showEmptyState();
    }
  });

  const moveHighlight = (delta: number): void => {
    if (currentResults.length === 0) return;
    userSelectedIndex = true;
    highlightedIndex =
      highlightedIndex === -1
        ? delta > 0
          ? 0
          : currentResults.length - 1
        : (highlightedIndex + delta + currentResults.length) % currentResults.length;
    renderBarResults(currentResults);
  };

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    userSelectedIndex = false;
    updateModeIndicator(query);

    const isPersian = /[؀-ۿ]/.test(query);
    searchInput.style.direction = isPersian ? 'rtl' : 'ltr';

    if (query.length < SUGGESTIONS.minQueryLength) {
      window.clearTimeout(debounceTimer);
      ApiClient.abortSuggestions();
      setSuggestionsLoading(false);
      void showEmptyState();
      return;
    }

    runProgressiveSearch(query);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const query = searchInput.value.trim();
      activeFaviconLoader?.cancelPending();
      window.clearTimeout(debounceTimer);
      ApiClient.abortSuggestions();

      // 1. If the user explicitly arrow-keyed to an item, run it immediately
      if (userSelectedIndex && highlightedIndex >= 0 && currentResults[highlightedIndex]) {
        executeResult(currentResults[highlightedIndex]);
        return;
      }

      if (!query) return;

      // 2. If instant local results for this EXACT query have a utility (calc/money/bang/>cmd), run it
      const top = currentResultsQuery === query ? currentResults[0] : undefined;
      if (top && (top.icon === 'calc' || top.icon === 'money' || top.icon === 'bang' || query.startsWith('>'))) {
        executeResult(top);
        return;
      }

      // 3. Otherwise navigate immediately (0ms) via direct URL or selected search engine
      clearBar();
      searchInput.value = '';
      updateModeIndicator('');
      if (barEngine) {
        barEngine.resolveEnterAction(query)();
      } else {
        window.location.href = buildSearchUrl(
          settings?.general.searchEngine,
          query,
          settings?.general.customSearchUrl
        );
      }
    } else if (e.key === 'Escape') {
      clearBar();
      searchInput.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target as Node) && !suggestionsEl.contains(e.target as Node)) {
      clearBar();
    }
  });
}

// --- Shortcuts Keycap Dock ---
const shortcutsGrid = document.getElementById('shortcuts-grid')!;
const addShortcutBtn = document.getElementById('add-shortcut-trigger');
const modal = document.getElementById('shortcut-modal')!;
const modalTitleEl = document.getElementById('shortcut-modal-title');
const closeModalBtn = document.getElementById('close-modal');
const saveShortcutBtn = document.getElementById('save-shortcut');

let dragSourceIndex = -1;
let editingIndex = -1;

async function loadShortcuts(): Promise<void> {
  shortcutsCache = await storage.getShortcuts();
  renderShortcuts(shortcutsCache);
}

let shortcutRenderSeq = 0;
let activeFaviconLoader: LazyFaviconBatchLoader | null = null;

window.addEventListener('pagehide', () => {
  activeFaviconLoader?.cancelPending();
});

function renderShortcuts(shortcuts: Shortcut[]): void {
  const renderSeq = ++shortcutRenderSeq;
  activeFaviconLoader?.dispose();
  activeFaviconLoader = null;

  const iconStyle = settings?.appearance.bookmarkIconStyle ?? 'dithered';
  const loader = iconStyle !== 'off' ? new LazyFaviconBatchLoader(shortcutsGrid, 120, 3) : null;
  activeFaviconLoader = loader;
  const pendingTasks: LazyIconTask[] = [];
  const fragment = document.createDocumentFragment();

  shortcuts.forEach((shortcut, index) => {
    const href = ensureUrl(shortcut.url || '');
    const card = document.createElement('a');
    card.className = 'nav-link shortcut-keycap';
    card.href = href;
    card.target = '_self';
    card.draggable = true;
    card.dataset.index = String(index);

    // Preconnect DNS/TLS on hover or keyboard focus so clicking opens the site noticeably faster
    card.addEventListener('pointerenter', () => preconnectUrl(href), { passive: true });
    card.addEventListener('focus', () => preconnectUrl(href), { passive: true });
    // Immediately cancel pending uncached icon batches when navigating away
    card.addEventListener('click', (e) => {
      if (!e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        activeFaviconLoader?.cancelPending();
      }
    });

    const leftWrap = document.createElement('span');
    leftWrap.className = 'shortcut-left-wrap';

    if (iconStyle !== 'off') {
      const iconSlot = document.createElement('span');
      iconSlot.className = 'shortcut-favicon-wrap';
      iconSlot.setAttribute('aria-hidden', 'true');
      leftWrap.appendChild(iconSlot);

      const cachedEl = getCachedFaviconElementSync(shortcut.url || '', iconStyle);
      if (cachedEl) {
        iconSlot.replaceChildren(cachedEl);
        iconSlot.classList.add('is-loaded');
      } else {
        iconSlot.classList.add('is-pending');
        pendingTasks.push({
          slot: iconSlot,
          url: shortcut.url || '',
          style: iconStyle
        });
      }
    }

    const labelWrap = document.createElement('span');
    labelWrap.className = 'shortcut-label-wrap';

    const label = document.createElement('span');
    label.className = 'shortcut-text';
    label.textContent = shortcut.title;

    const host = document.createElement('small');
    host.className = 'shortcut-host';
    host.textContent = hostOfUrl(shortcut.url || '');

    labelWrap.append(label, host);
    leftWrap.appendChild(labelWrap);

    const rightMeta = document.createElement('span');
    rightMeta.className = 'shortcut-right-meta';

    const actions = document.createElement('span');
    actions.className = 'keycap-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'keycap-action-btn keycap-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', `Edit ${shortcut.title}`);
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      openEditDialog(index);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'keycap-action-btn keycap-del-btn';
    delBtn.textContent = '×';
    delBtn.setAttribute('aria-label', t('deleteShortcut', { name: shortcut.title }));
    delBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      void removeShortcutWithUndo(index);
    });

    actions.append(editBtn, delBtn);

    const keyIdx = document.createElement('span');
    keyIdx.className = 'keycap-index';
    keyIdx.textContent = String(index + 1).padStart(2, '0');
    if (index < 9) {
      keyIdx.title = `Press Alt+${index + 1} to launch`;
    }

    rightMeta.append(actions, keyIdx);
    card.append(leftWrap, rightMeta);

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openEditDialog(index);
    });

    card.addEventListener('dragstart', (e) => {
      dragSourceIndex = index;
      card.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      dragSourceIndex = -1;
      card.classList.remove('dragging');
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragSourceIndex !== -1 && dragSourceIndex !== index) {
        card.classList.add('drag-over');
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      void reorderShortcuts(dragSourceIndex, index);
    });

    fragment.appendChild(card);
  });

  shortcutsGrid.replaceChildren(fragment);

  if (pendingTasks.length > 0 && loader) {
    void ensureFaviconCachesLoaded().then(() => {
      if (renderSeq !== shortcutRenderSeq || activeFaviconLoader !== loader) return;
      for (const task of pendingTasks) {
        if (!task.slot.isConnected) continue;
        const cachedEl = getCachedFaviconElementSync(task.url, task.style);
        if (cachedEl) {
          task.slot.replaceChildren(cachedEl);
          task.slot.classList.remove('is-pending');
          task.slot.classList.add('is-loaded');
        } else {
          loader.observe(task);
        }
      }
    });
  }
}

async function reorderShortcuts(from: number, to: number): Promise<void> {
  if (from === to || from === -1) return;
  const shortcuts = await storage.getShortcuts();
  if (from >= shortcuts.length || to >= shortcuts.length) return;
  const [moved] = shortcuts.splice(from, 1);
  shortcuts.splice(to, 0, moved);
  await storage.setShortcuts(shortcuts);
  await loadShortcuts();
}

async function removeShortcutWithUndo(index: number): Promise<void> {
  const shortcuts = await storage.getShortcuts();
  const removed = shortcuts[index];
  if (!removed) return;
  shortcuts.splice(index, 1);
  await storage.setShortcuts(shortcuts);
  await loadShortcuts();

  showToast(`Removed "${removed.title}"`, async () => {
    const current = await storage.getShortcuts();
    current.splice(Math.min(index, current.length), 0, removed);
    await storage.setShortcuts(current);
    await loadShortcuts();
  });
}

function openEditDialog(index: number): void {
  const shortcut = shortcutsCache[index];
  if (!shortcut) return;
  editingIndex = index;
  const titleInput = document.getElementById('shortcut-title') as HTMLInputElement | null;
  const urlInput = document.getElementById('shortcut-url') as HTMLInputElement | null;
  if (!titleInput || !urlInput) return;

  if (modalTitleEl) modalTitleEl.textContent = t('editShortcut');
  titleInput.value = shortcut.title;
  urlInput.value = shortcut.url;
  if (saveShortcutBtn) saveShortcutBtn.textContent = t('saveChanges');
  modal.style.display = 'flex';
  titleInput.focus();
}

function openAddDialog(): void {
  editingIndex = -1;
  const titleInput = document.getElementById('shortcut-title') as HTMLInputElement | null;
  const urlInput = document.getElementById('shortcut-url') as HTMLInputElement | null;
  if (modalTitleEl) modalTitleEl.textContent = t('addShortcut');
  if (titleInput) titleInput.value = '';
  if (urlInput) urlInput.value = '';
  if (saveShortcutBtn) saveShortcutBtn.textContent = t('addToHome');
  modal.style.display = 'flex';
  titleInput?.focus();
}

addShortcutBtn?.addEventListener('click', openAddDialog);
closeModalBtn?.addEventListener('click', () => {
  editingIndex = -1;
  modal.style.display = 'none';
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.style.display = 'none';
});

saveShortcutBtn?.addEventListener('click', async () => {
  const titleInput = document.getElementById('shortcut-title') as HTMLInputElement | null;
  const urlInput = document.getElementById('shortcut-url') as HTMLInputElement;
  let urlVal = urlInput.value.trim();
  if (!urlVal) return;

  urlVal = ensureUrl(urlVal);
  let title: string;
  if (titleInput?.value?.trim()) {
    title = titleInput.value.trim();
  } else {
    try {
      title = new URL(urlVal).hostname.replace(/^www\./, '').split('.')[0];
    } catch {
      title = urlVal.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    }
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const shortcuts = await storage.getShortcuts();
  if (editingIndex >= 0 && shortcuts[editingIndex]) {
    shortcuts[editingIndex] = { title, url: urlVal };
  } else {
    shortcuts.push({ title, url: urlVal });
  }
  await storage.setShortcuts(shortcuts);

  editingIndex = -1;
  modal.style.display = 'none';
  if (titleInput) titleInput.value = '';
  urlInput.value = '';
  await loadShortcuts();
});

// --- Right Pane Live Telemetry (Cached-first + Deferred Stale Revalidation) ---
function getActiveMarketConfig(): {
  provider: MarketProviderId;
  assets: FinanceAssetId[];
  spotlight: FinanceAssetId;
} {
  const provider: MarketProviderId = settings?.finance.provider ?? 'auto';
  const configured = (settings?.finance.assets ?? []).filter(
    (id): id is FinanceAssetId => id in FINANCE_ASSETS
  );
  const assets: FinanceAssetId[] =
    configured.length > 0 ? configured.slice(0, 4) : ['usdt', 'usd', 'gold', 'btc'];
  const configuredSpot = settings?.finance.spotlight;
  const spotlight: FinanceAssetId =
    configuredSpot && assets.includes(configuredSpot) ? configuredSpot : assets[0];
  return { provider, assets, spotlight };
}

function formatSpotlightBig(asset: FinanceAssetId, item: PriceData | undefined): string {
  if (!item || item.price === 'Error' || item.price === 'Unavailable') return '---';
  const def = FINANCE_ASSETS[asset];
  const raw = parseFloat(item.price.replace(/,/g, ''));
  if (def.unit === 'usd') {
    const val = item.numericValue ?? raw;
    if (!Number.isFinite(val)) return '---';
    if (val >= 10_000) return `$${(val / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    if (val >= 1_000) return `$${Math.round(val).toLocaleString('en-US')}`;
    return `$${val.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  const toman = item.numericValue ?? (Number.isFinite(raw) ? Math.round(raw / 10) : NaN);
  if (!Number.isFinite(toman)) return item.price;
  if (toman >= 1_000_000) return `${(toman / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  if (toman >= 1_000) return `${Math.round(toman / 1000)}k`;
  return toman.toLocaleString('en-US');
}

function formatTickerRowPrice(asset: FinanceAssetId, item: PriceData): string {
  const def = FINANCE_ASSETS[asset];
  const raw = parseFloat(item.price.replace(/,/g, ''));
  if (def.unit === 'usd') {
    const val = item.numericValue ?? raw;
    if (!Number.isFinite(val)) return `$${item.price}`;
    return `$${val.toLocaleString('en-US', { maximumFractionDigits: val >= 1000 ? 0 : 2 })}`;
  }
  const toman = item.numericValue ?? (Number.isFinite(raw) ? Math.round(raw / 10) : NaN);
  return Number.isFinite(toman) ? toman.toLocaleString('en-US') : item.price;
}

function renderPriceMetrics(
  data: Partial<Record<FinanceAssetId, PriceData>>,
  recordHistory: boolean
): void {
  const listEl = document.getElementById('price-list');
  const bigEl = document.getElementById('price-usd-big');
  const sublabelEl = document.getElementById('price-spotlight-label');
  const sourceMetaEl = document.getElementById('price-source-meta');
  if (!listEl) return;

  const { assets, spotlight } = getActiveMarketConfig();
  const spotDef = FINANCE_ASSETS[spotlight];
  if (sublabelEl) sublabelEl.textContent = spotDef.sublabel;
  if (bigEl) bigEl.textContent = formatSpotlightBig(spotlight, data[spotlight]);

  const fragment = document.createDocumentFragment();
  const sources = new Set<string>();

  for (const assetId of assets) {
    const def = FINANCE_ASSETS[assetId];
    const item = data[assetId];
    const row = document.createElement('span');

    if (!item) {
      row.className = 'price-item';
      row.textContent = `${def.code} —`;
      fragment.appendChild(row);
      continue;
    }

    if (item.price === 'Error' || item.price === 'Unavailable') {
      row.className = 'price-item';
      row.textContent = `${def.code} OFFLINE`;
      fragment.appendChild(row);
      continue;
    }

    if (item.source) sources.add(item.source);

    if (recordHistory) {
      const parsedRaw = parseFloat(item.price.replace(/,/g, ''));
      const historyVal =
        def.unit === 'toman'
          ? Number.isFinite(parsedRaw)
            ? Math.round(parsedRaw)
            : item.numericValue !== undefined
            ? Math.round(item.numericValue * 10)
            : NaN
          : item.numericValue ?? parsedRaw;
      if (Number.isFinite(historyVal) && historyVal > 0) {
        void appendPricePoint(assetId, historyVal, item.trend);
      }
    }

    const formatted = formatTickerRowPrice(assetId, item);
    const arrow = item.trend === 'up' ? '▲' : item.trend === 'down' ? '▼' : '';
    let deltaStr = '';
    if (item.changePercent !== undefined && Number.isFinite(item.changePercent) && Math.abs(item.changePercent) >= 0.05) {
      const sign = item.changePercent > 0 ? '+' : '';
      deltaStr = `${sign}${item.changePercent.toFixed(1)}%${arrow ? ` ${arrow}` : ''}`;
    } else if (arrow) {
      deltaStr = arrow;
    }

    row.className =
      'price-item' + (item.trend === 'up' ? ' is-up' : item.trend === 'down' ? ' is-down' : '');

    const leftText = document.createElement('span');
    leftText.className = 'price-row-main';
    leftText.textContent = `${def.code} ${formatted}`;
    row.appendChild(leftText);

    if (deltaStr) {
      const deltaEl = document.createElement('span');
      deltaEl.className = 'price-delta';
      deltaEl.textContent = deltaStr;
      row.appendChild(deltaEl);
    }

    fragment.appendChild(row);
  }

  listEl.replaceChildren(fragment);

  if (sourceMetaEl) {
    sourceMetaEl.textContent = sources.size > 0 ? Array.from(sources).join(' · ') : '';
  }
}

async function updatePrices(forceRefresh = false): Promise<void> {
  if (!settings?.widgets.priceTicker) return;
  const { assets, provider } = getActiveMarketConfig();

  if (!forceRefresh) {
    const cached = await ApiClient.getCachedPrices(assets, provider);
    if (Object.keys(cached.data).length > 0) {
      renderPriceMetrics(cached.data, false);
    }
    if (cached.fresh) return;
  }

  const data = await ApiClient.fetchPrices(assets, provider);
  renderPriceMetrics(data, true);
}

function renderNewsArticle(article: NewsArticle | null): void {
  const newsEl = document.getElementById('news-widget') as HTMLAnchorElement | null;
  const headlineEl = document.getElementById('news-headline');
  const sourceMetaEl = document.getElementById('news-source-meta');
  if (!newsEl || !headlineEl) return;

  if (article) {
    if (article.noKeywordMatch) {
      headlineEl.textContent = article.title;
      newsEl.removeAttribute('href');
      newsEl.classList.add('news-widget--inert');
      if (sourceMetaEl) {
        sourceMetaEl.textContent = `${article.sourceName} · FILTERED`;
      }
      return;
    }

    headlineEl.textContent = `"${article.title}"`;
    newsEl.href = article.url;
    newsEl.classList.remove('news-widget--inert');
    if (sourceMetaEl) {
      sourceMetaEl.textContent = article.matchedKeyword
        ? `${article.sourceName} · #${article.matchedKeyword}`
        : `${article.sourceName} · ${article.sourceDomain}`;
    }
  } else {
    headlineEl.textContent = t('noRecentNews');
    newsEl.removeAttribute('href');
    newsEl.classList.add('news-widget--inert');
  }
}

async function updateNews(forceRefresh = false): Promise<void> {
  const newsEl = document.getElementById('news-widget') as HTMLAnchorElement | null;
  const headlineEl = document.getElementById('news-headline');
  const sourceMetaEl = document.getElementById('news-source-meta');
  if (!newsEl || !headlineEl || !settings?.widgets.newsWidget) return;

  const activeSource =
    settings.news?.sourceId === 'custom' && settings.news?.customUrl
      ? hostOfUrl(settings.news.customUrl)
      : getNewsSource(settings.news?.sourceId).name;
  const activeKeywords = (settings.news?.keywords || []).filter((k) => k.trim().length > 0);

  if (sourceMetaEl) {
    sourceMetaEl.textContent =
      activeKeywords.length > 0 ? `${activeSource} · ${activeKeywords.join(', ')}` : activeSource;
  }

  if (!forceRefresh) {
    const cached = await ApiClient.getCachedNews(settings.news);
    if (cached.article) {
      renderNewsArticle(cached.article);
    }
    if (cached.fresh) return;
  }

  const article = await ApiClient.fetchNews(settings.news, forceRefresh);
  renderNewsArticle(article);
}

// --- Right Pane Atmosphere & AQI Telemetry ---
function renderHeroWeather(data: WeatherSnapshot | null): void {
  const tempEl = document.getElementById('hero-weather-temp');
  const metaEl = document.getElementById('hero-weather-meta');
  const aqiEl = document.getElementById('hero-weather-aqi');
  if (!tempEl || !metaEl || !aqiEl || !settings) return;

  const unit = settings.weather.unit ?? 'c';
  if (!data) {
    tempEl.textContent = `--°${unit.toUpperCase()}`;
    metaEl.textContent = 'Weather offline';
    aqiEl.textContent = '';
    aqiEl.className = 'price-item';
    return;
  }

  const aqi = aqiDescriptor(data.aqi);
  tempEl.textContent = formatTemp(data.temp, unit);
  metaEl.textContent = `${data.city} / ${data.condition}`;
  aqiEl.textContent = `AQI ${data.aqi} · ${aqi.label}`;
  aqiEl.className = `price-item hero-aqi is-${aqi.level}`;
}

async function updateHeroWeather(forceRefresh = false): Promise<void> {
  if (!settings) return;

  if (!forceRefresh) {
    const cached = await getCachedWeather(settings.weather);
    if (cached.data) {
      renderHeroWeather(cached.data);
    }
    if (cached.fresh) return;
  }

  const data = await fetchWeatherData(settings.weather, forceRefresh);
  renderHeroWeather(data);
}

// --- Hero Daily Focus Line (auto-resets each morning) ---
const FOCUS_STORAGE_KEY = 'dailyIntention';

interface FocusData {
  text: string;
  date: string;
  completed: boolean;
}

function getTodayDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function initHeroFocus(preloaded?: FocusData): Promise<void> {
  const focusWrap = document.querySelector('.hero-focus');
  const toggleBtn = document.getElementById('focus-toggle-btn') as HTMLButtonElement | null;
  const focusInput = document.getElementById('focus-input') as HTMLInputElement | null;
  if (!toggleBtn || !focusInput) return;

  const today = getTodayDateKey();
  let state: FocusData = { text: '', date: today, completed: false };
  const stored = preloaded !== undefined ? preloaded : await storage.get<FocusData>(FOCUS_STORAGE_KEY);
  if (stored && stored.date === today) {
    state = stored;
  } else if (stored) {
    void storage.set(FOCUS_STORAGE_KEY, state);
  }

  const syncUi = (): void => {
    focusInput.value = state.text;
    const isDone = Boolean(state.completed && state.text.trim().length > 0);
    toggleBtn.textContent = isDone ? '[×]' : '[ ]';
    toggleBtn.setAttribute('aria-pressed', String(isDone));
    focusWrap?.classList.toggle('is-completed', isDone);
    focusWrap?.classList.toggle('has-value', state.text.trim().length > 0);
  };

  const persistFocus = async (): Promise<void> => {
    state = { ...state, date: getTodayDateKey() };
    await storage.set(FOCUS_STORAGE_KEY, state);
    syncUi();
  };

  syncUi();

  toggleBtn.addEventListener('click', () => {
    if (!state.text.trim()) {
      focusInput.focus();
      return;
    }
    state.completed = !state.completed;
    void persistFocus();
  });

  focusInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      state.text = focusInput.value.trim();
      if (!state.text) state.completed = false;
      void persistFocus();
      focusInput.blur();
    } else if (e.key === 'Escape') {
      focusInput.value = state.text;
      focusInput.blur();
    }
  });

  focusInput.addEventListener('blur', () => {
    const nextText = focusInput.value.trim();
    if (nextText !== state.text) {
      state.text = nextText;
      if (!state.text) state.completed = false;
      void persistFocus();
    }
  });
}

let priceTimer: number | undefined;
let newsTimer: number | undefined;
let weatherTimer: number | undefined;

function startWidgetTimers(deferNetwork = false): void {
  window.clearInterval(priceTimer);
  window.clearInterval(newsTimer);
  window.clearInterval(weatherTimer);

  const weatherSection = document.getElementById('hero-weather');
  const priceWidget = document.getElementById('price-widget');
  const newsSection = document.getElementById('news-widget')?.closest<HTMLElement>('.telemetry-block');

  const showWeather = settings?.widgets.weather ?? true;
  if (weatherSection) weatherSection.hidden = !showWeather;
  if (priceWidget) priceWidget.hidden = !settings?.widgets.priceTicker;
  if (newsSection) newsSection.hidden = !settings?.widgets.newsWidget;

  const hydrateAll = (): void => {
    if (settings?.widgets.priceTicker) {
      void updatePrices();
      priceTimer = window.setInterval(() => void updatePrices(true), INTERVALS.prices);
    }
    if (settings?.widgets.newsWidget) {
      void updateNews();
      newsTimer = window.setInterval(() => void updateNews(true), INTERVALS.news);
    }
    if (showWeather) {
      void updateHeroWeather();
      weatherTimer = window.setInterval(() => void updateHeroWeather(true), 20 * 60 * 1000);
    }
  };

  if (deferNetwork) {
    // Paint any local cached values immediately; defer stale network calls until browser is idle
    if (showWeather) {
      void getCachedWeather(settings.weather).then((c) => {
        if (c.data) renderHeroWeather(c.data);
      });
    }
    if (settings?.widgets.priceTicker) {
      const { assets, provider } = getActiveMarketConfig();
      void ApiClient.getCachedPrices(assets, provider).then((c) => {
        if (Object.keys(c.data).length > 0) renderPriceMetrics(c.data, false);
      });
    }
    if (settings?.widgets.newsWidget) {
      void ApiClient.getCachedNews(settings.news).then((c) => {
        if (c.article) renderNewsArticle(c.article);
      });
    }
    scheduleIdle(hydrateAll, 250);
  } else {
    hydrateAll();
  }
}

// Click right-pane market or weather blocks → open Workspace Deck
const openDeckOnKey = (e: KeyboardEvent): void => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setDrawerOpen(true);
  }
};
const priceWidgetEl = document.getElementById('price-widget');
priceWidgetEl?.addEventListener('click', () => setDrawerOpen(true));
priceWidgetEl?.addEventListener('keydown', openDeckOnKey);

const weatherWidgetEl = document.getElementById('hero-weather');
weatherWidgetEl?.addEventListener('click', () => setDrawerOpen(true));
weatherWidgetEl?.addEventListener('keydown', openDeckOnKey);

// Bottom Dock Controls
document.getElementById('nav-scratchpad-btn')?.addEventListener('click', () => {
  const open = scratchpad?.toggleTray() ?? false;
  document.getElementById('nav-scratchpad-btn')?.classList.toggle('is-active', open);
  document.getElementById('nav-scratchpad-btn')?.setAttribute('aria-expanded', String(open));
});

document.getElementById('nav-settings-btn')?.addEventListener('click', () => {
  void openSettingsModal('search');
});

// --- Global Keyboard Navigation ---
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typingInField =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable;

  // Cmd/Ctrl+K → Command slot
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput?.focus();
    searchInput?.select();
    return;
  }

  // Cmd/Ctrl+J → Toggle Workspace Deck
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    setDrawerOpen(!drawerOpen);
    return;
  }

  // Cmd/Ctrl+. → Toggle Scratchpad Tray
  if ((e.ctrlKey || e.metaKey) && e.key === '.') {
    e.preventDefault();
    const open = scratchpad?.toggleTray() ?? false;
    document.getElementById('nav-scratchpad-btn')?.classList.toggle('is-active', open);
    return;
  }

  // Alt+1..9 → Instant shortcut keycap launch
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    const sc = shortcutsCache[idx];
    if (sc) {
      e.preventDefault();
      window.location.href = ensureUrl(sc.url);
    }
    return;
  }

  // "/" when not typing → Focus command bar
  if (e.key === '/' && !typingInField) {
    e.preventDefault();
    searchInput?.focus();
    return;
  }

  // "Tab" when idle on body → Toggle Workspace Deck
  if (e.key === 'Tab' && !typingInField && !settingsUI?.isOpen && modal.style.display !== 'flex') {
    e.preventDefault();
    setDrawerOpen(!drawerOpen);
    return;
  }

  // Escape closes overlays cleanly in priority order
  if (e.key === 'Escape') {
    if (modal.style.display === 'flex') {
      modal.style.display = 'none';
    } else if (settingsUI?.isOpen) {
      settingsUI.close();
    } else if (scratchpad?.isTrayOpen) {
      scratchpad.toggleTray(false);
      document.getElementById('nav-scratchpad-btn')?.classList.remove('is-active');
    } else if (drawerOpen) {
      setDrawerOpen(false);
    }
  }
});

// --- Boot (Instant First Paint: 1 batched storage read, lazy deck & settings, deferred telemetry) ---
(async function boot(): Promise<void> {
  // Kick off favicon cache read alongside settings snapshot so repeat opens hydrate icons synchronously
  const faviconReady = ensureFaviconCachesLoaded();
  const snapshot = await storage.getMany([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.shortcuts,
    FOCUS_STORAGE_KEY,
    STORAGE_KEYS.stickyNotes,
    STORAGE_KEYS.notesVisible,
    STORAGE_KEYS.drawerOpen
  ]);
  await faviconReady;

  settings = storage.parseSettings(snapshot[STORAGE_KEYS.settings]);
  applyTheme(settings);
  syncSearchEngineUi();
  startClock();

  // Render bookmarks FIRST so they are immediately interactive
  const rawShortcuts = snapshot[STORAGE_KEYS.shortcuts] as Shortcut[] | undefined;
  if (rawShortcuts === undefined) {
    shortcutsCache = STARTER_SHORTCUTS.map((s) => ({ ...s }));
    void storage.setShortcuts(shortcutsCache);
  } else {
    shortcutsCache = rawShortcuts;
  }
  renderShortcuts(shortcutsCache);

  // Hydrate Daily Focus from batched snapshot (zero extra storage IPC)
  void initHeroFocus(snapshot[FOCUS_STORAGE_KEY] as FocusData | undefined);

  const persistSettings = async (updated: Settings): Promise<void> => {
    const prevTheme = settings?.appearance.themePreset;
    const prevIconStyle = settings?.appearance.bookmarkIconStyle;
    const prevProvider = settings?.finance.provider;
    settings = updated;
    await storage.saveSettings(updated);
    applyTheme(updated);
    syncSearchEngineUi();
    settingsUI?.syncExternal(updated);
    startClock();
    if (prevProvider !== updated.finance.provider) {
      ApiClient.clearPriceCache();
      startWidgetTimers(false);
    } else {
      startWidgetTimers(false);
    }
    if (prevTheme !== updated.appearance.themePreset || prevIconStyle !== updated.appearance.bookmarkIconStyle) {
      renderShortcuts(shortcutsCache);
    }
    if (deckInitialized && drawerOpen) {
      await deckGrid?.refresh();
    } else {
      deckNeedsRefresh = true;
    }
  };
  persistSettingsFn = persistSettings;

  // Initialize Spatial Scratchpad with preloaded state (zero extra storage reads, tray built lazily on open)
  scratchpad = new SpatialScratchpad({
    canvasEl: document.getElementById('notes-container')!,
    trayEl: document.getElementById('scratchpad-tray')!,
    onToast: (msg, undo) => showToast(msg, undo),
    onCountChange: (count) => {
      const labelEl = document.getElementById('scratchpad-btn-label');
      if (labelEl) labelEl.textContent = count > 0 ? `SCRATCH_PAD (${count})` : 'SCRATCH_PAD';
    }
  });
  await scratchpad.init({
    notes: (snapshot[STORAGE_KEYS.stickyNotes] as NoteData[] | undefined) ?? [],
    visible: (snapshot[STORAGE_KEYS.notesVisible] as boolean | undefined) ?? true
  });

  // Register Power Command Actions
  actionRegistry.register({
    name: 'Toggle Workspace Deck',
    aliases: ['deck', 'widgets', 'dashboard', 'drawer'],
    kbd: 'Tab',
    run: () => setDrawerOpen(!drawerOpen)
  });
  actionRegistry.register({
    name: 'New Scratchpad Note',
    aliases: ['note', 'sticky', 'scratchpad'],
    kbd: '⌘.',
    run: () => void scratchpad?.createNote()
  });
  actionRegistry.register({
    name: 'Toggle Scratchpad Tray',
    aliases: ['notes list', 'tray'],
    kbd: '⌘.',
    run: () => {
      const open = scratchpad?.toggleTray() ?? false;
      document.getElementById('nav-scratchpad-btn')?.classList.toggle('is-active', open);
    }
  });
  actionRegistry.register({
    name: 'Add Shortcut Keycap',
    aliases: ['shortcut', 'link', 'bookmark'],
    run: openAddDialog
  });
  actionRegistry.register({
    name: 'Open Preferences',
    aliases: ['settings', 'config', 'bangs'],
    run: () => void openSettingsModal('search')
  });
  actionRegistry.register({
    name: 'Toggle Jalali / Gregorian Calendar',
    aliases: ['calendar', 'jalali', 'persian', 'shamsi'],
    run: () => {
      const next = structuredClone(settings);
      next.general.calendar = next.general.calendar === 'jalali' ? 'gregorian' : 'jalali';
      void persistSettings(next);
      showToast(`Calendar set to ${next.general.calendar === 'jalali' ? 'Jalali' : 'Gregorian'}`);
    }
  });
  actionRegistry.register({
    name: 'Export Scratchpad Markdown',
    aliases: ['export notes', 'markdown'],
    run: () => scratchpad?.exportMarkdown()
  });

  for (const preset of THEME_PRESETS) {
    actionRegistry.register({
      name: `Theme: ${preset.name}`,
      aliases: ['theme', preset.category.toLowerCase(), preset.id],
      run: () => {
        const next = structuredClone(settings);
        next.appearance.themePreset = preset.id;
        void persistSettings(next);
        showToast(`Theme switched to ${preset.name}`);
      }
    });
  }

  barEngine = new CommandBarEngine(actionRegistry, getShortcutCache, {
    historyEnabled: () => settings?.privacy.historySearch ?? false,
    clipboardEnabled: () => settings?.privacy.clipboardHistory ?? false,
    getSearchEngine: () => ({
      id: settings?.general.searchEngine ?? 'google',
      customUrl: settings?.general.customSearchUrl
    }),
    onCopy: (label) => showToast(label)
  });

  // Pre-warm DNS/TLS to active search engine during idle so first search/suggestion is instant
  scheduleIdle(() => preconnectSearchEngine(), 400);

  // Only mount Workspace Deck on boot if user explicitly chose to remember an open drawer
  if (settings.general.rememberDrawerState && snapshot[STORAGE_KEYS.drawerOpen] === true) {
    setDrawerOpen(true, false);
  }

  // Paint cached right-pane telemetry immediately and defer any stale network calls until idle
  startWidgetTimers(true);
})();
