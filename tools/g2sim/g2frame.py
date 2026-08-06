#!/usr/bin/env python3
"""
g2sim — off-glass render simulator for the FFS Glasses OS (FUT-177).

The G2 CFW display frame (see modules/ffs-ble/ios/G2Anim.swift, FUT-165) is:

    mode-2 payload = [0x02] + RFC1950-zlib( 8bpp W*H pixels, row-major TOP-DOWN )

  - W=576, H=288, monochrome green µLED HUD, 0=black .. 255=brightest.
  - zlib stream = 0x78 0x9C + raw-deflate + big-endian adler32 (standard zlib,
    so python `zlib.decompress` reads it directly).

This module is the ground-truth codec + PNG renderer: it decodes the EXACT bytes
the app would stream to the glasses into a screenshot of what the HUD would show,
and can re-encode a buffer to verify a round-trip against the Swift wire format.
"""
from __future__ import annotations
import struct, zlib
from PIL import Image

W, H = 576, 288
N = W * H


def adler32(buf: bytes) -> int:
    return zlib.adler32(buf) & 0xFFFFFFFF


def encode_mode2(pixels: bytes) -> bytes:
    """8bpp W*H buffer -> CFW mode-2 wire payload (matches G2Anim.mode2Payload)."""
    assert len(pixels) == N, f"expected {N} px, got {len(pixels)}"
    # Build a valid RFC1950 stream exactly like Swift does: 0x78 0x9c + raw
    # deflate body + big-endian adler32 (Swift uses Apple Compression raw deflate).
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    body = co.compress(pixels) + co.flush()
    out = bytearray()
    out.append(0x02)               # CFW image mode 2
    out += b"\x78\x9c"             # zlib RFC1950 header
    out += body                    # raw deflate body
    out += struct.pack(">I", adler32(pixels))  # big-endian adler32
    return bytes(out)


def decode_mode2(payload: bytes) -> bytes:
    """CFW mode-2 payload -> 8bpp W*H buffer (top-down)."""
    assert payload and payload[0] == 0x02, "not a mode-2 payload"
    pixels = zlib.decompress(payload[1:])   # 0x78 0x9c + deflate + adler32 = std zlib
    assert len(pixels) == N, f"decoded {len(pixels)} px, expected {N}"
    return pixels


def buffer_to_png(pixels: bytes, path: str, scale: int = 1, green: bool = True) -> str:
    """Render an 8bpp buffer as the G2 would show it (green phosphor on black)."""
    img = Image.frombytes("L", (W, H), pixels)  # L = 8bpp grayscale, top-down
    if green:
        rgb = Image.merge("RGB", (
            img.point(lambda g: int(g * 0.15)),  # R
            img,                                  # G (the µLED green)
            img.point(lambda g: int(g * 0.28)),  # B
        ))
    else:
        rgb = img.convert("RGB")
    if scale != 1:
        rgb = rgb.resize((W * scale, H * scale), Image.NEAREST)
    rgb.save(path)
    return path


def payload_to_png(payload: bytes, path: str, scale: int = 1) -> str:
    return buffer_to_png(decode_mode2(payload), path, scale=scale)


if __name__ == "__main__":
    # self-test: round-trip a gradient through encode->decode
    grad = bytes(((x * 255) // W) for _ in range(H) for x in range(W))
    p = encode_mode2(grad)
    back = decode_mode2(p)
    assert back == grad, "round-trip mismatch!"
    print(f"round-trip OK — payload {len(p)}B for {N}px ({len(p)*100//N}% of raw)")
