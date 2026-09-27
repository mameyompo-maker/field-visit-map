/* field_visit_map — Firebase の共通初期化(Auth / Firestore / Storage)。
 *
 * ビルド無しの構成なので、Firebase JS SDK はCDN配布のESモジュールをそのままimportする
 * (jatlog_offline/nutrition_trackerと同じ「push即反映」運用に合わせるため)。
 * バージョンは固定して読み込む — 上げるときはこの1ファイルの数字と、
 * docs/sw.js の CDN_FILES の両方を直すこと(片方だけだとオフラインで起動しなくなる)。
 */
const SDK_VERSION = '12.4.0';
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

/* SDKを1つずつ await すると、前のダウンロードが終わるまで次のリクエストが始まらず、
 * 往復が直列に積み上がって初回表示が体感で遅くなる。依存していないので並列で取る。
 * Storageは写真を送るときにしか要らないので、ここでは読まない(下の getStorageApi)。 */
const [
  { initializeApp },
  { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged },
  {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    doc, getDoc, getDocs, collection, setDoc, updateDoc, onSnapshot, serverTimestamp, increment
  }
] = await Promise.all([
  import(`${CDN}/firebase-app.js`),
  import(`${CDN}/firebase-auth.js`),
  import(`${CDN}/firebase-firestore.js`)
]);

const cfg = window.FIELD_VISIT_MAP_CONFIG;
if (!cfg || !cfg.firebase || !cfg.firebase.apiKey || cfg.firebase.apiKey === 'YOUR_API_KEY') {
  throw new Error(
    'docs/config.js が見つからないか未設定です。docs/config.example.js をコピーして ' +
    'docs/config.js を作り、実際の値を入れてください。'
  );
}

const app = initializeApp(cfg.firebase);
const auth = getAuth(app);

/* 現行の推奨API(persistentLocalCache)。旧 enableIndexedDbPersistence() は非推奨。
 * persistentMultipleTabManager にしておくと、同じ端末で複数タブを開いても壊れない。 */
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* Cloud Storage は写真を1枚でも送るまで不要。起動時に読み込むと、使わない人にも
 * 毎回ダウンロードとパースの負担がかかるので、必要になった時点で取りに行く。
 * オフラインでも sw.js がキャッシュ済みなので読める。 */
let storagePromise = null;
export function getStorageApi() {
  if (!storagePromise) {
    storagePromise = import(`${CDN}/firebase-storage.js`).then((m) => ({
      storage: m.getStorage(app),
      ref: m.ref,
      uploadBytesResumable: m.uploadBytesResumable,
      getDownloadURL: m.getDownloadURL
    }));
  }
  return storagePromise;
}

export {
  cfg, app, auth, db,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  doc, getDoc, getDocs, collection, setDoc, updateDoc, onSnapshot, serverTimestamp, increment
};
