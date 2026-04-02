// IndexedDB cache for CLIP classification results.
// Keyed by "filename:size:lastModified" — stable across folder moves.
// Results are kept for 30 days, then evicted on next startup.

const DB_NAME    = 'PhotoSorterCache';
const DB_VERSION = 1;
const STORE_NAME = 'clipResults';
const TTL_MS     = 30 * 24 * 60 * 60 * 1000; // 30 days

let db = null;

function openDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const store = e.target.result.createObjectStore(STORE_NAME, { keyPath: 'fileKey' });
      store.createIndex('cachedAt', 'cachedAt');
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = () => reject(req.error);
  });
}

export function makeFileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export async function getCached(fileKey) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = idb.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(fileKey);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function putCached(fileKey, label, score) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = idb.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put({ fileKey, label, score, cachedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// Call once on startup to remove expired entries
export async function evictExpired() {
  try {
    const idb   = await openDB();
    const cutoff = Date.now() - TTL_MS;
    await new Promise((resolve, reject) => {
      const tx    = idb.transaction(STORE_NAME, 'readwrite');
      const index = tx.objectStore(STORE_NAME).index('cachedAt');
      const range = IDBKeyRange.upperBound(cutoff);
      const req   = index.openCursor(range);
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Cache errors are non-fatal
  }
}
