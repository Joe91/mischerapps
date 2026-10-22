import { h, progressBar, download, toast } from '../../../../packages/ui-kit/dom';
import { isAdmin } from '../../../../packages/auth/auth';
import { uploadFile } from '../../../../packages/upload/http-upload';
import { uploadToCloud } from '../../../../packages/upload/cloud-upload';
import { UPLOAD_KINDS, profileKind, SERVER_PROFILE } from '../settings';
import { STEP, type Ctx, type Step } from '../context';
import { isValidFileName, sanitizeFileName } from '../naming';

export function createUploadStep(ctx: Ctx): Step {
  const profileSel = h('select');
  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  const status = h('div');
  const target = h('p', { class: 'muted small' });
  let abort: (() => void) | null = null;

  profileSel.addEventListener('change', () => { ctx.settings.activeProfileId = profileSel.value; ctx.saveSettings(); showTarget(); });
  nameInput.addEventListener('change', () => { ctx.state.fileName = sanitizeFileName(nameInput.value); nameInput.value = ctx.state.fileName; });

  // the mischer user always uploads to the server; the admin may pick another target
  const profile = () => isAdmin()
    ? ctx.settings.profiles.find(p => p.id === profileSel.value)
    : ctx.settings.profiles.find(p => profileKind(p) === 'server') ?? SERVER_PROFILE;

  function showTarget() {
    const p = profile();
    target.textContent = p && isAdmin() ? `Ziel: ${UPLOAD_KINDS[profileKind(p)].label}${profileKind(p) === 'server' ? '' : ` – ${p.url}`}` : '';
    uploadBtn.disabled = !p;
  }

  function fillProfiles() {
    const ps = ctx.settings.profiles;
    profileSel.replaceChildren(...ps.map(p => h('option', { value: p.id }, p.name || p.url)));
    if (ps.some(p => p.id === ctx.settings.activeProfileId)) profileSel.value = ctx.settings.activeProfileId;
    showTarget();
    profileSel.parentElement?.classList.toggle('hidden', !isAdmin());
  }

  async function upload() {
    const r = ctx.state.rendered, p = profile();
    if (!r || !p) return;
    const name = sanitizeFileName(nameInput.value);
    nameInput.value = name;
    ctx.state.fileName = name;
    if (!isValidFileName(name)) { toast('Ungültiger Dateiname.', 'error'); return; }
    const kind = profileKind(p);
    const bar = progressBar('Lade hoch …');
    const cancel = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => abort?.() }, 'Abbrechen');
    status.replaceChildren(h('div', { class: 'row' }, bar.el, cancel));
    uploadBtn.disabled = true;
    try {
      const progress = (x: number) => bar.set(x, 'Lade hoch …');
      const up = kind === 'server'
        ? uploadFile(p.url, r.blob, name, progress)
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
  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '4 · Upload')),
    profileRow, target,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.goto(STEP.export) }, '← Export'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.state.rendered && download(ctx.state.rendered.blob, sanitizeFileName(nameInput.value)) }, '⬇ Herunterladen'),
      uploadBtn),
    status,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ctx.goto(STEP.load) }, 'Nächste Aufnahme bearbeiten')),
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
