/* field_visit_map — ピン追加/編集フォーム(#dlgPinForm)。 */
const $ = (id) => document.getElementById(id);

/**
 * ピンの新規作成/編集フォームを開く。
 * @param {{lat:number,lng:number,pin?:object}} opts
 * @returns {Promise<{name,description,category}|null>} キャンセル時は null
 */
export function openPinForm({ lat, lng, pin } = {}) {
  return new Promise((resolve) => {
    const dlg = $('dlgPinForm');
    const form = $('formPin');

    $('pinFormTitle').textContent = pin ? 'ピンを編集' : 'ピンを追加';
    $('inpPinName').value = pin?.name || '';
    $('inpPinDescription').value = pin?.description || '';
    $('inpPinCategory').value = pin?.category || '';
    $('pinFormLatLng').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    let settled = false;
    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      $('btnCancelPinForm').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onCancel);
    }
    function onSubmit(e) {
      e.preventDefault();
      if (!$('inpPinName').value.trim()) return;
      settled = true;
      cleanup();
      dlg.close();
      resolve({
        name: $('inpPinName').value.trim(),
        description: $('inpPinDescription').value.trim(),
        category: $('inpPinCategory').value.trim() || null
      });
    }
    function onCancel() {
      if (settled) return;
      cleanup();
      resolve(null);
    }

    form.addEventListener('submit', onSubmit);
    $('btnCancelPinForm').addEventListener('click', () => { dlg.close(); });
    dlg.addEventListener('close', onCancel);
    dlg.showModal();
  });
}
