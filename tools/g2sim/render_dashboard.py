#!/usr/bin/env python3
"""
Off-glass render of the FFS dashboard (app #1, FUT-176) into an 8bpp 576x288
buffer — the Linux-runnable mirror of the Swift renderDashboard() (FUT-177 path 2a).

This lets Rico SEE the dashboard layout without the glasses (Yoni is on stock) by
piping the buffer through g2frame -> PNG (green HUD). Keep this in visual sync with
the Swift render; the Swift is the shipping truth, this is the fast preview.
"""
from __future__ import annotations
import sys
from PIL import Image, ImageDraw, ImageFont
from g2frame import W, H, encode_mode2, decode_mode2, buffer_to_png

SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SERIF_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(sz, bold=True):
    return ImageFont.truetype(SERIF if bold else SERIF_R, sz)


def render_dashboard(state: dict) -> bytes:
    """Paint the dashboard into an 8bpp (mode 'L') buffer, top-down. 0=black..255=bright."""
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)

    # ---- Header: big time (left), battery (right) ----
    d.text((24, 8), state["time"], font=font(110), fill=255)
    # date under the time
    d.text((30, 132), state["date"], font=font(34), fill=210)

    # battery, top-right
    batt = f'{state["batt"]}%'
    bf = font(40)
    bw = d.textlength(batt, font=bf)
    d.text((W - bw - 70, 20), batt, font=bf, fill=255)
    # little battery glyph
    bx, by = W - 58, 24
    d.rectangle([bx, by, bx + 40, by + 22], outline=255, width=3)
    d.rectangle([bx + 40, by + 6, bx + 45, by + 16], fill=255)
    fillw = int(36 * state["batt"] / 100)
    d.rectangle([bx + 2, by + 2, bx + 2 + fillw, by + 20], fill=255)

    # ---- Divider ----
    d.line([(24, 188), (W - 24, 188)], fill=140, width=2)

    # ---- Widget row (3 glanceable widgets) ----
    cols = [24, 220, 400]
    labels = font(26)
    vals = font(40)
    for (x, w) in zip(cols, state["widgets"]):
        d.text((x, 208), w["label"], font=labels, fill=170)
        d.text((x, 238), w["value"], font=vals, fill=255)

    return img.tobytes()  # 'L' 8bpp top-down == our wire pixel order


SAMPLE = {
    "time": "14:32",
    "date": "Sat 18 Jul",
    "batt": 82,
    "widgets": [
        {"label": "WEATHER", "value": "24° Sun"},
        {"label": "NEXT", "value": "Standup"},
        {"label": "AAPL", "value": "+1.2%"},
    ],
}

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "dashboard_preview.png"
    buf = render_dashboard(SAMPLE)
    # round-trip through the REAL wire format so the preview == what the glass gets
    payload = encode_mode2(buf)
    assert decode_mode2(payload) == buf, "wire round-trip mismatch"
    buffer_to_png(decode_mode2(payload), out, scale=1)
    print(f"OK — dashboard rendered, mode-2 payload {len(payload)}B, PNG -> {out}")
