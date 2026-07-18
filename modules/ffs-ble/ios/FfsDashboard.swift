//
//  G2Dashboard.swift
//  ffs-ble
//
//  FUT-176 — App #1: our own dashboard, rendered as OUR pixels.
//
//  Built to the reverse-engineered stock-dashboard spec (FUT-178): an LVGL-tileview
//  model — a persistent header (time/date/battery) + ONE swipeable widget tile at a
//  time (6 tiles) + position dots, plus a per-widget EXPANDED page. Design proven in
//  the off-glass simulator (tools/g2sim/dashboard.py) before this port.
//
//  Pure render: produces an 8bpp 576×288 top-down grayscale buffer (0=black..255=bright,
//  quantized to the panel's 16 Gray4 levels). G2Central owns the container + mode-2 send
//  (reuses the FUT-165 animation pipeline). No BLE here.
//
//  Coordinate convention: we draw in Core Graphics native coords (origin bottom-left)
//  and reverse rows at the end (same as G2Anim.renderGray), so callers think TOP-DOWN:
//  every helper takes a top-down Y and converts internally (cgY = H - topY).
//

import Foundation
import CoreGraphics
import CoreText

enum FfsDashboard {
  static let W = 576
  static let H = 288
  static let N = W * H

  // MARK: - data model (fed from the phone; sensible defaults so it always renders)

  struct Model {
    var time: String = "--:--"
    var date: String = ""
    var battery: Int = 0
    var tile: Int = 0            // active widget index 0..5
    var expanded: Bool = false
    // per-widget summary lines (phone supplies real data later)
    var calendarTitle = "No events"
    var calendarSub = ""
    var stockA = "—"
    var stockB = ""
    var newsTitle = "—"
    var newsSub = ""
    var healthA = "—"
    var healthB = ""
    var todo1 = ""
    var todo2 = ""
    var statusA = "Connected"
    var statusB = ""
    var calendarRows: [(String, String)] = []   // expanded calendar list
  }

  static let TILE_COUNT = 6
  static let TITLES = ["Calendar", "Markets", "News", "Activity", "To-Do", "Status"]

  // MARK: - public render entry points

  static func render(_ m: Model) -> [UInt8] {
    if m.expanded { return renderExpanded(m) }
    return quantize(renderGray { ctx in
      header(ctx, m)
      tileBody(ctx, m)
      dots(ctx, m.tile)
    })
  }

  // MARK: - CG buffer + top-down helpers

