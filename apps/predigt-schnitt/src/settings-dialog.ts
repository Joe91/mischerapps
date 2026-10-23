import { DENOISE_ATTEN_DB } from '../../../packages/denoise/denoise';
import { h, download, toast } from '../../../packages/ui-kit/dom';
import type { Ctx } from './context';
import {
  EXPORT_PRESETS, LOUDNESS_PRESETS, SOUND_OPTIONS, normalizeSettings, settingsStore,
  type ExportPresetId, type LoudnessPresetId, type Settings, type SoundOption,
} from './settings';

/** Settings dialog (admin only). Edits a copy; "Speichern" stores it here and on the server, where it applies to everybody. */
export function openSettings(ctx: Ctx, onSaved?: () => void) {
  const draft: Settings = structuredClone(ctx.settings);
  const dlg = h('dialog', { class: 'settings' });

  const text = (label: string, get: () => string, set: (v: string) => void, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { ...attrs, value: get() });
    input.addEventListener('input', () => set(input.value));
    return h('label', null, label, input);
  };
  const select = (label: string, options: Record<string, { label: string }>, get: () => string, set: (v: string) => void) => {
    const el = h('select', null, ...Object.entries(options).map(([k, o]) => h('option', { value: k }, o.label)));
    el.value = get();
    el.addEventListener('change', () => set(el.value));
    return h('label', null, label, el);
  };
  // number rows, groups and checkboxes look like the advanced panel in the export step
  const amount = (label: string, unit: string, get: () => number, set: (v: number) => void, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { type: 'number', inputmode: 'decimal', ...attrs, value: String(get()) });
    input.addEventListener('change', () => { const v = Number(input.value); if (!isNaN(v)) set(v); });
    return { input, el: h('label', { class: 'inline' }, h('span', null, label), h('span', { class: 'unit' }, input, h('span', { class: 'unit-label' }, unit))) };
  };
  const sound = (key: SoundOption) => {
    const input = h('input', { type: 'checkbox', checked: draft[key] });
    const { label, hint } = SOUND_OPTIONS[key];
    return { input, el: h('label', { class: 'check-hint' }, input, h('span', null, label), h('small', null, hint)) };
  };
  const group = (title: string, ...children: Node[]) => h('div', { class: 'adv-group' }, h('h4', null, title), ...children);

  // ---- cover image ----
  const coverPreview = h('img', { class: 'cover-preview', alt: '' });
  const coverInput = h('input', { type: 'file', accept: 'image/jpeg,image/png' });
  const showCover = () => { coverPreview.src = draft.coverDataUrl; coverPreview.classList.toggle('hidden', !draft.coverDataUrl); };
  coverInput.addEventListener('change', () => {
    const f = coverInput.files?.[0];
    if (!f) return;
    if (f.size > 500_000) { toast('Cover-Bild bitte kleiner als 500 kB wählen.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => { draft.coverDataUrl = String(reader.result); showCover(); };
    reader.readAsDataURL(f);
  });
  showCover();

  // ---- import / export ----
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const imported = normalizeSettings(settingsStore.importJson(await f.text()));
      Object.assign(ctx.settings, imported);
      ctx.saveSettings();
      dlg.close();
      toast('Einstellungen importiert.', 'ok');
      onSaved?.();
    } catch (e) {
      toast(`Import fehlgeschlagen: ${(e as Error).message}`, 'error');
    }
  });

  // ---- sound ----
  const hp = sound('highpass'), comp = sound('compressor'), dn = sound('denoise');
  const dnDb = amount(`Stärke (Standard ${DENOISE_ATTEN_DB} dB)`, 'dB', () => draft.denoiseDb, v => { draft.denoiseDb = v; }, { min: 3, max: 40, step: 1 });
  dnDb.el.classList.add('sub');
  const syncSound = () => {
    for (const [key, o] of [['highpass', hp], ['compressor', comp], ['denoise', dn]] as const) draft[key] = o.input.checked;
    dnDb.input.disabled = !draft.denoise;
    dnDb.el.classList.toggle('disabled', !draft.denoise);
  };
  for (const o of [hp, comp, dn]) o.input.addEventListener('change', syncSound);
  syncSound();

  const body = h('div', { class: 'dlg-body' },
    h('fieldset', null, h('legend', null, 'Voreinstellungen'),
      h('p', { class: 'muted small' }, 'Diese Werte werden nach dem Schnitt automatisch angewendet. Im Export lassen sie sich über „Erweitert“ ' +
        'für eine einzelne Aufnahme ändern (ohne die Voreinstellung zu verändern).'),
      h('div', { class: 'adv-groups' },
        h('div', { class: 'adv-col' },
          group('Lautheit & Format',
            select('Zielwert', LOUDNESS_PRESETS, () => draft.loudnessPreset, v => { draft.loudnessPreset = v as LoudnessPresetId; }),
            select('Format (bestimmt Mono/Stereo)', EXPORT_PRESETS, () => draft.exportPreset, v => { draft.exportPreset = v as ExportPresetId; }),
            amount('Max. Anhebung', 'dB', () => draft.maxGainDb, v => { draft.maxGainDb = v; }, { min: 0, max: 80, step: 1 }).el,
          ),
          group('Übergänge',
            amount('Einblenden', 's', () => draft.fadeIn, v => { draft.fadeIn = v; }, { min: 0, max: 10, step: 0.1 }).el,
            amount('Ausblenden', 's', () => draft.fadeOut, v => { draft.fadeOut = v; }, { min: 0, max: 10, step: 0.1 }).el,
          ),
        ),
        group('Klang', hp.el, comp.el, dn.el, dnDb.el),
      ),
    ),
    h('fieldset', null, h('legend', null, 'Dateiname & Tags'),
      h('div', { class: 'grid' },
        text('Namensschema', () => draft.namePattern, v => { draft.namePattern = v; }, { class: 'mono' }),
        text('Titel-Vorgabe', () => draft.titlePrefix, v => { draft.titlePrefix = v; }),
        text('Gemeinde (Album)', () => draft.congregation, v => { draft.congregation = v; }),
        text('Prediger/in (Vorgabe)', () => draft.preacher, v => { draft.preacher = v; }),
      ),
      h('p', { class: 'muted small' }, 'Platzhalter: {jjmmdd} (JJMMTT, z. B. 260712) {datum} (JJJJ-MM-TT) {titel} {prediger} {bibelstelle} {gemeinde}. Umlaute werden ersetzt (ä → ae).'),
      h('div', { class: 'row' }, h('label', null, 'Cover-Bild (optional, JPEG/PNG < 500 kB)', coverInput), coverPreview,
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { draft.coverDataUrl = ''; coverInput.value = ''; showCover(); } }, 'Entfernen')),
    ),
    h('fieldset', null, h('legend', null, 'Erkennung'),
      h('div', { class: 'adv-groups' },
        h('div', { class: 'adv-group' },
          amount('Mindestlänge Predigt', 'min', () => draft.minSermonMin, v => { draft.minSermonMin = v; }, { min: 1, max: 60, step: 1 }).el,
          amount('Pausen zusammenführen bis', 's', () => draft.mergeGapSec, v => { draft.mergeGapSec = v; }, { min: 0, max: 60, step: 1 }).el,
        ),
      ),
      h('p', { class: 'muted small' }, 'Wirkt beim nächsten Laden einer Datei.'),
    ),
    h('fieldset', null, h('legend', null, 'Sichern & Übertragen'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-sm', type: 'button', onclick: () => {
            const json = settingsStore.exportJson(draft);
            download(new Blob([json], { type: 'application/json' }), 'predigt-schnitt-einstellungen.json');
          },
        }, 'Als JSON exportieren'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => importInput.click() }, 'JSON importieren …'),
        importInput,
      ),
    ),
  );

  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', null, 'Einstellungen'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button', {
        class: 'btn btn-primary', type: 'button', onclick: () => {
          Object.assign(ctx.settings, draft);
          ctx.saveSettings();
          ctx.changed();
          dlg.close();
          toast('Einstellungen gespeichert.', 'ok');
          onSaved?.();
        },
      }, 'Speichern'),
    ),
    body,
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}
