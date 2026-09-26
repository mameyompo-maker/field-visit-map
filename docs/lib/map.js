/* field_visit_map — Google Maps JavaScript API の読み込みと地図コントローラ。
 *
 * ビルド無し構成なので、Maps JS APIは <script> 動的挿入 + loading=async + コールバックで
 * 読み込む(ESモジュールのimportではなく、Google公式の推奨ローダー方式)。
 * Advanced Markers(google.maps.marker.AdvancedMarkerElement)を使うため、
 * config.js の mapId が必須(Google Cloud ConsoleのMap管理から発行する)。
 */
import { cfg } from './firebase-init.js';

let loadPromise = null;
function loadMapsApi() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    window.__fvmMapsReady = () => resolve(window.google.maps);
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.mapsApiKey)}` +
      `&libraries=marker&v=weekly&loading=async&callback=__fvmMapsReady`;
    script.async = true;
    script.onerror = () => reject(new Error('Google Maps API の読み込みに失敗しました'));
    document.head.appendChild(script);
  });
  return loadPromise;
}

/**
 * 地図を1つ作る。onPinClick(id) はマーカータップ時、onMapClick({lat,lng}) は
 * 地図の何もない場所をタップした時(新規ピン追加のきっかけ)に呼ばれる。
 */
export async function createMapController(container, { onPinClick, onMapClick } = {}) {
  const maps = await loadMapsApi();
  const { Map: GoogleMap } = await maps.importLibrary('maps');
  const { AdvancedMarkerElement, PinElement } = await maps.importLibrary('marker');

  const center = cfg.defaultCenter || { lat: 0, lng: 0 };
  const map = new GoogleMap(container, {
    center,
    zoom: cfg.defaultZoom || 10,
    mapId: cfg.mapId || undefined,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });

  if (onMapClick) {
    map.addListener('click', (e) => {
      if (!e.latLng) return;
      onMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
  }

  const markerById = new Map();

  function pinGlyph(pin) {
    // 未同期のピンは色を変えて一目で分かるようにする(同期ステータスの可視化)。
    const bg = pin._pendingWrite ? '#f59e0b' : '#2563eb';
    return new PinElement({ background: bg, borderColor: '#1e3a8a', glyphColor: '#ffffff' });
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
          content: pinGlyph(pin).element,
          gmpClickable: true
        });
        // addListener('click', …) はv3.66以降非推奨。標準の addEventListener + 'gmp-click' を使う。
        if (onPinClick) marker.addEventListener('gmp-click', () => onPinClick(pin.id));
        markerById.set(pin.id, marker);
      } else {
        marker.position = position;
        marker.title = pin.name || '';
        marker.content = pinGlyph(pin).element;
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

  function tryUseCurrentLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => {
      centerOn({ lat: p.coords.latitude, lng: p.coords.longitude }, 15);
    }, () => {}, { maximumAge: 60000, timeout: 8000 });
  }

  return { map, render, centerOn, tryUseCurrentLocation };
}
