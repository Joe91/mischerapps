import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions';
import TimelinePlugin from 'wavesurfer.js/plugins/timeline';
import { h, fmtTime, parseTime } from '../../../../packages/ui-kit/dom';
import type { AnalyzeOutput } from '../../../../packages/audio-core/pipeline';
import { integrateSubBlocks } from '../../../../packages/audio-core/loudness';
import { STEP, type Ctx, type Step } from '../context';
import { prefetchDenoising } from './prepare';

type Which = 'start' | 'end';
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const MAX_PX_PER_SEC = 200;
/** Seconds played before and after a marker by "Vorhören", and at the end by "Schluss". */
const PREVIEW_SEC = 4;
const END_PREVIEW_SEC = 8;
/** Playback is raised towards this loudness: desk recordings can be at −50 LUFS. */
const PLAYBACK_LUFS = -20;
const MAX_PLAYBACK_GAIN_DB = 40;

let audioCtx: AudioContext | null = null;

/**
 * Plays `audio` raised by `gainDb`; a limiter keeps the much louder organ and singing from clipping.
 * The context starts suspended until the first click, so it is resumed whenever playback starts.
 */
function amplify(audio: HTMLAudioElement, gainDb: number): AudioNode {
  audioCtx ??= new AudioContext();
  const ctx = audioCtx;
  const source = ctx.createMediaElementSource(audio);
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -6, knee: 0, ratio: 20, attack: 0.002, release: 0.2 });
  source.connect(new GainNode(ctx, { gain: Math.pow(10, gainDb / 20) })).connect(limiter).connect(ctx.destination);
  audio.addEventListener('play', () => { void ctx.resume(); });
  return source;
}

