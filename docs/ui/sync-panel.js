/* field_visit_map — アカウントメニューの同期状態と「今すぐ同期」。
 *
 * 画面上部のチップ(#syncBar)は全部片づくと消える作りなので、
 * 「今ちゃんと送れているのか」を確かめる場所が無かった。オフラインで使うアプリで
 * いちばん不安になるのはそこなので、いつでも開ける場所に常設する。
 *
 * 言えること・言えないことの線引き:
 *   - 「100% 同期されています」と言えるのは、Firestoreの未送信(hasPendingWrites)が0で、
 *     写真キューも空で、失敗も無く、オンラインのとき。このときだけ言う。
 *   - オフラインのときは「送れているか」を確かめる手段が無いので、
 *     送信済みだとは言わず「オフライン」と「端末に保存済み」だけを言う。
 *   - 「今すぐ同期」で確実に押し出せるのは写真キューのほう。Firestoreの書き込みは
 *     SDKが自分の判断で送るので、こちらから強制はできない(ボタンの説明もそう書く)。
 */
import { subscribe, syncNowAll } from '../lib/sync-status.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

/* 「最後に全部送り終えた時刻」。端末ごとの目安なので localStorage で十分
 * (共有する意味がなく、消えても困らない)。 */
const LAST_SYNC_KEY = 'fvm.lastSync';

function loadLastSync() {
  try {
    const v = Number(localStorage.getItem(LAST_SYNC_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

function saveLastSync(ms) {
  try { localStorage.setItem(LAST_SYNC_KEY, String(ms)); } catch { /* 使えなくても困らない */ }
}

function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return d.toLocaleString('ja-JP', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let lastSync = loadLastSync();

function setDot(kind) {
  $('syncDot').className = 'sync-dot ' + kind;
}

function describe(s) {
  const waiting = s.textPendingCount + s.photoPendingCount;

  if (s.offline) {
    setDot('offline');
    return waiting
      ? `オフライン ・ 未送信 ${waiting} 件(この端末に保存済み)`
      : 'オフライン ・ この端末に保存済み';
  }
  if (s.flushing) {
    setDot('busy');
    return waiting ? `同期中です… 残り ${waiting} 件` : '同期中です…';
  }
  if (s.photoErrorCount) {
    setDot('error');
    return `写真 ${s.photoErrorCount} 件を送れませんでした`;
  }
  if (waiting) {
    setDot('waiting');
    return `同期待ち ${waiting} 件`;
  }

  // ここだけが「全部送れている」と言い切れる状態。
  setDot('ok');
  if (!lastSync) { lastSync = Date.now(); saveLastSync(lastSync); }
  return `100% 同期されています(最終 ${fmtClock(lastSync)})`;
}

export function mountSyncPanel() {
  let previousWaiting = 0;
  let nothingPending = true;

  subscribe((s) => {
    const waiting = s.textPendingCount + s.photoPendingCount;
    // 「待ちがあった状態から、オンラインで待ち0になった」瞬間が同期の完了。
    // 起動直後にいきなり0だった場合まで「今同期した」と言わないようにする。
    if (previousWaiting > 0 && waiting === 0 && !s.offline && !s.photoErrorCount) {
      lastSync = Date.now();
      saveLastSync(lastSync);
    }
    previousWaiting = waiting;

    $('syncText').textContent = describe(s);
    /* 送るものが無くても押せるままにしておく。このボタンの役目は送ることだけでなく
     * 「本当に送れているか確かめる」ことでもあり、押せないと確かめようがない。
     * 同期中だけは二重に走らせないよう止める。 */
    $('btnSyncNow').disabled = s.flushing;
    $('syncNowLabel').textContent = s.flushing ? '同期中…' : '今すぐ同期する';
    nothingPending = !waiting && !s.photoErrorCount;
  });

  $('btnSyncNow').addEventListener('click', async () => {
    if (!navigator.onLine) {
      toast('オフラインです。電波が届く場所で自動的に送られます');
      return;
    }
    try {
      await syncNowAll();
      // 送るものが無かった場合も、押した手応えは返す(無反応だと壊れて見える)。
      if (nothingPending) toast('すべて送信済みです');
    } catch (err) {
      toast('同期できませんでした。電波の届く場所でもう一度お試しください', 5000);
    }
  });
}
