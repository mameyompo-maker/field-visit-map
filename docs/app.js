/* field_visit_map — 画面遷移のエントリポイント。
 *
 * 起動の順番が重要:
 *   地図(Google Maps API)はオンラインでないと読めない。一方、記録そのものは
 *   オフラインでもできなければならない。そこで「データの購読・同期・検索」を先に
 *   立ち上げ、地図は最後に、失敗しても他を巻き込まない形で読み込む。
 */
import { onAuthChange, signInWithGoogle, signOutUser, currentUser, recheckAllowed } from './lib/auth.js';
import { listenPins, createPin } from './lib/pins.js';
import { createMapController } from './lib/map.js';
import { mountStatusBar } from './lib/sync-status.js';
import { startAutoSync } from './lib/offline-queue.js';
import { openPinPanel, refreshPinData, closePinPanel, setPinPanelHandlers } from './ui/pin-panel.js';
import { openPinForm } from './ui/pin-form.js';
import { openVisitForm } from './ui/visit-form.js';
import {
  openPhotoImport, isPhotoImportOpen, setPhotoLocation, closePhotoImport
} from './ui/photo-import.js';
import { mountPinList, setPins, openPinList, closePinList } from './ui/pin-list.js';
import { openExportDialog } from './ui/export-dialog.js';
import { toast, errorToast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);
const screens = ['screenLogin', 'screenNotAllowed', 'screenError', 'screenLoading', 'screenMap'];
function showScreen(id) {
  screens.forEach((s) => { $(s).hidden = (s !== id); });
}

let mapController = null;
let latestPins = [];
let started = false;
let pendingOpenPinId = null;
let tempLatLng = null;   // 地図を押して置いた仮ピンの位置
/* 写真から記録する流れで、ピンができるまで持ち越す写真。
 * ピンが一覧に現れるのは onSnapshot が返ってからなので、その場では記録できない。 */
let pendingPhotos = null;

// ------------------------------------------------------------------ 地図

function focusPin(pin, { openPanel = true } = {}) {
  if (mapController) mapController.centerOn({ lat: pin.lat, lng: pin.lng }, 17);
  if (openPanel) openPinPanel(pin);
}

async function startMap() {
  $('mapFallback').hidden = true;
  try {
    mapController = await createMapController($('map'), {
      onPinClick: (pinId) => {
        const pin = latestPins.find((p) => p.id === pinId);
        if (!pin) return;
        // 写真シートを開いている間は、候補の選択と食い違わないよう詳細を開かない。
        if (isPhotoImportOpen()) { setPhotoLocation({ lat: pin.lat, lng: pin.lng }); return; }
        // 写真の置き場所を探している最中に既存のピンを押したら、そこに記録する
        // (写真を黙って捨てない。利用者の操作としては「ここだ」と指したのと同じ)。
        const carried = pendingPhotos;
        pendingPhotos = null;
        hidePlaceSheet();
        closePinList();
        openPinPanel(pin);
        if (carried) openVisitForm(pin.id, carried);
      },
      onMapClick: (latLng) => {
        // 写真の場所を探している最中は、地図を押す = その場所に写真の位置を移す。
        if (isPhotoImportOpen()) {
          setPhotoLocation(latLng);
          mapController.setTempPin(latLng, (moved) => setPhotoLocation(moved));
          return;
        }
        showPlaceSheet(latLng);
      }
    });
    mapController.render(latestPins);
    mapController.whenTilesFail(12000, () => {
      toast('地図を表示できていません。通信状況か地図の設定を確認してください', 6000);
    });
    // 起動時は現在地から始める(Google マップと同じ振る舞い)。
    const ok = await mapController.locate();
    if (!ok) toast('現在地を取得できませんでした。位置情報の許可を確認してください');
  } catch (err) {
    mapController = null;
    $('mapFallback').hidden = false;
  }
}

// ------------------------------------------------------------------ ピン追加

/* 地図を押した場所に仮ピンを置き、下からシートを出す(Google マップと同じ流れ)。
 * 押した瞬間にフォームを開かないのは、地図を動かすたびにダイアログが出る誤操作を
 * 避けるため。仮ピンはドラッグで微調整でき、「やめる」でいつでも取り消せる。 */
function showPlaceSheet(latLng) {
  tempLatLng = latLng;
  closePinPanel();
  closePinList();
  closeAccountMenu();
  if (mapController) {
    mapController.setTempPin(latLng, (moved) => {
      tempLatLng = moved;
      $('placeSheetLatLng').textContent = `${moved.lat.toFixed(6)}, ${moved.lng.toFixed(6)}`;
    });
  }
  $('placeSheetLatLng').textContent = `${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`;
  $('placeSheet').hidden = false;
  // シートを出してから、その高さぶん隠れていないか確かめる(出す前だと高さが0)。
  if (mapController) mapController.keepVisible(latLng, $('placeSheet').offsetHeight);
}

