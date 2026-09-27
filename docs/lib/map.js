/* field_visit_map — Google Maps JavaScript API の読み込みと地図コントローラ。
 *
 * ビルド無し構成なので、Maps JS APIは <script> 動的挿入 + loading=async + コールバックで
 * 読み込む(ESモジュールのimportではなく、Google公式の推奨ローダー方式)。
 * Advanced Markers(google.maps.marker.AdvancedMarkerElement)を使うため、
 * config.js の mapId が必須(Google Cloud ConsoleのMap管理から発行する)。
 *
 * ★ 地図コンテナには必ず「幅と高さ」を与えること(styles.css の #map)。
 *   Maps JS API はコンテナに position:relative をインラインで上書きするため、
 *   position:fixed + inset:0 で大きさを作っていると、その指定が殺されて高さ0になる。
 *   タイルは読み込まれているのに画面には何も出ない、という分かりにくい形で壊れる
 *   (実際にこれで「地図が表示されない」を出した)。
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

function getPosition(options) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      options
    );
  });
}

/**
 * 地図を1つ作る。onPinClick(id) はマーカータップ時に呼ばれる。
 * 地図の空白部分をタップしてもピン追加フォームは開かない
 * (移動のたびにダイアログが出る誤操作が多すぎるため。追加は＋ボタンから行う)。
 */
export async function createMapController(container, { onPinClick, onMapClick, onIdle } = {}) {
  const maps = await loadMapsApi();
  const { Map: GoogleMap } = await maps.importLibrary('maps');
  const { AdvancedMarkerElement, PinElement } = await maps.importLibrary('marker');

  // 現在地が取れるまでの「とりあえずの表示」。真っ白な地図を見せないためのもので、
  // 起動時は下の locate() で現在地へ寄せ直す。
  const saved = loadSavedView();
  const map = new GoogleMap(container, {
    center: saved ? { lat: saved.lat, lng: saved.lng } : (cfg.defaultCenter || { lat: 0, lng: 0 }),
    zoom: saved ? saved.zoom : (cfg.defaultZoom || 10),
    mapId: cfg.mapId || undefined,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: false,          // スマホはピンチで操作する(Google マップと同じ)
    clickableIcons: false,       // Googleの店舗アイコンの吹き出しは巡回記録には邪魔
    gestureHandling: 'greedy'    // 片手で1本指スクロールできるようにする
  });

  // 次に開いたとき同じ場所から始められるようにする。
  map.addListener('idle', () => {
    const c = map.getCenter();
    if (!c) return;
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }));
    } catch { /* 保存できなくても動作には影響しない */ }
    if (onIdle) onIdle();
  });

  /* 地図を押した場所にピンを落とす(Google マップと同じ操作感)。
   * 既存ピンのタップはマーカー側が受け取るので、ここには流れてこない。
   * 以前は押した瞬間にフォーム(モーダル)を開いていて誤操作が多かったため、
   * ここでは「仮のピンを置いて下からシートを出す」までに留め、いつでも取り消せるようにする。 */
  if (onMapClick) {
    const handler = (e) => {
      if (!e.latLng) return;
      onMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    };
    map.addListener('click', handler);
    map.addListener('contextmenu', handler);   // 長押し(端末によってはこちらが飛ぶ)
  }

  // ---------------------------------------------------------- 仮ピン(追加する場所の指定)

  let tempMarker = null;

  function normalize(p) {
    if (!p) return null;
    return {
      lat: typeof p.lat === 'function' ? p.lat() : p.lat,
      lng: typeof p.lng === 'function' ? p.lng() : p.lng
    };
  }

  /** 追加位置を示す仮ピンを置く。ドラッグで微調整でき、確定位置を onMove で返す。 */
  function setTempPin(pos, onMove) {
    if (!tempMarker) {
      const pin = new PinElement({
        background: '#1a73e8', borderColor: '#174ea6', glyphColor: '#ffffff', scale: 1.2
      });
      tempMarker = new AdvancedMarkerElement({
        map, position: pos, content: pin.element, gmpDraggable: true, zIndex: 5
      });
      tempMarker.addListener('dragend', () => {
        const p = normalize(tempMarker.position);
        if (p && onMove) onMove(p);
      });
    } else {
      tempMarker.position = pos;
      tempMarker.map = map;
    }
  }

  function clearTempPin() {
    if (tempMarker) tempMarker.map = null;
  }

  // ---------------------------------------------------------- 現在地の青い点

  let myDot = null;
  function showMyLocation(pos) {
    if (!myDot) {
      const dot = document.createElement('div');
      dot.className = 'my-location-dot';
      myDot = new AdvancedMarkerElement({ map, position: pos, content: dot, zIndex: 1 });
    } else {
      myDot.position = pos;
      myDot.map = map;
    }
  }

  /** 現在地を取得して地図を寄せる。成否を Promise<boolean> で返す。 */
  async function locate({ pan = true, zoom = 16 } = {}) {
    const pos = await getPosition({ enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 });
    if (!pos) return false;
    showMyLocation({ lat: pos.lat, lng: pos.lng });
    if (pan) {
      map.panTo({ lat: pos.lat, lng: pos.lng });
      if (zoom) map.setZoom(zoom);
    }
    return true;
  }

  // ---------------------------------------------------------- ピンの描画

  const markerById = new Map();
  const renderedState = new Map();   // 見た目に関係する値だけ控え、変化が無ければ作り直さない

  function pinContent(pin) {
    const bg = pin._pendingWrite ? '#f59e0b' : '#ea4335';
    const glyph = (pin.name || '').trim().charAt(0) || '';
    return new PinElement({
      background: bg, borderColor: '#b31412', glyphColor: '#ffffff', glyph, scale: 1
    }).element;
  }

  function render(pins) {
    const seen = new Set();
    pins.forEach((pin) => {
      seen.add(pin.id);
      const state = `${pin.name || ''}|${pin._pendingWrite ? 1 : 0}`;
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
        renderedState.set(pin.id, state);
      } else {
        marker.position = position;
        // 中身の作り直しは見た目が変わったときだけ。毎回作ると件数ぶん無駄に重くなる。
        if (renderedState.get(pin.id) !== state) {
          marker.title = pin.name || '';
          marker.content = pinContent(pin);
          renderedState.set(pin.id, state);
        }
      }
    });
    for (const [id, marker] of markerById.entries()) {
      if (!seen.has(id)) { marker.map = null; markerById.delete(id); renderedState.delete(id); }
    }
  }

  function centerOn(pos, zoom) {
    map.panTo(pos);
    if (zoom) map.setZoom(zoom);
  }

  function getCenter() {
    const c = map.getCenter();
    // 地図の初期化に失敗している場合(APIキーのリファラー制限違反など)は
    // getCenter() が undefined を返す。ここで落とすとピン追加ごと巻き込むので既定値に倒す。
    return c ? { lat: c.lat(), lng: c.lng() } : (cfg.defaultCenter || { lat: 0, lng: 0 });
  }

  /* タイルが1枚も描かれないまま時間が過ぎたら、設定側の問題(APIキーの制限、
   * Map IDの不備など)を疑う。コンソールにしか出ないと気づけないので呼び出し側へ返す。 */
  function whenTilesFail(ms, onFail) {
    let loaded = false;
    const once = map.addListener('tilesloaded', () => { loaded = true; once.remove(); });
    setTimeout(() => { if (!loaded) onFail(); }, ms);
  }

  return {
    map, render, centerOn, getCenter, locate, showMyLocation, whenTilesFail,
    setTempPin, clearTempPin
  };
}
