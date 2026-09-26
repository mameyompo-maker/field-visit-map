/* field_visit_map — 写真ライトボックス(#dlgLightbox)。 */
const $ = (id) => document.getElementById(id);

export function openLightbox(url) {
  const dlg = $('dlgLightbox');
  $('lightboxImg').src = url;
  dlg.showModal();
}

$('btnCloseLightbox')?.addEventListener('click', () => $('dlgLightbox').close());
$('dlgLightbox')?.addEventListener('click', (e) => {
  if (e.target.id === 'dlgLightbox') $('dlgLightbox').close();
});
