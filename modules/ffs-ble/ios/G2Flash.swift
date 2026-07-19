//
//  G2Flash.swift
//  ffs-ble — FUT-167 Stage 2: CFW OTA flasher (Swift port of g2flash.py's protocol).
//
//  PURE-LOGIC layer, NO CoreBluetooth and NO writes: the byte-exact OTA framing +
//  CRC16/CRC32C + EVENOTA container parsing + the MRAM brick-guard, plus a golden-vector
//  self-test. The BLE flash state machine (which drives these over the link) lives in
//  G2Central; this file is the protocol + the safety guard, deliberately isolated so it
//  can be reasoned about (and, in CI, unit-checked) on its own.
//
//  Every algorithm here was verified against the reference `g2flash.py` on the two real
//  bundled images before transcription (crc16 on random vectors; crc32c against both
//  images' stored TOC CRCs; the guard against the captured golden vectors below).
//  Portions of the protocol are derived from g2flash (see that project). FUT-167.
//

import Foundation

enum G2FlashError: Error, CustomStringConvertible {
  case badImage(String)
  var description: String {
    switch self { case .badImage(let m): return "bad firmware image: \(m)" }
  }
}

enum G2Flash {
  // ---- CRC16 (CCITT, init 0xFFFF, poly 0x1021) — the OTA body trailer, LE bytes. ----
  // Computed in UInt32 and masked to 16 bits each step so nothing traps.
  static func crc16(_ data: [UInt8]) -> [UInt8] {
    var c: UInt32 = 0xFFFF
    for b in data {
      c ^= UInt32(b) << 8
      for _ in 0..<8 {
        c = (c & 0x8000) != 0 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF
      }
    }
    return [UInt8(c & 0xFF), UInt8((c >> 8) & 0xFF)]
  }

  // ---- CRC32C (Castagnoli, MSB-first, init 0, xorout 0) — per-component payload CRC. ----
  private static let crc32cTable: [UInt32] = {
    var t = [UInt32](repeating: 0, count: 256)
    for b in 0..<256 {
      var c = UInt32(b) << 24
      for _ in 0..<8 {
        c = (c & 0x8000_0000) != 0 ? (c << 1) ^ 0x1EDC_6F41 : (c << 1)
      }
      t[b] = c
    }
    return t
  }()

  static func crc32c(_ buf: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0
    for byte in buf {
      crc = (crc << 8) ^ crc32cTable[Int(((crc >> 24) ^ UInt32(byte)) & 0xFF)]
    }
    return crc
  }

  // ---- little-endian u32 read ----
  static func readU32LE(_ b: [UInt8], _ o: Int) -> UInt32 {
    return UInt32(b[o]) | (UInt32(b[o + 1]) << 8) | (UInt32(b[o + 2]) << 16) | (UInt32(b[o + 3]) << 24)
  }

  // ---- OTA transport framing (validated byte-for-byte vs g2flash `frames`) ----
  // body = pb + crc16(pb); chunk into 232-byte frames; per frame:
  //   [0xAA, 0x21, seq, len(chunk), tot, serial(1-based), sid, flag] + chunk
  // sid = 0xC0 ctrl, 0xC1 data. A shared `seq` links a marker+block pair.
  static let CHUNK = 232

  static func frames(sid: UInt8, pb: [UInt8], flag: UInt8 = 0, seq: UInt8) -> [[UInt8]] {
    let body = pb + crc16(pb)
    let tot = max(1, (body.count + CHUNK - 1) / CHUNK)
    var out: [[UInt8]] = []
    var off = 0
    for i in 0..<tot {
      let end = min(off + CHUNK, body.count)
      let ch = Array(body[off..<end])
      off = end
      var frame: [UInt8] = [0xAA, 0x21, seq, UInt8(ch.count), UInt8(tot), UInt8(i + 1), sid, flag]
      frame.append(contentsOf: ch)
      out.append(frame)
    }
    return out
  }

  static func ctrlFrames(_ op: UInt8, _ data: [UInt8] = [], seq: UInt8) -> [[UInt8]] {
    return frames(sid: 0xC0, pb: [op] + data, seq: seq)
  }

  static func dataFrames(_ block: [UInt8], seq: UInt8) -> [[UInt8]] {
    return frames(sid: 0xC1, pb: block, seq: seq)
  }

  /// Unwrap an `aa12` reply envelope → (sid, pb). pb = [opcode, status, ...].
  static func parseRx(_ frame: [UInt8]) -> (sid: UInt8, pb: [UInt8])? {
    guard frame.count >= 10, frame[0] == 0xAA, frame[1] == 0x12 else { return nil }
    let ln = Int(frame[3])
    let sid = frame[6]
    let n = max(0, ln - 2)
    let end = min(8 + n, frame.count)
    guard end >= 8 else { return (sid, []) }
    return (sid, Array(frame[8..<end]))
  }

