/* field_visit_map — 記録の書き出し(ダウンロード)。
 *
 * 狙い: このアプリを「データの置き場」で終わらせず、他の道具(Excel、Google
 * マイマップ、生成AIへの読み込みなど)へ持ち出せるようにする。そのため、
 * 同じ中身を用途別に3つの形で出す:
 *
 *   1. 地図        … KML。Google マイマップにそのまま読み込める。
 *   2. 記録テキスト … CSV(Excel用)・Markdown(読む/AIに渡す用)・JSON(プログラム用)。
 *   3. 写真つき一式 … 上記すべて + 写真の実体をZIPに詰めたもの。
 *
 * 1と2・3を分けているのは、地図に要るのは位置と名前だけで、写真や備考まで
 * 入れるとマイマップ側が重くなるため。用途が違うものは別のファイルにする。
 *
 * 取得について:
 *   Firestoreの getDocs は既定で「サーバーに聞き、届かなければ端末のキャッシュ」
 *   という順に動く。したがって圏外でもテキストは書き出せる。写真の実体だけは
 *   ネットワークが要る(未送信の写真は端末のキューから拾うので、それは圏外でも出せる)。
 */
import { db, collection, getDocs } from './firebase-init.js';
import { pinActivityTime, visitTime } from './pins.js';
import { pendingBlobsByPhotoId } from './offline-queue.js';
import { createZip } from './zip.js';

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 小道具

function toMs(v) {
  if (!v) return 0;
  if (v.toMillis) return v.toMillis();
  return typeof v === 'number' ? v : 0;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** 2026-09-27 15:04 形式。表計算でもそのまま日時として読める並び。 */
export function fmtStamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtFileStamp(ms) {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/* Windowsのファイル名に使えない文字を落とす。長い名前はパス全体が260文字の
 * 制限に当たって展開できなくなることがあるので、短く切る。 */
function safeName(s, max = 40) {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || '名前なし').slice(0, max);
}

/* CSVの決まりごと: 値に , " 改行 が含まれるときは " で囲み、中の " は "" にする。
 * ここを手抜きすると、備考に改行を書いた記録で表がずれる。 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRows(rows) {
  // 先頭のBOMは、Excelが「UTF-8である」と判断するための目印。
  // これが無いと日本語版のExcelがcp932と誤認して文字化けする。
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- データ収集

/**
 * ピン → 記録 → 写真 を一括で読む。件数ぶん往復するので、進み具合を onProgress で返す。
 * @returns {{pins: Array, counts: {pins:number, visits:number, photos:number}}}
 */
export async function collectAll(onProgress) {
  const report = (text, done, total) => { if (onProgress) onProgress({ text, done, total }); };

  report('場所を読んでいます…', 0, 1);
  const pinSnap = await getDocs(collection(db, 'pins'));
  const pins = pinSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => pinActivityTime(b) - pinActivityTime(a));

  let visitTotal = 0;
  let photoTotal = 0;

  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    report(`記録を読んでいます… (${i + 1}/${pins.length})`, i + 1, pins.length);
    const vSnap = await getDocs(collection(db, 'pins', pin.id, 'visits'));
    pin.visits = vSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => visitTime(b) - visitTime(a));
    visitTotal += pin.visits.length;

    for (const visit of pin.visits) {
      const pSnap = await getDocs(collection(db, 'pins', pin.id, 'visits', visit.id, 'photos'));
      visit.photos = pSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.uploadedAtLocal || 0) - (b.uploadedAtLocal || 0));
      photoTotal += visit.photos.length;
    }
  }

  return { pins, counts: { pins: pins.length, visits: visitTotal, photos: photoTotal } };
}

/* 写真のZIP内でのパス。records.csv の「写真ファイル」列に同じ名前を書いて、
 * 「表の行」と「写真の実体」を突き合わせられるようにしている。 */
function photoPath(pin, pinIndex, visit, n) {
  const folder = `${pad(pinIndex + 1)}_${safeName(pin.name)}`;
  return `photos/${folder}/${fmtFileStamp(visitTime(visit))}_${pad(n)}.jpg`;
}

