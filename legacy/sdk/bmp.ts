// 4-bit grayscale BMP encoder.
//
// Two reasons this exists rather than only the 8bpp mode-2 raster:
//
// 1. It is the PROVEN path. A 4-bit BMP over the image channel is photographed rendering
//    on-glass, so it is the control that isolates a failure: if a BMP drawn through the same
//    container/fragment plumbing appears and a mode-2 frame does not, the plumbing is fine and
//    the fault is in the zlib path — which is otherwise very hard to tell apart from a page that
//    was never accepted, because both look like a black HUD.
//
// 2. It needs no compression at all, so it cannot fail on a device-side allocation.
//
// The cost is 16 grey levels instead of 256, which is enough for solid shapes but visibly
// banded on a gradient.

import type { Raster } from "./raster";

/**
 * Pack an 8bpp buffer into a 4-bit BMP.
 *
 * Bottom-up rows (positive height), rows padded to 4 bytes, and a 16-entry grayscale palette —
 * matching the encoder already proven on hardware byte for byte, because the firmware's fast
 * path only accepts 4bpp BMPs whose dimensions match the container.
 */
export function build4BitBmp(gray: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow4 = (width + 1) >> 1;
  const paddedRow = (bytesPerRow4 + 3) & ~3;
  const pixelBytes = paddedRow * height;
  const headerSize = 14 + 40 + 64; // file header + DIB + 16-entry palette
  const fileSize = headerSize + pixelBytes;

  const b = new Uint8Array(fileSize);
  const dv = new DataView(b.buffer);
  let o = 0;
  const u8 = (v: number) => { b[o++] = v & 0xff; };
  const le16 = (v: number) => { dv.setUint16(o, v, true); o += 2; };
  const le32 = (v: number) => { dv.setUint32(o, v >>> 0, true); o += 4; };

  u8(0x42); u8(0x4d);          // "BM" — also the mode byte the CFW reads as "raw BMP"
  le32(fileSize);
  le16(0); le16(0);
  le32(headerSize);

  le32(40);                    // BITMAPINFOHEADER
  le32(width);
  le32(height);                // positive => bottom-up
  le16(1);                     // planes
  le16(4);                     // bits per pixel
  le32(0);                     // BI_RGB, no compression
  le32(pixelBytes);
  le32(2835); le32(2835);      // ~72 DPI
  le32(16);                    // palette entries used
  le32(0);

  for (let i = 0; i < 16; i++) {
    const v = i * 17;          // 0..255 in 16 even steps
    u8(v); u8(v); u8(v); u8(0);
  }

  for (let row = 0; row < height; row++) {
    const srcRow = height - 1 - row;   // BMP rows run bottom-up
    const base = o;
    for (let col = 0; col < width; col++) {
      const g = gray[srcRow * width + col] & 0xff;
      const idx = g >> 4;
      const pos = base + (col >> 1);
      if ((col & 1) === 0) b[pos] = idx << 4;
      else b[pos] |= idx;
    }
    o += paddedRow;
  }

  return b;
}

/** Convenience: encode a Raster as a 4-bit BMP ready to push at a matching container. */
export function rasterToBmp(r: Raster): Uint8Array {
  return build4BitBmp(r.data, r.width, r.height);
}
