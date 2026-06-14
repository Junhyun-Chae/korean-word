// IndexedDB: words, cards, reviews, meta
const DB_NAME = 'kokuin';
const DB_VER = 1;
let _db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('words')) {
        const s = db.createObjectStore('words', { keyPath: 'id' });
        s.createIndex('term', 'term');
        s.createIndex('deck', 'deck');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('wordId', 'wordId');
        s.createIndex('due', 'due');
        s.createIndex('state', 'state');
        s.createIndex('deck', 'deck');
      }
      if (!db.objectStoreNames.contains('reviews')) {
        const s = db.createObjectStore('reviews', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
        s.createIndex('cardId', 'cardId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = 'readonly') { const db = await openDB(); return db.transaction(name, mode).objectStore(name); }

export async function put(name, val) { return reqP((await store(name, 'readwrite')).put(val)); }
export async function get(name, key) { return reqP((await store(name)).get(key)); }
export async function del(name, key) { return reqP((await store(name, 'readwrite')).delete(key)); }
export async function all(name) { return reqP((await store(name)).getAll()); }
export async function allByIndex(name, index, query) { return reqP((await store(name)).index(index).getAll(query)); }
export async function count(name) { return reqP((await store(name)).count()); }
export async function clearStore(name) { return reqP((await store(name, 'readwrite')).clear()); }

export async function bulkPut(name, vals) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(name, 'readwrite');
    const os = t.objectStore(name);
    for (const v of vals) os.put(v);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });
}

// write to several stores in one transaction
// map = { storeName: [records...] }
export async function bulkPutAll(map) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const names = Object.keys(map);
    const t = db.transaction(names, 'readwrite');
    for (const n of names) { const os = t.objectStore(n); for (const v of map[n]) os.put(v); }
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });
}

// meta key/value helpers
export async function getMeta(key, def) { const v = await get('meta', key); return v === undefined ? def : v.value; }
export async function setMeta(key, value) { return put('meta', { key, value }); }
