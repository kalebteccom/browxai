// `storage` — localStorage / sessionStorage / cookies / IndexedDB / Cache API
// playground. Exercises the full storage CRUD family + dump/inject storage state
// + auth save/load. Buttons seed values; a readout reflects current state so an
// exercise can assert a write landed or a clear emptied it.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const storage: Surface = {
  id: "storage",
  path: "/storage",
  title: "Storage surface",
  blurb: "localStorage, sessionStorage, cookies, IndexedDB, Cache API",
  html: () =>
    doc(
      "Storage surface",
      `
<section class="card">
  <button id="seed" data-testid="seed-storage">seed all stores</button>
  <button id="read" data-testid="read-storage">read all stores</button>
  <button id="clear" data-testid="clear-storage">clear all stores</button>
  <pre id="s-out" data-testid="storage-out"></pre>
</section>
`,
      {
        surfaceId: "storage",
        script: `
const out = document.getElementById('s-out');
function idb(run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('testbed-db', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('kv'); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => run(open.result, resolve, reject);
  });
}
async function seed() {
  localStorage.setItem('ls-key', 'ls-value');
  sessionStorage.setItem('ss-key', 'ss-value');
  document.cookie = 'ck-key=ck-value; path=/';
  await idb((db, resolve) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put('idb-value', 'idb-key');
    tx.oncomplete = () => resolve();
  });
  const cache = await caches.open('testbed-cache');
  await cache.put('/cache-item', new Response('cache-value'));
  out.textContent = 'seeded';
}
async function read() {
  const idbVal = await idb((db, resolve) => {
    const r = db.transaction('kv', 'readonly').objectStore('kv').get('idb-key');
    r.onsuccess = () => resolve(r.result);
  });
  const cache = await caches.open('testbed-cache');
  const cached = await cache.match('/cache-item');
  out.textContent = JSON.stringify({
    localStorage: localStorage.getItem('ls-key'),
    sessionStorage: sessionStorage.getItem('ss-key'),
    cookie: document.cookie,
    idb: idbVal,
    cache: cached ? await cached.text() : null,
  }, null, 2);
}
async function clearAll() {
  localStorage.clear(); sessionStorage.clear();
  document.cookie = 'ck-key=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  await caches.delete('testbed-cache');
  indexedDB.deleteDatabase('testbed-db');
  out.textContent = 'cleared';
}
document.getElementById('seed').addEventListener('click', seed);
document.getElementById('read').addEventListener('click', read);
document.getElementById('clear').addEventListener('click', clearAll);
`,
      },
    ),
};
