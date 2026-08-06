#!/usr/bin/env python3
"""
FFS dashboard design in the simulator (FUT-176), built to the reverse-engineered
stock spec (FUT-178): an LVGL-tileview model — persistent header + one swipeable
widget tile at a time (6 tiles) + position dots + per-widget EXPANDED page.
16-level Gray4 quantized to match the real panel. Design lab before the Swift port.
"""
from __future__ import annotations
import sys
from PIL import Image, ImageDraw, ImageFont
from g2frame import W, H, encode_mode2, decode_mode2, buffer_to_png

FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
def f(sz, bold=True): return ImageFont.truetype(FB if bold else FR, sz)

def quantize_gray4(img: Image.Image) -> Image.Image:
    """Match the panel: 16 grey levels (0x0..0xF scaled back to 0..255)."""
    return img.point(lambda g: (g >> 4) * 17)

# ---- vector icons (crisp, our own — stock uses baked bitmaps we can't extract) ----
import math
def i_cal(d,cx,cy,r,v=255):
    d.rounded_rectangle([cx-r,cy-r+3,cx+r,cy+r],radius=4,outline=v,width=3)
    d.line([cx-r,cy-r+11,cx+r,cy-r+11],fill=v,width=3)
    d.line([cx-r//2,cy-r-2,cx-r//2,cy-r+5],fill=v,width=3)
    d.line([cx+r//2,cy-r-2,cx+r//2,cy-r+5],fill=v,width=3)
def i_stock(d,cx,cy,r,v=255):
    pts=[(cx-r,cy+r//2),(cx-r//3,cy-r//3),(cx+r//5,cy+r//5),(cx+r,cy-r)]
    d.line(pts,fill=v,width=3,joint="curve")
    d.polygon([(cx+r-6,cy-r),(cx+r,cy-r),(cx+r,cy-r+6)],fill=v)
def i_news(d,cx,cy,r,v=255):
    d.rectangle([cx-r,cy-r,cx+r,cy+r],outline=v,width=3)
    for yy in range(cy-r+7,cy+r-3,7): d.line([cx-r+6,yy,cx+r-6,yy],fill=v,width=2)
def i_health(d,cx,cy,r,v=255):
    d.line([cx-r,cy, cx-r//2,cy, cx-r//4,cy-r//2, cx,cy+r//2, cx+r//4,cy-r//3, cx+r//2,cy, cx+r,cy],fill=v,width=3,joint="curve")
def i_list(d,cx,cy,r,v=255):
    for k,yy in enumerate(range(cy-r+2,cy+r,10)):
        d.ellipse([cx-r,yy-2,cx-r+4,yy+2],fill=v)
        d.line([cx-r+10,yy,cx+r,yy],fill=v,width=2)
def i_status(d,cx,cy,r,v=255):
    d.ellipse([cx-r,cy-r,cx+r,cy+r],outline=v,width=3)
    d.line([cx,cy,cx,cy-r+5],fill=v,width=3); d.line([cx,cy,cx+r//2,cy],fill=v,width=3)

TILES = ["calendar","stock","news","health","quicklist","status"]
ICONS = {"calendar":i_cal,"stock":i_stock,"news":i_news,"health":i_health,"quicklist":i_list,"status":i_status}
TITLES = {"calendar":"Calendar","stock":"Markets","news":"News","health":"Activity","quicklist":"To-Do","status":"Status"}

def header(d):
    d.text((22,4), "14:32", font=f(78), fill=255)
    d.text((26,84), "Sat 18 Jul", font=f(26), fill=204)
    d.text((W-138,14), "82%", font=f(30), fill=255)
    bx,by=W-52,18
    d.rectangle([bx,by,bx+34,by+18],outline=255,width=2); d.rectangle([bx+34,by+5,bx+38,by+13],fill=255)
    d.rectangle([bx+2,by+2,bx+2+int(30*0.82),by+16],fill=255)
    d.line([(22,122),(W-22,122)],fill=120,width=2)

def dots(d, active):
    n=len(TILES); gap=26; x0=W//2-(n-1)*gap//2; y=H-20
    for i in range(n):
        x=x0+i*gap
        if i==active: d.ellipse([x-5,y-5,x+5,y+5],fill=255)
        else: d.ellipse([x-3,y-3,x+3,y+3],outline=150,width=2)

def tile_body(d, name):
    ICONS[name](d, 52, 176, 26, v=255)
    d.text((96,140), TITLES[name], font=f(28), fill=175)
    if name=="calendar":
        d.text((96,168), "Standup", font=f(40), fill=255)
        d.text((96,214), "15:00 · Zoom", font=f(26), fill=205)
    elif name=="stock":
        d.text((96,168), "AAPL 231.4", font=f(38), fill=255)
        d.text((96,214), "▲ +1.2%   NDX +0.6%", font=f(26), fill=205)
    elif name=="news":
        d.text((96,166), "Fed holds rates", font=f(32), fill=255)
        d.text((96,210), "markets steady into close", font=f(24), fill=200)
    elif name=="health":
        d.text((96,168), "8,240 steps", font=f(38), fill=255)
        d.text((96,214), "68 bpm · 4.1 km", font=f(26), fill=205)
    elif name=="quicklist":
        d.text((96,166), "○ Ship dashboard", font=f(28), fill=255)
        d.text((96,204), "○ Call supplier", font=f(28), fill=205)
    else:
        d.text((96,168), "All synced", font=f(38), fill=255)
        d.text((96,214), "5 apps · signal good", font=f(26), fill=205)

def render_home(active=0) -> bytes:
    img=Image.new("L",(W,H),0); d=ImageDraw.Draw(img)
    header(d); tile_body(d, TILES[active]); dots(d, active)
    return quantize_gray4(img).tobytes()

def render_expanded_calendar() -> bytes:
    img=Image.new("L",(W,H),0); d=ImageDraw.Draw(img)
    i_cal(d,40,34,22,v=255); d.text((74,12),"Calendar",font=f(40),fill=255)
    d.line([(W-64,26),(W-48,44)],fill=255,width=4); d.line([(W-48,44),(W-32,26)],fill=255,width=4)
    rows=[("09:00","Standup",255),("11:30","Design review",235),("15:00","Supplier call",235),("18:00","Gym",200)]
    y=78
    for i,(t,label,v) in enumerate(rows):
        if i==0: d.rounded_rectangle([16,y-6,W-16,y+40],radius=8,fill=60)  # focus glow (brightness)
        d.text((28,y), t, font=f(30,bold=(i==0)), fill=v)
        d.text((150,y), label, font=f(30,bold=(i==0)), fill=v)
        y+=50
    return quantize_gray4(img).tobytes()

def emit(name, buf, outdir):
    p=encode_mode2(buf); assert decode_mode2(p)==buf
    out=f"{outdir}/dash_{name}.png"; buffer_to_png(decode_mode2(p),out)
    print(f"OK {name}: {len(p)}B -> {out}"); return out

if __name__=="__main__":
    outdir=sys.argv[1] if len(sys.argv)>1 else "."
    emit("home_calendar", render_home(0), outdir)
    emit("home_stock", render_home(1), outdir)
    emit("home_health", render_home(3), outdir)
    emit("expanded_calendar", render_expanded_calendar(), outdir)
