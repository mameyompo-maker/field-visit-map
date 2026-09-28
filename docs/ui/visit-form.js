/* field_visit_map — 訪問記録フォーム(#dlgVisitForm)。
 * 訪問者欄は無い(要件どおり、currentUser() から自動記録する。手入力させない)。
 *
 * 保存の考え方:
 *   Firestoreへの書き込みはローカルに反映された時点で「記録できた」とみなし、
 *   すぐダイアログを閉じる。サーバー到達を待たないので圏外でも一瞬で終わる
 *   (待っていると圏外では永久に閉じない。未送信ぶんはステータスバーに出る)。
 *   写真の圧縮とキュー投入は閉じたあとに裏で進める。
 */
import { createVisit, attachPhoto } from '../lib/pins.js';
import { currentUser } from '../lib/auth.js';
import { toast, errorToast } from './toast.js';

const $ = (id) => document.getElementById(id);

let picked = [];          // 撮影/選択した File の一覧(カメラと選択の両方をここに集める)
let previewUrls = [];

function clearPreviews() {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
}

function renderPreview() {
  const box = $('visitPhotoPreview');
  clearPreviews();
  box.innerHTML = '';
  box.hidden = !picked.length;
  picked.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    previewUrls.push(url);
    const cell = document.createElement('div');
    cell.className = 'preview-cell';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preview-remove';
    del.textContent = '×';
    del.title = 'この写真を外す';
    del.onclick = () => { picked.splice(i, 1); renderPreview(); };
    cell.appendChild(img);
    cell.appendChild(del);
    box.appendChild(cell);
  });
  $('visitPhotoCount').textContent = picked.length ? `${picked.length}枚` : '';
}

/**
 * 訪問記録フォームを開く。閉じたら Promise<boolean> を返す(保存したら true)。
 * @param {string} pinId
 * @param {{files?: File[], takenAt?: number|null}} [initial]
 *   写真から記録する経路で、選んだ写真と撮影日時を引き継ぐために使う。
 */
export function openVisitForm(pinId, { files: initialFiles = [], takenAt = null } = {}) {
  return new Promise((resolve) => {
    const dlg = $('dlgVisitForm');
    const form = $('formVisit');
    const camInput = $('inpVisitCamera');
    const libInput = $('inpVisitLibrary');
    const submitBtn = $('btnSaveVisitForm');

    $('inpVisitNote').value = '';
    picked = initialFiles.slice();
    camInput.value = '';
    libInput.value = '';
    renderPreview();
    const who = currentUser();
    $('visitFormWho').textContent = who ? `記録者: ${who.displayName}(自動)` : '';
    // 撮影日時があるときは、この記録がいつの出来事として残るのかを明示する
    // (アップロードした今日ではなく、写真を撮った日で並ぶため)。
    const takenEl = $('visitFormTaken');
    takenEl.hidden = !takenAt;
    if (takenAt) {
      takenEl.textContent = '写真の撮影日時: ' + new Date(takenAt).toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      }) + '(この日時で記録します)';
    }

    let settled = false;

    function onPick(input) {
      return () => {
        picked = picked.concat(Array.from(input.files || []));
        // 同じ写真をもう一度選べるように毎回空にする
        // (空にしないと2枚目の撮影で change が飛ばない端末がある)。
        input.value = '';
        renderPreview();
      };
    }
    const onCam = onPick(camInput);
    const onLib = onPick(libInput);

    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      camInput.removeEventListener('change', onCam);
      libInput.removeEventListener('change', onLib);
      $('btnCancelVisitForm').removeEventListener('click', onCancelClick);
      dlg.removeEventListener('close', onCancel);
      clearPreviews();
    }

    function onSubmit(e) {
      e.preventDefault();
      const note = $('inpVisitNote').value.trim();
      const files = picked.slice();
      let visitId;
      try {
        visitId = createVisit(pinId, { note, takenAtLocal: takenAt });
      } catch (err) {
        errorToast('記録できませんでした', err);
        return;
      }

      settled = true;
      cleanup();
      dlg.close();
      resolve(true);
      toast(files.length ? `記録しました(写真${files.length}枚を処理中…)` : '記録しました');

      // 圧縮はそれなりに重いので、閉じたあとに1枚ずつ進める(端末のメモリを守る)。
      (async () => {
        let done = 0;
        for (const file of files) {
          try { await attachPhoto(pinId, visitId, file); done += 1; }
          catch (err) { errorToast('写真を保存できませんでした', err); }
        }
        if (done) toast(`写真${done}枚を保存しました`);
      })();
    }

    function onCancel() {
      // dialog.close() の close イベントは非同期に届く。前の回の close が
      // 次の回が開いたあとに飛んでくると、開いたばかりの画面が「取り消された」と
      // 誤判定される(実際にこれで写真の選択が無かったことにされた)。
      // その瞬間は既に開き直しているので、開いていれば自分宛てではない。
      if (settled || dlg.open) return;
      cleanup();
      resolve(false);
    }
    function onCancelClick() { dlg.close(); }

    form.addEventListener('submit', onSubmit);
    camInput.addEventListener('change', onCam);
    libInput.addEventListener('change', onLib);
    $('btnCancelVisitForm').addEventListener('click', onCancelClick);
    dlg.addEventListener('close', onCancel);
    submitBtn.disabled = false;
    dlg.showModal();
    $('inpVisitNote').focus();
  });
}
