/* field_visit_map — Google Maps JavaScript API の読み込みと地図コントローラ。
 *
 * ビルド無し構成なので、Maps JS APIは <script> 動的挿入 + loading=async + コールバックで
 * 読み込む(ESモジュールのimportではなく、Google公式の推奨ローダー方式)。
 * Advanced Markers(google.maps.marker.AdvancedMarkerElement)を使うため、
 * config.js の mapId が必須(Google Cloud ConsoleのMap管理から発行する)。
 *
 * 設定は firebase-init.js からではなく window から直接読む。firebase-init.js は
 * 先頭で Firebase SDK を await しているため、そちらを経由すると地図の読み込みが
 * SDKのダウンロード完了まで始まらず、初回表示が目に見えて遅くなる。
 */
const cfg = window.FIELD_VISIT_MAP_CONFIG || {};
const VIEW_KEY = 'fvm.view';

let loadPromise = null;

export function loadMapsApi() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (!cfg.mapsApiKey) { reject(new Error('地図のAPIキーが設定されていません')); return; }
    window.__fvmMapsReady = () => resolve(window.google.maps);
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.mapsApiKey)}` +
      `&libraries=marker&v=weekly&loading=async&callback=__fvmMapsReady`;
    script.async = true;
    script.onerror = () => {
      // 失敗した Promise を抱えたままにすると、圏内に戻っても二度と読み直せない。
      loadPromise = null;
      script.remove();
      reject(new Error('地図を読み込めませんでした(電波が無い可能性があります)'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

/* ログインを待たずに取りに行く。地図の課金は new Map() の回数で数えられるため、
 * スクリプトを先に落としておくだけなら増えない。ログイン直後の待ち時間が消える。 */
if (cfg.mapsApiKey) loadMapsApi().catch(() => { /* 起動時点の失敗は握りつぶす(後で再試行する) */ });

function loadSavedView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)) return v;
  } catch { /* 壊れていたら既定位置を使う */ }
  return null;
}

/**
 * 地図を1つ作る。onPinClick(id) はマーカータップ時に呼ばれる。
 * 地図の空白部分をタップしてもピン追加フォームは開かない
 * (移動のたびにダイアログが出る誤操作が多すぎるため。追加は＋ボタンから行う)。
 */
export async function createMapController(container, { onPinClick } = {}) {
  const maps = await loadMapsApi();
  const { Map: GoogleMap } = await maps.importLibrary('maps');
  const { AdvancedMarkerElement, PinElement } = await maps.importLibrary('marker');

  const saved = loadSavedView();
  const map = new GoogleMap(container, {
    center: saved ? { lat: saved.lat, lng: saved.lng } : (cfg.defaultCenter || { lat: 0, lng: 0 }),
    zoom: saved ? saved.zoom : (cfg.defaultZoom || 10),
    mapId: cfg.mapId || undefined,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,      // Googleの店舗アイコン等の吹き出しは巡回記録には邪魔
    gestureHandling: 'greedy'   // 片手操作で1本指スクロールできるようにする
  });

  // 次に開いたとき同じ場所から始められるようにする(毎回リバウエ近郊から
  // 探し直すのは現場では手間なので)。
  map.addListener('idle', () => {
    const c = map.getCenter();
    if (!c) return;
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }));
    } catch { /* 保存できなくても動作には影響しない */ }
  });

  const markerById = new Map();

  function pinContent(pin) {
    // 未同期のピンは色を変えて一目で分かるようにする(同期ステータスの可視化)。
    const bg = pin._pendingWrite ? '#f59e0b' : '#2563eb';
    // 名前の先頭1文字をマーカーに出すと、拡大しなくても見分けがつく。
    const glyph = (pin.name || '').trim().charAt(0) || '';
    return new PinElement({
      background: bg, borderColor: '#1e3a8a', glyphColor: '#ffffff', glyph, scale: 1.1
    }).element;
  }

  function render(pins) {
    const seen = new Set();
    pins.forEach((pin) => {
      seen.add(pin.id);
      let marker = markerById.get(pin.id);
      const position = { lat: pin.lat, lng: pin.lng };
      if (!marker) {
        marker = new AdvancedMarkerElement({
          map, position, title: pin.name || '',
          content: pinContent(pin),
          gmpClickable: true
        });
        // addListener('click', …) はv3.66以降非推奨。標準の addEventListener + 'gmp-click' を使う。
        if (onPinClick) marker.addEventListener('gmp-click', () => onPinClick(pin.id));
        markerById.set(pin.id, marker);
      } else {
        marker.position = position;
        marker.title = pin.name || '';
        marker.content = pinContent(pin);
      }
    });
    for (const [id, marker] of markerById.entries()) {
      if (!seen.has(id)) { marker.map = null; markerById.delete(id); }
    }
  }

  function centerOn(pos, zoom) {
    map.panTo(pos);
    if (zoom) map.setZoom(zoom);
  }

  function getCenter() {
    const c = map.getCenter();
    return { lat: c.lat(), lng: c.lng() };
  }

  /** 現在地へ移動する。成否を Promise<boolean> で返す(呼び出し側が通知を出せるように)。 */
  function tryUseCurrentLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(false); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => { centerOn({ lat: p.coords.latitude, lng: p.coords.longitude }, 16); resolve(true); },
        () => resolve(false),
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 8000 }
      );
    });
  }

  // 初回起動(保存された表示位置が無い)のときだけ、黙って現在地に寄せる。
  if (!saved) tryUseCurrentLocation();

  return { map, render, centerOn, getCenter, tryUseCurrentLocation, restoredView: !!saved };
}
