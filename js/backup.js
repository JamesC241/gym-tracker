/*
 * backup.js — Export all data to a JSON file, and Import it back.
 *
 * File format:
 *   { app: "gym-tracker", format: 1, exportedAt: "...ISO date...",
 *     exercises: [...], routines: [...], sessions: [...], meta: [...] }
 */

import { readEverything, replaceEverything, DATA_STORES } from './db.js';

const APP_TAG = 'gym-tracker';
const FORMAT = 1;

/** Build the backup file and hand it to the user (share sheet on phones, download elsewhere). */
export async function exportData() {
  const data = await readEverything();
  // Don't put the "last backup" marker itself into the backup.
  data.meta = data.meta.filter((m) => m.key !== 'lastBackup');
  const payload = { app: APP_TAG, format: FORMAT, exportedAt: new Date().toISOString(), ...data };
  const json = JSON.stringify(payload, null, 1);
  const filename = `gym-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], filename, { type: 'application/json' });

  // On phones the share sheet is the most reliable way to save a file
  // (iPhone: "Save to Files"; Android: Drive, Files, etc.).
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false; // user cancelled
      // otherwise fall through to a normal download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

/** Read a backup File, check it looks right, and replace all data with it. */
export async function importData(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || data.app !== APP_TAG) throw new Error('That file is not a Gym Tracker backup.');
  if (data.format > FORMAT) throw new Error('That backup is from a newer version of the app.');
  for (const name of DATA_STORES) {
    if (data[name] && !Array.isArray(data[name])) throw new Error(`Backup is damaged ("${name}").`);
  }
  await replaceEverything(data);
  return {
    exercises: (data.exercises || []).length,
    sessions: (data.sessions || []).length,
  };
}
