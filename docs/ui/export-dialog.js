/* field_visit_map — データの書き出し画面(#dlgExport)。
 *
 * 開いた時点で全件を数える(collectAll)。件数が分からないまま「ダウンロード」を
 * 押させると、写真が数百枚あったときに何分待たされるのか予想できないため。
 * 数えた結果はそのまま書き出しに使い回すので、二度読みにはならない。
 *
 * 圏外のときは写真の実体が取れない。黙って欠けると気づけないので、
 * 事前に断ったうえで、取れなかったぶんはZIPの中に一覧として同梱する。
 */
import {
  collectAll, downloadKml, downloadTextPack, downloadFullPack
} from '../lib/export.js';
import { toast, errorToast } from './toast.js';

const $ = (id) => document.getElementById(id);

let data = null;      // collectAll の結果(開くたびに取り直す)
let busy = false;

function setBusy(on) {
  busy = on;
  ['btnExportAll', 'btnExportKml', 'btnExportText', 'btnExportFull'].forEach((id) => { $(id).disabled = on; });
}

function showProgress(on) {
  $('exportProgress').hidden = !on;
  if (!on) { $('exportBar').style.width = '0%'; $('exportStatus').textContent = ''; }
}

function onProgress({ text, done, total }) {
  $('exportStatus').textContent = text;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('exportBar').style.width = `${Math.min(100, pct)}%`;
}

function describe(counts) {
  return `場所 ${counts.pins} 件 ・ 記録 ${counts.visits} 件 ・ 写真 ${counts.photos} 枚`;
}

async function ensureData() {
  if (data) return data;
  showProgress(true);
  data = await collectAll(onProgress);
  showProgress(false);
  $('exportSummary').textContent = describe(data.counts);
  return data;
}

async function run(job) {
  if (busy) return;
  setBusy(true);
  try {
    await job(await ensureData());
  } catch (err) {
    errorToast('書き出せませんでした', err);
  } finally {
    setBusy(false);
    showProgress(false);
  }
}

export async function openExportDialog() {
  data = null;                       // 前回の内容を出さないよう、毎回読み直す
  $('exportSummary').textContent = '数えています…';
  $('exportNote').textContent = navigator.onLine
    ? ''
    : '今はオフラインです。テキストは書き出せますが、送信済みの写真は取り出せません。';
  showProgress(false);
  setBusy(true);
  $('dlgExport').showModal();

  try {
    await ensureData();
  } catch (err) {
    $('exportSummary').textContent = '読み込めませんでした';
    errorToast('データを読み込めませんでした', err);
  } finally {
    setBusy(false);
  }
}

$('btnCloseExport')?.addEventListener('click', () => $('dlgExport').close());

/* 「写真つき一式」の中には地図.kmlも既に入っているので、内容として欠けはない。
 * それでも地図(KML)を単独でも出すのは、マイマップに直接読み込めるのはKML単体
 * ファイルだけだから(ZIPのままでは読み込めない)。だから「すべて」は
 * 「KML単体 + 写真つき一式ZIP」の2ファイルを指す。 */
$('btnExportAll')?.addEventListener('click', () => run(async (d) => {
  downloadKml(d);
  showProgress(true);
  const { failed } = await downloadFullPack(d, onProgress);
  if (failed) {
    toast(`保存しました。ただし写真 ${failed} 枚は取り出せませんでした(ZIP内の説明を参照)`, 7000);
  } else {
    toast('地図(KML)と写真つき一式(ZIP)を保存しました');
  }
}));

$('btnExportKml')?.addEventListener('click', () => run((d) => {
  downloadKml(d);
  toast('地図(KML)を保存しました');
}));

$('btnExportText')?.addEventListener('click', () => run(async (d) => {
  showProgress(true);
  onProgress({ text: 'ZIPを作っています…', done: 1, total: 1 });
  await downloadTextPack(d);
  toast('記録テキストを保存しました');
}));

$('btnExportFull')?.addEventListener('click', () => run(async (d) => {
  showProgress(true);
  const { failed } = await downloadFullPack(d, onProgress);
  if (failed) {
    toast(`保存しました。ただし写真 ${failed} 枚は取り出せませんでした(ZIP内の説明を参照)`, 7000);
  } else {
    toast('写真つき一式を保存しました');
  }
}));
