/* field_visit_map — 写真(JPEG)から撮影地点と撮影日時を読む。
 *
 * 外部ライブラリを使わない理由は zip.js と同じ。CDNからもう1本読むと sw.js の
 * キャッシュ対象が増え、「圏外で写真からの登録だけ動かない」事故の種になる。
 * 必要なのは GPS と撮影日時だけなので、EXIFの全体を解釈する必要はない。
 *
 * 読み方の流れ:
 *   JPEG は 0xFFD8 で始まり、0xFFxx のマーカー区画が並ぶ。そのうち APP1(0xFFE1)で
 *   先頭が "Exif\0\0" のものがEXIF。その直後から TIFF 形式(バイト順・IFD)になる。
 *   IFD0 の中の「GPS IFDへのポインタ(0x8825)」と「Exif IFDへのポインタ(0x8769)」を
 *   たどり、GPS IFD から緯度経度、Exif IFD から撮影日時(0x9003)を取り出す。
 *
 * 限界(承知のうえ):
 *   - JPEGのみ。iPhoneのHEICをそのまま渡されると読めない(nullを返す)。
 *     ブラウザのファイル選択では多くの場合JPEGに変換されて渡ってくるが、
 *     読めなかった場合は「地図で場所を選ぶ」に倒す作りにしてある。
 *   - 端末やSNS経由の写真はGPSが削除されていることがある。これも同じく null。
 */

/* EXIFは先頭付近にある(APP1の最大長は64KB)。写真全体を読み込むと10MB級の
 * ファイルで端末のメモリを無駄に使うので、先頭だけを切り出して調べる。 */
const HEAD_BYTES = 2 * 1024 * 1024;

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function ascii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** TIFFブロックを読んで {lat, lng, takenAt} を返す。読めない項目は null。 */
function parseTiff(view, tiff) {
  if (tiff + 8 > view.byteLength) return null;
  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) return null;
  const le = byteOrder === 0x4949;
  const u16 = (o) => view.getUint16(o, le);
  const u32 = (o) => view.getUint32(o, le);
  if (u16(tiff + 2) !== 0x002A) return null;

  /** IFDの各項目を cb(tag, type, count, valueOffset) で渡す。 */
  function walk(ifd, cb) {
    if (ifd + 2 > view.byteLength) return;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > view.byteLength) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const bytes = (TYPE_SIZE[type] || 0) * count;
      // 4バイトに収まる値はその場に、収まらない値は「TIFF先頭からの位置」に入る。
      const value = bytes > 4 ? tiff + u32(e + 8) : e + 8;
      if (value >= 0 && value + Math.min(bytes, 4) <= view.byteLength) cb(tag, type, count, value);
    }
  }

  function rational(o) {
    if (o + 8 > view.byteLength) return null;
    const den = u32(o + 4);
    return den ? u32(o) / den : null;
  }

  /** 度・分・秒の3つのRATIONALを十進の度に直す。 */
  function dms(o, count) {
    if (count < 3 || o + 24 > view.byteLength) return null;
    const d = rational(o);
    const m = rational(o + 8);
    const s = rational(o + 16);
    if (d === null || m === null || s === null) return null;
    return d + m / 60 + s / 3600;
  }

  let gpsIfd = 0;
  let exifIfd = 0;
  walk(tiff + u32(tiff + 4), (tag, type, count, value) => {
    if (tag === 0x8825) gpsIfd = tiff + u32(value);
    if (tag === 0x8769) exifIfd = tiff + u32(value);
  });

  let lat = null;
  let lng = null;
  let latRef = 'N';
  let lngRef = 'E';
  if (gpsIfd) {
    walk(gpsIfd, (tag, type, count, value) => {
      if (tag === 1) latRef = ascii(view, value, Math.min(count, 2)) || 'N';
      if (tag === 2) lat = dms(value, count);
      if (tag === 3) lngRef = ascii(view, value, Math.min(count, 2)) || 'E';
      if (tag === 4) lng = dms(value, count);
    });
  }
  if (lat !== null && latRef.toUpperCase().startsWith('S')) lat = -lat;
  if (lng !== null && lngRef.toUpperCase().startsWith('W')) lng = -lng;

  let takenAt = null;
  if (exifIfd) {
    walk(exifIfd, (tag, type, count, value) => {
      // 0x9003 = DateTimeOriginal。"2026:09:24 14:32:10" 形式。
      if (tag === 0x9003 && !takenAt) takenAt = parseExifDate(ascii(view, value, Math.min(count, 20)));
    });
  }

  const valid = lat !== null && lng !== null
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    // 0,0 は「値が入っていない」写真で出てくる。大西洋のど真ん中を候補に
    // 出しても混乱させるだけなので、座標なしとして扱う。
    && !(lat === 0 && lng === 0);

  return { lat: valid ? lat : null, lng: valid ? lng : null, takenAt };
}

/** "2026:09:24 14:32:10" をミリ秒に直す。端末の時計基準(EXIFに時差情報は無い)。 */
function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 写真1枚から撮影地点と撮影日時を読む。
 * @returns {Promise<{lat:number|null, lng:number|null, takenAt:number|null}>}
 */
export async function readPhotoMeta(file) {
  const empty = { lat: null, lng: null, takenAt: null };
  if (!file) return empty;
  try {
    const buf = await file.slice(0, Math.min(file.size, HEAD_BYTES)).arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return empty;   // JPEGではない

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xFF) { offset += 1; continue; }         // 詰め物
      const marker = view.getUint8(offset + 1);
      // スタンドアロンマーカー(長さを持たない)
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { offset += 2; continue; }
      if (marker === 0xDA) break;                                            // 画像データの開始
      const size = view.getUint16(offset + 2);
      if (size < 2) break;
      if (marker === 0xE1 && offset + 10 <= view.byteLength
        && ascii(view, offset + 4, 4) === 'Exif') {
        const parsed = parseTiff(view, offset + 10);
        if (parsed) return parsed;
      }
      offset += 2 + size;
    }
    return empty;
  } catch {
    // 壊れた写真でも「場所なし」として先へ進めるようにする(例外で止めない)。
    return empty;
  }
}

/** 複数枚のうち、最初に位置が読めたものを採用する。日時は最も古いものを使う。 */
export async function readGroupMeta(files) {
  let lat = null;
  let lng = null;
  let takenAt = null;
  let withGps = 0;
  for (const f of files) {
    const m = await readPhotoMeta(f);
    if (m.lat !== null && m.lng !== null) {
      withGps += 1;
      if (lat === null) { lat = m.lat; lng = m.lng; }
    }
    if (m.takenAt && (takenAt === null || m.takenAt < takenAt)) takenAt = m.takenAt;
  }
  return { lat, lng, takenAt, withGps, total: files.length };
}
