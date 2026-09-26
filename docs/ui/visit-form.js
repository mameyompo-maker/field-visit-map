/* field_visit_map — 訪問記録フォーム(#dlgVisitForm)。
 * 訪問者欄は無い(要件どおり、currentUser() から自動記録する。手入力させない)。
 */
import { createVisit, attachPhoto } from '../lib/pins.js';
import { currentUser } from '../lib/auth.js';

const $ = (id) => document.getElementById(id);

function renderPreview(files) {
  const box = $('visitPhotoPreview');
  box.innerHTML = '';
  box.style.display = files.length ? 'flex' : 'none';
  box.style.flexWrap = 'wrap';
  box.style.gap = '6px';
  files.forEach((f) => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f);
    img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;';
    img.onload = () => URL.revokeObjectURL(img.src);
    box.appendChild(img);
  });
}

/** 訪問記録フォームを開く。保存が終わるまで解決しない Promise<boolean> を返す。 */
export function openVisitForm(pinId) {
  return new Promise((resolve) => {
    const dlg = $('dlgVisitForm');
    const form = $('formVisit');
    const fileInput = $('inpVisitPhotos');
    const submitBtn = $('btnSaveVisitForm');

    $('inpVisitNote').value = '';
    fileInput.value = '';
    renderPreview([]);
    const who = currentUser();
    $('visitFormWho').textContent = who ? `記録者: ${who.displayName}` : '';

    let settled = false;
    function onFileChange() { renderPreview(Array.from(fileInput.files || [])); }

    async function onSubmit(e) {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中…';
      try {
        const visitId = await createVisit(pinId, { note: $('inpVisitNote').value.trim() });
        const files = Array.from(fileInput.files || []);
        for (const file of files) {
          await attachPhoto(pinId, visitId, file);
        }
        settled = true;
        cleanup();
        dlg.close();
        resolve(true);
      } catch (err) {
        alert('保存できませんでした: ' + (err?.message || err));
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '記録する';
      }
    }

    function onCancel() {
      if (settled) return;
      cleanup();
      resolve(false);
    }

    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      fileInput.removeEventListener('change', onFileChange);
      $('btnCancelVisitForm').removeEventListener('click', onCancelClick);
      dlg.removeEventListener('close', onCancel);
    }
    function onCancelClick() { dlg.close(); }

    form.addEventListener('submit', onSubmit);
    fileInput.addEventListener('change', onFileChange);
    $('btnCancelVisitForm').addEventListener('click', onCancelClick);
    dlg.addEventListener('close', onCancel);
    dlg.showModal();
  });
}
