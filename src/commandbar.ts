import { fuzzyMatch } from './fuzzy';
import { evaluateExpression, formatResult } from './calculator';
import { convertToToman, parseConversionQuery } from './currency';
import { ApiClient } from './api';
import { buildSearchUrl, getSearchEngine, hostOfUrl, type SearchEngineId } from './constants';
import { isAIReady, parseNLCommand } from './ai';
import {
  clipboardProviderFactory,
  historyProviderFactory,
  tabsProvider,
  bookmarksProvider,
  topSitesProvider
} from './chrome-providers';
import { storage } from './storage';
import type { Shortcut } from './types';

// --- Result model ---

export interface BarResult {
  id: string;
  /** Primary display text */
  title: string;
  /** Secondary text shown right/under title */
  hint?: string;
  /** Optional short keyboard badge */
  kbd?: string;
  icon?:
    | 'shortcut'
    | 'calc'
    | 'money'
    | 'action'
    | 'search'
    | 'bang'
    | 'tab'
    | 'bookmark'
    | 'history'
    | 'topsite'
    | 'clipboard'
    | 'ai';
  /** Enter executes this */
  run: () => void;
  /** Higher sorts first. */
  score: number;
}

export interface BarProvider {
  id: string;
  /** true → skip other providers (bangs & '>' commands do this) */
  exclusive?: boolean;
  search(query: string): Promise<BarResult[]> | BarResult[];
}

// --- Bangs ---

export interface BangDef {
  short: string; // "g"
  urlTemplate: string; // uses %s
  name: string;
}

