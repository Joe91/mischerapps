// Small localStorage wrapper with defaults, deep-merge on load and JSON export/import.
// Data stays on this device only.

export interface Store<T> {
  load(): T;
  save(value: T): void;
  exportJson(value: T, strip?: (v: T) => T): string;
  importJson(text: string): T;
}

function merge<T>(defaults: T, value: unknown): T {
  if (Array.isArray(defaults)) return (Array.isArray(value) ? value : defaults) as T;
  if (defaults && typeof defaults === 'object') {
    const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = k in out ? merge(out[k], v) : v;
      }
    }
    return out as T;
  }
  if (value === undefined) return defaults;
  if (defaults === undefined || defaults === null) return value as T;
  return (typeof value === typeof defaults ? value : defaults) as T;
}

/** `upgrade` sees the stored (or imported) values before they are merged with the defaults. */
export function createStore<T>(key: string, defaults: () => T, upgrade: (stored: unknown) => unknown = v => v): Store<T> {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? merge(defaults(), upgrade(JSON.parse(raw))) : defaults();
      } catch {
        return defaults();
      }
    },
    save(value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    },
    exportJson(value, strip) {
      return JSON.stringify({ app: key, exported: new Date().toISOString(), settings: strip ? strip(value) : value }, null, 2);
    },
    importJson(text) {
      const parsed = JSON.parse(text);
      return merge(defaults(), upgrade(parsed?.settings ?? parsed));
    },
  };
}
