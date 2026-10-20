/*
 * db.js — a tiny promise-based wrapper around IndexedDB.
 *
 * All workout data lives in the browser's IndexedDB on this device, in a
 * database called "gym-tracker". Nothing is ever sent anywhere.
 *
 * Stores (think "tables"):
 *   exercises  { id, name, group, bodyweight, deleted? }
 *   routines   { id, name, exerciseIds: [] }            ← "workout plans"
 *   sessions   { id, startedAt, finishedAt, name, routineId,
 *                entries: [{ exerciseId, skipped, bodyweight, swappedFrom,
 *                            sets: [{ kg, reps }] }] }
 *   meta       { key, value }  ← small settings, e.g. lastBackup, bodyweights
 *
 * Changing the schema later: bump DB_VERSION and add a step in
 * onupgradeneeded guarded by `if (e.oldVersion < N)`. Never delete a store
 * that holds data — that would wipe history.
 */

const DB_NAME = 'gym-tracker';
const DB_VERSION = 1;
export const DATA_STORES = ['exercises', 'routines', 'sessions', 'meta'];

let dbPromise = null;

/** Open (and if needed create/upgrade) the database. Cached after first call. */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('exercises', { keyPath: 'id' });
        db.createObjectStore('routines', { keyPath: 'id' });
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If a newer version of the app opens the DB in another tab, let it upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Run fn(store) inside a transaction and resolve when the transaction commits. */
async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let result;
    const req = fn(t.objectStore(storeName));
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAll = (store) => withStore(store, 'readonly', (s) => s.getAll());
export const put = (store, value) => withStore(store, 'readwrite', (s) => s.put(value));
export const del = (store, id) => withStore(store, 'readwrite', (s) => s.delete(id));

/** Read every store into one plain object (used for loading and for export). */
export async function readEverything() {
  const out = {};
  for (const name of DATA_STORES) out[name] = await getAll(name);
  return out;
}

/**
 * Replace ALL data with `data` (used by Import). Runs in a single
 * transaction, so either everything is replaced or nothing changes.
 */
export async function replaceEverything(data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(DATA_STORES, 'readwrite');
    for (const name of DATA_STORES) {
      const store = t.objectStore(name);
      store.clear();
      for (const row of data[name] || []) store.put(row);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Random unique id for new records. */
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
