/* field_visit_map — Service Worker。
 *
 * 2つのルールだけ(projects/jatlog_offline/docs/sw.js を踏襲):
 *   1. アプリ本体のファイルはキャッシュから返す(オフラインでも開ける)。裏で更新する。
 *   2. それ以外(Firestore/Storage/Maps APIへの通信)は絶対にキャッシュしない。
 *      キャッシュすると、圏外復帰後も古いデータのままになる。
 *
 * ファイルを1つでも追加・変更したら CACHE のバージョン番号を必ず上げること。
 * 上げ忘れると、既に開いている端末が古い版のキャッシュを使い続ける。
 */

const CACHE = 'field-visit-map-v2';

const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './lib/firebase-init.js',
  './lib/auth.js',
  './lib/pins.js',
  './lib/image.js',
  './lib/map.js',
  './lib/offline-queue.js',
  './lib/sync-status.js',
  './ui/pin-panel.js',
  './ui/pin-form.js',
  './ui/visit-form.js',
  './ui/lightbox.js'
];

const ROOT = new URL('./', self.location).pathname;
const NAMES = FILES.map((f) => f.replace(/^\.\//, ''));

function isAppFile(url) {
  if (url.search) return false;
  if (url.pathname.indexOf(ROOT) !== 0) return false;
  return NAMES.indexOf(url.pathname.slice(ROOT.length)) >= 0;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  if (url.origin !== self.location.origin || !isAppFile(url)) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      const fromNetwork = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fromNetwork;
    })
  );
});

/*
 * Background Sync: 'sync' タグ 'field-visit-map-photos' が来たら開いている
 * タブに「送信を試みて」と伝えるだけ。写真のアップロードにはFirebaseの有効な
 * IDトークンが要るが、それはページが開いている間しかSDKが更新してくれない
 * ため、Service Worker単独で安全にアップロードを完了させる手段を実装していない
 * (未検証のハックでトークンを持ち出すより、正直に「アプリを開いている間に
 * 同期する」運用に倒す判断。docs/lib/offline-queue.js 冒頭のコメント参照)。
 * 開いているタブが無ければ何もせず終わる — 次にアプリを開いたときに
 * offline-queue.js の startAutoSync() が自動でキューを片づける。
 */
self.addEventListener('sync', (e) => {
  if (e.tag !== 'field-visit-map-photos') return;
  e.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'flush-photo-queue' }));
    })
  );
});
