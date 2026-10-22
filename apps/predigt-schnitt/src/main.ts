import '../../../packages/ui-kit/ui.css';
import './app.css';
import { ensureLogin, isAdmin, logout } from '../../../packages/auth/auth';
import { loadShared, saveShared } from '../../../packages/settings/shared';
import { AudioWorkerClient } from '../../../packages/audio-core/client';
import { h, $, toast } from '../../../packages/ui-kit/dom';
import { normalizeSettings, settingsStore, sharedPart, type Settings } from './settings';
import { lastSunday } from './naming';
import type { AppState, Ctx, Step } from './context';
import { openSettings } from './settings-dialog';
import { createLoadStep } from './steps/load';
import { createCutStep } from './steps/cut';
import { createLoudnessStep } from './steps/loudness';
import { createExportStep } from './steps/export';
import { createUploadStep } from './steps/upload';

const STEP_LABELS = ['Laden', 'Schnitt', 'Lautheit', 'Export', 'Upload'];

function initialState(settings: Settings): AppState {
  return {
    file: null, audioUrl: null, analysis: null, start: 0, end: 0,
    meta: { title: settings.titlePrefix, preacher: settings.preacher, date: lastSunday(), scripture: '', album: settings.congregation },
    fileName: '', fileNameEdited: false,
    measurement: null, measurementKey: '', rendered: null, uploadedAs: null,
  };
}

await ensureLogin('Predigt-Schnitt');

// what the admin set up for everybody (server) wins over the browser's own copy
const settings = settingsStore.load();
Object.assign(settings, await loadShared('predigt'));
normalizeSettings(settings);

const nav = $('#steps');
const main = $('#main');
let current = 0;
const steps: Step[] = [];

const ctx: Ctx = {
  worker: new AudioWorkerClient(),
  settings,
  saveSettings() {
    settingsStore.save(ctx.settings);
    if (isAdmin()) saveShared('predigt', sharedPart(ctx.settings)).catch(e => toast((e as Error).message, 'error'));
  },
  state: initialState(settings),
  goto(i) {
    if (!available(i)) return;
    steps[current]?.leave?.();
    current = i;
    main.replaceChildren(steps[i].el);
    steps[i].enter?.();
    ctx.updateNav();
    window.scrollTo({ top: 0 });
  },
  changed() {
    // measurement and export are cached by option key; just refresh the navigation
    ctx.updateNav();
  },
  updateNav() {
    nav.querySelectorAll('button').forEach((b, i) => {
      b.disabled = !available(i);
      b.classList.toggle('active', i === current);
      b.classList.toggle('done', i < current && available(i));
    });
  },
  resetForNewFile() {
    if (ctx.state.audioUrl) URL.revokeObjectURL(ctx.state.audioUrl);
    if (ctx.state.rendered) URL.revokeObjectURL(ctx.state.rendered.url);
    // reset in place: the steps keep references to ctx.state
    Object.assign(ctx.state, initialState(ctx.settings));
  },
};

function available(i: number): boolean {
  if (i === 0) return true;
  if (!ctx.state.analysis) return false;
  if (i === 4) return !!ctx.state.rendered;
  return true;
}

nav.append(...STEP_LABELS.map((label, i) =>
  h('button', { type: 'button', onclick: () => ctx.goto(i) },
    h('span', { class: 'n' }, String(i + 1)), h('span', { class: 'label' }, label)),
));
steps.push(createLoadStep(ctx), createCutStep(ctx), createLoudnessStep(ctx), createExportStep(ctx), createUploadStep(ctx));

$('#settings').addEventListener('click', () => openSettings(ctx, () => ctx.goto(current)));
$('#logout').addEventListener('click', logout);
window.addEventListener('beforeunload', e => {
  if (ctx.state.rendered && !ctx.state.uploadedAs) e.preventDefault();
});

ctx.goto(0);