function photoNamesFor(pin, pinIndex, visit) {
  return (visit.photos || []).map((ph, i) => photoPath(pin, pinIndex, visit, i + 1));
}

/** 「前回から何日」。visits は新しい順なので、1つ後ろの要素が前回にあたる。 */
function gapDays(visits, i) {
  const prev = visits[i + 1];
  if (!prev) return null;
  return Math.max(0, Math.round((visitTime(visits[i]) - visitTime(prev)) / DAY));
}

// ---------------------------------------------------------------- 書き出す形

export function buildKml(data) {
  const items = data.pins.filter((p) => !p.archived).map((pin) => {
    const last = toMs(pin.lastVisitAt) || toMs(pin.lastVisitAtLocal);
    // マイマップでは説明欄がそのまま吹き出しに出る。現場で知りたい順に並べる。
    const lines = [
      pin.category ? `分類: ${pin.category}` : '',
      `記録: ${pin.visitCount || 0} 件`,
      last ? `最終記録: ${fmtStamp(last)}` : '',
      pin.createdBy && pin.createdBy.displayName ? `登録者: ${pin.createdBy.displayName}` : '',
      pin.description ? `\n${pin.description}` : ''
    ].filter(Boolean).join('\n');
    return [
      '  <Placemark>',
      `    <name>${xmlEsc(pin.name || '(名前なし)')}</name>`,
      `    <description>${xmlEsc(lines)}</description>`,
      '    <styleUrl>#fvm</styleUrl>',
      `    <Point><coordinates>${pin.lng},${pin.lat},0</coordinates></Point>`,
      '  </Placemark>'
    ].join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `  <name>現場・圃場 巡回記録マップ ${today()}</name>`,
    '  <description>field_visit_map から書き出した巡回先の一覧です。</description>',
    '  <Style id="fvm">',
    '    <IconStyle>',
    '      <Icon><href>https://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon>',
    '    </IconStyle>',
    '  </Style>',
    items,
    '</Document>',
    '</kml>',
    ''
  ].join('\n');
}

export function buildGeoJson(data) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: data.pins.filter((p) => !p.archived).map((pin) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pin.lng, pin.lat] },
      properties: {
        id: pin.id,
        name: pin.name || '',
        category: pin.category || '',
        description: pin.description || '',
        visitCount: pin.visitCount || 0,
        createdBy: (pin.createdBy && pin.createdBy.displayName) || '',
        createdAt: fmtStamp(toMs(pin.createdAt) || toMs(pin.createdAtLocal)),
        lastVisitAt: fmtStamp(toMs(pin.lastVisitAt) || toMs(pin.lastVisitAtLocal))
      }
    }))
  }, null, 2);
}

export function buildPinsCsv(data) {
  const rows = [[
    'ID', '名前', '分類', '緯度', '経度', '説明',
    '登録者', '登録日時', '記録件数', '最終記録日時', 'アーカイブ'
  ]];
  data.pins.forEach((pin) => {
    rows.push([
      pin.id, pin.name || '', pin.category || '', pin.lat, pin.lng, pin.description || '',
      (pin.createdBy && pin.createdBy.displayName) || '',
      fmtStamp(toMs(pin.createdAt) || toMs(pin.createdAtLocal)),
      pin.visitCount || 0,
      fmtStamp(toMs(pin.lastVisitAt) || toMs(pin.lastVisitAtLocal)),
      pin.archived ? 'はい' : 'いいえ'
    ]);
  });
  return csvRows(rows);
}

export function buildRecordsCsv(data) {
  const rows = [[
    '場所', '分類', '緯度', '経度', '記録日時', '記録者', '前回からの日数',
    '備考', '写真枚数', '写真ファイル', '場所ID', '記録ID'
  ]];
  data.pins.forEach((pin, pinIndex) => {
    const visits = pin.visits || [];
    visits.forEach((visit, i) => {
      const gap = gapDays(visits, i);
      rows.push([
        pin.name || '', pin.category || '', pin.lat, pin.lng,
        fmtStamp(visitTime(visit)),
        (visit.visitedBy && visit.visitedBy.displayName) || '',
        gap === null ? '' : gap,
        visit.note || '',
        (visit.photos || []).length,
        photoNamesFor(pin, pinIndex, visit).join(' ; '),
        pin.id, visit.id
      ]);
    });
  });
  return csvRows(rows);
}

