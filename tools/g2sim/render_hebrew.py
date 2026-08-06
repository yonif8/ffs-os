#!/usr/bin/env python3
"""
Prove Hebrew renders in OUR pixel pipeline (FUT-179) — off-glass.

Even's stock firmware can't show Hebrew (its baked font has no Hebrew glyphs, FUT-178).
But our apps rasterize text on the phone and stream PIXELS (mode-2), so with a Hebrew
font + RTL shaping we render Hebrew fine — no firmware change for OUR screens. This proves
the concept in the simulator (PIL+RAQM does the RTL shaping, same as CoreText on-device).
"""
from __future__ import annotations
import sys
from PIL import Image, ImageDraw, ImageFont
from g2frame import W, H, encode_mode2, decode_mode2, buffer_to_png

HEB = "/usr/share/fonts/truetype/ibm-plex/IBMPlexSansHebrew-Medium.ttf"
LAT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def q4(img): return img.point(lambda g: (g >> 4) * 17)

def rtl(d, s, right_x, y, size, v=255):
    """Draw Hebrew right-aligned with RTL shaping (anchor to the right edge)."""
    f = ImageFont.truetype(HEB, size)
    d.text((right_x, y), s, font=f, fill=v, direction="rtl", anchor="ra", language="he")

def render() -> bytes:
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    # header: time (LTR) left, Hebrew greeting (RTL) right
    d.text((22, 6), "14:32", font=ImageFont.truetype(LAT, 78), fill=255)
    rtl(d, "בוקר טוב", W - 24, 22, 44, 255)          # "Good morning"
    d.line([(22, 122), (W - 24, 122)], fill=120, width=2)
    # a Hebrew widget: weather
    rtl(d, "מזג אוויר", W - 24, 138, 30, 180)          # "Weather"
    rtl(d, "24° בהיר", W - 24, 172, 44, 255)           # "24° Clear"
    # a Hebrew agenda line (mixed with an LTR time)
    rtl(d, "פגישה עם הספק", W - 24, 226, 32, 235)      # "Meeting with the supplier"
    d.text((22, 232), "15:00", font=ImageFont.truetype(LAT, 30), fill=235)
    return q4(img).tobytes()

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "hebrew_proof.png"
    buf = render()
    p = encode_mode2(buf); assert decode_mode2(p) == buf
    buffer_to_png(decode_mode2(p), out)
    print(f"OK Hebrew render: mode-2 {len(p)}B -> {out}")
