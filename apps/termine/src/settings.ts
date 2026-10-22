import { createStore } from '../../../packages/settings/store';
import type { CloudKind } from '../../../packages/upload/cloud-upload';

export interface Settings {
  /** the Termine live in a spreadsheet inside a shared cloud folder */
  kind: CloudKind;
  /** public link of that folder, with permission to edit (https://cloud.example.org/s/AbC123) */
  shareUrl: string;
  password: string;
  /** name of the spreadsheet in the folder */
  file: string;
  /** own Kürzel, e.g. "JD" */
  sign: string;
  /** how many Sundays ahead are listed */
  weeks: number;
}

export const DEFAULT_FILE = 'termine.xlsx';
export const isValidFileName = (s: string) => /^[^\\/:*?"<>|\s][^\\/:*?"<>|]*\.xlsx$/i.test(s);

const isLocalHost = () => /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(location.hostname);

export function defaultSettings(): Settings {
  const local = import.meta.env.DEV || isLocalHost();
  return {
    kind: 'opencloud', shareUrl: local ? `${location.origin}/s/dev-token` : '', password: local ? 'dev-token' : '',
    file: DEFAULT_FILE, sign: '', weeks: 12,
  };
}

export const settingsStore = createStore<Settings>('audio-tools.termine.settings.v2', defaultSettings);
