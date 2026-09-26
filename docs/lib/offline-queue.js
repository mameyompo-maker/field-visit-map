/* field_visit_map — 写真のオフラインキュー(IndexedDB)。
 *
 * Firestoreの書き込み(ピン・訪問メモ)はSDK標準のオフライン永続化(persistentLocalCache,
 * firebase-init.js)にそのまま乗るので、ここで面倒を見る必要はない。
 * 一方 Cloud Storage の uploadBytes系はオフライン時の自動キューを持たず、電波が無い
 * ときに呼ぶとその場でエラーになる。そのため写真だけはこのキューを自前で持つ。
 *
 * 設計は projects/jatlog_offline/docs/colheita/app.js のIndexedDBキュー(store名
 * 'envios'、keyPath 'uuid'、状態 pendente/erro)を踏襲している:
 *   - navigator.onLine だけを信用しない(Wi-Fiのみ接続でtrueになる等、jatlogのHANDOVER.md
 *     の教訓どおり)。実際のアップロード成否で状態を更新する。
 *   - 自動(online イベント・定期リトライ・visibilitychange)+手動「今すぐ同期」の両方。
 *   - Background Sync API は Android/Chrome のみ存在する機能拡張として登録するが、
 *     Service Worker側でFirebaseの有効なIDトークンを維持する仕組みは実装していない
 *     (Firebase Authのトークンはページが開いている間しか自動更新されないため)。
 *     したがって実際にキューを空にする主経路は「アプリを開いている間の同期」であり、
 *     Background Syncは開いているタブがあれば起こす合図(best-effort)に留まる。
 *     iOS/Android共通で「電波のある場所でアプリを一度開く」が確実な運用ルールになる。
 */

const DB_NAME = 'field_visit_map';
const DB_VERSION = 1;
const STORE = 'photoQueue';

const RETRY_INTERVAL_MS = 25000;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('state', 'state');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function withStore(mode, fn) {
  return openDB().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
}

/**
 * 写真1件をキューに積む。item には最低限 pinId, visitId, blob(本体),
 * thumbBlob(サムネ), mimeType が必要。id を渡さなければ採番する。
 */
export function enqueue(item) {
  const record = Object.assign({
    id: uuid(),
    state: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: Date.now()
  }, item);
  return withStore('readwrite', (s) => s.put(record)).then(() => record);
}

export function listAll() {
  return withStore('readonly', (s) => s.getAll());
}

export function listPending() {
  return listAll().then((all) => (all || []).filter((r) => r.state !== 'synced'));
}

export function getItem(id) {
  return withStore('readonly', (s) => s.get(id));
}

export function updateItem(id, patch) {
  return withStore('readwrite', (s) => {
    const getReq = s.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) s.put(Object.assign(rec, patch));
    };
    return getReq;
  });
}

export function remove(id) {
  return withStore('readwrite', (s) => s.delete(id));
}

// ------------------------------------------------------------- 同期ループ

let processor = null;      // (item) => Promise<void>  成功したら remove() まで含めて処理する
let flushing = false;
let lastRequestOk = true;  // navigator.onLine だけに頼らないための実績ベースの判定
const stateListeners = [];

/** 写真1件を実際にアップロードする処理を登録する(pins.js から渡す)。 */
export function registerProcessor(fn) {
  processor = fn;
}

export function onQueueChange(fn) {
  stateListeners.push(fn);
  return () => {
    const i = stateListeners.indexOf(fn);
    if (i >= 0) stateListeners.splice(i, 1);
  };
}

async function emitState() {
  const pending = await listPending();
  const info = {
    pendingCount: pending.filter((p) => p.state === 'pending').length,
    errorCount: pending.filter((p) => p.state === 'error').length,
    flushing,
    offline: !lastRequestOk
  };
  stateListeners.forEach((fn) => fn(info));
  return info;
}

/** 実際にネットワークへ届いたかどうかで印を付け直す。jatlogの marcarRede() と同じ考え方。 */
function markNetwork(ok) {
  lastRequestOk = ok;
}

export async function flush() {
  if (flushing || !processor) return;
  if (!navigator.onLine) { await emitState(); return; }

  flushing = true;
  await emitState();

  const items = (await listAll()).filter((r) => r.state !== 'uploading');
  for (const item of items) {
    try {
      await updateItem(item.id, { state: 'uploading' });
      await processor(item);
      markNetwork(true);
      await remove(item.id);
    } catch (err) {
      markNetwork(err && err.networkError === false ? true : false);
      await updateItem(item.id, {
        state: 'error',
        attempts: (item.attempts || 0) + 1,
        lastError: (err && err.message) || String(err)
      });
    }
  }

  flushing = false;
  await emitState();
}

function requestBackgroundSync() {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
  navigator.serviceWorker.ready.then((reg) => {
    if (reg.sync) return reg.sync.register('field-visit-map-photos');
  }).catch(() => {});
}

/** 起動時に一度呼ぶ: online/visibilitychange/定期リトライを配線する。 */
export function startAutoSync() {
  emitState();
  window.addEventListener('online', () => { markNetwork(true); flush(); });
  window.addEventListener('offline', () => { markNetwork(false); emitState(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });
  setInterval(() => flush(), RETRY_INTERVAL_MS);
  requestBackgroundSync();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'flush-photo-queue') flush();
    });
  }
  flush();
}

/** 「今すぐ同期」ボタン用。 */
export function syncNow() {
  requestBackgroundSync();
  return flush();
}

export async function retryErrors() {
  const items = (await listAll()).filter((r) => r.state === 'error');
  await Promise.all(items.map((i) => updateItem(i.id, { state: 'pending' })));
  return flush();
}
