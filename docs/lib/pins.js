/* field_visit_map — ピン・訪問記録・写真の読み書き(Firestore + Storage)。
 *
 * 要点:
 *   - createdBy/visitedBy は必ず currentUser() から書く(手入力させない)。
 *   - ピン・訪問メモ(テキスト)はFirestoreの persistentLocalCache に自動で乗る。
 *     onSnapshot の hasPendingWrites を集計して sync-status に流し込むだけでよい。
 *   - 写真だけは offline-queue.js のIndexedDBキュー経由でアップロードする
 *     (uploadBytes系はオフライン時の自動キューを持たないため)。
 *
 * ★ 書き込みの Promise を await しないこと。
 *   Firestoreの setDoc/updateDoc が返す Promise は「サーバーに届いたら」解決する。
 *   ローカル(キャッシュ)への反映と onSnapshot の発火はその前に完了しているのに、
 *   await すると圏外では永久に待たされ、画面が「保存中…」で固まる。
 *   保存の成否はステータスバーの未同期件数で見せる方針にしてある。
 */
import {
  db, storage, doc, collection, setDoc, updateDoc, onSnapshot, serverTimestamp,
  increment, ref, uploadBytesResumable, getDownloadURL
} from './firebase-init.js';
import { currentUser } from './auth.js';
import { prepareUpload } from './image.js';
import { enqueue, registerProcessor } from './offline-queue.js';
import { setTextPendingCount } from './sync-status.js';
import { errorToast } from '../ui/toast.js';

// ---------------------------------------------------- 未送信件数の集計

const pendingByListener = {};
function reportPending(key, count) {
  pendingByListener[key] = count;
  const total = Object.values(pendingByListener).reduce((a, b) => a + b, 0);
  setTextPendingCount(total);
}
function clearPending(key) {
  delete pendingByListener[key];
  const total = Object.values(pendingByListener).reduce((a, b) => a + b, 0);
  setTextPendingCount(total);
}

// -------------------------------------------------------------- ピン

function whoAmI() {
  const u = currentUser();
  if (!u) throw new Error('ログインしていません');
  return { uid: u.uid, email: u.email, displayName: u.displayName };
}

/* 並べ替えを orderBy でサーバーに任せない理由:
 *   1. serverTimestamp() は同期されるまで null なので、圏外で作った記録が末尾に沈む。
 *   2. orderBy に指定したフィールドを「持たない」ドキュメントはクエリ結果から
 *      丸ごと除外される。フィールドを後から足した場合に古い記録が消えて見える。
 * 件数がたかだか数百なので、取得は素直に全件、並べ替えはクライアント側で行う。 */

export function listenPins(onChange) {
  const q = collection(db, 'pins');
  // includeMetadataChanges: true にしないと、ローカル書き込みがサーバーに届いた瞬間
  // (データ自体は変わらずhasPendingWritesだけがfalseになる)を拾えず、未同期バッジが
  // いつまでも消えないままになる。
  return onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    reportPending('pins', snap.docs.filter((d) => d.metadata.hasPendingWrites).length);
    const pins = snap.docs
      .map((d) => ({ id: d.id, ...d.data(), _pendingWrite: d.metadata.hasPendingWrites }))
      .filter((p) => !p.archived)
      .sort((a, b) => pinActivityTime(b) - pinActivityTime(a));
    onChange(pins);
  });
}

/** 新しいピンを作る。IDはクライアント側で採番されるので即座に返せる(オフラインでも同じ)。 */
export function createPin({ name, description, lat, lng, category }) {
  const who = whoAmI();
  const pinRef = doc(collection(db, 'pins'));
  setDoc(pinRef, {
    name: name || '',
    description: description || '',
    lat, lng,
    category: category || null,
    createdBy: who,
    createdAt: serverTimestamp(),
    // serverTimestamp() は同期されるまで null。圏外でも並べ替え・表示ができるよう
    // 端末側の時刻も一緒に持っておく(表示の当座しのぎ用で、正はサーバー側)。
    createdAtLocal: Date.now(),
    updatedAt: serverTimestamp(),
    lastVisitAt: null,
    lastVisitAtLocal: null,
    visitCount: 0,
    archived: false
  }).catch((e) => errorToast('ピンを保存できませんでした', e));
  return pinRef.id;
}

export function updatePin(pinId, patch) {
  updateDoc(doc(db, 'pins', pinId), { ...patch, updatedAt: serverTimestamp() })
    .catch((e) => errorToast('ピンを更新できませんでした', e));
}

export function archivePin(pinId) {
  updateDoc(doc(db, 'pins', pinId), { archived: true, updatedAt: serverTimestamp() })
    .catch((e) => errorToast('アーカイブできませんでした', e));
}

/** 一覧・並べ替え用。サーバー時刻が未同期なら端末時刻で代用する。 */
export function pinActivityTime(pin) {
  const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === 'number' ? v : 0));
  return Math.max(
    toMs(pin.lastVisitAt), toMs(pin.lastVisitAtLocal),
    toMs(pin.createdAt), toMs(pin.createdAtLocal)
  );
}

