/* field_visit_map — 画面遷移のエントリポイント。
 *
 * 起動の順番が重要:
 *   地図(Google Maps API)はオンラインでないと読めない。一方、記録そのものは
 *   オフラインでもできなければならない。そこで「データの購読・同期・一覧」を先に
 *   立ち上げ、地図は最後に、失敗しても他を巻き込まない形で読み込む。
 *   以前は地図を最初に await していたため、圏外だと同期も一覧も動かなかった。
 */
import { onAuthChange, signInWithGoogle, signOutUser, currentUser, recheckAllowed } from './lib/auth.js';
import { listenPins, createPin } from './lib/pins.js';
import { createMapController } from './lib/map.js';
import { mountStatusBar } from './lib/sync-status.js';
import { startAutoSync } from './lib/offline-queue.js';
import { openPinPanel, refreshPinData, closePinPanel, setPinPanelHandlers } from './ui/pin-panel.js';
import { openPinForm } from './ui/pin-form.js';
import { mountPinList, setPins, openPinList, closePinList, togglePinList } from './ui/pin-list.js';
import { toast, errorToast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);
const screens = ['screenLogin', 'screenNotAllowed', 'screenError', 'screenLoading', 'screenMap'];
function showScreen(id) {
  screens.forEach((s) => { $(s).hidden = (s !== id); });
}

let mapController = null;
let latestPins = [];
let started = false;
let placing = false;
let pendingOpenPinId = null;

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
        if (pin) openPinPanel(pin);
      }
    });
    mapController.render(latestPins);
  } catch (err) {
    mapController = null;
    $('mapFallback').hidden = false;
  }
}

// ------------------------------------------------------------------ ピン追加

function setPlacing(on) {
  placing = on;
  $('crosshair').hidden = !on;
  $('placeBar').hidden = !on;
  $('mapControls').hidden = on;
  if (on) { closePinPanel(); closePinList(); }
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
  if (!result) return;
  try {
    // 追加したらそのまま訪問を記録する流れが多いので、詳細パネルを開いてやる。
    // ただしピンが一覧に現れるのは onSnapshot が返ってから(同じ処理の中ではない)
    // なので、IDだけ控えて購読側で開く。
    pendingOpenPinId = createPin({ ...result, ...latLng });
    toast('ピンを追加しました');
  } catch (err) {
    errorToast('ピンを追加できませんでした', err);
  }
}

async function beginAddPin() {
  if (mapController) { setPlacing(true); return; }
  // 地図が無いとき(圏外など)は現在地に置く道を用意する。
  toast('現在地を取得しています…');
  const pos = await currentPosition();
  if (!pos) { toast('現在地を取得できませんでした。地図が使える場所で追加してください'); return; }
  addPinAt(pos);
}

// ------------------------------------------------------------------ 起動

function wireMapScreen() {
  $('btnAddPin').addEventListener('click', beginAddPin);
  $('btnPlaceCancel').addEventListener('click', () => setPlacing(false));
  $('btnPlaceConfirm').addEventListener('click', () => {
    if (!mapController) return;
    const latLng = mapController.getCenter();
    setPlacing(false);
    addPinAt(latLng);
  });

  $('btnLocate').addEventListener('click', async () => {
    if (!mapController) { toast('地図を表示できていません'); return; }
    const ok = await mapController.tryUseCurrentLocation();
    if (!ok) toast('現在地を取得できませんでした(位置情報の許可を確認してください)');
  });

  $('btnList').addEventListener('click', togglePinList);
  $('btnOpenListFromFallback').addEventListener('click', openPinList);
  $('btnRetryMap').addEventListener('click', () => {
    toast('地図を読み込んでいます…');
    startMap();
  });

  // 圏内に戻ったら地図を自動で読み直す(利用者が気づいて押す必要がないように)。
  window.addEventListener('online', () => { if (started && !mapController) startMap(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (placing) { setPlacing(false); return; }
    closePinList();
    closePinPanel();
  });
}

function startApp() {
  if (started) return;
  started = true;

  mountStatusBar($('syncBar'), $('btnSyncNow'));
  startAutoSync();

  mountPinList({
    onSelect: (pin) => { closePinList(); focusPin(pin); }
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
      if (fresh) { pendingOpenPinId = null; openPinPanel(fresh); }
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
  const photo = $('userPhoto');
  photo.hidden = !user.photoURL;
  if (user.photoURL) photo.src = user.photoURL;
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
