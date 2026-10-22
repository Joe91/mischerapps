import { createStore } from '../../../packages/settings/store';
import type { EncodeOptions } from '../../../packages/audio-core/pipeline';

export type UploadKind = 'server' | 'opencloud' | 'nextcloud';

/**
 * An upload target. 'server' is this server (the NAS the app is served from); for cloud folders
 * `url` is the public share link and `token` its password.
 */
export interface UploadProfile { id: string; name: string; kind?: UploadKind; url: string; token: string; }

export const UPLOAD_KINDS: Record<UploadKind, { label: string; url: string; urlHint: string; secret: string }> = {
  opencloud: { label: 'Cloud-Ordner (OpenCloud)', url: 'Freigabe-Link', urlHint: 'https://cloud.example.org/s/AbC123', secret: 'Link-Passwort' },
  nextcloud: { label: 'Cloud-Ordner (Nextcloud)', url: 'Freigabe-Link', urlHint: 'https://cloud.example.org/s/AbC123', secret: 'Link-Passwort' },
  server: { label: 'Dieser Server (NAS)', url: 'Adresse', urlHint: '/api/upload', secret: '' },
};

/** The cloud kinds an admin can add as extra targets. */
export const CLOUD_KINDS = { opencloud: UPLOAD_KINDS.opencloud, nextcloud: UPLOAD_KINDS.nextcloud };

export const SERVER_PROFILE: UploadProfile = { id: 'server', name: 'NAS', kind: 'server', url: '/api/upload', token: '' };

export const profileKind = (p: UploadProfile): UploadKind => p.kind ?? 'server';

export const LOUDNESS_PRESETS = {
  mono19: { label: 'Podcast Mono (Standard) – −19 LUFS, −1,5 dBTP', lufs: -19, tp: -1.5 },
  stereo16: { label: 'Podcast Stereo – −16 LUFS, −1,0 dBTP', lufs: -16, tp: -1.0 },
  archive23: { label: 'Leise/Archiv (EBU R128) – −23 LUFS, −1,0 dBTP', lufs: -23, tp: -1.0 },
} as const;
export type LoudnessPresetId = keyof typeof LOUDNESS_PRESETS;

export const EXPORT_PRESETS = {
  speech64: { label: 'Sprache Standard – Mono, 64 kbps (≈ 14 MB / 30 min)', channels: 1, kbps: 64 },
  speech96: { label: 'Sprache hoch – Mono, 96 kbps (≈ 21 MB / 30 min)', channels: 1, kbps: 96 },
  music128: { label: 'Mit Musik – Stereo, 128 kbps (≈ 29 MB / 30 min)', channels: 2, kbps: 128 },
} as const satisfies Record<string, { label: string; channels: 1 | 2; kbps: EncodeOptions['kbps'] }>;
export type ExportPresetId = keyof typeof EXPORT_PRESETS;

export interface Settings {
  profiles: UploadProfile[];
  activeProfileId: string;
  loudnessPreset: LoudnessPresetId;
  exportPreset: ExportPresetId;
  highpass: boolean;
  compressor: boolean;
  fadeIn: number;
  fadeOut: number;
  maxGainDb: number;
  namePattern: string;
  congregation: string;
  preacher: string;
  titlePrefix: string;
  coverDataUrl: string;
  minSermonMin: number;
  mergeGapSec: number;
}

export function defaultSettings(): Settings {
  return {
    profiles: [{ ...SERVER_PROFILE }],
    activeProfileId: SERVER_PROFILE.id,
    loudnessPreset: 'mono19',
    exportPreset: 'speech64',
    highpass: true,
    compressor: false,
    fadeIn: 0.5,
    fadeOut: 1.5,
    maxGainDb: 20,
    namePattern: 'predigt_eag_{datum}',
    congregation: '',
    preacher: '',
    titlePrefix: 'Predigt',
    coverDataUrl: '',
    minSermonMin: 8,
    mergeGapSec: 8,
  };
}

export const settingsStore = createStore<Settings>('audio-tools.predigt-schnitt.settings.v1', defaultSettings);

/** Keys the admin sets for everybody; they live on the server (the upload targets stay per browser). */
export const SHARED_KEYS = [
  'loudnessPreset', 'exportPreset', 'highpass', 'compressor', 'fadeIn', 'fadeOut', 'maxGainDb', 'namePattern',
  'congregation', 'preacher', 'titlePrefix', 'coverDataUrl', 'minSermonMin', 'mergeGapSec',
] as const satisfies readonly (keyof Settings)[];

export const sharedPart = (s: Settings) => Object.fromEntries(SHARED_KEYS.map(k => [k, s[k]]));

/** Drops targets of removed kinds (the old PHP script) and makes sure the server target exists. */
export function normalizeSettings(s: Settings): Settings {
  s.profiles = s.profiles.filter(p => p.kind === 'server' || p.kind === 'opencloud' || p.kind === 'nextcloud');
  if (!s.profiles.some(p => p.kind === 'server')) s.profiles.unshift({ ...SERVER_PROFILE });
  if (!s.profiles.some(p => p.id === s.activeProfileId)) s.activeProfileId = SERVER_PROFILE.id;
  return s;
}

export const stripTokens = (s: Settings): Settings => ({ ...s, profiles: s.profiles.map(p => ({ ...p, token: '' })) });

export const newId = () => Math.random().toString(36).slice(2, 10);