export const BUILT_IN_BANGS: BangDef[] = [
  { short: 'g', name: 'Google', urlTemplate: 'https://www.google.com/search?q=%s' },
  { short: 'd', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  { short: 'y', name: 'YouTube', urlTemplate: 'https://www.youtube.com/results?search_query=%s' },
  { short: 'w', name: 'Wikipedia', urlTemplate: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' },
  { short: 'gh', name: 'GitHub', urlTemplate: 'https://github.com/search?q=%s' },
  { short: 'r', name: 'Reddit', urlTemplate: 'https://www.reddit.com/search/?q=%s' }
];

const CUSTOM_BANGS_KEY = 'customBangs';
let customBangsCache: BangDef[] = [];
let customBangsLoaded = false;

export async function getCustomBangs(): Promise<BangDef[]> {
  const list = await storage.get<BangDef[]>(CUSTOM_BANGS_KEY, []);
  customBangsCache = list;
  customBangsLoaded = true;
  return list;
}

export async function saveCustomBang(bang: BangDef): Promise<void> {
  const cleanShort = bang.short.replace(/^!+/, '').trim().toLowerCase();
  if (!cleanShort) return;
  const all = await getCustomBangs();
  const entry: BangDef = {
    short: cleanShort,
    name: bang.name.trim() || cleanShort.toUpperCase(),
    urlTemplate: bang.urlTemplate.trim()
  };
  const idx = all.findIndex((b) => b.short === cleanShort);
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  customBangsCache = all;
  await storage.set(CUSTOM_BANGS_KEY, all);
}

export async function deleteCustomBang(short: string): Promise<void> {
  const all = await getCustomBangs();
  const next = all.filter((b) => b.short !== short);
  customBangsCache = next;
  await storage.set(CUSTOM_BANGS_KEY, next);
}

function resolveBang(short: string, custom: BangDef[]): BangDef | undefined {
  const lower = short.toLowerCase();
  return (
    custom.find((b) => b.short === lower) ||
    BUILT_IN_BANGS.find((b) => b.short === lower)
  );
}

export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return true;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(s);
}

const navigate = (url: string): void => {
  window.location.href = url;
};

/** "!gh react" or bare "!g" or bare "!" to list bangs */
function parseBangQuery(query: string, custom: BangDef[]): { bang: BangDef; rest: string } | null {
  const m = query.match(/^!(\w+)\s*(.*)$/);
  if (!m) return null;
  const bang = resolveBang(m[1], custom);
  if (!bang) return null;
  return { bang, rest: m[2].trim() };
}

export const bangProvider = (): BarProvider => ({
  id: 'bang',
  exclusive: true,
  async search(query) {
    const custom = await getCustomBangs();
    const allBangs = [...custom, ...BUILT_IN_BANGS.filter((b) => !custom.some((c) => c.short === b.short))];

    // Bare "!" or partial "!x" without space shows matching bangs
    if (query === '!' || (/^!\w+$/.test(query) && !resolveBang(query.slice(1), custom))) {
      const prefix = query.slice(1).toLowerCase();
      return allBangs
        .filter((b) => !prefix || b.short.startsWith(prefix) || b.name.toLowerCase().includes(prefix))
        .slice(0, 6)
        .map((b, i) => ({
          id: `bang-hint:${b.short}`,
          title: `!${b.short} — ${b.name}`,
          hint: 'Type query after bang',
          kbd: `!${b.short}`,
          icon: 'bang',
          score: 950 - i,
          run: () => {
            const url = b.urlTemplate.replace('%s', '');
            navigate(url);
          }
        }));
    }

    const parsed = parseBangQuery(query, custom);
    if (!parsed) return [];
    const url = parsed.bang.urlTemplate.includes('%s')
      ? parsed.bang.urlTemplate.replace('%s', encodeURIComponent(parsed.rest))
      : parsed.bang.urlTemplate;
    return [
      {
        id: `bang:${parsed.bang.short}`,
        title: parsed.rest ? `Search ${parsed.bang.name}: ${parsed.rest}` : `Open ${parsed.bang.name}`,
        hint: parsed.bang.name,
        kbd: `!${parsed.bang.short}`,
        icon: 'bang',
        score: 1000,
        run: () => navigate(url)
      }
    ];
  }
});

// --- Calculator ---

const calculatorProvider = (onCopy?: (label: string) => void): BarProvider => ({
  id: 'calculator',
  search(query) {
    if (!/\d/.test(query)) return [];
    if (!/[+\-*/%^×÷]|sqrt|sin|cos|tan|log|ln/i.test(query)) return [];

    const value = evaluateExpression(query);
    if (value === null) return [];
    const formatted = formatResult(value);
    return [
      {
        id: 'calc:result',
        title: `= ${formatted}`,
        hint: `${query.trim()} · Copy result`,
        kbd: 'Copy',
        icon: 'calc',
        score: 900,
        run: async () => {
          try {
            await navigator.clipboard.writeText(formatted);
            onCopy?.(`Copied ${formatted}`);
          } catch {
            // clipboard denied
          }
        }
      }
    ];
  }
});

// --- Currency (Bidirectional: USD/Gold → Toman AND Toman → USD/Gold) ---

function parseReverseTomanQuery(input: string): { toman: number; target: 'usd' | 'gold' } | null {
  const s = input.trim().toLowerCase();
  const m = s.match(/^([\d.,]+)\s*([km]?)\s*(?:t|toman|tomans|irt|تومان)\s*(?:to|in|=|به)\s*(usdt|tether|usd|dollar|\$|gold|geram|طلا|دلار|تتر)$/);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1;
  const target: 'usd' | 'gold' = /gold|geram|طلا/.test(m[3]) ? 'gold' : 'usd';
  return { toman: base * mult, target };
}

const currencyProvider = (onCopy?: (label: string) => void): BarProvider => ({
  id: 'currency',
  async search(query): Promise<BarResult[]> {
    const reverse = parseReverseTomanQuery(query);
    if (reverse) {
      const prices = await lastPrices();
      const usdPrice = prices.usd?.price !== 'Error' ? prices.usd?.price : prices.usdt?.price;
      const rawRate = reverse.target === 'usd' ? usdPrice : prices.gold?.price;
      const rateToman = rawRate && rawRate !== 'Error' ? Number(rawRate.replace(/,/g, '')) / 10 : null;
      if (!rateToman || rateToman <= 0) {
        return [
          {
            id: 'currency:rev',
            title: 'Rate unavailable',
            hint: 'Currency converter',
            icon: 'money',
            score: 850,
            run: () => {}
          }
        ];
      }
      const converted = reverse.toman / rateToman;
      const formatted = converted.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const unit = reverse.target === 'usd' ? 'USD' : 'g Gold';
      return [
        {
          id: 'currency:rev',
          title: `${formatted} ${unit}`,
          hint: `${reverse.toman.toLocaleString('en-US')} Toman · Copy`,
          kbd: 'Copy',
          icon: 'money',
          score: 860,
          run: async () => {
            try {
              await navigator.clipboard.writeText(`${formatted} ${unit}`);
              onCopy?.(`Copied ${formatted} ${unit}`);
            } catch {
              // ignore
            }
          }
        }
      ];
    }

    const parsed = parseConversionQuery(query);
    if (!parsed) return [];

    const prices = await lastPrices();
    const usd = prices.usd?.price !== 'Error' ? prices.usd?.price : prices.usdt?.price;
    const gold = prices.gold?.price;
    const rates = {
      usdToman: usd && usd !== 'Error' ? Number(usd.replace(/,/g, '')) / 10 : null,
      goldToman: gold && gold !== 'Error' ? Number(gold.replace(/,/g, '')) / 10 : null
    };
    const total = convertToToman(parsed, rates);
    const formatted = total !== null ? `${formatResult(total)} Toman` : 'Rate unavailable';

    return [
      {
        id: 'currency:result',
        title: formatted,
        hint: `${parsed.amount} ${parsed.asset.toUpperCase()} · Copy`,
        kbd: 'Copy',
        icon: 'money',
        score: 850,
        run: async () => {
          if (total === null) return;
          try {
            await navigator.clipboard.writeText(formatted);
            onCopy?.(`Copied ${formatted}`);
          } catch {
            // ignore
          }
        }
      }
    ];
  }
});

let priceMemo: Partial<Record<'usd' | 'usdt' | 'gold', Awaited<ReturnType<typeof ApiClient.fetchAssetPrice>>>> | null = null;
let priceMemoTimestamp = 0;
const PRICE_MEMO_TTL = 3 * 60 * 1000;

async function lastPrices() {
  const now = Date.now();
  if (!priceMemo || now - priceMemoTimestamp > PRICE_MEMO_TTL) {
    priceMemo = await ApiClient.fetchPrices(['usd', 'usdt', 'gold']);
    priceMemoTimestamp = now;
  }
  return priceMemo;
}

// --- Actions registry ---

export interface ActionDef {
  name: string;
  aliases?: string[];
  kbd?: string;
  run: () => void;
}

export class ActionRegistry {
  private actions: ActionDef[] = [];

  register(action: ActionDef): void {
    this.actions.push(action);
  }

  getAll(): ActionDef[] {
    return [...this.actions];
  }

  searchActions(query: string): Array<{ action: ActionDef; score: number }> {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.actions.map((action, idx) => ({ action, score: 100 - idx }));
    }
    const results: Array<{ action: ActionDef; score: number }> = [];
    for (const action of this.actions) {
      const names = [action.name, ...(action.aliases || [])];
      let best = 0;
      for (const name of names) {
        const m = fuzzyMatch(trimmed, name);
        if (m && m.score > best) best = m.score;
      }
      if (best > 0) results.push({ action, score: best });
    }
    return results.sort((a, b) => b.score - a.score);
  }
}

