/* field_visit_map — ピン詳細パネル(#pinPanel): 訪問履歴タイムライン + 写真。 */
import { listenVisits, listenPhotos, archivePin, updatePin } from '../lib/pins.js';
import { openVisitForm } from './visit-form.js';
import { openPinForm } from './pin-form.js';
import { openLightbox } from './lightbox.js';

const $ = (id) => document.getElementById(id);

let currentPin = null;
let unsubVisits = null;
const unsubPhotosByVisit = {};

function fmtTime(ts) {
  if (!ts) return '(未同期)';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function stopPhotoListeners() {
  Object.values(unsubPhotosByVisit).forEach((fn) => fn());
  Object.keys(unsubPhotosByVisit).forEach((k) => delete unsubPhotosByVisit[k]);
}

function renderBody(pin, visits) {
  const body = $('pinPanelBody');
  const pendingBadge = pin._pendingWrite ? '<span class="pending-badge">未同期</span>' : '';
  body.innerHTML = `
    <h2>${esc(pin.name)}${pendingBadge}</h2>
    <p class="hint">${esc(pin.description || '')}</p>
    <p class="hint">${pin.category ? 'カテゴリ: ' + esc(pin.category) : ''}</p>
    <div class="dlg-actions" style="justify-content:flex-start;margin:12px 0;">
      <button id="btnEditPin" class="btn-secondary">編集</button>
      <button id="btnArchivePin" class="btn-secondary">アーカイブ</button>
      <button id="btnRecordVisit" class="btn-primary">訪問を記録</button>
    </div>
    <h3>訪問履歴</h3>
    <div id="visitList"></div>
  `;

  $('btnEditPin').onclick = async () => {
    const result = await openPinForm({ lat: pin.lat, lng: pin.lng, pin });
    if (result) await updatePin(pin.id, result);
  };
  $('btnArchivePin').onclick = async () => {
    if (!confirm('このピンをアーカイブしますか?(一覧から消えますが、記録は残ります)')) return;
    await archivePin(pin.id);
    closePinPanel();
  };
  $('btnRecordVisit').onclick = () => openVisitForm(pin.id);

  const listEl = $('visitList');
  if (!visits.length) {
    listEl.innerHTML = '<p class="hint">まだ訪問記録がありません。</p>';
    return;
  }
  listEl.innerHTML = '';
  visits.forEach((visit) => {
    const card = document.createElement('div');
    card.className = 'visit-card';
    const pendingBadgeV = visit._pendingWrite ? '<span class="pending-badge">未同期</span>' : '';
    card.innerHTML = `
      <div class="who">${esc(visit.visitedBy?.displayName || '')}${pendingBadgeV}</div>
      <div class="when">${fmtTime(visit.visitedAt)}</div>
      <div class="note">${esc(visit.note || '')}</div>
      <div class="photo-thumbs" id="photos-${visit.id}"></div>
    `;
    listEl.appendChild(card);

    if (!unsubPhotosByVisit[visit.id]) {
      unsubPhotosByVisit[visit.id] = listenPhotos(pin.id, visit.id, (photos) => {
        const box = document.getElementById('photos-' + visit.id);
        if (!box) return;
        box.innerHTML = '';
        photos.forEach((p) => {
          const img = document.createElement('img');
          if (p.thumbURL) {
            img.src = p.thumbURL;
            img.onclick = () => openLightbox(p.fullURL || p.thumbURL);
          } else {
            img.alt = 'アップロード待ち';
            img.style.opacity = '0.4';
          }
          box.appendChild(img);
        });
      });
    }
  });
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let lastVisits = [];

export function openPinPanel(pin) {
  currentPin = pin;
  lastVisits = [];
  $('pinPanel').hidden = false;
  if (unsubVisits) unsubVisits();
  stopPhotoListeners();
  unsubVisits = listenVisits(pin.id, (visits) => {
    lastVisits = visits;
    renderBody(currentPin, visits);
  });
}

/** app.js の listenPins から呼ばれる: パネルが開いていれば見た目だけ更新する。 */
export function refreshPinData(pins) {
  if (!currentPin) return;
  const updated = pins.find((p) => p.id === currentPin.id);
  if (!updated) { closePinPanel(); return; }
  currentPin = updated;
  renderBody(currentPin, lastVisits);
}

export function closePinPanel() {
  $('pinPanel').hidden = true;
  if (unsubVisits) { unsubVisits(); unsubVisits = null; }
  stopPhotoListeners();
  currentPin = null;
}

$('btnClosePinPanel')?.addEventListener('click', closePinPanel);
