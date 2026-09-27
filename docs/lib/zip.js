/* field_visit_map — 無圧縮(stored)ZIPの書き出し。
 *
 * 外部ライブラリを使わない理由:
 *   このアプリはビルド無し・CDN依存を最小にする方針で、オフラインでも動くことが
 *   要件。ZIP用のライブラリをもう1本CDNから読むと、sw.js のキャッシュ対象が増え、
 *   圏外で「ダウンロードだけ動かない」事故の種になる。ZIPの「無圧縮で詰めるだけ」は
 *   仕様が単純なので自前で書いたほうが確実。
 *
 * 圧縮しないのは、中身がほぼJPEG(圧縮済み)で、deflateしてもまず縮まないため。
 * 縮まない圧縮のために端末のCPUと待ち時間を使うのは割に合わない。
 *
 * 制約(承知のうえで割り切っている):
 *   - ZIP64非対応。合計4GB、1ファイル4GBを超えると壊れる。巡回記録の写真は
 *     長辺1600pxに縮小済み(image.js)で1枚200〜400KB程度なので、数千枚でも届かない。
 *   - ファイル名はUTF-8。汎用フラグのbit 11を立てているので、Windowsの
 *     エクスプローラでも日本語のフォルダ名が文字化けしない。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** ZIPはMS-DOS時代の日付形式(2秒刻み・1980年起点)を使う。 */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

export function createZip() {
  const parts = [];        // Blobの断片。ここに順に積んでいく
  const entries = [];      // 中央ディレクトリを作るための控え
  let offset = 0;
  const encoder = new TextEncoder();

  function push(u8) { parts.push(u8); offset += u8.length; }

  /**
   * @param {string} name  ZIP内のパス(`photos/圃場A/2026-09-24.jpg` のように / 区切り)
   * @param {Blob|Uint8Array|string} data
   */
  async function add(name, data) {
    let u8;
    if (typeof data === 'string') u8 = encoder.encode(data);
    else if (data instanceof Uint8Array) u8 = data;
    else u8 = new Uint8Array(await data.arrayBuffer());

    const nameBytes = encoder.encode(name);
    const crc = crc32(u8);
    const { time, date } = dosDateTime(new Date());

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);   // ローカルファイルヘッダ
    head.setUint16(4, 20, true);           // 展開に必要なバージョン(2.0)
    head.setUint16(6, 0x0800, true);       // bit11: ファイル名はUTF-8
    head.setUint16(8, 0, true);            // 圧縮方式 0 = 無圧縮
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, u8.length, true);   // 圧縮後サイズ(無圧縮なので同じ)
    head.setUint32(22, u8.length, true);
    head.setUint16(26, nameBytes.length, true);
    head.setUint16(28, 0, true);           // 拡張フィールドなし

    entries.push({ nameBytes, crc, size: u8.length, time, date, offset });
    push(new Uint8Array(head.buffer));
    push(nameBytes);
    // ここでBlobにしておくと、元のUint8Arrayを手放せる(大量の写真でメモリが
    // 膨らむのを避ける。Blobはブラウザがディスクに逃がしてくれる)。
    parts.push(new Blob([u8]));
    offset += u8.length;
  }

  function finish() {
    const cdStart = offset;
    for (const e of entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);    // 中央ディレクトリ
      c.setUint16(4, 20, true);            // 作成したバージョン
      c.setUint16(6, 20, true);            // 展開に必要なバージョン
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, e.time, true);
      c.setUint16(14, e.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true);
      c.setUint16(30, 0, true);            // 拡張フィールド
      c.setUint16(32, 0, true);            // コメント
      c.setUint16(34, 0, true);            // 分割ディスク番号
      c.setUint16(36, 0, true);            // 内部属性
      c.setUint32(38, 0, true);            // 外部属性
      c.setUint32(42, e.offset, true);
      push(new Uint8Array(c.buffer));
      push(e.nameBytes);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, offset - cdStart, true);
    end.setUint32(16, cdStart, true);
    end.setUint16(20, 0, true);
    push(new Uint8Array(end.buffer));

    return new Blob(parts, { type: 'application/zip' });
  }

  return { add, finish, get count() { return entries.length; } };
}