const commandPrefixProvider = (registry: ActionRegistry): BarProvider => ({
  id: 'command-prefix',
  exclusive: true,
  search(query) {
    if (!query.startsWith('>')) return [];
    const rest = query.slice(1).trim();
    return registry.searchActions(rest).slice(0, 8).map(({ action, score }) => ({
      id: `cmd:${action.name}`,
      title: action.name,
      hint: 'Command',
      kbd: action.kbd,
      icon: 'action',
      score: 900 + score,
      run: action.run
    }));
  }
});

const actionsProvider = (registry: ActionRegistry): BarProvider => ({
  id: 'actions',
  search(query) {
    if (query.startsWith('>')) return [];
    return registry.searchActions(query).slice(0, 4).map(({ action, score }) => ({
      id: `action:${action.name}`,
      title: action.name,
      hint: 'Command',
      kbd: action.kbd,
      icon: 'action',
      score,
      run: action.run
    }));
  }
});

// --- Shortcuts ---

const shortcutsProvider = (getShortcuts: () => Shortcut[]): BarProvider => ({
  id: 'shortcuts',
  search(query) {
    const results: BarResult[] = [];
    const list = getShortcuts();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const m = fuzzyMatch(query, `${s.title} ${hostOfUrl(s.url)}`);
      if (m) {
        results.push({
          id: `shortcut:${s.url}`,
          title: s.title,
          hint: hostOfUrl(s.url),
          kbd: i < 9 ? `Alt+${i + 1}` : undefined,
          icon: 'shortcut',
          score: m.score + 30,
          run: () => navigate(s.url.startsWith('http') ? s.url : `https://${s.url}`)
        });
      }
    }
    return results;
  }
});

