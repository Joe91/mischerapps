import { createStore } from '../../../packages/settings/store';

/** Only the own Kürzel is personal (kept in this browser). */
export interface Settings {
  /** own Kürzel, e.g. "JD" */
  sign: string;
}

export const defaultSettings = (): Settings => ({ sign: '' });

export const settingsStore = createStore<Settings>('audio-tools.termine.settings.v3', defaultSettings);
