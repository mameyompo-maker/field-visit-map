/* field_visit_map — 場所の詳細シート(#pinPanel): 記録のタイムライン + 写真。
 *
 * 「いつ・誰が」と「前回からの変化」が分かることを最優先にしている:
 *   - 場所そのものに「誰がいつ登録したか」を出す
 *   - 記録は新しい順。各記録に日時・記録者・前回からの日数を出す
 *   - 直近2件の写真を左右に並べて見比べられるようにする
 *
 * 描き直しの方針:
 *   ピンの情報が更新されるたびにシート全体を innerHTML で作り直すと、
 *   写真の入れ物(div)も毎回新品になる。写真は別の購読(listenPhotos)から
 *   後追いで流し込む作りなので、Firestoreが再送してくれない限り二度と埋まらず、
 *   「一覧を更新した瞬間に写真だけ消える」という不具合になる(実際に出した)。
 *   そのため:
 *     - 見出しなど場所の情報は textContent で部分更新する(作り直さない)
 *     - 写真は photosByVisit に控えを持ち、描き直しのたびにそこから埋め直す
 */
import { listenVisits, listenPhotos, archivePin, updatePin, visitTime } from '../lib/pins.js';
import { pendingBlobsByPhotoId } from '../lib/offline-queue.js';
import { openVisitForm } from './visit-form.js';
import { openPinForm } from './pin-form.js';
import { openLightbox, openCompare } from './lightbox.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;

let currentPin = null;
let unsubVisits = null;
let onCenterRequest = null;
let visitsCache = [];
const unsubPhotosByVisit = {};
const photosByVisit = {};
const blobUrls = new Map();   // photoId -> objectURL(送信待ちの手元写真)

export function setPinPanelHandlers({ onCenter }) {
  onCenterRequest = onCenter;
}

// ------------------------------------------------------------------ 日時の表示

function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 「今日 / 昨日 / N日前」。パッと古さが掴めるようにする。 */
function ago(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 31) return `${days}日前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}か月前`;
  return `${Math.floor(days / 365)}年前`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pinCreatedTime(pin) {
  if (pin.createdAt && pin.createdAt.toMillis) return pin.createdAt.toMillis();
  return pin.createdAtLocal || 0;
}

// ------------------------------------------------------------------ 写真の控え

function stopPhotoListeners() {
  Object.values(unsubPhotosByVisit).forEach((fn) => fn());
  Object.keys(unsubPhotosByVisit).forEach((k) => delete unsubPhotosByVisit[k]);
  Object.keys(photosByVisit).forEach((k) => delete photosByVisit[k]);
}

function releaseBlobUrls() {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url);
  blobUrls.clear();
}

/** 送信待ちの写真は手元のBlobを見せる。送信が済んだ分のURLは解放する。 */
async function refreshLocalBlobs() {
  let map = {};
  try { map = await pendingBlobsByPhotoId(); } catch { return; }
  Object.keys(map).forEach((photoId) => {
    if (!blobUrls.has(photoId) && map[photoId]) {
      blobUrls.set(photoId, URL.createObjectURL(map[photoId]));
    }
  });
  for (const [photoId, url] of Array.from(blobUrls.entries())) {
    if (!map[photoId]) { URL.revokeObjectURL(url); blobUrls.delete(photoId); }
  }
}

function photoUrl(p) {
  return p.thumbURL || blobUrls.get(p.id) || null;
}

/** 見比べ用に、写真のある直近2件を新しい順で返す。足りなければ null。 */
function findComparePair() {
  const found = [];
  for (const v of visitsCache) {
    const photos = photosByVisit[v.id] || [];
    const p = photos.find((ph) => photoUrl(ph));
    if (p) found.push({ visit: v, url: p.fullURL || photoUrl(p) });
    if (found.length === 2) break;
  }
  return found.length === 2 ? found : null;
}

function updateCompareButton() {
  const btn = $('btnCompare');
  if (!btn) return;
  btn.hidden = !findComparePair();
}

// ------------------------------------------------------------------ 骨組み

function buildShell() {
  $('pinPanelBody').innerHTML = `
    <h2 id="ppName"></h2>
    <p id="ppMeta" class="hint"></p>
    <p id="ppCreated" class="hint"></p>
    <p id="ppDesc" class="panel-desc"></p>
    <button id="btnRecordVisit" class="btn-primary btn-wide">記録を追加(写真・備考)</button>
    <div class="panel-actions">
      <button id="btnCompare" class="btn-secondary" hidden>前回と見比べる</button>
      <button id="btnCenterPin" class="btn-secondary">地図で見る</button>
      <button id="btnEditPin" class="btn-secondary">編集</button>
      <button id="btnArchivePin" class="btn-secondary">アーカイブ</button>
    </div>
    <h3 id="ppHistoryTitle">記録</h3>
    <div id="visitList"></div>
  `;

  $('btnRecordVisit').onclick = () => { if (currentPin) openVisitForm(currentPin.id); };
  $('btnCenterPin').onclick = () => {
    if (currentPin && onCenterRequest) onCenterRequest(currentPin);
  };
  $('btnCompare').onclick = () => {
    const pair = findComparePair();
    if (!pair) { toast('見比べるには写真つきの記録が2件必要です'); return; }
    const [newer, older] = pair;
    const gap = Math.max(0, Math.round((visitTime(newer.visit) - visitTime(older.visit)) / DAY));
    openCompare(
      { url: older.url, label: `前回 ${fmtDate(visitTime(older.visit))}` },
      { url: newer.url, label: `今回 ${fmtDate(visitTime(newer.visit))}(${gap}日後)` }
    );
  };
  $('btnEditPin').onclick = () => {
    if (!currentPin) return;
    const pin = currentPin;
    openPinForm({ lat: pin.lat, lng: pin.lng, pin }).then((result) => {
      if (result) { updatePin(pin.id, result); toast('保存しました'); }
    });
  };
  $('btnArchivePin').onclick = () => {
    if (!currentPin) return;
    if (!confirm('この場所をアーカイブしますか?(地図から消えますが、記録は残ります)')) return;
    archivePin(currentPin.id);
    closePinPanel();
    toast('アーカイブしました');
  };
}