// --- Network Autocomplete Suggestions ---

const suggestionsProvider = (
  getEngine: () => { id: SearchEngineId; customUrl?: string }
): BarProvider => ({
  id: 'suggestions',
  async search(query) {
    if (query.length < 2 || query.startsWith('>') || query.startsWith('!')) return [];
    const cfg = getEngine();
    const engine = getSearchEngine(cfg.id, cfg.customUrl);
    const results = await ApiClient.fetchSuggestions(query, engine.id);
    const lowerQ = query.trim().toLowerCase();
    return results
      .filter((text) => text.trim().toLowerCase() !== lowerQ)
      .slice(0, 5)
      .map((text, idx) => ({
        id: `sugg:${text.toLowerCase()}`,
        title: text,
        hint: `${engine.name} Search`,
        icon: 'search',
        score: 52 - idx,
        run: () => navigate(buildSearchUrl(cfg.id, text, cfg.customUrl))
      }));
  }
});

// --- AI NL Commands ---

const aiNlProvider = (registry: ActionRegistry): BarProvider => ({
  id: 'ai-nl',
  async search(query): Promise<BarResult[]> {
    if (!isAIReady()) return [];
    if (/^[!>]/.test(query)) return [];
    if (/^[\d+\-*/%^().\s]+$/.test(query)) return [];
    if (query.split(/\s+/).length < 3) return [];

    const result = await parseNLCommand(query);
    if (!result || result.action === 'none' || result.confidence < 0.5) return [];

    const actionMap: Record<string, string> = {
      create_note: 'New note',
      remove_shortcut: 'Add shortcut',
      add_shortcut: 'Add shortcut',
      toggle_setting: 'Open preferences',
      search: 'Google',
      none: ''
    };

    const actionName = actionMap[result.action];
    if (!actionName) return [];

    const matched = registry.searchActions(actionName);
    if (matched.length === 0) return [];

    return [
      {
        id: `ai:${result.action}`,
        title: `${matched[0].action.name}${result.params.query ? `: ${result.params.query}` : ''}`,
        hint: 'Suggested action',
        icon: 'action',
        score: 50,
        run: matched[0].action.run
      }
    ];
  }
});

// --- Engine ---

export interface MergedResults {
  results: BarResult[];
  exclusive: boolean;
}

export interface EngineOptions {
  historyEnabled?: () => boolean;
  clipboardEnabled?: () => boolean;
  getSearchEngine?: () => { id: SearchEngineId; customUrl?: string };
  onCopy?: (label: string) => void;
}

export class CommandBarEngine {
  private providers: BarProvider[] = [];
  private localAsyncProviders: BarProvider[] = [];
  private networkProvider: BarProvider;
  private getEngine: () => { id: SearchEngineId; customUrl?: string };
  private calcProv: BarProvider;
  private actionsProv: BarProvider;
  private shortcutsProv: BarProvider;
  private cmdPrefixProv: BarProvider;

