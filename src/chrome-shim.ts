// Browser preview shim for Chrome extension APIs.
// No-op when running inside an actual Chrome extension (where chrome.runtime.id exists).

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type StorageListener = (changes: Record<string, StorageChange>, areaName: string) => void;

const STORAGE_PREFIX = 'start_ext:';

function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.id === 'string' &&
    chrome.runtime.id.length > 0 &&
    typeof chrome.storage?.local?.get === 'function'
  );
}

function installChromeShim(): void {
  if (typeof window === 'undefined' || isExtensionContext()) return;

  const listeners = new Set<StorageListener>();

  const readKey = (key: string): unknown => {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  const writeKey = (key: string, value: unknown): void => {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // storage quota or private mode
    }
  };

  const notifyListeners = (changes: Record<string, StorageChange>): void => {
    if (Object.keys(changes).length === 0) return;
    listeners.forEach((fn) => {
      try {
        fn(changes, 'local');
      } catch {
        // ignore listener errors
      }
    });
  };

  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(STORAGE_PREFIX)) return;
    const key = event.key.slice(STORAGE_PREFIX.length);
    const parse = (raw: string | null): unknown => {
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    };
    notifyListeners({
      [key]: { oldValue: parse(event.oldValue), newValue: parse(event.newValue) }
    });
  });

  const storageLocal = {
    get(
      keys?: string | string[] | Record<string, unknown> | null,
      callback?: (items: Record<string, unknown>) => void
    ): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};

      if (keys === null || keys === undefined) {
        for (let i = 0; i < window.localStorage.length; i++) {
          const fullKey = window.localStorage.key(i);
          if (fullKey && fullKey.startsWith(STORAGE_PREFIX)) {
            const k = fullKey.slice(STORAGE_PREFIX.length);
            result[k] = readKey(k);
          }
        }
      } else if (typeof keys === 'string') {
        const val = readKey(keys);
        if (val !== undefined) result[keys] = val;
      } else if (Array.isArray(keys)) {
        for (const k of keys) {
          const val = readKey(k);
          if (val !== undefined) result[k] = val;
        }
      } else if (typeof keys === 'object') {
        for (const [k, defaultVal] of Object.entries(keys)) {
          const val = readKey(k);
          result[k] = val !== undefined ? val : defaultVal;
        }
      }

      if (callback) {
        queueMicrotask(() => callback(result));
      }
      return Promise.resolve(result);
    },

    set(items: Record<string, unknown>, callback?: () => void): Promise<void> {
      const changes: Record<string, StorageChange> = {};
      for (const [key, newValue] of Object.entries(items)) {
        const oldValue = readKey(key);
        writeKey(key, newValue);
        changes[key] = { oldValue, newValue };
      }

      if (callback) {
        queueMicrotask(() => callback());
      }
      queueMicrotask(() => notifyListeners(changes));
      return Promise.resolve();
    },

    remove(keys: string | string[], callback?: () => void): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, StorageChange> = {};
      for (const key of list) {
        const oldValue = readKey(key);
        window.localStorage.removeItem(STORAGE_PREFIX + key);
        if (oldValue !== undefined) {
          changes[key] = { oldValue, newValue: undefined };
        }
      }
      if (callback) queueMicrotask(() => callback());
      queueMicrotask(() => notifyListeners(changes));
      return Promise.resolve();
    },

    clear(callback?: () => void): Promise<void> {
      const toRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) toRemove.push(k);
      }
      toRemove.forEach((k) => window.localStorage.removeItem(k));
      if (callback) queueMicrotask(() => callback());
      return Promise.resolve();
    }
  };

  const handleMessage = async (message: { action?: string; url?: string; query?: string }): Promise<unknown> => {
    if (message?.action === 'PROXY_FETCH' && typeof message.url === 'string') {
      try {
        const resp = await fetch(`/api/proxy?url=${encodeURIComponent(message.url)}`);
        if (!resp.ok) {
          return { success: false, error: `HTTP ${resp.status}` };
        }
        const data = await resp.text();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Proxy fetch failed' };
      }
    }

    if (message?.action === 'FETCH_RSS' && typeof message.url === 'string') {
      try {
        const resp = await fetch(`/api/rss?url=${encodeURIComponent(message.url)}`);
        if (!resp.ok) {
          return { success: false, error: `HTTP ${resp.status}` };
        }
        const data = await resp.text();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'RSS fetch failed' };
      }
    }

    if (message?.action === 'FETCH_SUGGESTIONS' && typeof message.query === 'string') {
      try {
        const resp = await fetch(`/api/suggestions?q=${encodeURIComponent(message.query)}`);
        if (!resp.ok) {
          return { success: false, error: `HTTP ${resp.status}` };
        }
        const data = (await resp.json()) as string[];
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Suggestions failed' };
      }
    }

    return { success: false, error: 'Unsupported action in web preview' };
  };

  const shim = {
    storage: {
      local: storageLocal,
      onChanged: {
        addListener(fn: StorageListener) {
          listeners.add(fn);
        },
        removeListener(fn: StorageListener) {
          listeners.delete(fn);
        },
        hasListener(fn: StorageListener) {
          return listeners.has(fn);
        }
      }
    },
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      getManifest() {
        return {
          manifest_version: 3,
          name: 'Start',
          version: '1.1.0',
          description: 'A modern, customizable new tab page with shortcuts and price ticker.'
        };
      },
      reload() {
        window.location.reload();
      },
      sendMessage(
        message: { action?: string; url?: string; query?: string },
        callback?: (response: unknown) => void
      ): Promise<unknown> {
        const promise = handleMessage(message);
        if (callback) {
          void promise.then((res) => callback(res));
        }
        return promise;
      }
    }
  };

  const existing = (globalThis as unknown as { chrome?: Record<string, unknown> }).chrome ?? {};
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
    ...existing,
    storage: shim.storage,
    runtime: shim.runtime
  };
}

installChromeShim();
