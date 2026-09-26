/* field_visit_map — 設定ファイル(公開前提の情報。docs/config.example.js の実値版)。 */
window.FIELD_VISIT_MAP_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyBVIqK4Xq42N8b107daWjWtNyPvyZja7Tw',
    authDomain: 'kazdr-field-visit-map.firebaseapp.com',
    projectId: 'kazdr-field-visit-map',
    storageBucket: 'kazdr-field-visit-map.firebasestorage.app',
    messagingSenderId: '829426716512',
    appId: '1:829426716512:web:c8f44371bef9bb54e85805'
  },
  mapsApiKey: 'AIzaSyDFBo75cjAY_9NfX5rOTmhPbx-0W9SqhwY',
  // Advanced Markers用のMap ID。Kazさんがconsoleで発行後にここへ設定する(SETUP.md手順3参照)。
  mapId: 'YOUR_MAP_ID',
  defaultCenter: { lat: -14.9, lng: 38.35 },
  defaultZoom: 12
};
