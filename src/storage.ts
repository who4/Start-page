import { STARTER_SHORTCUTS, STORAGE_KEYS } from './constants';
import type { Settings, Shortcut, NoteData } from './types';

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    accent: 'orange',
    themePreset: 'graphite',
    customAccent: '',
    customBg: '',
    clockScale: 'standard',
    density: 'standard',
    bookmarkIconStyle: 'dithered',
    scrollbarStyle: 'thin',
    showBookmarkHosts: true,
    showBookmarkIndices: true,
    surfaceGrid: false,
    colorPalette: []
  },
  general: {
    calendar: 'gregorian',
    clock24h: true,
    showSeconds: true,
    showDualDate: true,
    showDailyFocus: true,
    rememberDrawerState: false
  },
  weather: {
    city: 'Tehran',
    country: 'Iran',
    lat: 35.6892,
    lon: 51.3890,
    useGeolocation: false,
    unit: 'c'
  },
  news: {
    sourceId: 'bbc-world',
    customUrl: '',
    keywords: []
  },
  widgets: {
    priceTicker: true,
    newsWidget: true,
    greeting: false,
    intention: false,
    weather: true,
    calendar: true,
    rss: true,
    habits: false,
    focus: false
  },
  privacy: {
    historySearch: true,
    clipboardHistory: false
  },
  finance: {
    assets: ['usd', 'gold'],
    alerts: []
  }
};

export const SCHEMA_VERSION = 2;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Deep-merge stored settings over defaults so newly-added keys always exist.
export function mergeWithDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(stored) || !isPlainObject(defaults)) {
    return (isPlainObject(defaults) ? { ...defaults } : stored) as T;
  }
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults as Record<string, unknown>)) {
    const dVal = (defaults as Record<string, unknown>)[key];
    const sVal = (stored as Record<string, unknown>)[key];
    if (sVal === undefined) continue;
    if (Array.isArray(dVal) && !Array.isArray(sVal)) continue;
    out[key] = isPlainObject(dVal) ? mergeWithDefaults(dVal, sVal) : sVal;
  }
  return out as T;
}

type ChangeListener = (changes: Record<string, unknown>, area: string) => void;

class StorageService {
  private listeners: Set<ChangeListener> = new Set();

  get<T>(key: string): Promise<T | undefined>;
  get<T>(key: string, fallback: T): Promise<T>;
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          const value = result[key];
          resolve(value === undefined ? fallback : (value as T));
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  set<T>(key: string, value: T): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  onChanged(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      this.listeners.forEach((l) => l(changes as Record<string, unknown>, area));
    });
  }

  // --- Typed convenience accessors ---

  async getShortcuts(): Promise<Shortcut[]> {
    const stored = await this.get<Shortcut[] | undefined>(STORAGE_KEYS.shortcuts);
    if (stored === undefined) {
      const starters = STARTER_SHORTCUTS.map((s) => ({ ...s }));
      await this.setShortcuts(starters);
      return starters;
    }
    return stored;
  }

  async setShortcuts(shortcuts: Shortcut[]): Promise<void> {
    await this.set(STORAGE_KEYS.shortcuts, shortcuts);
  }

  async getNotes(): Promise<NoteData[]> {
    return this.get<NoteData[]>(STORAGE_KEYS.stickyNotes, []);
  }

  async setNotes(notes: NoteData[]): Promise<void> {
    await this.set(STORAGE_KEYS.stickyNotes, notes);
  }

  async getDrawerOpen(): Promise<boolean> {
    return this.get<boolean>(STORAGE_KEYS.drawerOpen, false);
  }

  async setDrawerOpen(open: boolean): Promise<void> {
    await this.set(STORAGE_KEYS.drawerOpen, open);
  }

  async getNotesVisible(): Promise<boolean> {
    return this.get<boolean>(STORAGE_KEYS.notesVisible, true);
  }

  async setNotesVisible(visible: boolean): Promise<void> {
    await this.set(STORAGE_KEYS.notesVisible, visible);
  }

  async getSettings(): Promise<Settings> {
    const raw = await this.get<unknown>(STORAGE_KEYS.settings);
    const merged = mergeWithDefaults(DEFAULT_SETTINGS, raw);
    // Migrate legacy preset/icon values
    if ((merged.appearance.themePreset as string) === 'midnight') {
      merged.appearance.themePreset = 'graphite';
    }
    if ((merged.appearance.bookmarkIconStyle as string) === 'grain') {
      merged.appearance.bookmarkIconStyle = 'solid';
    }
    return merged;
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.set(STORAGE_KEYS.settings, settings);
  }
}

export const storage = new StorageService();
