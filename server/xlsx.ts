// Reading cells of .xlsx files by their address, and changing a single cell in place – for spreadsheets other
// people maintain in OpenCloud (Einsatzplan, eAg-Übersicht). An .xlsx file is a zip of XML parts; an edit
// replaces just that cell's XML, so formatting, other sheets, formulas and everything else stay as they were.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export type CellValue = string | number | boolean;

export class XlsxError extends Error {}

/** "E" → 4, "AA" → 26 */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export function colName(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

const unescapeXml = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // characters XML 1.0 does not allow
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
/** the text of <t> elements (rich text has several), without phonetic runs */
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join('');

/** One <c> element: its address, attributes, content and position in the sheet XML. */
interface CellXml { ref: string; row: number; col: number; attrs: string; inner: string; start: number; end: number; }

const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

export class Xlsx {
  private files: Record<string, Uint8Array>;
  private strings: string[] = [];
  private sheetXml = new Map<string, string>();
  /** workbook order; `path` is the part inside the zip */
  readonly sheets: { name: string; path: string }[] = [];
  readonly date1904: boolean;

  constructor(data: Uint8Array) {
    try { this.files = unzipSync(data); } catch { throw new XlsxError('not an xlsx file'); }
    const workbook = this.text('xl/workbook.xml');
    const rels = this.text('xl/_rels/workbook.xml.rels');
    if (!workbook || !rels) throw new XlsxError('not an xlsx file');
    this.date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook);
    const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(m => [attr(m[1], 'Id'), attr(m[1], 'Target') ?? '']));
    for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const target = targets.get(attr(m[1], 'r:id')) ?? '';
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      this.sheets.push({ name: unescapeXml(attr(m[1], 'name') ?? ''), path });
    }
    const shared = this.text('xl/sharedStrings.xml');
    if (shared) this.strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  }

  private text(path: string): string | null {
    return this.files[path] ? strFromU8(this.files[path]) : null;
  }

  private xml(sheet: number): string {
    const s = this.sheets[sheet];
    if (!s) throw new XlsxError(`no sheet ${sheet + 1}`);
    const cached = this.sheetXml.get(s.path);
    if (cached !== undefined) return cached;
    const xml = this.text(s.path);
    if (xml === null) throw new XlsxError(`sheet ${s.name} missing`);
    this.sheetXml.set(s.path, xml);
    return xml;
  }

  private *cellsXml(sheet: number): Generator<CellXml> {
    const xml = this.xml(sheet);
    for (const m of xml.matchAll(CELL)) {
      const ref = attr(m[1], 'r');
      const at = ref && /^([A-Z]+)(\d+)$/.exec(ref);
      if (!at) throw new XlsxError('cell without address');
      yield { ref: ref!, row: Number(at[2]), col: colIndex(at[1]), attrs: m[1], inner: m[2] ?? '', start: m.index!, end: m.index! + m[0].length };
    }
  }

  private value(c: CellXml): CellValue | null {
    const type = attr(c.attrs, 't');
    if (type === 'inlineStr') return texts(c.inner);
    const v = /<v>([\s\S]*?)<\/v>/.exec(c.inner)?.[1];
    if (v === undefined) return null;
    if (type === 's') return this.strings[Number(v)] ?? '';
    if (type === 'str') return unescapeXml(v);
    if (type === 'b') return v === '1';
    if (type === 'e') return null;
    return Number(v);
  }

  /** The cells of a sheet (0 = the first): row number (1-based, as in Excel) → column index (0 = A) → value. */
  rows(sheet = 0): Map<number, Map<number, CellValue>> {
    const rows = new Map<number, Map<number, CellValue>>();
    for (const c of this.cellsXml(sheet)) {
      const v = this.value(c);
      if (v === null || v === '') continue;
      if (!rows.has(c.row)) rows.set(c.row, new Map());
      rows.get(c.row)!.set(c.col, v);
    }
    return rows;
  }

  /** Excel's day number → YYYY-MM-DD (null if it is no plausible date). */
  serialToIso(n: number): string | null {
    if (!(n > 0 && n < 2958466)) return null;
    const base = this.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    return new Date(base + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
  }

  /**
   * Sets one cell to a text (empty: no value) and keeps its formatting. Refuses cells with a formula. Cells that
   * do not exist yet are added to their row (which must exist).
   */
  setText(sheet: number, row: number, col: number, text: string) {
    const path = this.sheets[sheet].path;
    let xml = this.xml(sheet);
    const ref = `${colName(col)}${row}`;
    const cell = [...this.cellsXml(sheet)].find(c => c.ref === ref);
    if (cell && /<f\b/.test(cell.inner)) throw new XlsxError(`${ref} contains a formula`);
    const style = cell ? attr(cell.attrs, 's') : undefined;
    const value = escapeXml(text);
    const newCell = `<c r="${ref}"${style !== undefined ? ` s="${style}"` : ''}${value ? ' t="inlineStr"><is><t xml:space="preserve">' + value + '</t></is></c>' : '/>'}`;
    if (cell) {
      xml = xml.slice(0, cell.start) + newCell + xml.slice(cell.end);
    } else {
      const rowMatch = new RegExp(`<row\\b([^>]*\\br="${row}"[^>]*?)(?:/>|>([\\s\\S]*?)</row>)`).exec(xml);
      if (!rowMatch) throw new XlsxError(`row ${row} missing`);
      // cells must stay in column order; "spans" is only a hint and may no longer fit
      const rowAttrs = rowMatch[1].replace(/\s+spans="[^"]*"/, '');
      const inner = rowMatch[2] ?? '';
      const after = [...inner.matchAll(CELL)].find(m => colIndex(/^([A-Z]+)/.exec(attr(m[1], 'r') ?? '')?.[1] ?? 'A') > col);
      const at = after ? after.index! : inner.length;
      const rowXml = `<row${rowAttrs}>${inner.slice(0, at)}${newCell}${inner.slice(at)}</row>`;
      xml = xml.slice(0, rowMatch.index) + rowXml + xml.slice(rowMatch.index + rowMatch[0].length);
    }
    this.sheetXml.set(path, xml);
    this.files[path] = strToU8(xml);
  }

  toBuffer(): Uint8Array {
    return zipSync(this.files, { level: 6 });
  }
}