export function createCutStep(ctx: Ctx): Step {
  let ws: WaveSurfer | null = null;
  let region: Region | null = null;
  let audio: HTMLAudioElement | null = null;
  let route: AudioNode | null = null;
  let builtFor: AnalyzeOutput | null = null;
  let active: Which = 'start';
  let fitPx = 1;

  const waveEl = h('div', { class: 'wave' });
  const timelineEl = h('div', { class: 'timeline' });
  const overview = h('canvas', { class: 'overview', title: 'Übersicht – klicken zum Springen' });
  const timeLabel = h('span', { class: 'time mono' }, '0:00.0');
  const gainEl = h('span', { class: 'muted small', title: 'Nur zum Anhören – der Export wird getrennt angepasst' });
  const playBtn = h('button', { class: 'btn btn-primary play', type: 'button', title: 'Abspielen/Pause (Leertaste)', onclick: () => ws?.playPause() }, '▶');
  const zoom = h('input', { type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Zoom', class: 'zoom' });
  const confEl = h('span', { class: 'badge' });
  const durEl = h('span', { class: 'muted' });
  const altsEl = h('div', { class: 'row alts' });
  const hintEl = h('div');

  const markerRow = (which: Which) => {
    const label = which === 'start' ? 'Start' : 'Ende';
    const input = h('input', { class: 'time-input mono', 'aria-label': `${label}zeit`, inputmode: 'decimal' });
    input.addEventListener('change', () => {
      const t = parseTime(input.value);
      if (isNaN(t)) { refresh(); return; }
      setMarker(which, t, true);
    });
    input.addEventListener('focus', () => setActive(which));
    const nudge = (d: number, text: string, title: string) =>
      h('button', { class: 'btn btn-sm', type: 'button', title, onclick: () => { setActive(which); setMarker(which, get(which) + d, true); } }, text);
    const row = h('div', { class: 'marker-row', onclick: () => setActive(which) },
      h('span', { class: 'marker-label' }, label),
      input,
      nudge(-1, '−1 s', `${label} 1 s früher`), nudge(-0.1, '−0,1', `${label} 0,1 s früher`),
      h('button', { class: 'btn btn-sm', type: 'button', title: `${2 * PREVIEW_SEC} s um den Marker anhören (P)`, onclick: () => preview(which) }, '▶ Vorhören'),
      nudge(0.1, '+0,1', `${label} 0,1 s später`), nudge(1, '+1 s', `${label} 1 s später`),
      h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', title: `${label} auf Abspielposition setzen (${which === 'start' ? 'S' : 'E'})`,
        onclick: () => ws && setMarker(which, ws.getCurrentTime(), false),
      }, '⤓ an Abspielposition'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Im Wellenbild anzeigen', onclick: () => reveal(get(which)) }, '⌖ zeigen'),
    );
    return { row, input };
  };
  const startRow = markerRow('start');
  const endRow = markerRow('end');

  const get = (w: Which) => (w === 'start' ? ctx.state.start : ctx.state.end);

  function setActive(w: Which) {
    active = w;
    startRow.row.classList.toggle('active', w === 'start');
    endRow.row.classList.toggle('active', w === 'end');
  }

  /** Denoising starts here already (if switched on); after marker changes once they have settled. */
  let prefetchTimer = 0;
  function markersChanged() {
    ctx.changed();
    clearTimeout(prefetchTimer);
    prefetchTimer = window.setTimeout(() => prefetchDenoising(ctx), 2000);
  }

  function setMarker(which: Which, t: number, revealIt: boolean) {
    const a = ctx.state.analysis;
    if (!a) return;
    const dur = a.info.duration;
    if (which === 'start') ctx.state.start = Math.max(0, Math.min(t, ctx.state.end - 1));
    else ctx.state.end = Math.min(dur, Math.max(t, ctx.state.start + 1));
    region?.setOptions({ start: ctx.state.start, end: ctx.state.end });
    if (revealIt) reveal(get(which));
    refresh();
    markersChanged();
  }

  function setRange(start: number, end: number) {
    ctx.state.start = start;
    ctx.state.end = end;
    region?.setOptions({ start, end });
    reveal(start);
    refresh();
    markersChanged();
  }

  function reveal(t: number) {
    if (!ws) return;
    const width = waveEl.clientWidth || 800;
    const px = Number(zoomPx());
    const span = width / px;
    ws.setScrollTime(Math.max(0, t - span / 2));
  }

  function preview(which: Which) {
    setActive(which);
    const t = get(which);
    ws?.play(Math.max(0, t - PREVIEW_SEC), t + PREVIEW_SEC);
  }

  const zoomPx = () => fitPx * Math.pow(MAX_PX_PER_SEC / fitPx, Number(zoom.value) / 1000);

  function refresh() {
    const a = ctx.state.analysis;
    if (!a) return;
    if (document.activeElement !== startRow.input) startRow.input.value = fmtTime(ctx.state.start);
    if (document.activeElement !== endRow.input) endRow.input.value = fmtTime(ctx.state.end);
    durEl.textContent = `Länge der Auswahl: ${fmtTime(ctx.state.end - ctx.state.start, false)}`;
    drawOverview();
  }

  function drawOverview() {
    const a = ctx.state.analysis;
    if (!a) return;
    const dpr = window.devicePixelRatio || 1;
    const w = overview.clientWidth, hgt = overview.clientHeight;
    if (!w) return;
    overview.width = Math.round(w * dpr);
    overview.height = Math.round(hgt * dpr);
    const g = overview.getContext('2d')!;
    g.scale(dpr, dpr);
    const dur = a.info.duration, x = (t: number) => (t / dur) * w;
    const colors = { speech: css('--speech'), music: css('--music'), silence: css('--silence') };
    const bandY = 6, bandH = hgt - 12;
    g.clearRect(0, 0, w, hgt);
    for (const s of a.result.segments) {
      g.fillStyle = colors[s.kind];
      g.fillRect(x(s.start), bandY, Math.max(1, x(s.end) - x(s.start)), bandH);
    }
    // sermon selection
    const sx = x(ctx.state.start), ex = x(ctx.state.end);
    g.fillStyle = css('--region');
    g.fillRect(sx, 0, ex - sx, hgt);
    g.strokeStyle = css('--region-edge');
    g.lineWidth = 2;
    g.strokeRect(sx, 1, ex - sx, hgt - 2);
    // playhead
    if (ws) {
      g.fillStyle = css('--text');
      g.fillRect(x(ws.getCurrentTime()) - 0.5, 0, 1.5, hgt);
    }
  }

  overview.addEventListener('click', e => {
    const a = ctx.state.analysis;
    if (!a || !ws) return;
    const r = overview.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * a.info.duration;
    ws.setTime(t);
    reveal(t);
    drawOverview();
  });

  /** Ctrl + mouse wheel (or a trackpad pinch) over the waveform zooms it around the pointer instead of the page. */
  const waveBox = h('div', { class: 'wave-box', title: 'Strg + Mausrad: zoomen' }, waveEl, timelineEl);
  waveBox.addEventListener('wheel', e => {
    if (!ws || !e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; // lines / pages → pixels
    const x = e.clientX - waveEl.getBoundingClientRect().left, t = (ws.getScroll() + x) / zoomPx();
    // one wheel notch (100 px) moves the slider by 6 %, about ×1.5 for a 1-hour recording
    zoom.value = String(Math.min(1000, Math.max(0, Number(zoom.value) - e.deltaY * unit * 0.6)));
    const px = zoomPx();
    ws.zoom(px);
    ws.setScroll(t * px - x); // the time under the pointer stays in place
  }, { passive: false });

  zoom.addEventListener('input', () => {
    if (!ws) return;
    // keep the playhead in view while playing, otherwise the marker being edited
    const center = ws.isPlaying() ? ws.getCurrentTime() : get(active);
    ws.zoom(zoomPx());
    reveal(center);
  });

  function build() {
    const a = ctx.state.analysis!;
    ws?.destroy();
    audio?.pause();
    audio = new Audio(ctx.state.audioUrl!);
    audio.preload = 'auto';
    // as loud as the suggested sermon needs (the cut itself does not change it while listening)
    const c = a.result.candidates[0];
    const lufs = integrateSubBlocks(a.loudness, c ? Math.floor(c.start * 10) : 0, c ? Math.ceil(c.end * 10) : a.loudness.length);
    const gainDb = isFinite(lufs) ? Math.round(Math.min(MAX_PLAYBACK_GAIN_DB, Math.max(0, PLAYBACK_LUFS - lufs))) : 0;
    route?.disconnect(); // the previous recording's
    route = amplify(audio, gainDb);
    gainEl.textContent = gainDb > 0 ? `Wiedergabe +${gainDb} dB` : '';
    const regions = RegionsPlugin.create();
    const width = waveEl.clientWidth || 900;
    fitPx = width / a.info.duration;
    zoom.value = '0';
    ws = WaveSurfer.create({
      container: waveEl,
      media: audio,
      peaks: [a.peaks],
      duration: a.info.duration,
      height: 150,
      waveColor: css('--wave'),
      progressColor: css('--wave-progress'),
      cursorColor: css('--text'),
      cursorWidth: 1.5,
      normalize: true,
      minPxPerSec: fitPx,
      fillParent: true,
      autoScroll: true,
      autoCenter: false,
      dragToSeek: true,
      barWidth: 0,
      plugins: [regions, TimelinePlugin.create({ container: timelineEl, height: 18, formatTimeCallback: t => fmtTime(t, false) })],
    });
    // regions need the duration, which wavesurfer knows only after (peak) decoding
    ws.once('decode', () => {
      region = regions.addRegion({
        start: ctx.state.start, end: ctx.state.end, color: css('--region'),
        drag: true, resize: true, minLength: 1, content: h('span', { class: 'region-label' }, 'Predigt'),
      });
      reveal(ctx.state.start);
    });
    regions.on('region-updated', (r, side) => {
      ctx.state.start = r.start;
      ctx.state.end = r.end;
      if (side) setActive(side === 'start' ? 'start' : 'end');
      refresh();
      markersChanged();
    });
    ws.on('timeupdate', t => { timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(a.info.duration, false)}`; drawOverview(); });
    ws.on('play', () => { playBtn.textContent = '❚❚'; });
    ws.on('pause', () => { playBtn.textContent = '▶'; });
    ws.on('finish', () => { playBtn.textContent = '▶'; });
    builtFor = a;
    region = null;
    timeLabel.textContent = `${fmtTime(0)} / ${fmtTime(a.info.duration, false)}`;

    // confidence and alternatives
    const r = a.result;
    const level = r.confidence >= 0.75 ? 'hoch' : r.confidence >= 0.5 ? 'mittel' : 'niedrig';
    confEl.textContent = `Erkennung: ${level}`;
    confEl.className = `badge conf-${level}`;
    hintEl.replaceChildren();
    if (!r.candidates.length) {
      hintEl.append(h('div', { class: 'notice warn' }, 'Es wurde kein längerer Sprachblock gefunden. Bitte Start und Ende von Hand setzen.'));
    } else if (r.confidence < 0.5) {
      hintEl.append(h('div', { class: 'notice warn' }, 'Die Erkennung ist unsicher – bitte Marker prüfen oder einen anderen Vorschlag wählen.'));
    }
    altsEl.replaceChildren(
      ...(r.candidates.length ? [h('span', { class: 'muted' }, 'Vorschläge:')] : []),
      ...r.candidates.map((c, i) => h('button', {
        class: 'btn btn-sm', type: 'button', title: 'Diesen Bereich übernehmen',
        onclick: () => setRange(c.start, c.end),
      }, `${'ABC'[i]}  ${fmtTime(c.start, false)}–${fmtTime(c.end, false)} (${fmtTime(c.end - c.start, false)})`)),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => setRange(0, a.info.duration) }, 'Ganze Datei'),
    );
    setActive('start');
    refresh();
  }

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey || !ws) return;
    const step = e.shiftKey ? 1 : 0.1;
    switch (e.key) {
      case ' ': e.preventDefault(); ws.playPause(); break;
      case 's': case 'S': setActive('start'); setMarker('start', ws.getCurrentTime(), false); break;
      case 'e': case 'E': setActive('end'); setMarker('end', ws.getCurrentTime(), false); break;
      case 'ArrowLeft': e.preventDefault(); setMarker(active, get(active) - step, true); break;
      case 'ArrowRight': e.preventDefault(); setMarker(active, get(active) + step, true); break;
      case 'p': case 'P': preview(active); break;
      case 'Tab': return;
      default: return;
    }
  };
  const onResize = () => drawOverview();

  const legend = h('div', { class: 'legend' },
    h('span', null, h('i', { class: 'sw sw-speech' }), 'Sprache'),
    h('span', null, h('i', { class: 'sw sw-music' }), 'Musik'),
    h('span', null, h('i', { class: 'sw sw-silence' }), 'Stille'),
    h('span', null, h('i', { class: 'sw sw-region' }), 'Predigt (Auswahl)'),
  );

  const el = h('section', { class: 'card cut' },
    h('div', { class: 'card-head' }, h('h2', null, '2 · Predigt markieren'), confEl, h('span', { class: 'spacer' }), durEl),
    hintEl,
    overview,
    legend,
    waveBox,
    h('div', { class: 'row transport' },
      playBtn, timeLabel, gainEl,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ws?.play(ctx.state.start, ctx.state.end) }, '▶ Auswahl abspielen'),
      h('button', { class: 'btn btn-sm', type: 'button', title: `Letzte ${END_PREVIEW_SEC} s der Auswahl`, onclick: () => ws?.play(Math.max(ctx.state.start, ctx.state.end - END_PREVIEW_SEC), ctx.state.end) }, '▶ Schluss'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, 'Zoom'), zoom,
    ),
    h('div', { class: 'markers' }, startRow.row, endRow.row),
    altsEl,
    h('p', { class: 'muted small keys' },
      'Tastatur: Leertaste Abspielen/Pause · S / E setzt Start / Ende an die Abspielposition · ← → verschiebt den aktiven Marker um 0,1 s (mit Umschalt 1 s) · P hört den aktiven Marker vor. ',
      'Der orange Bereich lässt sich im Wellenbild verschieben und an den Rändern ziehen. Strg + Mausrad über dem Wellenbild zoomt.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.goto(STEP.export) }, 'Weiter zum Export →')),
  );

  return {
    el,
    enter() {
      if (ctx.state.analysis && builtFor !== ctx.state.analysis) build();
      else { region?.setOptions({ start: ctx.state.start, end: ctx.state.end }); refresh(); }
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', onResize);
      prefetchDenoising(ctx);
    },
    leave() {
      ws?.pause();
      clearTimeout(prefetchTimer); // the export step asks for what it needs itself
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    },
  };
}
