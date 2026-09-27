/* field_visit_map — 写真の拡大表示(#dlgLightbox)と、前回の写真との見比べ。
 *
 * 見比べは「前回からの変化が分かるように」という要件のための機能。
 * 同じ場所の直近2件の記録の写真を左右に並べ、それぞれの日付を添える。
 * 左が前回、右が今回(時間の流れと同じ向き)。
 */
const $ = (id) => document.getElementById(id);

function show() { $('dlgLightbox').showModal(); }

export function openLightbox(url) {
  $('lightboxCompare').hidden = true;
  const img = $('lightboxImg');
  img.hidden = false;
  img.src = url;
  show();
}

/**
 * 2枚を並べて見せる。older / newer はどちらも {url, label}。
 */
export function openCompare(older, newer) {
  $('lightboxImg').hidden = true;
  $('cmpOldImg').src = older.url;
  $('cmpOldCap').textContent = older.label;
  $('cmpNewImg').src = newer.url;
  $('cmpNewCap').textContent = newer.label;
  $('lightboxCompare').hidden = false;
  show();
}

$('btnCloseLightbox')?.addEventListener('click', () => $('dlgLightbox').close());
$('dlgLightbox')?.addEventListener('click', (e) => {
  if (e.target.id === 'dlgLightbox') $('dlgLightbox').close();
});
