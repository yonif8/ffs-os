//
//  G2Anim.swift
//  ffs-ble
//
//  FUT-165 — on-glass pixel animation engine for the G2 CFW (custom firmware).
//
//  The CFW's `image_deferred` fast path dispatches on the image payload's LEADING
//  byte (zlib_glue.c). We use **mode 2** = [0x02][zlib(8bpp W*H pixels)]: the firmware
//  inflates it straight into the display buffer (dimensions come from the container
//  state, so no header on the pixels), with no per-frame 700ms settle. So the recipe is:
//  create ONE persistent 576×288 image container, then stream mode-2 frames to it.
//
//  This file is PURE logic — no BLE, no CoreBluetooth. It (1) encodes 8bpp pixel
//  frames into the mode-2 wire payload (Apple `Compression` gives RAW DEFLATE; we
//  hand-wrap it into a valid RFC1950 zlib stream: 0x78 0x9C header + raw deflate +
//  big-endian adler32 of the uncompressed pixels — validated to round-trip through a
//  standard zlib decoder), and (2) generates the procedural/static frame content for
//  the Animations menu. G2Central owns the container + the fire-and-forget frame loop.
//
//  Pixels: 8bpp grayscale, row-major TOP-DOWN, 0 = black, 255 = brightest (the G2 is a
//  monochrome green HUD; higher = brighter).
//

import Foundation
import Compression
import CoreGraphics
import CoreText

enum G2Anim {
  static let W = 576
  static let H = 288
  static let N = W * H

  // MARK: - mode-2 wire encoding

  /// adler32 (RFC1950), matches zlib.adler32 — verified equal off-glass.
  static func adler32(_ data: [UInt8]) -> UInt32 {
    let MOD: UInt32 = 65521
    var a: UInt32 = 1, b: UInt32 = 0
    for byte in data {
      a = (a + UInt32(byte)) % MOD
      b = (b + a) % MOD
    }
    return (b << 16) | a
  }

  /// RAW DEFLATE (RFC1951) via Apple's Compression framework (COMPRESSION_ZLIB emits
  /// raw deflate, no zlib header/trailer).
  static func rawDeflate(_ input: [UInt8]) -> [UInt8]? {
    guard !input.isEmpty else { return nil }
    let dstCap = input.count + (input.count / 2) + 4096
    var dst = [UInt8](repeating: 0, count: dstCap)
    let n = input.withUnsafeBufferPointer { src in
      compression_encode_buffer(&dst, dstCap, src.baseAddress!, input.count, nil, COMPRESSION_ZLIB)
    }
    guard n > 0 else { return nil }
    return Array(dst[0..<n])
  }

  /// Encode 8bpp pixels (W*H, top-down) as a CFW mode-2 payload:
  /// [0x02] + [0x78 0x9C] + rawDeflate(pixels) + adler32_BE(pixels).
  static func mode2Payload(_ pixels: [UInt8]) -> Data? {
    guard pixels.count == N, let raw = rawDeflate(pixels) else { return nil }
    var out = [UInt8]()
    out.reserveCapacity(raw.count + 7)
    out.append(0x02)                 // CFW image mode 2 (8bpp full frame, zlib)
    out.append(0x78); out.append(0x9C)  // zlib RFC1950 header
    out.append(contentsOf: raw)      // raw deflate body
    let ad = adler32(pixels)         // big-endian adler32 trailer
    out.append(UInt8((ad >> 24) & 0xff))
    out.append(UInt8((ad >> 16) & 0xff))
    out.append(UInt8((ad >> 8) & 0xff))
    out.append(UInt8(ad & 0xff))
    return Data(out)
  }

  // MARK: - Frame dispatch

  static let ids = ["image", "ball", "spinner", "rings", "plasma", "starfield", "marquee", "video"]

  /// Produce one 8bpp frame (W*H) for `anim` at frame index `f`.
  static func frame(_ anim: String, _ f: Int) -> [UInt8] {
    switch anim {
    case "image": return staticImage()
    case "ball": return ball(f)
    case "spinner": return spinner(f)
    case "rings": return rings(f)
    case "plasma": return plasma(f)
    case "starfield": return starfield(f)
    case "marquee": return marquee(f)
    case "video": return videoDemo(f)
    default: return [UInt8](repeating: 0, count: N)
    }
  }

