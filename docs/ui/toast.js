/* field_visit_map — 画面下部に数秒出る短い通知(#toast)。
 * alert() は現場で片手操作のときに邪魔なうえ、オフライン保存のように
 * 「止める必要のない知らせ」にまで操作を要求してしまうので使わない。 */
let timer = null;

export function toast(message, ms = 2600) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { box.hidden = true; }, ms);
}

export function errorToast(prefix, err) {
  const detail = (err && err.message) || String(err || '');
  toast(detail ? `${prefix}: ${detail}` : prefix, 5000);
}
