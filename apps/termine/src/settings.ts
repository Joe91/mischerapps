import { createStore } from '../../../packages/settings/store';

/** Only the own Kürzel is personal (kept in this browser); the number of Sundays is a shared setting from the server. */
export interface Settings {
  /** own Kürzel, e.g. "JD" */
  sign: string;
  /** how many Sundays ahead are listed */
  weeks: number;
}

export const defaultSettings = (): Settings => ({ sign: '', weeks: 12 });

export const settingsStore = createStore<Settings>('audio-tools.termine.settings.v3', defaultSettings);
