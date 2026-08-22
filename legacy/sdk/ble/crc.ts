// CRC primitives for the BLE command surface — pure, no I/O.
//
// TWO different CRCs live on the wire and they are NOT interchangeable:
//
//   • CRC-16/CCITT-FALSE  — the TRANSPORT integrity check appended little-endian to the last
//     fragment of every aa21 message (over the concatenated pb of all fragments). It is ALSO the
//     FFSP program-integrity CRC (`ffsp_crc16`, program.ts `crc16`). Same algorithm, two uses.
//
//   • CRC-32 (zlib/PKZIP, reflected) — the FXP1 frame body checksum the CFW loader validates
//     (`"FXP1" + u32 len + u32 crc32 + body`). NOT the Castagnoli CRC32C used for OTA headers.
//
// ⚠️ The proven native driver (modules/ffs-ble/.../G2Protocol.kt `g2CRC16`) computes the transport
// CRC with a byte-swap/xor *bit-mix* formulation rather than the MSB-first table walk below. They
// are mathematically the SAME function (both yield 0x29B1 for "123456789", the CCITT-FALSE check
// value) — `__tests__/crc.test.ts` pins that equivalence across random vectors so a future edit to
// either side cannot drift silently. We keep the readable MSB-first form here.

/**
 * CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF, no input/output reflection, no final xor.
 * Transport-frame CRC and FFSP program CRC. Check value: crc16("123456789") === 0x29B1.
 */
export function crc16CcittFalse(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** The transport CRC as its 2 little-endian bytes, ready to append to a final fragment. */
export function crc16BytesLE(data: Uint8Array): Uint8Array {
  const c = crc16CcittFalse(data);
  return Uint8Array.from([c & 0xff, (c >> 8) & 0xff]);
}

/**
 * zlib/PKZIP CRC-32 — reflected, poly 0xEDB88320, init & xorout 0xFFFFFFFF.
 * The FXP1 frame body checksum. Check value: crc32("123456789") === 0xCBF43926.
 *
 * ⚠️ NOT the CRC32C (Castagnoli, poly 0x1EDC6F41) in G2Flash.kt used for OTA component headers —
 * that one produces a frame the loader rejects.
 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The FXP1 body CRC-32 as its 4 little-endian bytes. */
export function crc32BytesLE(data: Uint8Array): Uint8Array {
  const c = crc32(data);
  return Uint8Array.from([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]);
}
