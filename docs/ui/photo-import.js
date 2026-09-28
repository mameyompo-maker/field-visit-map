/* field_visit_map — 写真から記録する(#photoSheet)。
 *
 * 流れ:
 *   写真を選ぶ → EXIFの撮影地点を読む → **その場所へ地図が動いてピンが立つ** →
 *   近くに登録済みの場所があれば「ここですか?」と候補を出す →
 *   選んで記録する / 新しい場所として登録する。
 *
 * モーダルではなく下から出るシートにしてあるのは、撮影地点のピンと周りの
 * 登録済みピンを見ながら選ぶ画面だから。モーダルで地図を覆うと、座標の数字だけで
 * 「ここですか?」に答えることになり、判断できない。
 *
 * 地図そのものの操作(移動・ピンを置く・範囲を合わせる)は app.js の責任にしてある。
 * このファイルは「どこが撮影地点か」「どれを選んだか」を handlers で伝えるだけ。
 * そうしておくと、地図が読めない(圏外)ときでも候補選びはそのまま動く。
 *
 * 位置が読めない写真もある(GPSが切ってある、SNS経由で削除された、HEICなど)。
 * その場合は黙って諦めず、「地図で場所を選ぶ」か「登録済みの場所から選ぶ」に倒す。
 */
import { readGroupMeta } from '../lib/exif.js';
import { distanceMeters, fmtDistance } from '../lib/geo.js';
import { pinActivityTime } from '../lib/pins.js';

const $ = (id) => document.getElementById(id);

/* スマホのGPS誤差はふつう5〜20m、樹冠の下ではもっと大きい。圃場そのものの
 * 広さもあるので、300mまでを「同じ場所かもしれない」として候補に出す。 */
const NEAR_METERS = 300;
const MAX_NEAR = 5;
/* 300m以内に何も無いときは「いちばん近い場所」も見せる。ただし数千kmも離れた
 * 場所を候補に並べても判断の助けにならないので、ここまで。 */
const FAR_METERS = 5000;
const NEW_PLACE = '__new__';

let previewUrls = [];
let session = null;      // シートが開いている間だけ中身が入る

