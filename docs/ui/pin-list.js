/* field_visit_map — ピン一覧と検索(#listPanel)。
 *
 * 地図から探すだけだと、ピンが増えたときに目的の圃場を見つけにくい。
 * さらに、圏外では地図そのものが読めない(タイルはキャッシュできない)ため、
 * この一覧が「地図が無くても記録できる」唯一の経路になる。オフライン運用の要。
 */
import { pinActivityTime } from '../lib/pins.js';

const $ = (id) => document.getElementById(id);

let pins = [];
let onSelect = null;
let filter = '';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(pin) {
  const ms = pinActivityTime(pin);
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('ja-JP', { year: '2-digit', month: '2-digit', day: '2-digit' });
}

function matches(pin) {
  if (!filter) return true;
  const hay = `${pin.name || ''} ${pin.description || ''} ${pin.category || ''}`.toLowerCase();
  return hay.includes(filter);
}

function render() {
  const box = $('pinListBody');
  if (!box) return;
  const shown = pins.filter(matches);

  $('pinListCount').textContent = pins.length
    ? (filter ? `${shown.length} / ${pins.length} 件` : `${pins.length} 件`)
    : '';

  if (!pins.length) {
    box.innerHTML = '<p class="hint">まだピンがありません。地図の「＋」ボタンから追加できます。</p>';
    return;
  }
  if (!shown.length) {
    box.innerHTML = '<p class="hint">一致するピンがありません。</p>';
    return;
  }

  box.innerHTML = '';
  shown.forEach((pin) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pin-row';
    row.innerHTML = `
      <span class="pin-row-main">
        <span class="pin-row-name">${esc(pin.name || '(名前なし)')}${pin._pendingWrite ? '<span class="pending-badge">未同期</span>' : ''}</span>
        <span class="pin-row-sub">${esc(pin.category || '')}</span>
      </span>
      <span class="pin-row-side">
        <span>${pin.visitCount || 0}回</span>
        <span class="pin-row-date">${esc(fmtDate(pin))}</span>
      </span>
    `;
    row.onclick = () => { if (onSelect) onSelect(pin); };
    box.appendChild(row);
  });
}

export function mountPinList({ onSelect: cb }) {
  onSelect = cb;
  $('btnClosePinList').addEventListener('click', closePinList);
  $('inpPinSearch').addEventListener('input', (e) => {
    filter = e.target.value.trim().toLowerCase();
    render();
  });
}

export function setPins(list) {
  pins = list;
  if (!$('listPanel').hidden) render();
}

export function openPinList() {
  $('listPanel').hidden = false;
  render();
  // 現場で片手に手袋、という状況もあるので自動でキーボードは出さない。
}

export function closePinList() {
  $('listPanel').hidden = true;
}

export function togglePinList() {
  if ($('listPanel').hidden) openPinList();
  else closePinList();
}
