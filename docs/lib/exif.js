/* field_visit_map — 写真から撮影地点と撮影日時を読む。
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
 * JPEG以外(HEIC/PNG/WebP)への対応:
 *   形式ごとに容器の構造は違うが、EXIFの中身はどれも「"Exif\0\0" + TIFFブロック」で
 *   同じ。容器を解釈するより、先頭部分から "Exif\0\0" を総当たりで探して、その直後が
 *   本物のTIFF(バイト順+0x002A)かどうかで判定するほうが短く、形式が増えても壊れない。
 *   iPhoneのHEICでは実際に先頭1KB以内にこの並びがある(実ファイルで確認済み)。
 *
 * ★ 位置情報が「入っているはずの写真」で読めないときの本当の原因(2026-09-28 調査)
 *   このパーサーの不足ではなく、ブラウザに渡る前にOSが消していることが大半:
 *     - Android 10以降、MediaStore は ACCESS_MEDIA_LOCATION を持たない読み手に対して
 *       GPSタグを取り除いて渡す。ブラウザはこの権限を持たないので、スマホから
 *       写真を選ぶと緯度経度だけが消える(Make/Model/撮影日時は残る)。
 *     - iOS Safari も写真ライブラリからのアップロードでEXIFを落とす。
 *   つまり「撮影日時は読めるのにGPSだけ無い」のが普通の状態。アプリ側では回避できない。
 *   → 呼び出し側は hasExif を見て理由を言い分け、位置は現在地で補う(photo-import.js)。
 *   PC(Windows/Mac)のブラウザからのアップロードでは消されないので、そちらは読める。
 */

/* EXIFは先頭付近にある(JPEGのAPP1は最大64KB、HEICも先頭のmetaボックスに入る)。
 * 写真全体を読み込むと10MB級のファイルで端末のメモリを無駄に使うので、
 * 先頭だけを切り出して調べる。 */
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

/** TIFFブロックを読んで {lat, lng, takenAt} を返す。TIFFでなければ null。 */
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

  const ifd0 = tiff + u32(tiff + 4);
  let gpsIfd = 0;
  let exifIfd = 0;
  walk(ifd0, (tag, type, count, value) => {
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
  // 0x0132 = DateTime(IFD0)。DateTimeOriginal が無い写真の控えとして使う。
  if (!takenAt) {
    walk(ifd0, (tag, type, count, value) => {
      if (tag === 0x0132 && !takenAt) takenAt = parseExifDate(ascii(view, value, Math.min(count, 20)));
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

/** ファイル形式を先頭バイトから見分ける。理由の言い分けと、表示できない形式の警告に使う。 */
function detectFormat(b) {
  if (b.length < 12) return 'unknown';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
  // ISO-BMFF: 先頭の box サイズのあとに "ftyp" が来る。銘柄(brand)で中身を判断する。
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return 'heic';
    if (/^(avif|avis)$/.test(brand)) return 'avif';
    return 'video';
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A)
    || (b[0] === 0x4D && b[1] === 0x4D && b[3] === 0x2A)) return 'tiff';
  return 'unknown';
}

/** ブラウザが画像として表示できない形式か。写真そのものが出せないので先に断る。 */
export function isUndisplayable(format) {
  return format === 'heic' || format === 'video';
}

/** JPEGのマーカーをたどって APP1(Exif) を見つける。 */
function walkJpeg(view) {
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) { offset += 1; continue; }      // 詰め物
    const marker = view.getUint8(offset + 1);
    // スタンドアロンマーカー(長さを持たない)
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { offset += 2; continue; }
    if (marker === 0xDA) break;                                         // 画像データの開始
    const size = view.getUint16(offset + 2);
    if (size < 2) break;
    if (marker === 0xE1 && offset + 10 <= view.byteLength
      && ascii(view, offset + 4, 4) === 'Exif') {
      const parsed = parseTiff(view, offset + 10);
      if (parsed) return parsed;
    }
    offset += 2 + size;
  }
  return null;
}

/**
 * 形式を問わず "Exif\0\0" を総当たりで探し、その直後をTIFFとして読む。
 * HEIC/PNG/WebP のほか、マーカーの並びが変則的なJPEGの受け皿にもなる。
 * parseTiff がバイト順と 0x002A を確かめるので、画像データ中の偶然の一致は弾かれる。
 */
function scanForExif(view, b) {
  for (let i = 0; i + 8 <= b.length; i++) {
    if (b[i] !== 0x45) continue;                                                // 'E'
    if (b[i + 1] !== 0x78 || b[i + 2] !== 0x69 || b[i + 3] !== 0x66) continue;  // 'xif'
    if (b[i + 4] !== 0x00 || b[i + 5] !== 0x00) continue;
    const parsed = parseTiff(view, i + 6);
    if (parsed) return parsed;
  }
  // 署名を持たず、先頭からTIFFが始まる形式(TIFF/DNG)。
  if (detectFormat(b) === 'tiff') return parseTiff(view, 0);
  return null;
}

/**
 * 写真1枚から撮影地点と撮影日時を読む。
 * @returns {Promise<{lat:number|null, lng:number|null, takenAt:number|null,
 *                    hasExif:boolean, format:string}>}
 *   hasExif は「EXIF自体は入っていた」か。位置が無い理由の言い分けに使う
 *   (EXIFごと無い=形式や加工の問題 / EXIFはあるがGPSだけ無い=OSが消した)。
 */
export async function readPhotoMeta(file) {
  const empty = { lat: null, lng: null, takenAt: null, hasExif: false, format: 'unknown' };
  if (!file) return empty;
  try {
    const buf = await file.slice(0, Math.min(file.size, HEAD_BYTES)).arrayBuffer();
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const format = detectFormat(bytes);

    let parsed = format === 'jpeg' ? walkJpeg(view) : null;
    if (!parsed) parsed = scanForExif(view, bytes);
    if (!parsed) return { ...empty, format };
    return { ...parsed, hasExif: true, format };
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
  let hasExif = false;
  const formats = new Set();
  /* ファイルの更新時刻。撮った直後に上げた写真かどうかの判断に使う。EXIFごと
   * 消されていても、これは必ず残るので最後の手がかりになる。 */
  let fileTime = null;

  for (const f of files) {
    const m = await readPhotoMeta(f);
    formats.add(m.format);
    if (m.hasExif) hasExif = true;
    if (m.lat !== null && m.lng !== null) {
      withGps += 1;
      if (lat === null) { lat = m.lat; lng = m.lng; }
    }
    if (m.takenAt && (takenAt === null || m.takenAt < takenAt)) takenAt = m.takenAt;
    const lm = Number(f.lastModified);
    if (Number.isFinite(lm) && lm > 0 && (fileTime === null || lm < fileTime)) fileTime = lm;
  }
  return { lat, lng, takenAt, withGps, total: files.length, hasExif, formats: [...formats], fileTime };
}
