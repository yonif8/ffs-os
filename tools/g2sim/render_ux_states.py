#!/usr/bin/env python3
"""
Reproduce stock-dashboard UX states in the off-glass simulator (FUT-178).

Renders the interaction states Yoni called out — the long-hold LEFT menu with a
DIMMED background, plus expand/collapse of a section — into 8bpp 576x288 buffers,
then through the real mode-2 wire format -> green-HUD PNG. These are design targets
for the Swift dashboard build (FUT-176), reproduced here without glasses/CFW.
"""
from __future__ import annotations
import sys
from PIL import Image, ImageDraw, ImageFont
from g2frame import W, H, encode_mode2, decode_mode2, buffer_to_png

F = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
def font(sz, bold=True): return ImageFont.truetype(F if bold else FR, sz)


# ---------- simple vector icons (drawn crisp, like the stock icon craft) ----------
def icon_gear(d, cx, cy, r, v=255):
    d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=v, width=3)
    d.ellipse([cx-r//3, cy-r//3, cx+r//3, cy+r//3], fill=v)
    import math
    for k in range(8):
        a = k*math.pi/4
        x1, y1 = cx+int((r-1)*math.cos(a)), cy+int((r-1)*math.sin(a))
        x2, y2 = cx+int((r+5)*math.cos(a)), cy+int((r+5)*math.sin(a))
        d.line([x1,y1,x2,y2], fill=v, width=4)

def icon_sun(d, cx, cy, r, v=255):
    d.ellipse([cx-r//2, cy-r//2, cx+r//2, cy+r//2], outline=v, width=3)
    import math
    for k in range(8):
        a = k*math.pi/4
        x1,y1 = cx+int((r*0.7)*math.cos(a)), cy+int((r*0.7)*math.sin(a))
        x2,y2 = cx+int(r*math.cos(a)), cy+int(r*math.sin(a))
        d.line([x1,y1,x2,y2], fill=v, width=3)

def icon_bell(d, cx, cy, r, v=255):
    d.pieslice([cx-r, cy-r, cx+r, cy+r], 180, 360, outline=v, width=3)
    d.line([cx-r, cy, cx-r, cy+3], fill=v, width=3)
    d.line([cx+r, cy, cx+r, cy+3], fill=v, width=3)
    d.line([cx-r-2, cy+4, cx+r+2, cy+4], fill=v, width=3)
    d.ellipse([cx-3, cy+6, cx+3, cy+12], fill=v)

def icon_calendar(d, cx, cy, r, v=255):
    d.rectangle([cx-r, cy-r+3, cx+r, cy+r], outline=v, width=3)
    d.line([cx-r, cy-r+12, cx+r, cy-r+12], fill=v, width=3)
    d.line([cx-r//2, cy-r-2, cx-r//2, cy-r+6], fill=v, width=3)
    d.line([cx+r//2, cy-r-2, cx+r//2, cy-r+6], fill=v, width=3)

def icon_chart(d, cx, cy, r, v=255):
    for i,h in enumerate([0.4,0.75,0.55,1.0]):
        x = cx-r + i*(2*r//4)
        d.rectangle([x, cy+r-int(2*r*h), x+ (2*r//4)-4, cy+r], fill=v)


def base_dashboard(d):
    d.text((24, 6), "14:32", font=font(104), fill=255)
    d.text((30, 126), "Sat 18 Jul", font=font(32), fill=205)
    d.text((W-150, 18), "82%", font=font(38), fill=255)
    bx, by = W-58, 24
    d.rectangle([bx, by, bx+40, by+22], outline=255, width=3)
    d.rectangle([bx+40, by+6, bx+45, by+16], fill=255)
    d.rectangle([bx+2, by+2, bx+2+int(36*0.82), by+20], fill=255)
    d.line([(24,178),(W-24,178)], fill=130, width=2)
    d.text((24, 196), "WEATHER", font=font(24), fill=165)
    d.text((24, 224), "24° Sun", font=font(38), fill=255)
    d.text((330, 196), "NEXT UP", font=font(24), fill=165)
    d.text((330, 224), "Standup 15:00", font=font(30), fill=255)


def render_menu_dim() -> bytes:
    """Long-hold: LEFT menu slides in, background dims. The hero interaction."""
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    base_dashboard(d)
    # dim the whole background (multiply toward black) — like the stock dim overlay
    img = img.point(lambda g: int(g * 0.30))
    d = ImageDraw.Draw(img)
    # left panel
    pw = 250
    d.rectangle([0, 0, pw, H], fill=8)
    d.line([(pw, 0), (pw, H)], fill=200, width=3)
    items = [
        ("gear", "Settings"),
        ("sun", "Weather"),
        ("calendar", "Calendar"),
        ("bell", "Notifications"),
        ("chart", "Stocks"),
    ]
    icons = {"gear":icon_gear,"sun":icon_sun,"calendar":icon_calendar,"bell":icon_bell,"chart":icon_chart}
    y = 26
    for i,(ic,label) in enumerate(items):
        sel = (i == 1)  # highlighted row
        if sel:
            d.rounded_rectangle([10, y-6, pw-14, y+42], radius=10, fill=70)
        v = 255 if sel else 200
        icons[ic](d, 40, y+18, 16, v=v)
        d.text((72, y+4), label, font=font(30, bold=sel), fill=v)
        y += 52
    return img.tobytes()


def render_expanded() -> bytes:
    """A section expanded (chevron down + content) vs the collapsed peers."""
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    d.text((22, 8), "Weather", font=font(40), fill=255)
    # down chevron (expanded)
    d.line([(W-70, 26),(W-52,44)], fill=255, width=4); d.line([(W-52,44),(W-34,26)], fill=255, width=4)
    icon_sun(d, 60, 110, 40, v=255)
    d.text((120, 74), "24°", font=font(60), fill=255)
    d.text((122, 138), "Sunny · feels 22°", font=font(28), fill=205)
    d.text((22, 190), "H 27°   L 16°   Wind 8kph", font=font(28), fill=185)
    # collapsed peer row below, dimmer, right chevron
    d.line([(22,238),(W-22,238)], fill=90, width=2)
    d.text((22, 248), "Calendar", font=font(30), fill=150)
    d.line([(W-60,254),(W-46,266)], fill=150, width=3); d.line([(W-46,266),(W-60,278)], fill=150, width=3)
    return img.tobytes()


STATES = {"menu_dim": render_menu_dim, "expanded": render_expanded}

if __name__ == "__main__":
    outdir = sys.argv[1] if len(sys.argv) > 1 else "."
    for name, fn in STATES.items():
        buf = fn()
        payload = encode_mode2(buf)
        assert decode_mode2(payload) == buf, f"{name} wire round-trip mismatch"
        p = f"{outdir}/ux_{name}.png"
        buffer_to_png(decode_mode2(payload), p)
        print(f"OK {name}: mode-2 {len(payload)}B -> {p}")
