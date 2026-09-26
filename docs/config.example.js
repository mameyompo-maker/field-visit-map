/* field_visit_map — 設定ファイルの雛形。
 *
 * 実際に使う値は docs/config.js に書く。ここに書く値(Firebase Config・Maps APIキー)は
 * どのみちクライアントに公開される情報であり、秘匿する必要はない。config.js自体も
 * リポジトリにコミットする(jatlog_offlineのconfig.jsと同じ扱い)。本当の防御は
 * firestore.rules / storage.rules。
 *
 * 使い方: このファイルを config.js としてコピーし、値を実際のものに差し替える。
 */
window.FIELD_VISIT_MAP_CONFIG = {
  firebase: {
    apiKey: 'YOUR_API_KEY',
    authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID'
  },
  mapsApiKey: 'YOUR_GOOGLE_MAPS_API_KEY',
  // Advanced Markers に必須。Google Cloud Console > Google Maps Platform > Map Management
  // で発行する(Map IDを作ると同時にスタイルも選べる。Vector mapにしておくこと)。
  mapId: 'YOUR_MAP_ID',
  // 地図の初期表示位置(未対応ブラウザ・現在地取得前のフォールバック)
  defaultCenter: { lat: -14.9, lng: 38.35 },
  defaultZoom: 12
};
