/* field_visit_map — 写真から記録する(#dlgPhotoImport)。
 *
 * 流れ:
 *   写真を選ぶ → EXIFの撮影地点を読む → 近くに登録済みの場所があれば
 *   「ここですか?」と候補を出す → 選んで記録する / 新しい場所として登録する。
 *
 * 地図を先に作らなくても記録を始められるようにするための入口。現場では
 * 「撮ってから後で整理する」ことのほうが多く、撮影地点は写真自身が持っている。
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

/**
 * 写真から記録する画面を開く。
 * @param {File[]} files
 * @param {Array} pins  現在のピン一覧
 * @returns {Promise<null | {action:'existing', pinId:string, files:File[], takenAt:number|null}
 *                        | {action:'new', latLng:{lat:number,lng:number}, files:File[], takenAt:number|null}
 *                        | {action:'pick-on-map', files:File[], takenAt:number|null}>}
 */
export function openPhotoImport(files, pins) {
  return new Promise((resolve) => {
    const dlg = $('dlgPhotoImport');
    const confirmBtn = $('btnConfirmPhotoImport');
    const choices = $('photoImportChoices');

    renderPreview(files);
    $('photoImportWhere').textContent = '写真を調べています…';
    $('photoImportWarn').hidden = true;
    choices.innerHTML = '';
    confirmBtn.disabled = true;

    let settled = false;
    let latLng = null;
    let takenAt = null;

    function selected() {
      const el = choices.querySelector('input[name="photoPinChoice"]:checked');
      return el ? el.value : null;
    }

    function updateButton() {
      const v = selected();
      confirmBtn.disabled = !v;
      // 文言は短く。390px幅だと長い名前は2行に折り返して押しにくくなる。
      if (v === NEW_PLACE) {
        confirmBtn.textContent = latLng ? '新しい場所を作る' : '地図で選ぶ';
      } else {
        confirmBtn.textContent = 'ここに記録する';
      }
    }

    function cleanup() {
      confirmBtn.removeEventListener('click', onConfirm);
      $('btnCancelPhotoImport').removeEventListener('click', onCancelClick);
      choices.removeEventListener('change', updateButton);
      dlg.removeEventListener('close', onClose);
      clearPreviews();
    }

    function finish(result) {
      settled = true;
      cleanup();
      dlg.close();
      resolve(result);
    }

    function onConfirm() {
      const v = selected();
      if (!v) return;
      if (v === NEW_PLACE) {
        finish(latLng
          ? { action: 'new', latLng, files, takenAt }
          : { action: 'pick-on-map', files, takenAt });
        return;
      }
      finish({ action: 'existing', pinId: v, files, takenAt });
    }

    function onClose() {
      // dialog.close() の close イベントは非同期に届く。前の回の close が
      // 次の回が開いたあとに飛んでくると、開いたばかりの画面が「取り消された」と
      // 誤判定される(実際にこれで写真の選択が無かったことにされた)。
      // その瞬間は既に開き直しているので、開いていれば自分宛てではない。
      if (settled || dlg.open) return;
      cleanup();
      resolve(null);
    }
    function onCancelClick() { dlg.close(); }

    confirmBtn.addEventListener('click', onConfirm);
    $('btnCancelPhotoImport').addEventListener('click', onCancelClick);
    choices.addEventListener('change', updateButton);
    dlg.addEventListener('close', onClose);
    dlg.showModal();

    // EXIFの読み取りは写真の枚数ぶんかかるので、画面を出してから進める。
    (async () => {
      const meta = await readGroupMeta(files);
      if (settled) return;
      latLng = (meta.lat !== null && meta.lng !== null) ? { lat: meta.lat, lng: meta.lng } : null;
      takenAt = meta.takenAt;

      const where = [];
      if (latLng) where.push(`撮影地点: ${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`);
      if (takenAt) where.push(`撮影日時: ${fmtDateTime(takenAt)}`);
      $('photoImportWhere').textContent = where.length
        ? where.join(' ・ ')
        : '写真に位置情報がありませんでした。';

      if (!latLng) {
        $('photoImportWarn').hidden = false;
        $('photoImportWarn').textContent =
          '位置情報が読み取れませんでした(カメラの位置情報が切ってあるか、'
          + '送信の途中で削除された可能性があります)。場所を選んでください。';
      }

      const { rows, hasNear } = pickCandidates(pins, latLng);

      const head = document.createElement('p');
      head.className = 'hint';
      if (!pins.length) head.textContent = 'まだ登録された場所がありません。';
      else if (!latLng) head.textContent = '登録済みの場所から選ぶ:';
      else if (hasNear) head.textContent = 'この近くの場所です。ここですか?';
      else if (rows.length) head.textContent = `${NEAR_METERS} m以内に登録された場所はありません。いちばん近いのは:`;
      else head.textContent = 'この近くに登録された場所はありません。新しい場所として登録できます。';
      choices.appendChild(head);

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
          // 近くに候補があるときだけ、いちばん近いものを最初から選んでおく。
          checked: hasNear && i === 0
        }));
      });

      choices.appendChild(choiceRow({
        value: NEW_PLACE,
        name: latLng ? 'ここを新しい場所として登録する' : '地図で場所を選ぶ',
        sub: latLng
          ? '写真の撮影地点に新しいピンを立てます'
          : '地図を押して、写真を撮った場所を指定します',
        checked: !hasNear
      }));

      updateButton();
    })();
  });
}