function renderHeader(pin) {
  if (!$('ppName')) return;
  $('ppName').textContent = pin.name || '(名前なし)';

  const bits = [];
  if (pin.category) bits.push(pin.category);
  bits.push(`記録 ${pin.visitCount || 0} 件`);
  if (pin._pendingWrite) bits.push('未同期');
  $('ppMeta').textContent = bits.join(' ・ ');

  const created = pinCreatedTime(pin);
  const who = pin.createdBy?.displayName || '';
  $('ppCreated').textContent = created
    ? `${who ? who + 'さんが' : ''}${fmtDate(created)} に登録`
    : (who ? `${who}さんが登録` : '');

  $('ppDesc').textContent = pin.description || '';
  $('ppDesc').hidden = !pin.description;
}

// ------------------------------------------------------------------ 記録の一覧

function renderPhotos(visitId) {
  const box = document.getElementById('photos-' + visitId);
  if (!box) return;
  const photos = photosByVisit[visitId] || [];
  box.innerHTML = '';
  photos.forEach((p) => {
    const url = photoUrl(p);
    if (!url) {
      // 手元にもサーバーにも画像が無い(別の端末から見ていて、まだ送信されていない)。
      // src の無い <img> を置くと壊れた画像アイコンが出るので、枠だけ見せる。
      const ph = document.createElement('div');
      ph.className = 'photo-placeholder';
      ph.textContent = '送信待ち';
      box.appendChild(ph);
      return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.alt = '写真';
    img.loading = 'lazy';
    img.onclick = () => openLightbox(p.fullURL || url);
    if (!p.thumbURL) img.classList.add('photo-pending');
    box.appendChild(img);
  });
}

function renderVisits(visits) {
  visitsCache = visits;
  const listEl = $('visitList');
  if (!listEl) return;

  const newest = visits.length ? visitTime(visits[0]) : 0;
  $('ppHistoryTitle').textContent = visits.length
    ? `記録(${visits.length}件) ・ 最終 ${fmtDate(newest)}(${ago(newest)})`
    : '記録';

  if (!visits.length) {
    listEl.innerHTML = '<p class="hint">まだ記録がありません。上の「記録を追加」から、写真と備考を残せます。</p>';
    updateCompareButton();
    return;
  }

  listEl.innerHTML = '';
  visits.forEach((visit, i) => {
    const t = visitTime(visit);
    const prev = visits[i + 1];
    // 「前回から何日空いたか」。変化を読むときの手がかりになる。
    const gap = prev ? Math.max(0, Math.round((t - visitTime(prev)) / DAY)) : null;

    const card = document.createElement('div');
    card.className = 'visit-card';
    const badge = visit._pendingWrite ? '<span class="pending-badge">未同期</span>' : '';
    const gapText = gap === null
      ? '<span class="gap-tag first">最初の記録</span>'
      : `<span class="gap-tag">前回から${gap}日</span>`;
    card.innerHTML = `
      <div class="when">${esc(fmtDateTime(t))}${badge}</div>
      <div class="who">${esc(visit.visitedBy?.displayName || '')} ・ ${esc(ago(t))} ${gapText}</div>
      <div class="note">${esc(visit.note || '')}</div>
      <div class="photo-thumbs" id="photos-${visit.id}"></div>
    `;
    listEl.appendChild(card);

    if (!unsubPhotosByVisit[visit.id]) {
      unsubPhotosByVisit[visit.id] = listenPhotos(currentPin.id, visit.id, async (photos) => {
        photosByVisit[visit.id] = photos;
        await refreshLocalBlobs();
        renderPhotos(visit.id);
        updateCompareButton();
      });
    } else {
      // 既に購読済みなら、控えから描き直す(ここを忘れると写真が消える)。
      renderPhotos(visit.id);
    }
  });
  updateCompareButton();
}

// ------------------------------------------------------------------ 開閉

export function openPinPanel(pin) {
  const isSame = currentPin && currentPin.id === pin.id;
  currentPin = pin;
  $('pinPanel').hidden = false;

  if (!isSame) {
    if (unsubVisits) { unsubVisits(); unsubVisits = null; }
    stopPhotoListeners();
    releaseBlobUrls();
    visitsCache = [];
    buildShell();
    renderHeader(pin);
    renderVisits([]);
    unsubVisits = listenVisits(pin.id, (visits) => renderVisits(visits));
  } else {
    renderHeader(pin);
  }
}

/** app.js の listenPins から呼ばれる: シートが開いていれば見出しだけ更新する。 */
export function refreshPinData(pins) {
  if (!currentPin) return;
  const updated = pins.find((p) => p.id === currentPin.id);
  if (!updated) { closePinPanel(); return; }
  currentPin = updated;
  renderHeader(currentPin);
}

export function closePinPanel() {
  $('pinPanel').hidden = true;
  if (unsubVisits) { unsubVisits(); unsubVisits = null; }
  stopPhotoListeners();
  releaseBlobUrls();
  currentPin = null;
  visitsCache = [];
}

$('btnClosePinPanel')?.addEventListener('click', closePinPanel);