export function buildRecordsMarkdown(data) {
  const out = [`# 現場・圃場 巡回記録  (${fmtStamp(Date.now())} 時点)`, ''];
  out.push(`場所 ${data.counts.pins} 件 / 記録 ${data.counts.visits} 件 / 写真 ${data.counts.photos} 枚`, '');

  data.pins.forEach((pin, pinIndex) => {
    out.push(`## ${pin.name || '(名前なし)'}${pin.archived ? '(アーカイブ済み)' : ''}`, '');
    const head = [
      pin.category ? `分類: ${pin.category}` : '',
      `位置: ${pin.lat}, ${pin.lng}`,
      (pin.createdBy && pin.createdBy.displayName)
        ? `登録: ${pin.createdBy.displayName} / ${fmtStamp(toMs(pin.createdAt) || toMs(pin.createdAtLocal))}`
        : ''
    ].filter(Boolean);
    out.push(head.join(' ・ '), '');
    if (pin.description) out.push(pin.description, '');

    const visits = pin.visits || [];
    if (!visits.length) { out.push('記録はまだありません。', ''); return; }

    visits.forEach((visit, i) => {
      const gap = gapDays(visits, i);
      const gapText = gap === null ? '最初の記録' : `前回から ${gap} 日`;
      const who = (visit.visitedBy && visit.visitedBy.displayName) || '(記録者不明)';
      out.push(`### ${fmtStamp(visitTime(visit))} — ${who}(${gapText})`, '');
      if (visit.note) out.push(visit.note, '');
      const names = photoNamesFor(pin, pinIndex, visit);
      if (names.length) {
        out.push('写真:');
        names.forEach((n) => out.push(`- ${n}`));
        out.push('');
      }
    });
  });

  return out.join('\n');
}

export function buildJson(data) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    counts: data.counts,
    pins: data.pins.map((pin, pinIndex) => ({
      id: pin.id,
      name: pin.name || '',
      category: pin.category || '',
      description: pin.description || '',
      lat: pin.lat,
      lng: pin.lng,
      archived: !!pin.archived,
      createdBy: pin.createdBy || null,
      createdAt: fmtStamp(toMs(pin.createdAt) || toMs(pin.createdAtLocal)),
      lastVisitAt: fmtStamp(toMs(pin.lastVisitAt) || toMs(pin.lastVisitAtLocal)),
      visits: (pin.visits || []).map((visit, i) => ({
        id: visit.id,
        visitedAt: fmtStamp(visitTime(visit)),
        visitedBy: visit.visitedBy || null,
        gapDaysFromPrevious: gapDays(pin.visits, i),
        note: visit.note || '',
        photos: photoNamesFor(pin, pinIndex, visit)
      }))
    }))
  }, null, 2);
}

