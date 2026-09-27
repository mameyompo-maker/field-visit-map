/* field_visit_map — 同期状況の集約(写真キュー + Firestoreの未送信件数)。
 *
 * 画面上部のステータスバー(#syncBar)と、各カードの「未同期」バッジはここが
 * 唯一の情報源から描画する。jatlog_offline の #barra と同じ考え方(オフライン件数・
 * 送信中・エラー件数を出し分け、全部片づいたら消える)。
 */
import { onQueueChange, syncNow as flushPhotosNow, retryErrors } from './offline-queue.js';

let textPendingCount = 0;   // Firestoreの hasPendingWrites なドキュメント数(pins.js が集計)
let photoState = { pendingCount: 0, errorCount: 0, flushing: false, offline: !navigator.onLine };
const listeners = [];

function emit() {
  const combined = {
    textPendingCount,
    photoPendingCount: photoState.pendingCount,
    photoErrorCount: photoState.errorCount,
    flushing: photoState.flushing,
    offline: photoState.offline || !navigator.onLine
  };
  listeners.forEach((fn) => fn(combined));
}

onQueueChange((info) => { photoState = info; emit(); });
window.addEventListener('online', emit);
window.addEventListener('offline', emit);

export function subscribe(fn) {
  listeners.push(fn);
  fn({
    textPendingCount,
    photoPendingCount: photoState.pendingCount,
    photoErrorCount: photoState.errorCount,
    flushing: photoState.flushing,
    offline: photoState.offline || !navigator.onLine
  });
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** pins.js が onSnapshot の hasPendingWrites を数えて呼ぶ。 */
export function setTextPendingCount(n) {
  textPendingCount = n;
  emit();
}

export async function syncNowAll() {
  await retryErrors();
  await flushPhotosNow();
}

/** 画面上部の細いバーを配線する共通処理。呼び出し側は要素IDだけ用意すればよい。 */
export function mountStatusBar(barEl, buttonEl) {
  subscribe((s) => {
    const total = s.textPendingCount + s.photoPendingCount;
    if (s.offline) {
      barEl.hidden = false;
      barEl.textContent = total
        ? `オフライン ・ 保存待ち ${total} 件`
        : 'オフライン ・ 記録はこの端末に保存されます';
    } else if (s.flushing) {
      barEl.hidden = false;
      barEl.textContent = '同期中…';
    } else if (total) {
      barEl.hidden = false;
      barEl.textContent = `同期待ち ${total} 件(タップで送信)`;
    } else if (s.photoErrorCount) {
      barEl.hidden = false;
      barEl.textContent = `送信できなかった写真 ${s.photoErrorCount} 件(タップで再試行)`;
    } else {
      barEl.hidden = true;
    }
    if (buttonEl) buttonEl.hidden = !(total || s.photoErrorCount);
  });
  if (buttonEl) buttonEl.addEventListener('click', () => syncNowAll());
  barEl.addEventListener('click', () => syncNowAll());
}