  constructor(
    registry: ActionRegistry,
    getShortcuts: () => Shortcut[],
    options: EngineOptions = {}
  ) {
    const {
      historyEnabled = () => false,
      clipboardEnabled = () => false,
      getSearchEngine: getEngineOpt = () => ({ id: 'google' as SearchEngineId }),
      onCopy
    } = options;

    this.getEngine = getEngineOpt;
    this.cmdPrefixProv = commandPrefixProvider(registry);
    this.calcProv = calculatorProvider(onCopy);
    this.actionsProv = actionsProvider(registry);
    this.shortcutsProv = shortcutsProvider(getShortcuts);
    this.networkProvider = suggestionsProvider(getEngineOpt);

    this.localAsyncProviders = [
      tabsProvider(),
      bookmarksProvider(),
      topSitesProvider(),
      historyProviderFactory(historyEnabled),
      clipboardProviderFactory(clipboardEnabled),
      currencyProvider(onCopy),
      aiNlProvider(registry)
    ];

    this.providers.push(
      bangProvider(),
      this.cmdPrefixProv,
      ...this.localAsyncProviders,
      this.calcProv,
      this.actionsProv,
      this.shortcutsProv,
      this.networkProvider
    );

    if (!customBangsLoaded) {
      void getCustomBangs();
    }
  }

  private static providerWeight(id: string): number {
    switch (id) {
      case 'bang':
      case 'command-prefix':
        return 0;
      case 'tabs':
        return 25;
      case 'shortcuts':
        return 20;
      case 'actions':
        return 15;
      case 'bookmarks':
        return 12;
      case 'calculator':
      case 'currency':
        return 10;
      case 'clipboard':
        return 8;
      case 'history':
        return 6;
      case 'topsites':
        return 4;
      default:
        return 0;
    }
  }

  private buildPrimarySearchItem(q: string): BarResult {
    const cfg = this.getEngine();
    const engine = getSearchEngine(cfg.id, cfg.customUrl);
    if (looksLikeUrl(q)) {
      const target = /^https?:\/\//i.test(q) ? q : `https://${q}`;
      return {
        id: 'primary:url',
        title: `Open ${q}`,
        hint: 'Direct URL',
        kbd: '↵',
        icon: 'shortcut',
        score: 210,
        run: () => navigate(target)
      };
    }
    return {
      id: 'primary:search',
      title: q,
      hint: `Search ${engine.name}`,
      kbd: '↵',
      icon: 'search',
      score: 180,
      run: () => navigate(buildSearchUrl(cfg.id, q, cfg.customUrl))
    };
  }

  private searchBangsSync(q: string): BarResult[] {
    if (!q.startsWith('!')) return [];
    const custom = customBangsCache;
    const allBangs = [...custom, ...BUILT_IN_BANGS.filter((b) => !custom.some((c) => c.short === b.short))];

    if (q === '!' || (/^!\w+$/.test(q) && !resolveBang(q.slice(1), custom))) {
      const prefix = q.slice(1).toLowerCase();
      return allBangs
        .filter((b) => !prefix || b.short.startsWith(prefix) || b.name.toLowerCase().includes(prefix))
        .slice(0, 6)
        .map((b, i) => ({
          id: `bang-hint:${b.short}`,
          title: `!${b.short} — ${b.name}`,
          hint: 'Type query after bang',
          kbd: `!${b.short}`,
          icon: 'bang',
          score: 950 - i,
          run: () => navigate(b.urlTemplate.replace('%s', ''))
        }));
    }

    const parsed = parseBangQuery(q, custom);
    if (!parsed) return [];
    const url = parsed.bang.urlTemplate.includes('%s')
      ? parsed.bang.urlTemplate.replace('%s', encodeURIComponent(parsed.rest))
      : parsed.bang.urlTemplate;
    return [
      {
        id: `bang:${parsed.bang.short}`,
        title: parsed.rest ? `Search ${parsed.bang.name}: ${parsed.rest}` : `Open ${parsed.bang.name}`,
        hint: parsed.bang.name,
        kbd: `!${parsed.bang.short}`,
        icon: 'bang',
        score: 1000,
        run: () => navigate(url)
      }
    ];
  }