  private static func renderGray(_ draw: (CGContext) -> Void) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: N)
    let cs = CGColorSpaceCreateDeviceGray()
    buf.withUnsafeMutableBytes { raw in
      guard let ctx = CGContext(
        data: raw.baseAddress, width: W, height: H, bitsPerComponent: 8,
        bytesPerRow: W, space: cs, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
      ctx.setShouldAntialias(true)
      draw(ctx)
    }
    var out = [UInt8](repeating: 0, count: N)
    for y in 0..<H {
      let src = (H - 1 - y) * W, dst = y * W
      for x in 0..<W { out[dst + x] = buf[src + x] }
    }
    return out
  }

  /// Quantize to the panel's 16 Gray4 levels (0x0..0xF -> 0..255) so the preview
  /// matches what the µLED actually shows.
  private static func quantize(_ buf: [UInt8]) -> [UInt8] {
    var out = buf
    for i in 0..<out.count { out[i] = (out[i] >> 4) &* 17 }
    return out
  }

  private static func g(_ v: CGFloat) -> CGColor {
    CGColor(colorSpace: CGColorSpaceCreateDeviceGray(), components: [v, 1.0])
      ?? CGColor(gray: v, alpha: 1.0)
  }

  /// Top-down filled rect.
  private static func fillRect(_ ctx: CGContext, _ x: Int, _ topY: Int, _ w: Int, _ h: Int, _ v: CGFloat) {
    ctx.setFillColor(g(v))
    ctx.fill(CGRect(x: x, y: H - topY - h, width: w, height: h))
  }
  private static func strokeRect(_ ctx: CGContext, _ x: Int, _ topY: Int, _ w: Int, _ h: Int, _ v: CGFloat, _ lw: CGFloat = 3) {
    ctx.setStrokeColor(g(v)); ctx.setLineWidth(lw)
    ctx.stroke(CGRect(x: x, y: H - topY - h, width: w, height: h))
  }
  /// Top-down line.
  private static func line(_ ctx: CGContext, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, _ v: CGFloat, _ lw: CGFloat = 3) {
    ctx.setStrokeColor(g(v)); ctx.setLineWidth(lw); ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: x0, y: H - y0)); ctx.addLine(to: CGPoint(x: x1, y: H - y1)); ctx.strokePath()
  }
  private static func disc(_ ctx: CGContext, _ cx: Int, _ cyTop: Int, _ r: Int, _ v: CGFloat, fill: Bool = true, lw: CGFloat = 2) {
    let rect = CGRect(x: cx - r, y: H - cyTop - r, width: 2 * r, height: 2 * r)
    if fill { ctx.setFillColor(g(v)); ctx.fillEllipse(in: rect) }
    else { ctx.setStrokeColor(g(v)); ctx.setLineWidth(lw); ctx.strokeEllipse(in: rect) }
  }
  private static func arcRing(_ ctx: CGContext, _ cx: Int, _ cyTop: Int, _ r: Int, _ v: CGFloat, _ lw: CGFloat = 3) {
    ctx.setStrokeColor(g(v)); ctx.setLineWidth(lw)
    ctx.addArc(center: CGPoint(x: cx, y: H - cyTop), radius: CGFloat(r), startAngle: 0, endAngle: 2 * .pi, clockwise: false)
    ctx.strokePath()
  }
  private static func roundRect(_ ctx: CGContext, _ x: Int, _ topY: Int, _ w: Int, _ h: Int, _ rad: CGFloat, _ v: CGFloat) {
    let rect = CGRect(x: x, y: H - topY - h, width: w, height: h)
    let p = CGPath(roundedRect: rect, cornerWidth: rad, cornerHeight: rad, transform: nil)
    ctx.addPath(p); ctx.setFillColor(g(v)); ctx.fillPath()
  }

  /// Top-down text; y is the TOP of the glyph box (approx), converted to a CG baseline.
  private static func text(_ ctx: CGContext, _ s: String, _ x: Int, _ topY: Int, _ size: CGFloat, _ v: CGFloat, bold: Bool = true) {
    let font = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
    let attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: g(v)]
    guard let attr = CFAttributedStringCreate(nil, s as CFString, attrs as CFDictionary) else { return }
    let l = CTLineCreateWithAttributedString(attr)
    // baseline ≈ topY + ascent; CG native y = H - baseline
    let baseline = CGFloat(topY) + size * 0.82
    ctx.textMatrix = .identity
    ctx.textPosition = CGPoint(x: CGFloat(x), y: CGFloat(H) - baseline)
    CTLineDraw(l, ctx)
  }

  // MARK: - components

  private static func header(_ ctx: CGContext, _ m: Model) {
    text(ctx, m.time, 22, 6, 78, 1.0)
    text(ctx, m.date, 26, 90, 26, 0.8, bold: false)
    let batt = "\(m.battery)%"
    text(ctx, batt, W - 138, 16, 30, 1.0)
    let bx = W - 52, by = 18
    strokeRect(ctx, bx, by, 34, 18, 1.0, 2)
    fillRect(ctx, bx + 34, by + 5, 4, 8, 1.0)
    fillRect(ctx, bx + 2, by + 2, max(0, Int(30.0 * Double(m.battery) / 100.0)), 14, 1.0)
    line(ctx, 22, 122, W - 22, 122, 0.47, 2)
  }

  private static func dots(_ ctx: CGContext, _ active: Int) {
    let n = TILE_COUNT, gap = 26, x0 = W / 2 - (n - 1) * gap / 2, y = H - 20
    for i in 0..<n {
      let x = x0 + i * gap
      if i == active { disc(ctx, x, y, 5, 1.0) }
      else { disc(ctx, x, y, 3, 0.6, fill: false) }
    }
  }

  private static func tileBody(_ ctx: CGContext, _ m: Model) {
    icon(ctx, m.tile, 52, 176, 26, 1.0)
    text(ctx, TITLES[m.tile], 96, 140, 28, 0.69)
    switch m.tile {
    case 0: text(ctx, m.calendarTitle, 96, 166, 40, 1.0); text(ctx, m.calendarSub, 96, 214, 26, 0.8, bold: false)
    case 1: text(ctx, m.stockA, 96, 166, 38, 1.0); text(ctx, m.stockB, 96, 214, 26, 0.8, bold: false)
    case 2: text(ctx, m.newsTitle, 96, 166, 32, 1.0); text(ctx, m.newsSub, 96, 210, 24, 0.78, bold: false)
    case 3: text(ctx, m.healthA, 96, 166, 38, 1.0); text(ctx, m.healthB, 96, 214, 26, 0.8, bold: false)
    case 4: text(ctx, m.todo1, 96, 164, 28, 1.0); text(ctx, m.todo2, 96, 202, 28, 0.8, bold: false)
    default: text(ctx, m.statusA, 96, 166, 38, 1.0); text(ctx, m.statusB, 96, 214, 26, 0.8, bold: false)
    }
  }

  private static func renderExpanded(_ m: Model) -> [UInt8] {
    quantize(renderGray { ctx in
      icon(ctx, m.tile, 40, 34, 22, 1.0)
      text(ctx, TITLES[m.tile], 74, 12, 40, 1.0)
      // down chevron (expanded)
      line(ctx, W - 64, 26, W - 48, 44, 1.0, 4); line(ctx, W - 48, 44, W - 32, 26, 1.0, 4)
      // list (calendar rows if present, else the summary)
      let rows = m.calendarRows.isEmpty ? [(m.calendarSub.isEmpty ? "—" : m.calendarTitle, m.calendarSub)] : m.calendarRows
      var y = 78
      for (i, r) in rows.enumerated() {
        if i == 0 { roundRect(ctx, 16, y - 6, W - 32, 46, 8, 0.24) }   // focus glow (brightness)
        let v: CGFloat = i == 0 ? 1.0 : 0.9
        text(ctx, r.0, 28, y, 30, v, bold: i == 0)
        text(ctx, r.1, 150, y, 30, v, bold: i == 0)
        y += 50
        if y > H - 30 { break }
      }
    })
  }

  // MARK: - vector icons (our own; stock uses baked bitmaps we can't extract)

  private static func icon(_ ctx: CGContext, _ tile: Int, _ cx: Int, _ cyTop: Int, _ r: Int, _ v: CGFloat) {
    switch tile {
    case 0: // calendar
      strokeRect(ctx, cx - r, cyTop - r + 3, 2 * r, 2 * r - 3, v, 3)
      line(ctx, cx - r, cyTop - r + 11, cx + r, cyTop - r + 11, v, 3)
      line(ctx, cx - r / 2, cyTop - r - 2, cx - r / 2, cyTop - r + 5, v, 3)
      line(ctx, cx + r / 2, cyTop - r - 2, cx + r / 2, cyTop - r + 5, v, 3)
    case 1: // stock line up
      line(ctx, cx - r, cyTop + r / 2, cx - r / 3, cyTop - r / 3, v, 3)
      line(ctx, cx - r / 3, cyTop - r / 3, cx + r / 5, cyTop + r / 5, v, 3)
      line(ctx, cx + r / 5, cyTop + r / 5, cx + r, cyTop - r, v, 3)
    case 2: // news
      strokeRect(ctx, cx - r, cyTop - r, 2 * r, 2 * r, v, 3)
      var yy = cyTop - r + 7
      while yy < cyTop + r - 3 { line(ctx, cx - r + 6, yy, cx + r - 6, yy, v, 2); yy += 7 }
    case 3: // heartbeat
      line(ctx, cx - r, cyTop, cx - r / 2, cyTop, v, 3)
      line(ctx, cx - r / 2, cyTop, cx - r / 4, cyTop - r / 2, v, 3)
      line(ctx, cx - r / 4, cyTop - r / 2, cx, cyTop + r / 2, v, 3)
      line(ctx, cx, cyTop + r / 2, cx + r / 4, cyTop - r / 3, v, 3)
      line(ctx, cx + r / 4, cyTop - r / 3, cx + r / 2, cyTop, v, 3)
      line(ctx, cx + r / 2, cyTop, cx + r, cyTop, v, 3)
    case 4: // list
      var yy = cyTop - r + 2
      while yy < cyTop + r {
        disc(ctx, cx - r + 2, yy, 2, v)
        line(ctx, cx - r + 10, yy, cx + r, yy, v, 2); yy += 10
      }
    default: // status ring
      arcRing(ctx, cx, cyTop, r, v, 3)
      line(ctx, cx, cyTop, cx, cyTop - r + 5, v, 3)
      line(ctx, cx, cyTop, cx + r / 2, cyTop, v, 3)
    }
  }
}