  // MARK: - Procedural generators (pure math, top-down)

  @inline(__always) private static func put(_ buf: inout [UInt8], _ x: Int, _ y: Int, _ v: UInt8) {
    if x >= 0 && x < W && y >= 0 && y < H { buf[y * W + x] = v }
  }

  /// Filled disc.
  private static func disc(_ buf: inout [UInt8], _ cx: Int, _ cy: Int, _ r: Int, _ v: UInt8) {
    let r2 = r * r
    for dy in -r...r {
      let yy = cy + dy
      if yy < 0 || yy >= H { continue }
      for dx in -r...r where dx * dx + dy * dy <= r2 {
        let xx = cx + dx
        if xx >= 0 && xx < W { buf[yy * W + xx] = v }
      }
    }
  }

  private static func ball(_ f: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    let r = 34
    let spanX = W - 2 * r, spanY = H - 2 * r
    // triangle-wave bounce
    func tri(_ t: Int, _ span: Int) -> Int {
      let p = span * 2
      let m = ((t % p) + p) % p
      return m < span ? m : p - m
    }
    let cx = r + tri(f * 7, spanX)
    let cy = r + tri(f * 5, spanY)
    disc(&buf, cx, cy, r, 255)
    disc(&buf, cx, cy, r - 6, 200)  // little inner shading
    return buf
  }

  private static func spinner(_ f: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    let cx = W / 2, cy = H / 2
    let dots = 12
    for i in 0..<dots {
      let ang = Double(i) / Double(dots) * 2 * .pi + Double(f) * 0.18
      let rr = 90.0
      let x = cx + Int(cos(ang) * rr)
      let y = cy + Int(sin(ang) * rr)
      // trailing brightness
      let bright = UInt8(60 + (195 * i) / dots)
      disc(&buf, x, y, 12, bright)
    }
    return buf
  }

  private static func rings(_ f: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    let cx = W / 2, cy = H / 2
    let maxR = 200
    let count = 4
    for k in 0..<count {
      let rr = ((f * 3 + k * (maxR / count)) % maxR)
      // draw a ring (annulus outline) of thickness 5
      let rlo = (rr - 3) * (rr - 3), rhi = (rr + 3) * (rr + 3)
      for dy in -rr - 3...rr + 3 {
        let yy = cy + dy
        if yy < 0 || yy >= H { continue }
        for dx in -rr - 3...rr + 3 {
          let d = dx * dx + dy * dy
          if d >= rlo && d <= rhi {
            let xx = cx + dx
            if xx >= 0 && xx < W { buf[yy * W + xx] = UInt8(max(40, 255 - rr)) }
          }
        }
      }
    }
    return buf
  }

  private static func plasma(_ f: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    let t = Double(f) * 0.12
    for y in 0..<H {
      let fy = Double(y)
      for x in 0..<W {
        let fx = Double(x)
        var v = sin(fx / 34.0 + t)
        v += sin(fy / 28.0 - t * 0.8)
        v += sin((fx + fy) / 40.0 + t * 0.6)
        v += sin(sqrt(fx * fx + fy * fy) / 34.0 - t)
        // v in [-4,4] -> [0,255]
        buf[y * W + x] = UInt8(max(0, min(255, Int((v + 4.0) * 31.9))))
      }
    }
    return buf
  }