function clearPreviews() {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function renderPreview(files) {
  const box = $('photoImportPreview');
  clearPreviews();
  box.innerHTML = '';
  files.slice(0, 6).forEach((f) => {
    const url = URL.createObjectURL(f);
    previewUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    box.appendChild(img);
  });
  if (files.length > 6) {
    const more = document.createElement('span');
    more.className = 'hint';
    more.textContent = `ほか ${files.length - 6} 枚`;
    box.appendChild(more);
  }
}

function choiceRow({ value, name, sub, checked }) {
  const label = document.createElement('label');
  label.className = 'choice-row';
  label.innerHTML = `
    <input type="radio" name="photoPinChoice" value="${value}"${checked ? ' checked' : ''}>
    <span class="choice-main">
      <span class="choice-name"></span>
      <span class="choice-sub"></span>
    </span>`;
  // 場所の名前は利用者が入力した文字列。HTMLとして解釈させないよう textContent で入れる。
  label.querySelector('.choice-name').textContent = name;
  label.querySelector('.choice-sub').textContent = sub;
  return label;
}

/** 撮影地点のまわりのピンを近い順に並べ、候補として出すぶんを決める。 */
function pickCandidates(pins, latLng) {
  if (!latLng) {
    // 位置が読めないときは「最近さわった場所」を出す。近さで並べられないため。
    return {
      rows: pins.slice().sort((a, b) => pinActivityTime(b) - pinActivityTime(a)).slice(0, 6)
        .map((pin) => ({ pin, distance: null })),
      hasNear: false
    };
  }
  const withDist = pins
    .map((pin) => ({ pin, distance: distanceMeters(latLng, { lat: pin.lat, lng: pin.lng }) }))
    .sort((a, b) => a.distance - b.distance);
  const near = withDist.filter((c) => c.distance <= NEAR_METERS).slice(0, MAX_NEAR);
  if (near.length) return { rows: near, hasNear: true };
  // 近くに無くても数km以内なら見せる。「本当に新しい場所か」を判断する材料になる
  // (数百m先に似た名前の圃場があるかもしれない)。
  return { rows: withDist.filter((c) => c.distance <= FAR_METERS).slice(0, 3), hasNear: false };
}

// ---------------------------------------------------------------- 外から使う

/** シートが開いているか。開いている間は地図のタップの意味が変わる(app.js)。 */
export function isPhotoImportOpen() {
  return !!session;
}

/**
 * 撮影地点を差し替える。地図をタップしたとき、撮影地点のピンをドラッグしたときに
 * app.js から呼ばれる。GPSが少しずれている場合と、位置情報が無い写真で地図から
 * 指す場合に使う。位置が変われば近さも変わるので、候補も出し直す。
 */
export function setPhotoLocation(latLng) {
  if (!session) return;
  session.latLng = latLng;
  session.adjusted = true;
  renderWhere();
  $('photoImportWarn').hidden = true;
  renderChoices();
}

/** 外(Escapeキーなど)から閉じる。 */
export function closePhotoImport() {
  if (session) $('btnCancelPhotoImport').click();
}

// ---------------------------------------------------------------- 描画

function renderWhere() {
  const { latLng, takenAt, adjusted } = session;
  const parts = [];
  if (latLng) {
    parts.push(`${adjusted ? '指定した位置' : '撮影地点'}: ${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`);
  }
  if (takenAt) parts.push(`撮影日時: ${fmtDateTime(takenAt)}`);
  $('photoImportWhere').textContent = parts.length
    ? parts.join(' ・ ')
    : '写真に位置情報がありませんでした。';
}

function renderChoices() {
  const { pins, latLng } = session;
  const choices = $('photoImportChoices');
  // 出し直しても選択が飛ばないよう、選ばれていた値を覚えておく。
  const checked = choices.querySelector('input:checked');
  const previous = checked ? checked.value : null;
  choices.innerHTML = '';

  const { rows, hasNear } = pickCandidates(pins, latLng);
  session.rows = rows;

  const head = document.createElement('p');
  head.className = 'hint';
  if (!pins.length) head.textContent = 'まだ登録された場所がありません。';
  else if (!latLng) head.textContent = '登録済みの場所から選ぶ:';
  else if (hasNear) head.textContent = 'この近くの場所です。ここですか?';
  else if (rows.length) head.textContent = `${NEAR_METERS} m以内に登録された場所はありません。いちばん近いのは:`;
  else head.textContent = 'この近くに登録された場所はありません。新しい場所として登録できます。';
  choices.appendChild(head);

  const keep = previous
    && (previous === NEW_PLACE || rows.some((c) => c.pin.id === previous));

  rows.forEach((c, i) => {
    const last = pinActivityTime(c.pin);
    const sub = [
      c.distance === null ? '' : fmtDistance(c.distance),
      c.pin.category || '',
      last ? `最終 ${fmtDate(last)}` : ''
    ].filter(Boolean).join(' ・ ');
    choices.appendChild(choiceRow({
      value: c.pin.id,
      name: c.pin.name || '(名前なし)',
      sub,
      checked: keep ? previous === c.pin.id : (hasNear && i === 0)
    }));
  });

  choices.appendChild(choiceRow({
    value: NEW_PLACE,
    name: latLng ? 'ここを新しい場所として登録する' : '地図で場所を選ぶ',
    sub: latLng
      ? '写真の撮影地点に新しいピンを立てます'
      : '地図を押して、写真を撮った場所を指定します',
    checked: keep ? previous === NEW_PLACE : !hasNear
  }));

  updateButton();
}

function selectedValue() {
  const el = $('photoImportChoices').querySelector('input[name="photoPinChoice"]:checked');
  return el ? el.value : null;
}

function updateButton() {
  const btn = $('btnConfirmPhotoImport');
  const v = selectedValue();
  btn.disabled = !v;
  // 文言は短く。390px幅だと長いと2行に折り返して押しにくくなる。
  if (v === NEW_PLACE) btn.textContent = session.latLng ? '新しい場所を作る' : '地図で選ぶ';
  else btn.textContent = 'ここに記録する';
}

// ---------------------------------------------------------------- 開く

/**
 * 写真から記録するシートを開く。
 * @param {File[]} files
 * @param {Array} pins  現在のピン一覧
 * @param {{onLocated?: Function, onHighlight?: Function, onDone?: Function}} handlers
 *   onLocated(latLng)        … 撮影地点が分かった時点。地図を動かしてピンを立てる
 *   onHighlight(latLng, pin) … 候補を選び直した時点。両方が入る範囲に地図を合わせる
 *   onDone()                 … 閉じた時点。仮ピンの片づけに使う
 * @returns {Promise<null | {action:'existing', pinId, files, takenAt}
 *                        | {action:'new', latLng, files, takenAt}
 *                        | {action:'pick-on-map', files, takenAt}>}
 */
export function openPhotoImport(files, pins, handlers = {}) {
  return new Promise((resolve) => {
    const sheet = $('photoSheet');
    const choices = $('photoImportChoices');
    const confirmBtn = $('btnConfirmPhotoImport');
    const cancelBtn = $('btnCancelPhotoImport');

    session = { files, pins, latLng: null, takenAt: null, adjusted: false, rows: [], handlers };

    renderPreview(files);
    $('photoImportWhere').textContent = '写真を調べています…';
    $('photoImportWarn').hidden = true;
    choices.innerHTML = '';
    confirmBtn.disabled = true;
    sheet.hidden = false;

    function cleanup() {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      choices.removeEventListener('change', onChange);
      clearPreviews();
      sheet.hidden = true;
      session = null;
      if (handlers.onDone) handlers.onDone();
    }

    function finish(result) {
      cleanup();
      resolve(result);
    }

    function onChange() {
      if (!session) return;
      updateButton();
      if (!handlers.onHighlight || !session.latLng) return;
      const v = selectedValue();
      const row = session.rows.find((c) => c.pin.id === v);
      handlers.onHighlight(session.latLng, row ? row.pin : null);
    }

    function onConfirm() {
      if (!session) return;
      const v = selectedValue();
      if (!v) return;
      const { latLng, takenAt } = session;
      if (v === NEW_PLACE) {
        finish(latLng
          ? { action: 'new', latLng, files, takenAt }
          : { action: 'pick-on-map', files, takenAt });
        return;
      }
      finish({ action: 'existing', pinId: v, files, takenAt });
    }

    function onCancel() { finish(null); }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    choices.addEventListener('change', onChange);

    // EXIFの読み取りは枚数ぶんかかるので、シートを出してから進める。
    (async () => {
      const meta = await readGroupMeta(files);
      if (!session) return;                       // 読んでいる間に閉じられた
      session.latLng = (meta.lat !== null && meta.lng !== null)
        ? { lat: meta.lat, lng: meta.lng }
        : null;
      session.takenAt = meta.takenAt;

      renderWhere();
      if (!session.latLng) {
        $('photoImportWarn').hidden = false;
        $('photoImportWarn').textContent =
          '位置情報が読み取れませんでした(カメラの位置情報が切ってあるか、'
          + '送信の途中で削除された可能性があります)。場所を選んでください。';
      } else if (handlers.onLocated) {
        // ここで地図が撮影地点へ動き、ピンが立つ。
        handlers.onLocated(session.latLng);
      }

      renderChoices();
      onChange();
    })();
  });
}
