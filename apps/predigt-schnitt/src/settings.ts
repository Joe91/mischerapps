import { createStore } from '../../../packages/settings/store';
import type { EncodeOptions } from '../../../packages/audio-core/pipeline';

export type UploadKind = 'opencloud' | 'nextcloud' | 'http-post';

/**
 * An upload target. For cloud folders `url` is the public share link and `token` its password;
 * for 'http-post' (server/upload.php) the script URL and its token.
 */
export interface UploadProfile { id: string; name: string; kind?: UploadKind; url: string; token: string; }

export const UPLOAD_KINDS: Record<UploadKind, { label: string; url: string; urlHint: string; secret: string }> = {
  opencloud: { label: 'Cloud-Ordner (OpenCloud)', url: 'Freigabe-Link', urlHint: 'https://cloud.example.org/s/AbC123', secret: 'Link-Passwort' },
  nextcloud: { label: 'Cloud-Ordner (Nextcloud)', url: 'Freigabe-Link', urlHint: 'https://cloud.example.org/s/AbC123', secret: 'Link-Passwort' },
  'http-post': { label: 'Upload-Skript (PHP)', url: 'Upload-URL', urlHint: 'https://example.org/upload.php', secret: 'Token' },
};

/** Profiles saved before upload kinds existed are PHP-script targets. */
export const profileKind = (p: UploadProfile): UploadKind => p.kind ?? 'http-post';

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

const isLocalHost = () => /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(location.hostname);

export const DEV_PROFILE: UploadProfile = { id: 'local-dev', name: 'Lokaler Test-Server (npm run dev)', kind: 'http-post', url: '/api/upload', token: 'dev-token' };

export function defaultSettings(): Settings {
  const local = import.meta.env.DEV || isLocalHost();
  return {
    profiles: local ? [{ ...DEV_PROFILE }] : [],
    activeProfileId: local ? DEV_PROFILE.id : '',
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

export const stripTokens = (s: Settings): Settings => ({ ...s, profiles: s.profiles.map(p => ({ ...p, token: '' })) });

export const newId = () => Math.random().toString(36).slice(2, 10);
