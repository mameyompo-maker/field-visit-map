/* field_visit_map — 写真の圧縮・サムネイル生成。
 *
 * C:\Users\kazdr\dev\my_clothes\src\lib\image.ts の prepareUpload() の移植(TSからJSへ)。
 * 「本体+サムネイルを1回のデコードで両方作る」設計そのまま: 撮影/選択した瞬間に
 * 呼び出し、メモを書いている間に圧縮を終わらせておく。
 */

async function renderToJpeg(bitmap, maxDimension, quality) {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * 本体(長辺1600px, q0.8)とサムネ(長辺480px, q0.7)を同時に作る。
 * 失敗しても投稿自体は止めず、元ファイルをそのまま本体として返す(サムネは無し)。
 */
export async function prepareUpload(file) {
  try {
    const bitmap = await createImageBitmap(file);
    // close() すると仕様上 width/height が 0 になるので、先に控えてから閉じる。
    const width = bitmap.width;
    const height = bitmap.height;
    const [full, thumb] = await Promise.all([
      renderToJpeg(bitmap, 1600, 0.8),
      renderToJpeg(bitmap, 480, 0.7)
    ]);
    bitmap.close?.();
    return { full: full || file, thumb, width, height };
  } catch {
    return { full: file, thumb: null, width: null, height: null };
  }
}
