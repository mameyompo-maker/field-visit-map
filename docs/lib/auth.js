/* field_visit_map — Googleログインと許可リスト(allowedUsers)によるアクセス判定。
 *
 * 「誰が行ったか」は必ずこのモジュールが返す currentUser() から取る。ピン・訪問記録の
 * フォームに訪問者を手入力させる項目は絶対に作らない(要件どおり自動記録を徹底する)。
 *
 * ここでの許可リスト判定はUX用(「アクセス権がありません」の表示分岐)でしかない。
 * 本当のガードは firestore.rules / storage.rules 側の isAllowed()。
 */
import {
  auth, db, doc, getDoc,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from './firebase-init.js';

let current = null;   // { uid, email, displayName, photoURL } | null
let allowed = null;   // true / false / null(未確認)
const listeners = [];

function notify() {
  listeners.forEach((fn) => fn({ user: current, allowed }));
}

export function onAuthChange(fn) {
  listeners.push(fn);
  fn({ user: current, allowed });
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function currentUser() {
  return current;
}

export function isAllowed() {
  return allowed === true;
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

export async function signOutUser() {
  await signOut(auth);
}

async function checkAllowed(email) {
  try {
    const emailKey = email.trim().toLowerCase();
    const snap = await getDoc(doc(db, 'allowedUsers', emailKey));
    return snap.exists() && snap.data().active !== false;
  } catch {
    // オフライン・キャッシュ無しでも「未許可」に倒さず null(判定保留)にする。
    // 判定不能を「拒否」にすると、圏外で開いた瞬間に締め出されてしまうため。
    return null;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    current = null;
    allowed = null;
    notify();
    return;
  }
  current = {
    uid: user.uid,
    email: (user.email || '').toLowerCase(),
    displayName: user.displayName || user.email || '',
    photoURL: user.photoURL || ''
  };
  notify();

  const result = await checkAllowed(current.email);
  allowed = result;
  notify();
});
