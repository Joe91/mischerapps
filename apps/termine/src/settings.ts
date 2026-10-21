import { createStore } from '../../../packages/settings/store';

export interface Settings {
  /** URL of server/termine.php */
  url: string;
  token: string;
  /** own Kürzel, e.g. "JD" */
  sign: string;
  /** how many Sundays ahead are listed */
  weeks: number;
}

const isLocalHost = () => /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(location.hostname);

export function defaultSettings(): Settings {
  const local = import.meta.env.DEV || isLocalHost();
  return { url: local ? '/api/termine' : '', token: local ? 'dev-token' : '', sign: '', weeks: 12 };
}

export const settingsStore = createStore<Settings>('audio-tools.termine.settings.v1', defaultSettings);