  // ---- EVENOTA container parsing ----
  struct Segment {
    let eid: UInt32
    let off: UInt32
    let size: UInt32
    let crc: UInt32
    let sub: [UInt8]   // 128-byte subheader
    let ps: UInt32     // payload size
    let fn: String     // component name
  }

  static func parseSegments(_ img: [UInt8]) throws -> [Segment] {
    guard img.count >= 0x40 else { throw G2FlashError.badImage("file too small") }
    let n = readU32LE(img, 8)
    guard n > 0 && n <= 64 else { throw G2FlashError.badImage("implausible component count \(n)") }
    var segs: [Segment] = []
    for i in 0..<Int(n) {
      let base = 0x40 + i * 16
      guard base + 16 <= img.count else { throw G2FlashError.badImage("TOC entry \(i) past EOF") }
      let eid = readU32LE(img, base)
      let off = readU32LE(img, base + 4)
      let size = readU32LE(img, base + 8)
      let crc = readU32LE(img, base + 12)
      let so = Int(off)
      guard so >= 0, so + 128 <= img.count else {
        throw G2FlashError.badImage("segment \(i) subheader past EOF")
      }
      let sub = Array(img[so..<so + 128])
      let ps = readU32LE(sub, 8)
      let nameBytes = sub[48..<128].prefix(while: { $0 != 0 })
      let fn = String(bytes: nameBytes, encoding: .isoLatin1) ?? ""
      segs.append(Segment(eid: eid, off: off, size: size, crc: crc, sub: sub, ps: ps, fn: fn))
    }
    return segs
  }

  // ---- MRAM brick-guard (the ONLY thing preventing a hard, SWD-only brick) ----
  static let APP_LOAD_ADDR: UInt32 = 0x0043_8000
  static let APP_MAX_END: UInt32 = 0x007F_0000
  static let OTA_FLAG_ADDR: UInt32 = 0x007F_E000
  static let MRAM_END: UInt32 = 0x0080_0000
  static let APP_PREAMBLE = 0x20
  static let REQUIRED_SEGMENT = "ota/s200_firmware_ota.bin"

  struct GuardResult {
    let ps: UInt32
    let loadAddr: UInt32
    let preLen: UInt32
    let progEnd: UInt32
    let pass: Bool
    let reason: String
  }

  /// Re-derives the guard from the image bytes exactly as g2flash's
  /// `check_mainapp_fits_mram`. Call before EVERY flash (never cache).
  static func checkMainAppFitsMram(_ img: [UInt8], _ segs: [Segment]) -> GuardResult {
    guard let s = segs.first(where: { $0.fn == REQUIRED_SEGMENT }) else {
      return GuardResult(ps: 0, loadAddr: 0, preLen: 0, progEnd: 0, pass: false,
                         reason: "main-app segment \(REQUIRED_SEGMENT) not found")
    }
    let ps = s.ps
    let po = Int(s.off) + 128
    guard po + APP_PREAMBLE <= img.count else {
      return GuardResult(ps: ps, loadAddr: 0, preLen: 0, progEnd: 0, pass: false,
                         reason: "main-app payload smaller than its 32-byte preamble")
    }
    let pre = Array(img[po..<po + APP_PREAMBLE])
    let loadAddr = readU32LE(pre, 0x14)
    let preLen = readU32LE(pre, 0) & 0x00FF_FFFF
    if loadAddr != APP_LOAD_ADDR {
      return GuardResult(ps: ps, loadAddr: loadAddr, preLen: preLen, progEnd: 0, pass: false,
                         reason: String(format: "load addr 0x%08x != 0x00438000", loadAddr))
    }
    if preLen != ps {
      return GuardResult(ps: ps, loadAddr: loadAddr, preLen: preLen, progEnd: 0, pass: false,
                         reason: "preamble length \(preLen) != staged payload size \(ps)")
    }
    let progEnd = APP_LOAD_ADDR &+ ps &- UInt32(APP_PREAMBLE)
    if progEnd > APP_MAX_END {
      return GuardResult(ps: ps, loadAddr: loadAddr, preLen: preLen, progEnd: progEnd, pass: false,
                         reason: String(format: "too large: prog_end 0x%08x past ceiling 0x%08x", progEnd, APP_MAX_END))
    }
    return GuardResult(ps: ps, loadAddr: loadAddr, preLen: preLen, progEnd: progEnd, pass: true, reason: "ok")
  }

  // ---- Golden-vector self-test (council fix #2) ----
  // Captured from g2flash.py on the exact two bundled, SHA-verified images. The Swift
  // guard MUST reproduce these; a mis-transcribed constant that silently disabled the
  // guard would fail this test (and we refuse to flash if it does).
  struct GoldenVector {
    let sha256: String
    let ps: UInt32
    let progEnd: UInt32
    let pass: Bool
  }

