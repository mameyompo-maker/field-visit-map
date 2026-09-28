/* field_visit_map — 2地点の距離。写真の撮影地点から近いピンを探すのに使う。 */

const R = 6371000;   // 地球の半径(m)

/** ヒュベニではなく球面距離(haversine)。数km以内なら十分な精度で、式が単純。 */
export function distanceMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* 「12.3456m」のような細かい表示は現場では意味がない(スマホのGPS誤差が
 * そもそも5〜20mある)。丸めて、桁の感覚だけ伝える。 */
export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 20) return 'ほぼ同じ場所';
  if (m < 1000) return `約 ${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `約 ${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('ja-JP')} km`;
}
