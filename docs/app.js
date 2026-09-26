/* field_visit_map — 画面遷移のエントリポイント。 */
import { onAuthChange, signInWithGoogle, signOutUser, currentUser } from './lib/auth.js';
import { listenPins, createPin } from './lib/pins.js';
import { createMapController } from './lib/map.js';
import { mountStatusBar } from './lib/sync-status.js';
import { startAutoSync } from './lib/offline-queue.js';
import { openPinPanel, refreshPinData, closePinPanel } from './ui/pin-panel.js';
import { openPinForm } from './ui/pin-form.js';

const $ = (id) => document.getElementById(id);
const screens = ['screenLogin', 'screenNotAllowed', 'screenLoading', 'screenMap'];
function showScreen(id) {
  screens.forEach((s) => { $(s).hidden = (s !== id); });
}

let mapController = null;
let latestPins = [];
let unsubPins = null;

async function ensureMapStarted() {
  if (mapController) return;
  mapController = await createMapController($('map'), {
    onPinClick: (pinId) => {
      const pin = latestPins.find((p) => p.id === pinId);
      if (pin) openPinPanel(pin);
    },
    onMapClick: async (latLng) => {
      const result = await openPinForm(latLng);
      if (result) await createPin({ ...result, ...latLng });
    }
  });
  mountStatusBar($('syncBar'), $('btnSyncNow'));
  startAutoSync();

  unsubPins = listenPins((pins) => {
    latestPins = pins;
    mapController.render(pins);
    refreshPinData(pins);
  });

  $('btnAddPin').addEventListener('click', async () => {
    const center = mapController.map.getCenter();
    const latLng = { lat: center.lat(), lng: center.lng() };
    const result = await openPinForm(latLng);
    if (result) await createPin({ ...result, ...latLng });
  });
  $('btnLocate').addEventListener('click', () => mapController.tryUseCurrentLocation());
}

onAuthChange(({ user, allowed }) => {
  if (!user) {
    closePinPanel();
    showScreen('screenLogin');
    return;
  }
  if (allowed === null) {
    showScreen('screenLoading');
    return;
  }
  if (allowed === false) {
    $('notAllowedEmail').textContent = user.email;
    showScreen('screenNotAllowed');
    return;
  }
  $('userName').textContent = user.displayName;
  $('userPhoto').src = user.photoURL || '';
  showScreen('screenMap');
  ensureMapStarted();
});

$('btnSignIn').addEventListener('click', () => signInWithGoogle().catch((e) => alert(e.message)));
$('btnSignOut').addEventListener('click', () => signOutUser());
$('btnSignOutFromNotAllowed').addEventListener('click', () => signOutUser());
$('btnCopyEmail').addEventListener('click', () => {
  const email = currentUser()?.email || '';
  navigator.clipboard?.writeText(email).catch(() => {});
});