  private static func starfield(_ f: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    // deterministic pseudo-stars, moving left, wrapping
    var seed: UInt64 = 0x9E3779B97F4A7C15
    func rnd() -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 33) & 0x7fffffff) }
    for _ in 0..<140 {
      let baseX = rnd() % W
      let y = rnd() % H
      let depth = 1 + rnd() % 3          // 1..3
      let x = ((baseX - f * depth) % W + W) % W
      let bright = UInt8(90 + depth * 55)
      put(&buf, x, y, bright)
      if depth == 3 { put(&buf, x - 1, y, bright / 2) }  // little streak for near stars
    }
    return buf
  }

  private static func videoDemo(_ f: Int) -> [UInt8] {
    // A short looping "video": a pulsing checker + a sweeping bar — a placeholder
    // multi-frame loop until the real converted clip lands (next build).
    var buf = [UInt8](repeating: 0, count: N)
    let phase = f % 90
    let pulse = UInt8(60 + Int(80 * (0.5 + 0.5 * sin(Double(f) * 0.1))))
    let cell = 48
    for y in 0..<H {
      for x in 0..<W {
        let on = ((x / cell) + (y / cell) + phase / 10) % 2 == 0
        buf[y * W + x] = on ? pulse : 0
      }
    }
    // sweeping vertical bar
    let barX = (f * 9) % W
    for y in 0..<H { for dx in 0..<10 { put(&buf, barX + dx, y, 255) } }
    return buf
  }

  // MARK: - CoreGraphics text/image render (static image + marquee)

  /// Render into an 8bpp grayscale buffer, flipped so drawing is TOP-DOWN.
  private static func renderGray(_ draw: (CGContext) -> Void) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    let cs = CGColorSpaceCreateDeviceGray()
    buf.withUnsafeMutableBytes { raw in
      guard let ctx = CGContext(
        data: raw.baseAddress, width: W, height: H, bitsPerComponent: 8,
        bytesPerRow: W, space: cs, bitmapInfo: CGImageAlphaInfo.none.rawValue)
      else { return }
      // CG origin is bottom-left; flip so our draw calls are top-down.
      ctx.translateBy(x: 0, y: CGFloat(H))
      ctx.scaleBy(x: 1, y: -1)
      draw(ctx)
    }
    return buf
  }

  private static func drawText(_ ctx: CGContext, _ text: String, x: CGFloat, y: CGFloat, size: CGFloat, gray: CGFloat = 1.0) {
    // CoreText-native attribute keys (no UIKit/AppKit dependency).
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    guard let color = CGColor(colorSpace: CGColorSpaceCreateDeviceGray(), components: [gray, 1.0]) else { return }
    let attrs: [CFString: Any] = [
      kCTFontAttributeName: font,
      kCTForegroundColorAttributeName: color,
    ]
    guard let attr = CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary) else { return }
    let line = CTLineCreateWithAttributedString(attr)
    // our context is already Y-flipped (top-down); flip text glyphs back upright
    ctx.saveGState()
    ctx.textMatrix = .identity
    ctx.translateBy(x: x, y: y)
    ctx.scaleBy(x: 1, y: -1)
    ctx.textPosition = .zero
    CTLineDraw(line, ctx)
    ctx.restoreGState()
  }

  private static func staticImage() -> [UInt8] {
    return renderGray { ctx in
      // soft vertical gradient background
      let cs = CGColorSpaceCreateDeviceGray()
      if let grad = CGGradient(colorsSpace: cs, colors: [
        CGColor(colorSpace: cs, components: [0.10, 1])!,
        CGColor(colorSpace: cs, components: [0.55, 1])!,
      ] as CFArray, locations: [0, 1]) {
        ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: CGFloat(H)), options: [])
      }
      // border
      ctx.setStrokeColor(CGColor(colorSpace: cs, components: [1, 1])!)
      ctx.setLineWidth(6)
      ctx.stroke(CGRect(x: 6, y: 6, width: CGFloat(W - 12), height: CGFloat(H - 12)))
      drawText(ctx, "FFS OS", x: 150, y: 120, size: 96, gray: 1.0)
      drawText(ctx, "custom firmware · 576×288", x: 120, y: 200, size: 30, gray: 0.9)
    }
  }

  private static func marquee(_ f: Int) -> [UInt8] {
    let msg = "FFS GLASSES OS — our own firmware, our own pixels — smooth on-glass graphics unlocked · "
    // scroll: shift the text left by f*6 px, wrapping over a nominal width
    let span = 2200
    let off = CGFloat(-((f * 6) % span))
    return renderGray { ctx in
      drawText(ctx, msg, x: off, y: 150, size: 64, gray: 1.0)
      drawText(ctx, msg, x: off + CGFloat(span), y: 150, size: 64, gray: 1.0)
    }
  }
}
