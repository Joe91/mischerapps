import { h, progressBar, download, toast } from '../../../../packages/ui-kit/dom';
import { publishTarget } from '../../../../packages/auth/auth';
import { uploadFile } from '../../../../packages/upload/http-upload';
import { STEP, type Ctx, type Step } from '../context';
import { isValidFileName, sanitizeFileName } from '../naming';

/** Publishes the export: the server stores it in the shared OpenCloud folder (or on the NAS without cloud configuration). */
export function createUploadStep(ctx: Ctx): Step {
  const nameInput = h('input', { class: 'mono', spellcheck: 'false' });
  const status = h('div');
  const target = h('p', { class: 'muted small' });
  let abort: (() => void) | null = null;

  nameInput.addEventListener('change', () => { ctx.state.fileName = sanitizeFileName(nameInput.value); nameInput.value = ctx.state.fileName; });

  const where = () => publishTarget() === 'OpenCloud' ? 'den gemeinsamen Ordner in OpenCloud' : 'das NAS';

  async function upload() {
    const r = ctx.state.rendered;
    if (!r) return;
    const name = sanitizeFileName(nameInput.value);
    nameInput.value = name;
    ctx.state.fileName = name;
    if (!isValidFileName(name)) { toast('Ungültiger Dateiname.', 'error'); return; }
    const bar = progressBar('Lade hoch …');
    const cancel = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => abort?.() }, 'Abbrechen');
    status.replaceChildren(h('div', { class: 'row' }, bar.el, cancel));
    uploadBtn.disabled = true;
    try {
      const up = uploadFile(r.blob, name, (p, stored) => {
        bar.set(p, stored ? `Wird in ${publishTarget()} gespeichert …` : 'Lade hoch …');
        if (stored) cancel.remove(); // the server finishes it now
      });
      abort = up.abort;
      await up.promise;
      ctx.state.uploadedAs = name;
      status.replaceChildren(h('div', { class: 'notice ok' }, `Veröffentlicht: ${name} → ${publishTarget()}`));
    } catch (e) {
      status.replaceChildren(h('div', { class: 'notice error' }, (e as Error).message));
    } finally {
      abort = null;
      uploadBtn.disabled = false;
    }
  }

  const uploadBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: upload }, '⬆ Hochladen');
  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '4 · Upload')),
    h('div', { class: 'grid' }, h('label', null, 'Dateiname', nameInput)),
    target,
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
      target.textContent = `Die Datei wird in ${where()} hochgeladen. Eine vorhandene Datei gleichen Namens wird nie überschrieben.`;
      status.replaceChildren(ctx.state.uploadedAs ? h('div', { class: 'notice ok' }, `Bereits veröffentlicht als ${ctx.state.uploadedAs}.`) : '');
    },
  };
}