  static let goldenCFW = GoldenVector(
    sha256: "5c1539fd39c599e6035f6a8ec0779ba687c250d342a24c21a39952fed6c56aa0",
    ps: 3_539_474, progEnd: 0x0079_81F2, pass: true)
  static let goldenStock = GoldenVector(
    sha256: "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa",
    ps: 3_523_396, progEnd: 0x0079_4324, pass: true)
  // FUT-167 canary: stock 2.2.6.10 with ONLY the reported firmware-version string changed
  // (2.2.6.10 → 2.2.6.77, 10 length-preserving rodata edits, checksums recomputed). Because
  // the edit is length-preserving, ps + prog_end are byte-for-byte identical to stock —
  // verified via g2flash — so the same MRAM guard vector holds; only the SHA differs. This
  // is the safe FIRST real flash (the write→commit→readback proof). Bootloader untouched.
  static let goldenCanary = GoldenVector(
    sha256: "67759cd67ed7031d7b4c8a613b8b0fe9dc9bd51c11e82260c35f5bc807159b5e",
    ps: 3_523_396, progEnd: 0x0079_4324, pass: true)
  // FUT-188 "fontpeek" CFW: the shipped CFW (_cfw.bin) + one injected read that appends
  // the XIP font-slot-0 header (127 B from 0x80100000) to the sid=0x09 device-info
  // response, so we can capture the s200_font.bin format ground-truth. Pure read, no new
  // flash-write behavior; ps/prog_end verified against the built image via g2flash.
  // v3 (FUT-186): read window moved to slot-0 0x80100030..0xA4 (116 B) to capture the
  // wrapper tail (len@0x3c + metrics) + glyph-body start — the bytes v2 missed.
  // v4 (FUT-186): v3 proved the blob is a LINKED lv_font struct image (absolute ptrs baked
  // to base). v4 reads TWO labeled windows in one 120-B record — 64 B tail @0x80533FD8
  // (== lv_font_t + font_dsc, to lock the struct ABI + absolute-pointer fields) + 48 B
  // @0x801000A4 (front hedge). Same pure read, new golden vector (injected read changed).
  static let goldenFontpeek = GoldenVector(
    sha256: "70332b9822806a546e028ffb1b88b49a44593fe88236a3daa70866185acbb4f0",
    ps: 3_540_259, progEnd: 0x0079_8503, pass: true)
  // FUT-190 Hebrew RTL, BIDI-ONLY (staged flash stage 1): ports LVGL v9.3 lv_bidi into
  // the CFW + hooks the ONE per-char decoder in lv_draw_label_iterate_characters so each
  // line reorders to visual order. NO glyph/font changes — flashed first to confirm the
  // shared label-draw hook doesn't disturb existing English/Chinese text before Hebrew is
  // added. Fails safe to stock LTR on any anomaly. (patches/bidi_patch.c)
  static let goldenBidiOnly = GoldenVector(
    sha256: "33404e1977aa7d1abaeedfb34a64f1b81e470b6ea818a1d21f61a0187ca5be1c",
    ps: 3_545_731, progEnd: 0x0079_9A63, pass: true)
  // FUT-189 + FUT-190 COMBINED (staged flash stage 2): bidi (above) PLUS Hebrew glyphs —
  // an embedded 21 KB Hebrew TTF served from RAM by hooking the FreeType-cache requester
  // (sentinel name "FFSHEB") + a fallback node appended to both font chains. This is the
  // one that makes Hebrew actually render, correctly ordered, system-wide. (patches/
  // hebrew_font_patch.c + bidi_patch.c) prog_end 0x0079effe = 324 KB under the ceiling.
  static let goldenHebrewFull = GoldenVector(
    sha256: "45a481fc13b3cb864a9c6b63a4c428c248ab1f3a8ab770715b71965bad09ed5f",
    ps: 3_567_646, progEnd: 0x0079_EFFE, pass: true)

  /// Run the parse+guard on `img` and assert it reproduces the golden vector. Returns
  /// nil on success, or a failure description. Any non-nil result MUST block flashing.
  static func selfTestGuard(_ img: [UInt8], expect gv: GoldenVector) -> String? {
    let segs: [Segment]
    do { segs = try parseSegments(img) } catch { return "parse failed: \(error)" }
    let r = checkMainAppFitsMram(img, segs)
    if r.pass != gv.pass { return "guard pass=\(r.pass) != golden \(gv.pass)" }
    if r.ps != gv.ps { return "ps \(r.ps) != golden \(gv.ps)" }
    if r.progEnd != gv.progEnd {
      return String(format: "prog_end 0x%08x != golden 0x%08x", r.progEnd, gv.progEnd)
    }
    return nil
  }
}
