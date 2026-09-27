/* field_visit_map — ピン詳細パネル(#pinPanel): 訪問履歴タイムライン + 写真。
 *
 * 描き直しの方針:
 *   ピンの情報が更新されるたびにパネル全体を innerHTML で作り直すと、
 *   写真の入れ物(div)も毎回新品になる。写真は別の購読(listenPhotos)から
 *   後追いで流し込む作りなので、Firestoreが再送してくれない限り二度と埋まらず、
 *   「一覧を更新した瞬間に写真だけ消える」という不具合になる(実際に出した)。
 *   そのため:
 *     - 見出しなどピンの情報は textContent で部分更新する(作り直さない)
 *     - 写真は photosByVisit に控えを持ち、描き直しのたびにそこから埋め直す
 */
import { listenVisits, listenPhotos, archivePin, updatePin } from '../lib/pins.js';
import { pendingBlobsByPhotoId } from '../lib/offline-queue.js';
import { openVisitForm } from './visit-form.js';
import { openPinForm } from './pin-form.js';
import { openLightbox } from './lightbox.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

let currentPin = null;
let unsubVisits = null;
let onCenterRequest = null;
const unsubPhotosByVisit = {};
const photosByVisit = {};
const blobUrls = new Map();   // photoId -> objectURL(送信待ちの手元写真)

export function setPinPanelHandlers({ onCenter }) {
  onCenterRequest = onCenter;
}

function fmtTime(visit) {
  const ms = (visit.visitedAt && visit.visitedAt.toMillis)
    ? visit.visitedAt.toMillis()
    : visit.visitedAtLocal;
  if (!ms) return '';
  return new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// ------------------------------------------------------------------ 骨組み

function buildShell() {
  $('pinPanelBody').innerHTML = `
    <h2 id="ppName"></h2>
    <p id="ppMeta" class="hint"></p>
    <p id="ppDesc" class="panel-desc"></p>
    <button id="btnRecordVisit" class="btn-primary btn-wide">訪問を記録する</button>
    <div class="panel-actions">
      <button id="btnCenterPin" class="btn-secondary">地図で見る</button>
      <button id="btnEditPin" class="btn-secondary">編集</button>
      <button id="btnArchivePin" class="btn-secondary">アーカイブ</button>
    </div>
    <h3 id="ppHistoryTitle">訪問履歴</h3>
    <div id="visitList"></div>
  `;

  $('btnRecordVisit').onclick = () => { if (currentPin) openVisitForm(currentPin.id); };
  $('btnCenterPin').onclick = () => {
    if (currentPin && onCenterRequest) onCenterRequest(currentPin);
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
    if (!confirm('このピンをアーカイブしますか?(地図から消えますが、記録は残ります)')) return;
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
  bits.push(`訪問 ${pin.visitCount || 0} 回`);
  if (pin._pendingWrite) bits.push('未同期');
  $('ppMeta').textContent = bits.join(' ・ ');
  $('ppDesc').textContent = pin.description || '';
  $('ppDesc').hidden = !pin.description;
}

// ------------------------------------------------------------------ 訪問履歴

function renderPhotos(visitId) {
  const box = document.getElementById('photos-' + visitId);
  if (!box) return;
  const photos = photosByVisit[visitId] || [];
  box.innerHTML = '';
  photos.forEach((p) => {
    const url = p.thumbURL || blobUrls.get(p.id);
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
    img.onclick = () => openLightbox(p.fullURL || url);
    if (!p.thumbURL) img.classList.add('photo-pending');
    box.appendChild(img);
  });
}

function renderVisits(visits) {
  const listEl = $('visitList');
  if (!listEl) return;
  $('ppHistoryTitle').textContent = visits.length ? `訪問履歴(${visits.length}件)` : '訪問履歴';

  if (!visits.length) {
    listEl.innerHTML = '<p class="hint">まだ訪問記録がありません。上の「訪問を記録する」から追加できます。</p>';
    return;
  }

  listEl.innerHTML = '';
  visits.forEach((visit) => {
    const card = document.createElement('div');
    card.className = 'visit-card';
    const badge = visit._pendingWrite ? '<span class="pending-badge">未同期</span>' : '';
    card.innerHTML = `
      <div class="when">${esc(fmtTime(visit))}${badge}</div>
      <div class="who">${esc(visit.visitedBy?.displayName || '')}</div>
      <div class="note">${esc(visit.note || '')}</div>
      <div class="photo-thumbs" id="photos-${visit.id}"></div>
    `;
    listEl.appendChild(card);

    if (!unsubPhotosByVisit[visit.id]) {
      unsubPhotosByVisit[visit.id] = listenPhotos(currentPin.id, visit.id, async (photos) => {
        photosByVisit[visit.id] = photos;
        await refreshLocalBlobs();
        renderPhotos(visit.id);
      });
    } else {
      // 既に購読済みなら、控えから描き直す(ここを忘れると写真が消える)。
      renderPhotos(visit.id);
    }
  });
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
    buildShell();
    renderHeader(pin);
    renderVisits([]);
    unsubVisits = listenVisits(pin.id, (visits) => renderVisits(visits));
  } else {
    renderHeader(pin);
  }
}

/** app.js の listenPins から呼ばれる: パネルが開いていれば見出しだけ更新する。 */
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
}

export function isPinPanelOpen() {
  return !!currentPin;
}

$('btnClosePinPanel')?.addEventListener('click', closePinPanel);