function hidePlaceSheet() {
  $('placeSheet').hidden = true;
  if (mapController) mapController.clearTempPin();
  tempLatLng = null;
}

/* 「やめる」で抜けるときだけ、持ち越していた写真も捨てる。
 * hidePlaceSheet() 自体で捨ててはいけない — 「ここに場所を追加」でも呼ばれるため、
 * 一緒にすると写真から作った場所に写真が付かなくなる。 */
function cancelPlaceSheet() {
  hidePlaceSheet();
  pendingPhotos = null;
}

function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
    );
  });
}

async function addPinAt(latLng) {
  const result = await openPinForm(latLng);
  if (!result) { pendingPhotos = null; return; }
  try {
    // 追加したらそのまま訪問を記録する流れが多いので、詳細シートを開いてやる。
    // ただしピンが一覧に現れるのは onSnapshot が返ってから(同じ処理の中ではない)
    // なので、IDだけ控えて購読側で開く。
    pendingOpenPinId = createPin({ ...result, ...latLng });
    toast('場所を追加しました');
  } catch (err) {
    errorToast('場所を追加できませんでした', err);
  }
}

async function beginAddPin() {
  // ＋ボタンは「画面の中心に置く」。地図を押して置く操作と同じシートに合流させる。
  if (mapController) { showPlaceSheet(mapController.getCenter()); return; }
  // 地図が無いとき(圏外など)は現在地に置く道を用意する。
  toast('現在地を取得しています…');
  const pos = await currentPosition();
  if (!pos) { toast('現在地を取得できませんでした。地図が使える場所で追加してください'); return; }
  addPinAt(pos);
}

// ------------------------------------------------------------------ 写真から記録する

/* 写真を選んだら、EXIFの撮影地点を読んだ時点で地図をそこへ動かし、青いピンを立てる。
 * 座標の数字だけ見せて「ここですか?」と聞いても答えようがないため、
 * まず地図の上に出す。ピンはドラッグで動かせ、地図を押しても動かせる
 * (GPSは数十m単位でずれることがあり、直せないと使い物にならない)。 */
async function startPhotoImport(files) {
  if (!files.length) return;
  hidePlaceSheet();
  closePinPanel();
  closePinList();

  const result = await openPhotoImport(files, latestPins, {
    onLocated: (latLng) => {
      if (!mapController) return;
      mapController.centerOn(latLng, 17);
      mapController.setTempPin(latLng, (moved) => setPhotoLocation(moved));
      mapController.keepVisible(latLng, $('photoSheet').offsetHeight);
    },
    onHighlight: (latLng, pin) => {
      if (!mapController) return;
      const bottom = $('photoSheet').offsetHeight;
      // 候補を選んだら、撮影地点とその場所の両方が入るように地図を合わせる。
      mapController.fitPoints(
        pin ? [latLng, { lat: pin.lat, lng: pin.lng }] : [latLng],
        bottom
      );
    },
    onDone: () => { if (mapController) mapController.clearTempPin(); }
  });
  if (!result) return;

  if (result.action === 'existing') {
    const pin = latestPins.find((p) => p.id === result.pinId);
    if (pin) focusPin(pin, { openPanel: true });
    openVisitForm(result.pinId, { files: result.files, takenAt: result.takenAt });
    return;
  }

  if (result.action === 'new') {
    pendingPhotos = { files: result.files, takenAt: result.takenAt };
    if (mapController) mapController.centerOn(result.latLng, 17);
    addPinAt(result.latLng);
    return;
  }

  // 位置が読めなかったので、地図で指してもらう。
  pendingPhotos = { files: result.files, takenAt: result.takenAt };
  if (!mapController) {
    toast('地図を表示できないため、場所を指定できません。通信できる場所でお試しください', 6000);
    pendingPhotos = null;
    return;
  }
  toast('写真を撮った場所を地図で押してください', 5000);
  showPlaceSheet(mapController.getCenter());
}

// ------------------------------------------------------------------ アカウントメニュー

function closeAccountMenu() { $('accountMenu').hidden = true; }

// ------------------------------------------------------------------ 起動

