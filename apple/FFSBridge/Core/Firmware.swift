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
import CryptoKit

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
    guard frame[4] == 1, frame[5] == 1, ln >= 4, frame.count == 8 + ln else { return nil }
    let body = Array(frame[8..<frame.count - 2])
    guard Array(frame.suffix(2)) == crc16(body) else { return nil }
    return (frame[6], body)
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
    guard img.count >= 0x40, Array(img.prefix(7)) == Array("EVENOTA".utf8) else { throw G2FlashError.badImage("file too small") }
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
      guard ps > 0, Int(size) >= 128 + Int(ps), so >= 0x40 + Int(n) * 16,
            so + Int(size) <= img.count else { throw G2FlashError.badImage("component bounds") }
      let payload = Array(img[so + 128..<so + 128 + Int(ps)])
      guard crc32c(payload) == crc, readU32LE(sub, 12) == crc else {
        throw G2FlashError.badImage("component CRC mismatch")
      }
      guard !segs.contains(where: { $0.fn == fn || (so < Int($0.off + $0.size) && Int($0.off) < so + Int(size)) }) else {
        throw G2FlashError.badImage("duplicate or overlapping component")
      }
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
    guard ps >= UInt32(APP_PREAMBLE) else {
      return GuardResult(ps: ps, loadAddr: 0, preLen: 0, progEnd: 0, pass: false, reason: "short main payload")
    }
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


  struct GoldenVector { let sha256: String; let ps: UInt32; let progEnd: UInt32; let pass: Bool; let label: String }
  // Generated from current Android G2Flash.kt; verified by parity tests.
  static let goldens: [GoldenVector] = [
    GoldenVector(sha256: "5c1539fd39c599e6035f6a8ec0779ba687c250d342a24c21a39952fed6c56aa0", ps: 3539474, progEnd: 0x007981F2, pass: true, label: "CFW (2.2.6.10 base)"),
    GoldenVector(sha256: "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa", ps: 3523396, progEnd: 0x00794324, pass: true, label: "stock 2.2.6.10"),
    GoldenVector(sha256: "0fced0aebcc6c88db6f76dba34f91b805d842a5fc297bfd7fa6d6a34ec83cecb", ps: 3557884, progEnd: 0x0079C9DC, pass: true, label: "stock 2.2.7.14 (RESTORE)"),
    GoldenVector(sha256: "79f64a8d87ef5f5630fb3d72de562246aef3131c8625ecf97dbfd34f526dc1b8", ps: 3600918, progEnd: 0x007A71F6, pass: true, label: "v3 resident hook (2.2.7.14)"),
    GoldenVector(sha256: "67759cd67ed7031d7b4c8a613b8b0fe9dc9bd51c11e82260c35f5bc807159b5e", ps: 3523396, progEnd: 0x00794324, pass: true, label: "canary 2.2.6.77"),
    GoldenVector(sha256: "70332b9822806a546e028ffb1b88b49a44593fe88236a3daa70866185acbb4f0", ps: 3540259, progEnd: 0x00798503, pass: true, label: "fontpeek (FUT-188)"),
    GoldenVector(sha256: "33404e1977aa7d1abaeedfb34a64f1b81e470b6ea818a1d21f61a0187ca5be1c", ps: 3545731, progEnd: 0x00799A63, pass: true, label: "bidi-only (FUT-190)"),
    GoldenVector(sha256: "45a481fc13b3cb864a9c6b63a4c428c248ab1f3a8ab770715b71965bad09ed5f", ps: 3567646, progEnd: 0x0079EFFE, pass: true, label: "hebrew-full (FUT-189/190)"),
    GoldenVector(sha256: "39ea04a2964c443a1434310d929d64cf22c24ef908255f0f8d07a4b01e72cbfd", ps: 3559323, progEnd: 0x0079CF7B, pass: true, label: "hebrew v2 + font probe (FUT-191)"),
    GoldenVector(sha256: "3a673c966658216ecbb9397d65682e8131ea4465f8915c941250985f8368d8ce", ps: 3562746, progEnd: 0x0079DCDA, pass: true, label: "ffs-ui probe (FUT-197)"),
    GoldenVector(sha256: "913a7f28cc79957ed8a5991c7434d993583070fc3d369b6c6a9e1683fd6f3f86", ps: 3563490, progEnd: 0x0079DFC2, pass: true, label: "ram-exec probe (FUT-214)"),
    GoldenVector(sha256: "373bfe9aa3645f1cda5b0204df1db3516e16347f31dcc9a39846442022c43103", ps: 3566014, progEnd: 0x0079E99E, pass: true, label: "resident loader (2.2.6.10)"),
    GoldenVector(sha256: "7ecf5f4948e510469cc85cd77c1a291e67bf78800f93a40cb918cf5f326eb9a6", ps: 3600806, progEnd: 0x007A7186, pass: true, label: "resident loader (2.2.7.14)"),
    GoldenVector(sha256: "e206a0ec5449c865546e8f2885d50c66e118da5c502df97fcce82b4048de4eeb", ps: 3601454, progEnd: 0x007A740E, pass: true, label: "arena loader (2.2.7.14)"),
    GoldenVector(sha256: "47a337ef02f83808424c11ca75ac28129f232186d72c8bd99e958d0d8dd0c16b", ps: 3601454, progEnd: 0x007A740E, pass: true, label: "big-arena loader (2.2.7.14)"),
    GoldenVector(sha256: "80d4c1a70bb86cf2db0c2b8bf42b1dec87be6e007a309750eaef58b500bfafa0", ps: 3601866, progEnd: 0x007A75AA, pass: true, label: "gif+telemetry loader (2.2.7.14)"),
    GoldenVector(sha256: "8d63a4312f703a6011dda4e68cee62bc1ea2d7fd82343456bb0409fed53d23b3", ps: 3602538, progEnd: 0x007A784A, pass: true, label: "gif-sync loader (2.2.7.14)"),
    GoldenVector(sha256: "e4befdccbeda6fb17cde5cf55cd3c1bd8b4e73f9e6be5856f1c349b8f7b69b35", ps: 3602514, progEnd: 0x007A7832, pass: true, label: "gif-sync DIAG (2.2.7.14)"),
    GoldenVector(sha256: "4521d40cef3bdb7c776fc2395f236671a92ce8b001a4f63b6ad02a341eac9594", ps: 3603810, progEnd: 0x007A7D42, pass: true, label: "OS takeover usable dashboard — tap-safe (2.2.7.14)"),
    GoldenVector(sha256: "361cdb214ebc4ae85e2a35310d43c79799b6c9439d1cbfa54a33917f384e7aa2", ps: 3610244, progEnd: 0x007A9664, pass: true, label: "OS takeover — functional nav + redraw fix (2.2.7.14)"),
    GoldenVector(sha256: "cbeacb985d03fd9bc923c5ac371dd6fa3f656e3227949e04c579ec493acf3a44", ps: 3610970, progEnd: 0x007A993A, pass: true, label: "OS takeover — longpress menu + hide + stereo-sync (2.2.7.14)"),
    GoldenVector(sha256: "7ad48130a6b3616a7cdddb0d268193d902d5e5f03bd639a6793f9fff79b7097e", ps: 3627524, progEnd: 0x007AD9E4, pass: true, label: "OS takeover + S2 app runtime (2.2.7.14)"),
    GoldenVector(sha256: "340a078884dba9f0b60b608e8c87a5a8d2ed8adabb63086bd57859fa27224cba", ps: 3628388, progEnd: 0x007ADD44, pass: true, label: "OS takeover + S2 app runtime, 160x64 canvas (2.2.7.14)"),
    GoldenVector(sha256: "791998750f7db3c4ab7d7b70e51d878f9ebff249167805961d8acac765acb569", ps: 3622864, progEnd: 0x007AC7B0, pass: true, label: "OS takeover + panic-reset gate + layer-top shell on P_FT (2.2.7.14)"),
    GoldenVector(sha256: "7e8422fac671885ac6a6c7cf1da3713859f0cfe7360087256da2353c3cd83053", ps: 3622844, progEnd: 0x007AC79C, pass: true, label: "OS takeover + panic gate + FULL-HUD 576x288 shell on P_FT (2.2.7.14)"),
    GoldenVector(sha256: "c5dfd200459fe5f0ff0e6721a5197105807e5eb6de7f77732a8edfda8d73eb24", ps: 3643874, progEnd: 0x007B19C2, pass: true, label: "OS takeover + FFSC data channel + tier-3 gate + left-lens peer readback (2.2.7.14)"),
    GoldenVector(sha256: "6288cd10a004f386cdbd1ed8f4a92c567acd6025ab47381c5bf0558d9f30a0e7", ps: 3640637, progEnd: 0x007B0D1D, pass: true, label: "OS takeover + long-press-to-app + double-tap back + Close-app modal (2.2.7.14)"),
    GoldenVector(sha256: "6bbef9e46e0edb5ea99de9eb88633a63b010d167344079ef76edbe0ff8ac079c", ps: 3641097, progEnd: 0x007B0EE9, pass: true, label: "OS takeover + S7 cross-lens sync (ABI 3: ctx->frame/seed) (2.2.7.14)"),
    GoldenVector(sha256: "7e0b04ac8ecc7232cb030f58a36ffcb29121ff622e84ac54804c4e9900f55aeb", ps: 3641151, progEnd: 0x007B0F1F, pass: true, label: "OS takeover + S7 sync + double-tap fade restored (2.2.7.14)"),
    GoldenVector(sha256: "643d80a869a39a50756b0fc7da7bc939cc9855fa17bd19936bf71baabc722170", ps: 3641151, progEnd: 0x007B0F1F, pass: true, label: "de-Even P1: EvenHub killed + S7 sync + fade (2.2.7.14)"),
    GoldenVector(sha256: "c61c570f7f409fb98c4fa8237f974f15b783e7b9b6bcb17d5a305df99dae016d", ps: 3641959, progEnd: 0x007B1247, pass: true, label: "event bus: g2_emit + gesture tap on sid 0x91 (2.2.7.14)"),
    GoldenVector(sha256: "9ad3c2b9c15960250ff4b8d53b14c33fa84292580a6d133e69e85d243ba21e1e", ps: 3643011, progEnd: 0x007B1663, pass: true, label: "gesture inject: FGES frame -> rt_nav_apply (2.2.7.14)"),
    GoldenVector(sha256: "7bd9859b593d09e3b94df61ccd30cdeb00746a714a9b6e7e495db7d982e090c0", ps: 3646159, progEnd: 0x007B22AF, pass: true, label: "stereo reveal: no lens renders before the other (2.2.7.14)"),
    GoldenVector(sha256: "42e76a71b688e03291431410ab1483a9e86164dc79eb79f939eb8ba7a4674889", ps: 3646255, progEnd: 0x007B230F, pass: true, label: "cold-wake: FWAK -> RequestDisplayStartUp(1) (2.2.7.14)"),
    GoldenVector(sha256: "1d9df8374decf5fea792b0adebc12da953a24212fd47ce4ca0e1fb4aadead8eb", ps: 3646435, progEnd: 0x007B23C3, pass: true, label: "swirl-free mic (FMIC/AUDM_appAcquire) + long-press-0x91 (2.2.7.14) [CURRENT]"),
  ]
  struct Validated {
    let bytes: [UInt8]; let segments: [Segment]; let sha: String; let guardResult: GuardResult; let label: String
  }
  static func validate(_ data: Data, sha: String, allowUnknown: Bool = false) throws -> Validated {
    guard sha.count == 64, sha.allSatisfy({ $0.isHexDigit }) else { throw G2FlashError.badImage("64-digit SHA-256 required") }
    let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard actual == sha.lowercased() else { throw G2FlashError.badImage("SHA-256 mismatch") }
    let bytes = [UInt8](data), segments = try parseSegments(bytes)
    let g = checkMainAppFitsMram(bytes, segments)
    guard g.pass else { throw G2FlashError.badImage(g.reason) }
    let known = goldens.first { $0.sha256 == actual }
    guard known != nil || allowUnknown else { throw G2FlashError.badImage("Unknown golden; explicit override required") }
    if let k = known {
      guard g.ps == k.ps, g.progEnd == k.progEnd, g.pass == k.pass else { throw G2FlashError.badImage("Golden guard self-test failed") }
    }
    return Validated(bytes: bytes, segments: segments, sha: actual, guardResult: g, label: known?.label ?? "SHA-pinned custom build")
  }
}