  /** Phase 1: 0ms synchronous search — instant feedback on every keystroke. */
  searchInstant(query: string): MergedResults {
    const q = query.trim();
    if (!q) return { results: [], exclusive: false };

    if (q.startsWith('!')) {
      const bangRes = this.searchBangsSync(q);
      if (bangRes.length > 0) return { results: bangRes.slice(0, 8), exclusive: true };
    }
    if (q.startsWith('>')) {
      const cmdRes = this.cmdPrefixProv.search(q) as BarResult[];
      if (cmdRes.length > 0) return { results: cmdRes.slice(0, 8), exclusive: true };
    }

    const items: BarResult[] = [this.buildPrimarySearchItem(q)];
    const pushWeighted = (id: string, list: BarResult[]): void => {
      const w = CommandBarEngine.providerWeight(id);
      for (const r of list) items.push({ ...r, score: r.score + w });
    };

    pushWeighted('calculator', this.calcProv.search(q) as BarResult[]);
    pushWeighted('shortcuts', this.shortcutsProv.search(q) as BarResult[]);
    pushWeighted('actions', this.actionsProv.search(q) as BarResult[]);

    const deduped = this.mergeLists([items]);
    return { results: deduped.slice(0, 8), exclusive: false };
  }

  /** Phase 2a: fast local Chrome IPC + currency providers (no network autocomplete wait). */
  async searchLocalAsync(query: string): Promise<BarResult[]> {
    const q = query.trim();
    if (!q || q.startsWith('!') || q.startsWith('>')) return [];
    const settled = await Promise.all(
      this.localAsyncProviders.map(async (p) => {
        try {
          const res = await p.search(q);
          const w = CommandBarEngine.providerWeight(p.id);
          return res.map((r) => ({ ...r, score: r.score + w }));
        } catch {
          return [] as BarResult[];
        }
      })
    );
    return this.mergeLists(settled);
  }

  /** Phase 2b: network autocomplete suggestions (cached or debounced). */
  async searchNetworkSuggestions(query: string): Promise<BarResult[]> {
    const q = query.trim();
    if (q.length < 2 || q.startsWith('!') || q.startsWith('>') || looksLikeUrl(q)) return [];
    try {
      return await this.networkProvider.search(q);
    } catch {
      return [];
    }
  }

  mergeLists(lists: BarResult[][]): BarResult[] {
    const merged = new Map<string, BarResult>();
    for (const list of lists) {
      for (const r of list) {
        const existing = merged.get(r.id);
        if (!existing || existing.score < r.score) merged.set(r.id, r);
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  /** 0ms synchronous Enter resolver — never waits for network suggestions or debounces. */
  resolveEnterAction(query: string): () => void {
    const q = query.trim();
    if (!q) return () => {};

    if (q.startsWith('!')) {
      const bangs = this.searchBangsSync(q);
      if (bangs.length > 0) return bangs[0].run;
    }

    if (q.startsWith('>')) {
      const cmds = this.cmdPrefixProv.search(q) as BarResult[];
      if (cmds.length > 0) return cmds[0].run;
    }

    const calc = this.calcProv.search(q) as BarResult[];
    if (calc.length > 0) return calc[0].run;

    return this.buildPrimarySearchItem(q).run;
  }

  async search(query: string): Promise<MergedResults> {
    const q = query.trim();
    if (!q) return { results: [], exclusive: false };

    const instant = this.searchInstant(q);
    if (instant.exclusive) return instant;

    const [local, net] = await Promise.all([
      this.searchLocalAsync(q),
      this.searchNetworkSuggestions(q)
    ]);

    return {
      results: this.mergeLists([instant.results, local, net]),
      exclusive: false
    };
  }
}