// -------------------------------------------------------------- 訪問記録

export function visitTime(visit) {
  if (visit.visitedAt && visit.visitedAt.toMillis) return visit.visitedAt.toMillis();
  return visit.visitedAtLocal || 0;
}

export function listenVisits(pinId, onChange) {
  const key = 'visits:' + pinId;
  const q = collection(db, 'pins', pinId, 'visits');
  const unsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    reportPending(key, snap.docs.filter((d) => d.metadata.hasPendingWrites).length);
    const visits = snap.docs
      .map((d) => ({ id: d.id, ...d.data(), _pendingWrite: d.metadata.hasPendingWrites }))
      .sort((a, b) => visitTime(b) - visitTime(a));
    onChange(visits);
  });
  // パネルを閉じて購読をやめたら、そのぶんの未同期件数も集計から外す
  // (放置すると「実は既に同期済みなのに件数だけ残る」状態になる)。
  return () => { unsub(); clearPending(key); };
}

/** 訪問を記録する。こちらもIDを即返すので、写真の添付は呼び出し側で後追いできる。 */
export function createVisit(pinId, { note }) {
  const who = whoAmI();
  const now = Date.now();
  const visitRef = doc(collection(db, 'pins', pinId, 'visits'));
  setDoc(visitRef, {
    visitedBy: who,
    visitedAt: serverTimestamp(),
    visitedAtLocal: now,
    note: note || '',
    photoCount: 0,
    createdAt: serverTimestamp()
  }).catch((e) => errorToast('訪問を記録できませんでした', e));

  // 一覧表示用の非正規化キャッシュ。件数はざっくりでよく、トランザクションにはしない
  // (「同じ記録を複数人が同時編集することはない」という業務前提はjatlogと同じ)。
  updateDoc(doc(db, 'pins', pinId), {
    lastVisitAt: serverTimestamp(),
    lastVisitAtLocal: now,
    visitCount: increment(1)
  }).catch(() => {});

  return visitRef.id;
}

// -------------------------------------------------------------- 写真

function storagePathFor(pinId, visitId, photoId, suffix) {
  return `photos/${pinId}/${visitId}/${photoId}${suffix}`;
}

/** 訪問記録に写真を1枚添付する。撮影/選択直後に呼ぶ想定。 */
export async function attachPhoto(pinId, visitId, file) {
  const who = whoAmI();
  const { full, thumb, width, height } = await prepareUpload(file);
  const photoRef = doc(collection(db, 'pins', pinId, 'visits', visitId, 'photos'));
  const photoId = photoRef.id;
  const storagePath = storagePathFor(pinId, visitId, photoId, '_full.jpg');
  const thumbStoragePath = thumb ? storagePathFor(pinId, visitId, photoId, '_thumb.jpg') : null;

  setDoc(photoRef, {
    storagePath,
    thumbStoragePath,
    width: width || null,
    height: height || null,
    sizeBytes: full.size || null,
    uploadedBy: who,
    uploadedAt: serverTimestamp(),
    uploadedAtLocal: Date.now(),
    uploadStatus: 'pending',
    fullURL: null,
    thumbURL: null
  }).catch((e) => errorToast('写真の情報を保存できませんでした', e));

  // アップロード待ちの実体はこちら。IndexedDBへの書き込みは即完了するので await してよい。
  await enqueue({
    pinId, visitId, photoId,
    storagePath, thumbStoragePath,
    blob: full,
    thumbBlob: thumb || full,
    mimeType: 'image/jpeg'
  });

  return photoId;
}

export function listenPhotos(pinId, visitId, onChange) {
  const q = collection(db, 'pins', pinId, 'visits', visitId, 'photos');
  return onSnapshot(q, (snap) => {
    const photos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.uploadedAtLocal || 0) - (b.uploadedAtLocal || 0));
    onChange(photos);
  });
}

// ---------------------------------------------- 写真キューの実処理(offline-queue.js から呼ばれる)

registerProcessor(async (item) => {
  // uploadBytesResumable の UploadTask は thenable(Promise<UploadTaskSnapshot>を実装)
  // なので await できる。resumable にしているのは、電波が弱い現場での中断・再開に強いため。
  const fullRef = ref(storage, item.storagePath);
  await uploadBytesResumable(fullRef, item.blob, { contentType: item.mimeType });
  const fullURL = await getDownloadURL(fullRef);

  let thumbURL = null;
  if (item.thumbBlob && item.thumbStoragePath) {
    const thumbRef = ref(storage, item.thumbStoragePath);
    await uploadBytesResumable(thumbRef, item.thumbBlob, { contentType: 'image/jpeg' });
    thumbURL = await getDownloadURL(thumbRef);
  }

  // ここは await してよい。アップロードが通った=オンラインなので待たされない。
  await updateDoc(doc(db, 'pins', item.pinId, 'visits', item.visitId, 'photos', item.photoId), {
    uploadStatus: 'synced',
    fullURL,
    thumbURL: thumbURL || fullURL
  });
});
