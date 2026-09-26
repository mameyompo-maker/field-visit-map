/* field_visit_map — ピン・訪問記録・写真の読み書き(Firestore + Storage)。
 *
 * データ設計・オフライン方針は projects/field_visit_map の実装計画(plans内)を参照。
 * 要点:
 *   - createdBy/visitedBy は必ず currentUser() から書く(手入力させない)。
 *   - ピン・訪問メモ(テキスト)はFirestoreの persistentLocalCache に自動で乗る。
 *     onSnapshot の hasPendingWrites を集計して sync-status に流し込むだけでよい。
 *   - 写真だけは offline-queue.js のIndexedDBキュー経由でアップロードする
 *     (uploadBytes系はオフライン時の自動キューを持たないため)。
 */
import {
  db, storage, doc, collection, setDoc, updateDoc, onSnapshot, serverTimestamp,
  query, orderBy, increment, ref, uploadBytesResumable, getDownloadURL
} from './firebase-init.js';
import { currentUser } from './auth.js';
import { prepareUpload } from './image.js';
import { enqueue, registerProcessor } from './offline-queue.js';
import { setTextPendingCount } from './sync-status.js';

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

export function listenPins(onChange) {
  const q = query(collection(db, 'pins'), orderBy('createdAt', 'desc'));
  // includeMetadataChanges: true にしないと、ローカル書き込みがサーバーに届いた瞬間
  // (データ自体は変わらずhasPendingWritesだけがfalseになる)を拾えず、未同期バッジが
  // いつまでも消えないままになる。
  return onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    reportPending('pins', snap.docs.filter((d) => d.metadata.hasPendingWrites).length);
    const pins = snap.docs
      .map((d) => ({ id: d.id, ...d.data(), _pendingWrite: d.metadata.hasPendingWrites }))
      .filter((p) => !p.archived);
    onChange(pins);
  });
}

export async function createPin({ name, description, lat, lng, category }) {
  const who = whoAmI();
  const ref_ = doc(collection(db, 'pins'));
  await setDoc(ref_, {
    name: name || '',
    description: description || '',
    lat, lng,
    category: category || null,
    createdBy: who,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastVisitAt: null,
    visitCount: 0,
    archived: false
  });
  return ref_.id;
}

export async function updatePin(pinId, patch) {
  await updateDoc(doc(db, 'pins', pinId), { ...patch, updatedAt: serverTimestamp() });
}

export async function archivePin(pinId) {
  await updateDoc(doc(db, 'pins', pinId), { archived: true, updatedAt: serverTimestamp() });
}

// -------------------------------------------------------------- 訪問記録

export function listenVisits(pinId, onChange) {
  const key = 'visits:' + pinId;
  const q = query(collection(db, 'pins', pinId, 'visits'), orderBy('visitedAt', 'desc'));
  const unsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    reportPending(key, snap.docs.filter((d) => d.metadata.hasPendingWrites).length);
    onChange(snap.docs.map((d) => ({ id: d.id, ...d.data(), _pendingWrite: d.metadata.hasPendingWrites })));
  });
  // パネルを閉じて購読をやめたら、そのぶんの未同期件数も集計から外す
  // (放置すると「実は既に同期済みなのに件数だけ残る」状態になる)。
  return () => { unsub(); clearPending(key); };
}

export async function createVisit(pinId, { note }) {
  const who = whoAmI();
  const visitRef = doc(collection(db, 'pins', pinId, 'visits'));
  await setDoc(visitRef, {
    visitedBy: who,
    visitedAt: serverTimestamp(),
    note: note || '',
    photoCount: 0,
    createdAt: serverTimestamp()
  });
  // 一覧表示用の非正規化キャッシュ。件数はざっくりでよく、トランザクションにはしない
  // (「同じ記録を複数人が同時編集することはない」という業務前提はjatlogと同じ)。
  await updateDoc(doc(db, 'pins', pinId), {
    lastVisitAt: serverTimestamp(),
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

  await setDoc(photoRef, {
    storagePath,
    thumbStoragePath,
    width: width || null,
    height: height || null,
    sizeBytes: full.size || null,
    uploadedBy: who,
    uploadedAt: serverTimestamp(),
    uploadStatus: 'pending',
    fullURL: null,
    thumbURL: null
  });

  await enqueue({
    pinId, visitId, photoId,
    storagePath, thumbStoragePath,
    blob: full,
    thumbBlob: thumb,
    mimeType: 'image/jpeg'
  });

  return photoId;
}

export function listenPhotos(pinId, visitId, onChange) {
  const q = query(collection(db, 'pins', pinId, 'visits', visitId, 'photos'), orderBy('uploadedAt', 'asc'));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
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

  await updateDoc(doc(db, 'pins', item.pinId, 'visits', item.visitId, 'photos', item.photoId), {
    uploadStatus: 'synced',
    fullURL,
    thumbURL: thumbURL || fullURL
  });
});
