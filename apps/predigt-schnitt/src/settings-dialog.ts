import { h, download, toast } from '../../../packages/ui-kit/dom';
import type { Ctx } from './context';
import {
  CLOUD_KINDS, EXPORT_PRESETS, LOUDNESS_PRESETS, UPLOAD_KINDS, newId, normalizeSettings, profileKind, settingsStore, stripTokens,
  type ExportPresetId, type LoudnessPresetId, type Settings, type UploadKind, type UploadProfile,
} from './settings';

/** Settings dialog (admin only). Edits a copy; "Speichern" stores it here and, for the shared part, on the server. */
export function openSettings(ctx: Ctx, onSaved?: () => void) {
  const draft: Settings = structuredClone(ctx.settings);
  const dlg = h('dialog', { class: 'settings' });

  const text = (label: string, get: () => string, set: (v: string) => void, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { ...attrs, value: get() });
    input.addEventListener('input', () => set(input.value));
    return h('label', null, label, input);
  };
  const number = (label: string, get: () => number, set: (v: number) => void, attrs: Record<string, unknown> = {}) => {
    const input = h('input', { type: 'number', ...attrs, value: String(get()) });
    input.addEventListener('change', () => { const v = Number(input.value); if (!isNaN(v)) set(v); });
    return h('label', null, label, input);
  };
  const select = (label: string, options: Record<string, { label: string }>, get: () => string, set: (v: string) => void) => {
    const el = h('select', null, ...Object.entries(options).map(([k, o]) => h('option', { value: k }, o.label)));
    el.value = get();
    el.addEventListener('change', () => set(el.value));
    return h('label', null, label, el);
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const el = h('input', { type: 'checkbox', checked: get() });
    el.addEventListener('change', () => set(el.checked));
    return h('label', { class: 'check' }, el, label);
  };

  // ---- upload profiles ----
  const profileList = h('div', { class: 'profiles' });
  function renderProfiles() {
    profileList.replaceChildren(...draft.profiles.map(p => profileRow(p)),
      draft.profiles.length ? '' : h('p', { class: 'muted' }, 'Kein Ziel.'));
  }
  function profileRow(p: UploadProfile) {
    if (profileKind(p) === 'server') {
      const serverRadio = h('input', { type: 'radio', name: 'active-profile', checked: draft.activeProfileId === p.id, title: 'Standard-Ziel' });
      serverRadio.addEventListener('change', () => { draft.activeProfileId = p.id; });
      return h('div', { class: 'profile' },
        h('strong', null, UPLOAD_KINDS.server.label),
        h('p', { class: 'muted small' }, 'Die fertige MP3 wird auf dem NAS gespeichert (Ordner „predigten“ im Datenverzeichnis der App).'),
        h('div', { class: 'profile-actions' }, h('label', { class: 'check', title: 'Als Standard verwenden' }, serverRadio, 'Standard-Ziel')),
      );
    }
    const token = h('input', { type: 'password', value: p.token, autocomplete: 'off', spellcheck: 'false' });
    token.addEventListener('input', () => { p.token = token.value; });
    const show = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { token.type = token.type === 'password' ? 'text' : 'password'; } }, '👁');
    const radio = h('input', { type: 'radio', name: 'active-profile', checked: draft.activeProfileId === p.id, title: 'Standard-Ziel' });
    radio.addEventListener('change', () => { draft.activeProfileId = p.id; });
    const k = UPLOAD_KINDS[profileKind(p)];
    const kind = select('Art', CLOUD_KINDS, () => profileKind(p), v => { p.kind = v as UploadKind; renderProfiles(); });
    return h('div', { class: 'profile' },
      kind,
      text('Name', () => p.name, v => { p.name = v; }, { placeholder: 'z. B. Predigten-Ordner' }),
      text(k.url, () => p.url, v => { p.url = v.trim(); }, { placeholder: k.urlHint, type: 'url' }),
      h('label', null, k.secret, h('div', { class: 'row nowrap' }, token, show)),
      h('div', { class: 'profile-actions' },
        h('label', { class: 'check', title: 'Als Standard verwenden' }, radio, 'Standard-Ziel'),
        h('button', {
          class: 'btn btn-sm btn-danger', type: 'button', onclick: () => {
            draft.profiles = draft.profiles.filter(x => x !== p);
            if (draft.activeProfileId === p.id) draft.activeProfileId = draft.profiles[0]?.id ?? '';
            renderProfiles();
          },
        }, 'Entfernen'),
      ),
    );
  }
  renderProfiles();

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
  const withTokens = h('input', { type: 'checkbox' });
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const imported = normalizeSettings(settingsStore.importJson(await f.text()));
      // keep existing tokens where the import has none
      for (const p of imported.profiles) {
        if (!p.token) p.token = draft.profiles.find(x => x.id === p.id || x.url === p.url)?.token ?? '';
      }
      Object.assign(ctx.settings, imported);
      ctx.saveSettings();
      dlg.close();
      toast('Einstellungen importiert.', 'ok');
      onSaved?.();
    } catch (e) {
      toast(`Import fehlgeschlagen: ${(e as Error).message}`, 'error');
    }
  });

  const body = h('div', { class: 'dlg-body' },
    h('fieldset', null, h('legend', null, 'Upload-Ziele'),
      h('p', { class: 'muted small' }, 'Normalerweise geht der Upload auf dieses NAS. Zusätzlich lässt sich ein Cloud-Ordner eintragen: ' +
        'In OpenCloud bzw. Nextcloud den Ordner per öffentlichem Link mit Upload-Recht teilen und Link + Passwort hier eintragen ' +
        '(die Cloud muss Zugriffe von dieser Adresse erlauben, siehe README). Zusätzliche Ziele gelten nur in diesem Browser. ' +
        'Die übrigen Einstellungen auf dieser Seite gelten für alle.'),
      profileList,
      h('button', {
        class: 'btn btn-sm', type: 'button', onclick: () => {
          const p: UploadProfile = { id: newId(), name: '', kind: 'opencloud', url: '', token: '' };
          draft.profiles.push(p);
          if (!draft.activeProfileId) draft.activeProfileId = p.id;
          renderProfiles();
        },
      }, '+ Ziel hinzufügen'),
    ),
    h('fieldset', null, h('legend', null, 'Voreinstellungen'),
      h('p', { class: 'muted small' }, 'Diese Werte werden nach dem Schnitt automatisch angewendet. Im Export lassen sie sich über „Erweitert“ ' +
        'für eine einzelne Aufnahme ändern (ohne die Voreinstellung zu verändern).'),
      h('div', { class: 'grid' },
        select('Lautheit', LOUDNESS_PRESETS, () => draft.loudnessPreset, v => { draft.loudnessPreset = v as LoudnessPresetId; }),
        select('Export-Format', EXPORT_PRESETS, () => draft.exportPreset, v => { draft.exportPreset = v as ExportPresetId; }),
        number('Einblenden (s)', () => draft.fadeIn, v => { draft.fadeIn = v; }, { min: 0, max: 10, step: 0.1 }),
        number('Ausblenden (s)', () => draft.fadeOut, v => { draft.fadeOut = v; }, { min: 0, max: 10, step: 0.1 }),
        number('Max. Anhebung (dB)', () => draft.maxGainDb, v => { draft.maxGainDb = v; }, { min: 0, max: 40, step: 1 }),
        check('Hochpass 80 Hz', () => draft.highpass, v => { draft.highpass = v; }),
        check('Sanfte Kompression 2:1', () => draft.compressor, v => { draft.compressor = v; }),
        check('Hall & Rauschen reduzieren (KI, dauert einige Minuten)', () => draft.denoise, v => { draft.denoise = v; }),
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
      h('div', { class: 'grid' },
        number('Mindestlänge Predigt (min)', () => draft.minSermonMin, v => { draft.minSermonMin = v; }, { min: 1, max: 60, step: 1 }),
        number('Pausen zusammenführen bis (s)', () => draft.mergeGapSec, v => { draft.mergeGapSec = v; }, { min: 0, max: 60, step: 1 }),
      ),
      h('p', { class: 'muted small' }, 'Wirkt beim nächsten Laden einer Datei.'),
    ),
    h('fieldset', null, h('legend', null, 'Sichern & Übertragen'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-sm', type: 'button', onclick: () => {
            const json = settingsStore.exportJson(draft, withTokens.checked ? undefined : stripTokens);
            download(new Blob([json], { type: 'application/json' }), 'predigt-schnitt-einstellungen.json');
          },
        }, 'Als JSON exportieren'),
        h('label', { class: 'check' }, withTokens, 'Token mit exportieren'),
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
