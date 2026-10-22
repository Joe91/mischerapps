// Helpers for the files in dataDir that are rewritten as a whole (termine.xlsx, settings.json).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Runs the jobs one after another, so that read → change → write cycles cannot overwrite each other. */
export function serialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };
}

/** Writes via a temporary file and a rename: readers see the old or the new content, never half a file. */
export async function writeAtomic(file: string, data: string | Uint8Array) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}
