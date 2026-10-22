import { h, progressBar, download, toast } from '../../../../packages/ui-kit/dom';
import { uploadFile } from '../../../../packages/upload/http-upload';
import { uploadToCloud } from '../../../../packages/upload/cloud-upload';
import { UPLOAD_KINDS, profileKind } from '../settings';
import type { Ctx, Step } from '../context';
import { isValidFileName, sanitizeFileName } from '../naming';
import { openSettings } from '../settings-dialog';

export function createUploadStep(ctx: Ctx): Step {
  const profileSel = h('select');
  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  const status = h('div');
  const target = h('p', { class: 'muted small' });
  let abort: (() => void) | null = null;

  profileSel.addEventListener('change', () => { ctx.settings.activeProfileId = profileSel.value; ctx.saveSettings(); showTarget(); });
  nameInput.addEventListener('change', () => { ctx.state.fileName = sanitizeFileName(nameInput.value); nameInput.value = ctx.state.fileName; });

  const profile = () => ctx.settings.profiles.find(p => p.id === profileSel.value);

  function showTarget() {
    const p = profile();
    target.textContent = p ? `Ziel: ${UPLOAD_KINDS[profileKind(p)].label} – ${p.url}` : '';
    uploadBtn.disabled = !p;
  }

  function fillProfiles() {
    const ps = ctx.settings.profiles;
    profileSel.replaceChildren(...ps.map(p => h('option', { value: p.id }, p.name || p.url)));
    if (ps.some(p => p.id === ctx.settings.activeProfileId)) profileSel.value = ctx.settings.activeProfileId;
    showTarget();
    noProfile.classList.toggle('hidden', ps.length > 0);
    profileRow.classList.toggle('hidden', ps.length === 0);
  }

  async function upload() {
    const r = ctx.state.rendered, p = profile();
    if (!r || !p) return;
    const name = sanitizeFileName(nameInput.value);
    nameInput.value = name;
    ctx.state.fileName = name;
    if (!isValidFileName(name)) { toast('Ungültiger Dateiname.', 'error'); return; }
    const kind = profileKind(p);
    if (kind === 'http-post' && !p.token) {
      status.replaceChildren(h('div', { class: 'notice error' }, 'Für dieses Ziel ist kein Token hinterlegt (Einstellungen).'));
      return;
    }
    const bar = progressBar('Lade hoch …');
    const cancel = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => abort?.() }, 'Abbrechen');
    status.replaceChildren(h('div', { class: 'row' }, bar.el, cancel));
    uploadBtn.disabled = true;
    try {
      const progress = (x: number) => bar.set(x, 'Lade hoch …');
      const up = kind === 'http-post'
        ? uploadFile(p.url, p.token, r.blob, name, progress)
        : uploadToCloud(kind, p.url, p.token, r.blob, name, progress);
      abort = up.abort;
      await up.promise;
      ctx.state.uploadedAs = name;
      status.replaceChildren(h('div', { class: 'notice ok' }, `Hochgeladen: ${name} → ${p.name || p.url}`));
    } catch (e) {
      status.replaceChildren(h('div', { class: 'notice error' }, (e as Error).message));
    } finally {
      abort = null;
      uploadBtn.disabled = false;
    }
  }

  const uploadBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: upload }, '⬆ Hochladen');
  const profileRow = h('div', { class: 'grid' },
    h('label', null, 'Upload-Ziel', profileSel),
    h('label', null, 'Dateiname', nameInput),
  );
  const noProfile = h('div', { class: 'notice warn hidden' },
    'Kein Upload-Ziel eingerichtet – bitte die Datei herunterladen und auf dem üblichen Weg hochladen. ',
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openSettings(ctx, () => fillProfiles()) }, 'Upload-Ziel einrichten'));

  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '5 · Upload')),
    noProfile, profileRow, target,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(3) }, '← Export'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.state.rendered && download(ctx.state.rendered.blob, sanitizeFileName(nameInput.value)) }, '⬇ Herunterladen'),
      uploadBtn),
    status,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ctx.goto(0) }, 'Nächste Aufnahme bearbeiten')),
  );

  return {
    el,
    enter() {
      nameInput.value = ctx.state.fileName;
      fillProfiles();
      status.replaceChildren(ctx.state.uploadedAs ? h('div', { class: 'notice ok' }, `Bereits hochgeladen als ${ctx.state.uploadedAs}.`) : '');
    },
  };
}
