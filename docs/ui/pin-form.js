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
    function onCancelClick() { dlg.close(); }
    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      // ここで外すのは実際に登録した onCancelClick。以前は登録していない関数を
      // 外そうとしていて、フォームを開くたびに匿名のリスナーが積み上がっていた。
      $('btnCancelPinForm').removeEventListener('click', onCancelClick);
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
      // dialog.close() の close イベントは非同期に届く。前の回の close が
      // 次の回が開いたあとに飛んでくると、開いたばかりの画面が「取り消された」と
      // 誤判定される(実際にこれで写真の選択が無かったことにされた)。
      // その瞬間は既に開き直しているので、開いていれば自分宛てではない。
      if (settled || dlg.open) return;
      cleanup();
      resolve(null);
    }

    form.addEventListener('submit', onSubmit);
    $('btnCancelPinForm').addEventListener('click', onCancelClick);
    dlg.addEventListener('close', onCancel);
    dlg.showModal();
    $('inpPinName').focus();
  });
}
