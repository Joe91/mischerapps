type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript helper: h('button', { class: 'btn', onclick }, 'Text'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

/** Formats seconds as m:ss.s or h:mm:ss.s */
export function fmtTime(s: number, tenths = true): string {
  if (!isFinite(s)) return '–';
  const neg = s < 0;
  s = Math.abs(s);
  if (tenths) s = Math.round(s * 10) / 10;
  else s = Math.round(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const sec = tenths ? ss.toFixed(1).padStart(4, '0') : String(Math.floor(ss)).padStart(2, '0');
  return (neg ? '−' : '') + (hh ? `${hh}:${String(mm).padStart(2, '0')}:${sec}` : `${mm}:${sec}`);
}

/** Parses "1:02:10.5", "22:14", "95.2" (also with comma decimal). Returns NaN if invalid. */
export function parseTime(text: string): number {
  const parts = text.trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => p === '' || isNaN(Number(p)))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export const fmtDb = (v: number, digits = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(digits).replace('.', ',');
export const fmtNum = (v: number, digits = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits).replace('.', ',');
export const fmtBytes = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.round(b / 1e3)} kB`;

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 4500) {
  let host = document.querySelector('.toasts');
  if (!host) { host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const el = h('div', { class: `toast toast-${kind}` }, msg);
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

export interface ProgressBar { el: HTMLElement; set(p: number, label?: string): void; done(): void; }

export function progressBar(label = ''): ProgressBar {
  const fill = h('div', { class: 'progress-fill' });
  const text = h('span', { class: 'progress-label' }, label);
  const el = h('div', { class: 'progress' }, h('div', { class: 'progress-track' }, fill), text);
  return {
    el,
    set(p, l) {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
      text.textContent = `${l ?? label} ${Math.round(p * 100)} %`;
    },
    done() { el.remove(); },
  };
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
