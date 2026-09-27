/* field_visit_map — 検索バーとその結果一覧(#searchBar / #searchPanel)。
 *
 * Google マップと同じで、上の検索欄を触ると候補が下に出て、選ぶとその場所へ飛ぶ。
 * 何も入力していないときは、記録した場所を新しい順に全部出す(Google マップの
 * 「最近の検索」と同じ位置づけ)。
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
    ? (filter ? `${shown.length} / ${pins.length} 件` : `記録した場所 ${pins.length} 件`)
    : '';

  if (!pins.length) {
    box.innerHTML = '<p class="hint" style="padding:12px">まだ場所がありません。右下の「＋」から追加できます。</p>';
    return;
  }
  if (!shown.length) {
    box.innerHTML = '<p class="hint" style="padding:12px">一致する場所がありません。</p>';
    return;
  }

  box.innerHTML = '';
  shown.forEach((pin) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pin-row';
    row.innerHTML = `
      <span class="pin-row-icon">📍</span>
      <span class="pin-row-main">
        <span class="pin-row-name">${esc(pin.name || '(名前なし)')}${pin._pendingWrite ? '<span class="pending-badge">未同期</span>' : ''}</span>
        <span class="pin-row-sub">${esc(pin.category || '')}${pin.category && pin.visitCount ? ' ・ ' : ''}${pin.visitCount ? `訪問${pin.visitCount}回` : ''}</span>
      </span>
      <span class="pin-row-side">${esc(fmtDate(pin))}</span>
    `;
    row.onclick = () => { if (onSelect) onSelect(pin); };
    box.appendChild(row);
  });
}

export function mountPinList({ onSelect: cb }) {
  onSelect = cb;
  const input = $('inpSearch');
  const clear = $('btnClearSearch');

  input.addEventListener('focus', openPinList);
  input.addEventListener('input', () => {
    filter = input.value.trim().toLowerCase();
    clear.hidden = !input.value;
    openPinList();
  });
  // 検索欄でEnterを押したら候補の先頭を選ぶ(1件に絞れているときに速い)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = pins.filter(matches)[0];
    if (first && onSelect) onSelect(first);
    input.blur();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    filter = '';
    clear.hidden = true;
    closePinList();
    input.focus();
  });
}

export function setPins(list) {
  pins = list;
  if (!$('searchPanel').hidden) render();
}

export function openPinList() {
  $('searchPanel').hidden = false;
  render();
}

export function closePinList() {
  $('searchPanel').hidden = true;
}

export function togglePinList() {
  if ($('searchPanel').hidden) openPinList();
  else closePinList();
}
