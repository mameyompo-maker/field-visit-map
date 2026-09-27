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

/** 訪問記録フォームを開く。閉じたら Promise<boolean> を返す(保存したら true)。 */
export function openVisitForm(pinId) {
  return new Promise((resolve) => {
    const dlg = $('dlgVisitForm');
    const form = $('formVisit');
    const camInput = $('inpVisitCamera');
    const libInput = $('inpVisitLibrary');
    const submitBtn = $('btnSaveVisitForm');

    $('inpVisitNote').value = '';
    picked = [];
    camInput.value = '';
    libInput.value = '';
    renderPreview();
    const who = currentUser();
    $('visitFormWho').textContent = who ? `記録者: ${who.displayName}(自動)` : '';

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
        visitId = createVisit(pinId, { note });
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
      if (settled) return;
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