function buildReadme(data, withPhotos) {
  const lines = [
    '現場・圃場 巡回記録マップ — 書き出したデータ',
    `書き出し日時: ${fmtStamp(Date.now())}`,
    `場所 ${data.counts.pins} 件 / 記録 ${data.counts.visits} 件 / 写真 ${data.counts.photos} 枚`,
    '',
    '【ファイルの中身】',
    '  地図.kml     … Google マイマップに読み込める地図データ。',
    '  pins.csv     … 場所の一覧。Excelで開けます。',
    '  records.csv  … 記録(日時・記録者・備考・写真)の一覧。1行 = 1記録。',
    '  records.md   … 同じ内容を読みやすく並べたもの。生成AIに渡すならこれが向きます。',
    '  data.json    … 同じ内容の機械可読版。プログラムで加工するとき用。',
    '  map.geojson  … QGISなどの地図ソフト用。'
  ];
  if (withPhotos) {
    lines.push('  photos/      … 写真の実体。records.csv の「写真ファイル」列と同じ名前です。');
  }
  lines.push(
    '',
    '【Google マイマップへの読み込み方】',
    '  1. https://www.google.com/mymaps を開く',
    '  2.「新しい地図を作成」→ レイヤの「インポート」',
    '  3. 地図.kml を選ぶ',
    '',
    '【CSVが文字化けするとき】',
    '  UTF-8で保存してあります。Excelで開いて化ける場合は、Excelの',
    '  「データ」→「テキストまたはCSVから」で文字コードに UTF-8 を指定してください。',
    ''
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------- ダウンロード

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 即座に revoke するとダウンロードが始まる前にURLが死ぬ端末があるので、少し待つ。
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 1. 地図だけ(マイマップ用のKML)。 */
export function downloadKml(data) {
  download(
    new Blob([buildKml(data)], { type: 'application/vnd.google-earth.kml+xml' }),
    `巡回マップ_${today()}.kml`
  );
}

/** 2. 記録テキスト一式(写真は入れない)。 */
export async function downloadTextPack(data) {
  const zip = createZip();
  await zip.add('README.txt', buildReadme(data, false));
  await zip.add('地図.kml', buildKml(data));
  await zip.add('pins.csv', buildPinsCsv(data));
  await zip.add('records.csv', buildRecordsCsv(data));
  await zip.add('records.md', buildRecordsMarkdown(data));
  await zip.add('data.json', buildJson(data));
  await zip.add('map.geojson', buildGeoJson(data));
  download(zip.finish(), `巡回記録_${today()}.zip`);
}

/** 3. 写真も含めた一式。写真を1枚ずつ取りに行くので時間がかかる。 */
export async function downloadFullPack(data, onProgress) {
  const zip = createZip();
  await zip.add('README.txt', buildReadme(data, true));
  await zip.add('地図.kml', buildKml(data));
  await zip.add('pins.csv', buildPinsCsv(data));
  await zip.add('records.csv', buildRecordsCsv(data));
  await zip.add('records.md', buildRecordsMarkdown(data));
  await zip.add('data.json', buildJson(data));
  await zip.add('map.geojson', buildGeoJson(data));

  // まだ送信できていない写真は端末のキューに実体がある。圏外で撮った直後でも
  // 書き出せるよう、そちらも拾う。
  let pending = {};
  try { pending = await pendingBlobsByPhotoId(); } catch { pending = {}; }

  const failed = [];
  let done = 0;
  const total = data.counts.photos;

  for (let pinIndex = 0; pinIndex < data.pins.length; pinIndex++) {
    const pin = data.pins[pinIndex];
    for (const visit of (pin.visits || [])) {
      const photos = visit.photos || [];
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        const name = photoPath(pin, pinIndex, visit, i + 1);
        done++;
        if (onProgress) onProgress({ text: `写真を集めています… (${done}/${total})`, done, total });

        const local = pending[photo.id];
        if (local) { await zip.add(name, local); continue; }

        const url = photo.fullURL || photo.thumbURL;
        if (!url) { failed.push(`${name}(まだ送信されていません)`); continue; }
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await zip.add(name, await res.blob());
        } catch (err) {
          failed.push(`${name}(${(err && err.message) || err})`);
        }
      }
    }
  }

  if (failed.length) {
    // 黙って欠けるのがいちばん困る。何が入らなかったかを必ず同梱する。
    await zip.add('取得できなかった写真.txt', [
      '以下の写真はZIPに入れられませんでした。',
      '',
      ...failed,
      '',
      '圏外だったか、まだアップロードが終わっていない可能性があります。',
      '通信できる場所でアプリを開き、同期が終わってからもう一度お試しください。',
      ''
    ].join('\n'));
  }

  if (onProgress) onProgress({ text: 'ZIPを作っています…', done: total, total });
  download(zip.finish(), `巡回記録_写真つき_${today()}.zip`);
  return { failed: failed.length };
}
