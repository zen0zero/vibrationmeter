// IndexedDB persistence. Recordings are written in small chunks while driving,
// so a crash, a closed tab or a dead battery loses at most a couple of seconds.

const DB_NAME = 'vibrationmeter';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const chunks = db.createObjectStore('chunks', { autoIncrement: true });
      chunks.createIndex('bySession', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    result = fn(t);
  }));
}

function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function saveSession(meta) {
  return tx(['sessions'], 'readwrite', t => { t.objectStore('sessions').put(meta); });
}

// kind: 'motion' | 'gps' | 'marker'; data: plain array of numbers (flat rows)
export function appendChunk(sessionId, seq, kind, data) {
  return tx(['chunks'], 'readwrite', t => {
    t.objectStore('chunks').add({ sessionId, seq, kind, data });
  });
}

export async function listSessions() {
  const db = await openDb();
  const all = await reqResult(db.transaction('sessions').objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getSession(id) {
  const db = await openDb();
  return reqResult(db.transaction('sessions').objectStore('sessions').get(id));
}

export async function loadChunks(sessionId) {
  const db = await openDb();
  const idx = db.transaction('chunks').objectStore('chunks').index('bySession');
  const chunks = await reqResult(idx.getAll(IDBKeyRange.only(sessionId)));
  chunks.sort((a, b) => a.seq - b.seq);
  const out = { motion: [], gps: [], marker: [] };
  for (const c of chunks) {
    const arr = out[c.kind];
    for (let i = 0; i < c.data.length; i++) arr.push(c.data[i]);
  }
  return out;
}

export async function deleteSession(id) {
  const db = await openDb();
  const keys = await reqResult(
    db.transaction('chunks').objectStore('chunks').index('bySession').getAllKeys(IDBKeyRange.only(id)));
  return tx(['sessions', 'chunks'], 'readwrite', t => {
    t.objectStore('sessions').delete(id);
    const cs = t.objectStore('chunks');
    for (const k of keys) cs.delete(k);
  });
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) { /* not critical */ }
  return false;
}
