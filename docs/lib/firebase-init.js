/* field_visit_map — Firebase の共通初期化(Auth / Firestore / Storage)。
 *
 * ビルド無しの構成なので、Firebase JS SDK はCDN配布のESモジュールをそのままimportする
 * (jatlog_offline/nutrition_trackerと同じ「push即反映」運用に合わせるため)。
 * バージョンは固定して読み込む — 上げるときはこの1ファイルの数字を変えるだけでよい。
 */
const SDK_VERSION = '12.4.0';
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const { initializeApp } = await import(`${CDN}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} = await import(`${CDN}/firebase-auth.js`);
const {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, collection, addDoc, setDoc, updateDoc, onSnapshot, serverTimestamp,
  query, where, orderBy, waitForPendingWrites, increment
} = await import(`${CDN}/firebase-firestore.js`);
const {
  getStorage, ref, uploadBytesResumable, getDownloadURL
} = await import(`${CDN}/firebase-storage.js`);

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

const storage = getStorage(app);

export {
  cfg, app, auth, db, storage,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  doc, getDoc, collection, addDoc, setDoc, updateDoc, onSnapshot, serverTimestamp,
  query, where, orderBy, waitForPendingWrites, increment,
  ref, uploadBytesResumable, getDownloadURL
};
