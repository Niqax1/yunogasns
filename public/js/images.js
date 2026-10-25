// 写真はブラウザで縮小し、JPEG に変換してから送る。
// 通信量と保存容量を減らすためと、写真に埋め込まれた撮影場所（GPS）などの情報を消すため
// （描き直した画像にはそうした情報が残らない）。

/**
 * maxSize: 長いほうの辺の最大ピクセル数 / square: 中央を正方形に切り抜く（アイコン用）
 * 戻り値: { blob, width, height }
 */
export async function compressImage(file, { maxSize = 1600, quality = 0.85, square = false } = {}) {
  let bitmap;
  try {
    // スマホで横向き・縦向きに撮った写真の向きを正しく反映する
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("この画像は読み込めませんでした。JPEG や PNG などの画像を選んでください。");
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const sourceWidth = square ? side : bitmap.width;
  const sourceHeight = square ? side : bitmap.height;
  const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  // JPEG は透明を表せないので、透明な部分は白にする
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(
    bitmap,
    (bitmap.width - sourceWidth) / 2,
    (bitmap.height - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("画像の変換に失敗しました。");
  return { blob, width, height };
}
