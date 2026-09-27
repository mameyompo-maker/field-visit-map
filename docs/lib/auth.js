/* field_visit_map — Googleログインと許可リスト(allowedUsers)によるアクセス判定。
 *
 * 「誰が行ったか」は必ずこのモジュールが返す currentUser() から取る。ピン・訪問記録の
 * フォームに訪問者を手入力させる項目は絶対に作らない(要件どおり自動記録を徹底する)。
 *
 * ここでの許可リスト判定はUX用(画面の出し分け)でしかない。
 * 本当のガードは firestore.rules / storage.rules 側の isAllowed()。
 *
 * 状態(state)は必ず次のどれかで、「判定できない」を作らない:
 *   'signed-out' … 未ログイン
 *   'checking'   … 許可リスト照会中(この状態で止まり続けないよう必ずタイムアウトする)
 *   'allowed'    … 利用可
 *   'denied'     … 許可リストに載っていない
 *   'error'      … 照会に失敗し、過去に許可された記録も無い
 * 以前は 'error' を null(判定保留)にしていたせいで、画面が「読み込み中」のまま
 * 固まってログイン画面にも戻れない不具合を出した。状態を必ず確定させること。
 */
import {
  auth, db, doc, getDoc,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from './firebase-init.js';

const CHECK_TIMEOUT_MS = 10000;
const LS_PREFIX = 'fvm.allowed.';

let current = null;          // { uid, email, displayName, photoURL } | null
let state = 'signed-out';
let lastError = '';
let generation = 0;          // アカウント切替時に古い照会結果を捨てるための世代番号
const listeners = [];

function snapshot() {
  return { user: current, state, error: lastError };
}

function notify() {
  const s = snapshot();
  listeners.forEach((fn) => fn(s));
}

export function onAuthChange(fn) {
  listeners.push(fn);
  fn(snapshot());
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function currentUser() {
  return current;
}

export function isAllowed() {
  return state === 'allowed';
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  // 複数のGoogleアカウントを使い分けている端末で、意図しないアカウントに
  // 黙ってログインしてしまうのを防ぐ(巡回記録は「誰が行ったか」が要なので重要)。
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(auth, provider);
}

export async function signOutUser() {
  await signOut(auth);
}

// 一度許可されたことを端末に覚えておく。圏外で再起動したときに、照会できないことを
// 理由に締め出さないため(本当のガードはSecurity Rules側なので、ここは甘くてよい)。
function cachedAllowed(email) {
  try { return localStorage.getItem(LS_PREFIX + email) === '1'; } catch { return false; }
}
function rememberAllowed(email, ok) {
  try {
    if (ok) localStorage.setItem(LS_PREFIX + email, '1');
    else localStorage.removeItem(LS_PREFIX + email);
  } catch { /* プライベートモード等で書けなくても致命的ではない */ }
}

async function fetchAllowed(email) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('許可リストの確認がタイムアウトしました')), CHECK_TIMEOUT_MS);
  });
  const snap = await Promise.race([getDoc(doc(db, 'allowedUsers', email)), timeout]);
  return snap.exists() && snap.data().active !== false;
}

async function runCheck() {
  const my = ++generation;
  const email = current.email;
  state = 'checking';
  lastError = '';
  notify();

  let next;
  try {
    const ok = await fetchAllowed(email);
    rememberAllowed(email, ok);
    next = ok ? 'allowed' : 'denied';
  } catch (err) {
    if (cachedAllowed(email)) {
      next = 'allowed';
    } else {
      next = 'error';
      lastError = (err && err.message) || String(err);
    }
  }
  if (my !== generation) return;   // 照会中にログアウト/アカウント切替が起きていたら捨てる
  state = next;
  notify();
}

/** 「もう一度確認」ボタン用。 */
export function recheckAllowed() {
  if (!current) return Promise.resolve();
  return runCheck();
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    generation++;
    current = null;
    state = 'signed-out';
    lastError = '';
    notify();
    return;
  }
  current = {
    uid: user.uid,
    email: (user.email || '').toLowerCase(),
    displayName: user.displayName || user.email || '',
    photoURL: user.photoURL || ''
  };
  runCheck();
});
