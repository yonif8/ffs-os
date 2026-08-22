// A minimal zlib encoder — STORED blocks only.
//
// The firmware's mode-2 path calls inflateInit2(window=15), i.e. it wants a real zlib stream:
// 2-byte header, deflate blocks, 4-byte adler32 trailer. There is no deflate implementation in
// this project's dependencies and adding one for a first proof would be a large amount of
// machinery to trust sight-unseen.
//
// Stored ("uncompressed") deflate blocks are a legal, trivially verifiable deflate stream: a
// 5-byte header per block and the bytes verbatim. The cost is ~0.008% size overhead and no
// compression — which is fine, because the frames we push are small container-sized rasters,
// not full-canvas ones. If frame size ever becomes the bottleneck, swap this for a real
// fixed-Huffman encoder; the interface will not change.
//
// ⚠️ The adler32 must be correct. inflate() returns Z_STREAM_END only if the checksum matches,
// and the firmware checks for exactly that — a wrong checksum means the frame is silently
// dropped and the previous frame stays on screen, which looks identical to "nothing happened".

/** adler32 over `data`, per RFC 1950. */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  // 5552 is the largest run that cannot overflow a 32-bit accumulator before the modulo.
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Wrap `data` as a zlib stream using stored deflate blocks.
 *
 * Layout: [0x78 0x01] [block]* [adler32 big-endian]
 * Each block: [BFINAL|BTYPE=00] [LEN lo hi] [~LEN lo hi] [raw bytes]
 */
export function zlibStored(data: Uint8Array): Uint8Array {
  const MAX = 65535; // a stored block's LEN field is 16 bits
  const nBlocks = Math.max(1, Math.ceil(data.length / MAX));
  const out = new Uint8Array(2 + nBlocks * 5 + data.length + 4);
  let o = 0;

  // CMF=0x78: deflate, 32K window. FLG=0x01 makes (CMF<<8|FLG) % 31 == 0 with FLEVEL=0.
  out[o++] = 0x78;
  out[o++] = 0x01;

  for (let i = 0; i < nBlocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, data.length - start);
    const final = i === nBlocks - 1 ? 1 : 0;
    out[o++] = final; // BTYPE=00 (stored) in bits 1-2, BFINAL in bit 0
    out[o++] = len & 0xff;
    out[o++] = (len >> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }

  const sum = adler32(data);
  out[o++] = (sum >>> 24) & 0xff; // adler32 is BIG-endian, unlike everything else here
  out[o++] = (sum >>> 16) & 0xff;
  out[o++] = (sum >>> 8) & 0xff;
  out[o++] = sum & 0xff;

  return out.subarray(0, o);
}