function wireMapScreen() {
  $('btnAddPin').addEventListener('click', beginAddPin);
  $('btnCancelPlace').addEventListener('click', cancelPlaceSheet);
  $('btnAddHere').addEventListener('click', () => {
    const latLng = tempLatLng;
    hidePlaceSheet();
    if (latLng) addPinAt(latLng);
  });

  $('btnLocate').addEventListener('click', async () => {
    if (!mapController) { toast('地図を表示できていません'); return; }
    const ok = await mapController.locate();
    if (!ok) toast('現在地を取得できませんでした(位置情報の許可を確認してください)');
  });

  $('btnAccount').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('accountMenu');
    menu.hidden = !menu.hidden;
    if (!menu.hidden) closePinList();
  });

  $('inpPhotoImport').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    // 同じ写真をもう一度選べるように毎回空にする(空にしないと change が飛ばない端末がある)。
    e.target.value = '';
    startPhotoImport(files);
  });

  $('btnExport').addEventListener('click', () => {
    closeAccountMenu();
    openExportDialog();
  });

  $('btnOpenListFromFallback').addEventListener('click', openPinList);
  $('btnRetryMap').addEventListener('click', () => {
    toast('地図を読み込んでいます…');
    startMap();
  });

  // 地図やほかの場所をタップしたら、開いているメニュー・検索結果を閉じる。
  document.addEventListener('click', (e) => {
    if (!$('accountMenu').hidden && !$('accountMenu').contains(e.target)) closeAccountMenu();
    if (!$('searchPanel').hidden
      && !$('searchPanel').contains(e.target)
      && !$('searchBar').contains(e.target)) closePinList();
  });

  // 圏内に戻ったら地図を自動で読み直す(利用者が気づいて押す必要がないように)。
  window.addEventListener('online', () => { if (started && !mapController) startMap(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isPhotoImportOpen()) { closePhotoImport(); return; }
    if (!$('placeSheet').hidden) { cancelPlaceSheet(); return; }
    closeAccountMenu();
    closePinList();
    closePinPanel();
  });
}

function startApp() {
  if (started) return;
  started = true;

  mountStatusBar($('syncBar'), null);
  startAutoSync();

  mountPinList({
    onSelect: (pin) => {
      closePinList();
      $('inpSearch').blur();
      focusPin(pin);
    }
  });
  setPinPanelHandlers({
    onCenter: (pin) => {
      if (!mapController) { toast('地図を表示できていません'); return; }
      focusPin(pin, { openPanel: false });
    }
  });

  listenPins((pins) => {
    latestPins = pins;
    if (mapController) mapController.render(pins);
    setPins(pins);
    refreshPinData(pins);

    if (pendingOpenPinId) {
      const fresh = pins.find((p) => p.id === pendingOpenPinId);
      if (fresh) {
        pendingOpenPinId = null;
        if (pendingPhotos) {
          // 写真から作った場所は、そのまま記録まで進めてやる。
          const carried = pendingPhotos;
          pendingPhotos = null;
          openPinPanel(fresh);
          openVisitForm(fresh.id, carried);
        } else {
          openPinPanel(fresh);
        }
      }
    }
  });

  wireMapScreen();
  startMap();
}

// ------------------------------------------------------------------ 認証と画面出し分け

onAuthChange(({ user, state, error }) => {
  window.__fvmBooted = true;

  if (!user || state === 'signed-out') {
    closePinPanel();
    closePinList();
    showScreen('screenLogin');
    return;
  }
  if (state === 'checking') {
    showScreen('screenLoading');
    return;
  }
  if (state === 'denied') {
    $('notAllowedEmail').textContent = user.email;
    showScreen('screenNotAllowed');
    return;
  }
  if (state === 'error') {
    $('errorDetail').textContent = error || '';
    showScreen('screenError');
    return;
  }

  $('userName').textContent = user.displayName;
  $('userEmail').textContent = user.email;
  const photo = $('userPhoto');
  if (user.photoURL) {
    photo.src = user.photoURL;
    photo.hidden = false;
    $('userInitial').textContent = '';
  } else {
    photo.hidden = true;
    $('userInitial').textContent = (user.displayName || user.email || '?').trim().charAt(0).toUpperCase();
  }
  showScreen('screenMap');
  startApp();
});

$('btnSignIn').addEventListener('click', async () => {
  const errEl = $('loginError');
  errEl.hidden = true;
  try {
    await signInWithGoogle();
  } catch (err) {
    const code = (err && err.code) || '';
    errEl.hidden = false;
    if (code === 'auth/popup-blocked') {
      errEl.textContent = 'ログイン画面がブロックされました。ブラウザのポップアップを許可してからもう一度お試しください。';
    } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      errEl.hidden = true;
    } else {
      errEl.textContent = 'ログインできませんでした: ' + ((err && err.message) || err);
    }
  }
});
$('btnSignOut').addEventListener('click', () => signOutUser());
$('btnSignOutFromNotAllowed').addEventListener('click', () => signOutUser());
$('btnSignOutFromError').addEventListener('click', () => signOutUser());
$('btnRetryCheck').addEventListener('click', () => recheckAllowed());
$('btnRecheck').addEventListener('click', () => recheckAllowed());
$('btnCopyEmail').addEventListener('click', async () => {
  const email = currentUser()?.email || '';
  try {
    await navigator.clipboard.writeText(email);
    toast('コピーしました');
  } catch {
    toast('コピーできませんでした。手で控えてください');
  }
});
