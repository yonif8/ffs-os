// An 8-bit-per-pixel raster canvas — the escape hatch from EvenHub's three container types.
//
// WHY THIS EXISTS. Everything EvenHub can draw is a list, a text box or a bitmap, and the
// renderer ignores every border, radius and padding field on text. That caps the UI at: one
// rounded rect (the list's selection highlight), one font, one size, no shapes, no lines. The
// stock Even dashboard is visibly past that ceiling because the firmware draws it directly.
//
// The CFW's image channel has a mode the phone never used: mode 2 inflates a zlib stream
// STRAIGHT INTO THE DISPLAY BUFFER at 8 bits per pixel and presents it. So a container-sized
// frame of arbitrary pixels can be drawn with no LVGL, no resident loader, and no flash — the
// pixels are composed here and the firmware owns and redraws them.
//
// 8bpp means 256 intensity levels on a monochrome emissive panel, which is four bits more than
// the 4-bit BMP path and enough for genuine antialiasing. That matters more than it sounds: a
// hard-edged diagonal on this display shimmers, and a smooth one does not.

/** A container-sized 8bpp frame. `data[y * width + x]` is one pixel, 0 = off, 255 = full. */
export class Raster {
  readonly data: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height);
  }

  clear(value = 0): this {
    this.data.fill(value);
    return this;
  }

  /** Bounds-checked single pixel. Out-of-range writes are dropped, never wrapped. */
  px(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[y * this.width + (x | 0)] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }

  /** Read, returning 0 outside the canvas so blending near an edge needs no special case. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[y * this.width + (x | 0)];
  }

  /** Lighten-only blend. The panel is emissive: drawing is adding light, so max() composites. */
  blend(x: number, y: number, v: number): void {
    if (v <= 0) return;
    const cur = this.at(x, y);
    if (v > cur) this.px(x, y, v);
  }

  fillRect(x: number, y: number, w: number, h: number, v = 255): this {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, v);
    return this;
  }

  /**
   * A rounded rectangle OUTLINE — the shape EvenHub can only produce as a list's selection
   * highlight, and only one of at a time. Here it costs nothing and there can be any number.
   *
   * `t` is stroke thickness, drawn inward so the shape never exceeds its declared box.
   */
  roundRect(x: number, y: number, w: number, h: number, r: number, v = 255, t = 2): this {
    const rr = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    for (let k = 0; k < t; k++) {
      const xx = x + k, yy = y + k, ww = w - 2 * k, hh = h - 2 * k, cr = Math.max(0, rr - k);
      // straight edges
      for (let i = cr; i < ww - cr; i++) {
        this.px(xx + i, yy, v);
        this.px(xx + i, yy + hh - 1, v);
      }
      for (let j = cr; j < hh - cr; j++) {
        this.px(xx, yy + j, v);
        this.px(xx + ww - 1, yy + j, v);
      }
      // four corner arcs, antialiased by distance from the corner radius
      for (let j = 0; j <= cr; j++) {
        for (let i = 0; i <= cr; i++) {
          const d = Math.sqrt(i * i + j * j);
          const a = 1 - Math.abs(d - cr);
          if (a <= 0) continue;
          const s = Math.round(v * Math.min(1, a));
          this.blend(xx + cr - i, yy + cr - j, s);
          this.blend(xx + ww - 1 - cr + i, yy + cr - j, s);
          this.blend(xx + cr - i, yy + hh - 1 - cr + j, s);
          this.blend(xx + ww - 1 - cr + i, yy + hh - 1 - cr + j, s);
        }
      }
    }
    return this;
  }

  /** A filled rounded rectangle — an iPhone-style tile, as many as you like. */
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, v = 255): this {
    const rr = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        // Distance into the nearest corner's quarter-circle; negative means "inside the box".
        const dx = i < rr ? rr - i : i >= w - rr ? i - (w - rr) + 1 : 0;
        const dy = j < rr ? rr - j : j >= h - rr ? j - (h - rr) + 1 : 0;
        if (dx === 0 || dy === 0) { this.px(x + i, y + j, v); continue; }
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= rr) this.px(x + i, y + j, v);
        else if (d < rr + 1) this.blend(x + i, y + j, Math.round(v * (rr + 1 - d)));
      }
    }
    return this;
  }

  /** Antialiased line (Xiaolin Wu style, simplified). Diagonals shimmer badly without this. */
  line(x0: number, y0: number, x1: number, y1: number, v = 255): this {
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
    if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const dx = x1 - x0;
    const grad = dx === 0 ? 1 : (y1 - y0) / dx;
    let y = y0;
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      const f = y - Math.floor(y);
      const a = Math.floor(y);
      if (steep) {
        this.blend(a, x, Math.round(v * (1 - f)));
        this.blend(a + 1, x, Math.round(v * f));
      } else {
        this.blend(x, a, Math.round(v * (1 - f)));
        this.blend(x, a + 1, Math.round(v * f));
      }
      y += grad;
    }
    return this;
  }

  /** Antialiased circle outline. */
  circle(cx: number, cy: number, r: number, v = 255, t = 2): this {
    const outer = r + t / 2;
    const inner = r - t / 2;
    for (let j = Math.floor(cy - outer - 1); j <= Math.ceil(cy + outer + 1); j++) {
      for (let i = Math.floor(cx - outer - 1); i <= Math.ceil(cx + outer + 1); i++) {
        const d = Math.sqrt((i - cx) * (i - cx) + (j - cy) * (j - cy));
        if (d > outer + 1 || d < inner - 1) continue;
        const a = Math.min(outer - d, d - inner, 1);
        if (a > 0) this.blend(i, j, Math.round(v * a));
      }
    }
    return this;
  }

  /** Filled circle, antialiased at the rim. */
  disc(cx: number, cy: number, r: number, v = 255): this {
    for (let j = Math.floor(cy - r - 1); j <= Math.ceil(cy + r + 1); j++) {
      for (let i = Math.floor(cx - r - 1); i <= Math.ceil(cx + r + 1); i++) {
        const d = Math.sqrt((i - cx) * (i - cx) + (j - cy) * (j - cy));
        if (d <= r) this.px(i, j, v);
        else if (d < r + 1) this.blend(i, j, Math.round(v * (r + 1 - d)));
      }
    }
    return this;
  }

  /** An arc outline between two angles (radians), for gauges. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, v = 255, t = 3): this {
    const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) * r));
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps;
      for (let k = -t / 2; k <= t / 2; k += 0.5) {
        this.blend(Math.round(cx + Math.cos(a) * (r + k)), Math.round(cy + Math.sin(a) * (r + k)), v);
      }
    }
    return this;
  }

  /**
   * The mode-2 payload: [0x02] followed by the zlib stream of exactly width*height bytes.
   *
   * The firmware reads width/height from the CONTAINER, not from this message, so the frame
   * must match the declared container exactly — a mismatch makes inflate stop short of
   * total_out == w*h and the frame is dropped with the previous one left on screen.
   */
  toMode2(zlib: (b: Uint8Array) => Uint8Array): Uint8Array {
    const z = zlib(this.data);
    const out = new Uint8Array(1 + z.length);
    out[0] = 0x02;
    out.set(z, 1);
    return out;
  }
}
