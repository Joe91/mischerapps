import { h, fmtTime, fmtBytes, progressBar, toast } from '../../../../packages/ui-kit/dom';
import { STEP, type Ctx, type Step } from '../context';

export function createLoadStep(ctx: Ctx): Step {
  const input = h('input', { type: 'file', accept: '.mp3,.wav,audio/mpeg,audio/wav,audio/x-wav,audio/wave', class: 'hidden' });
  const status = h('div');
  const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': 'MP3- oder WAV-Datei auswählen' },
    h('div', { class: 'dropzone-icon', 'aria-hidden': 'true' }, '♪'),
    h('strong', null, 'MP3- oder WAV-Datei hierher ziehen'),
    h('span', { class: 'muted' }, 'oder klicken zum Auswählen – z. B. die Aufnahme des ganzen Gottesdienstes vom Mischpult'),
  );
  let busy = false;

  drop.addEventListener('click', () => !busy && input.click());
  drop.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files[0];
    if (f && !busy) load(f);
  });
  input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; if (f) load(f); });

  async function load(file: File) {
    if (!/\.(mp3|wav)$/i.test(file.name) && !/^audio\/(mpeg|wav|x-wav|wave)$/.test(file.type)) {
      toast('Bitte eine MP3- oder WAV-Datei wählen.', 'error');
      return;
    }
    if (ctx.state.rendered && !ctx.state.uploadedAs && !confirm('Der aktuelle Export wurde noch nicht hochgeladen. Trotzdem neue Datei laden?')) return;
    busy = true;
    drop.classList.add('busy');
    ctx.resetForNewFile();
    ctx.updateNav();
    const bar = progressBar('Analysiere …');
    status.replaceChildren(h('p', null, h('strong', null, file.name), h('span', { class: 'muted' }, ` · ${fmtBytes(file.size)}`)), bar.el);
    const t0 = performance.now();
    try {
      const out = await ctx.worker.analyze(file, {
        minSermon: ctx.settings.minSermonMin * 60,
        mergeGap: ctx.settings.mergeGapSec,
      }, p => bar.set(p, 'Dekodieren & analysieren …'));
      const st = ctx.state;
      st.file = file;
      st.audioUrl = URL.createObjectURL(file);
      st.analysis = out;
      const c = out.result.candidates[0];
      st.start = c ? c.start : 0;
      st.end = c ? c.end : out.info.duration;
      bar.done();
      status.replaceChildren(h('p', { class: 'muted' },
        `${file.name} · ${fmtTime(out.info.duration, false)} · analysiert in ${((performance.now() - t0) / 1000).toFixed(1).replace('.', ',')} s`));
      ctx.goto(STEP.cut);
    } catch (e) {
      bar.done();
      status.replaceChildren(h('div', { class: 'notice error' }, `Die Datei konnte nicht gelesen werden: ${(e as Error).message}`));
    } finally {
      busy = false;
      drop.classList.remove('busy');
    }
  }

  const el = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '1 · Aufnahme laden')),
    drop, input, status,
    h('p', { class: 'muted small' },
      'Die Datei wird nur in diesem Browser verarbeitet. Erst beim Upload (Schritt 4) verlässt das fertige MP3 den Rechner.'),
  );
  return { el };
}
