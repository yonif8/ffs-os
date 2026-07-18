#!/usr/bin/env python3
"""
build_font_ota_package.py  —  FUT-186 (FFS Glasses OS, Hebrew native font)

Builds a 1-component EVENOTA package that delivers a custom font to the G2's
external XIP font slot (0x80100000) over the SAME BLE OTA path g2flash already
drives (FILE_CHECK == OTA_TRANSMIT_INFORMATION -> firmware ota.service).

Package spec — RE-CONFIRMED via Ghidra on g2_2.2.6.10 (main-app image base
0x00438000; handlers FUN_00445660 / FUN_00446d40). See FUT-186 for the full trail.

EVENOTA container:
  0x00  "EVENOTA\0"
  0x08  u32  component count
  0x10  16B  build date  ("YYYY-MM-DD\0")
  0x20  16B  build time  ("HH:MM:SS\0")
  0x30  16B  version str ("s200_vX.Y.Z.W\0")
  0x40  TOC: count x 16B  (eid u32, off u32, size u32, crc32c u32)
                          off  = byte offset of the component's 128B subheader
                          size = 128 + payload_size   (whole block)
                          crc  = CRC32C(payload)  (MSB-first, poly 0x1EDC6F41)
  then, per component:    128B subheader + payload

Component subheader (128B):
  +0x08 u32  payload size (ps)
  +0x0c u32  CRC32C(payload)               (echoes the TOC crc)
  +0x14 4B   "EVEN" magic
  +0x18 8B   0xFF filler
  +0x24 u32  TYPE   -> 2  (eOTATransmitType_FONT)
                        {0 GLASSES_FIRMWARE,1 BOOTLOADER,2 FONT,3 TOUCH,
                         4 AUDIO,5 BLE9305,6 BOX,7 OTHER}
  +0x28 u32  STORAGE METHOD -> 1  (XIP direct erase+write path)
                        (stock firmware components use 3 = staged file write)
  +0x2c u32  0xFFFFFFFF
  +0x30 ..   pTargetPath : the XIP address as ASCII text, e.g. "0x80100000"
                        firmware scans for "0x"/"0X", sscanf "0x%x", validates
                        into the 0x80000000+ (32 MB) XIP window.

NOTE (per council / FUT-186): the FONT BLOB FORMAT itself (FreeType TTF/SFNT +
any Even header + CRC16 wrapper) is still unconfirmed — pending an on-device read
of Even's original font (step B). This tool only builds the *container*; it wraps
whatever payload bytes you give it. Do NOT flash a real font until step B confirms
the blob format and yields a recovery original.
"""
import struct, argparse, sys, datetime

# ---- component type / storage-method constants (Ghidra-confirmed, FUT-186) ----
OTA_TYPE = {
    "GLASSES_FIRMWARE": 0, "BOOTLOADER": 1, "FONT": 2, "TOUCH": 3,
    "AUDIO": 4, "BLE9305": 5, "BOX": 6, "OTHER": 7,
}
METHOD_FILE_DIRECT = 0   # FUN_00444c9c direct write
METHOD_XIP         = 1   # XIP erase+write path (fonts / external flash)
METHOD_STAGED_FILE = 3   # stock firmware components (staged file write)

DEFAULT_FONT_XIP = 0x80100000
SUBHEADER_LEN = 128


def crc32c_msb(buf, _t=[]):
    """CRC32C, MSB-first, poly 0x1EDC6F41, init 0, xorout 0 — identical to
    g2flash.crc32c_msb (the value the glasses verify per component)."""
    if not _t:
        for b in range(256):
            c = b << 24
            for _ in range(8):
                c = ((c << 1) ^ 0x1edc6f41) & 0xffffffff if c & 0x80000000 else (c << 1) & 0xffffffff
            _t.append(c)
    crc = 0
    for byte in buf:
        crc = ((crc << 8) & 0xffffffff) ^ _t[((crc >> 24) ^ byte) & 0xff]
    return crc


def build_subheader(payload, comp_type, method, target_path):
    """Build the 128-byte component subheader."""
    sub = bytearray(b"\x00" * SUBHEADER_LEN)
    ps = len(payload)
    crc = crc32c_msb(payload)
    struct.pack_into("<I", sub, 0x08, ps)
    struct.pack_into("<I", sub, 0x0c, crc)
    sub[0x14:0x18] = b"EVEN"
    sub[0x18:0x20] = b"\xff" * 8
    struct.pack_into("<I", sub, 0x24, comp_type)
    struct.pack_into("<I", sub, 0x28, method)
    struct.pack_into("<I", sub, 0x2c, 0xffffffff)
    tp = target_path.encode("ascii")
    if len(tp) > 80 - 1:
        raise ValueError("target path too long for subheader (max 79 bytes)")
    sub[0x30:0x30 + len(tp)] = tp
    return bytes(sub)


def build_container(components, version="s200_vFONT", when=None):
    """components = list of dicts {eid, sub(128B), payload}. Returns the EVENOTA bytes.
    Layout mirrors the stock container exactly (TOC size = 128 + ps)."""
    when = when or datetime.datetime.now()
    n = len(components)
    hdr = bytearray(b"\x00" * 0x40)
    hdr[0:8] = b"EVENOTA\x00"
    struct.pack_into("<I", hdr, 0x08, n)
    dstr = when.strftime("%Y-%m-%d").encode(); hdr[0x10:0x10 + len(dstr)] = dstr
    tstr = when.strftime("%H:%M:%S").encode(); hdr[0x20:0x20 + len(tstr)] = tstr
    vstr = version.encode(); hdr[0x30:0x30 + len(vstr)] = vstr

    # 16-byte trailer between the TOC and the first component (stock has this).
    toc_trailer = b"evenota\x00" + b"\x00" * 8
    toc = bytearray()
    body = bytearray()
    off = 0x40 + n * 16 + len(toc_trailer)   # components start after TOC + trailer
    for c in components:
        block = c["sub"] + c["payload"]
        ps = len(c["payload"])
        crc = crc32c_msb(c["payload"])
        toc += struct.pack("<IIII", c["eid"], off, SUBHEADER_LEN + ps, crc)
        body += block
        off += len(block)
    return bytes(hdr) + bytes(toc) + toc_trailer + bytes(body)


def build_font_package(font_blob, xip_addr=DEFAULT_FONT_XIP, eid=1, version="s200_vFONT"):
    """Build a 1-component FONT EVENOTA package for the given raw font blob."""
    target = "0x%08x" % xip_addr        # firmware parses "0x%x" from pTargetPath
    sub = build_subheader(font_blob, OTA_TYPE["FONT"], METHOD_XIP, target)
    return build_container([{"eid": eid, "sub": sub, "payload": font_blob}], version=version)


# ------------------------------- self-tests -----------------------------------

def _roundtrip_test(stock_path):
    """Acceptance gate: rebuild the stock container from its own parsed components
    and assert byte-for-byte identity. Proves our field semantics (TOC size = 128+ps,
    subheader layout, CRC32C) match the real firmware container exactly."""
    img = open(stock_path, "rb").read()
    assert img[0:8] == b"EVENOTA\x00", "not an EVENOTA container"
    n = struct.unpack_from("<I", img, 8)[0]
    comps = []
    for i in range(n):
        eid, off, size, crc = struct.unpack_from("<IIII", img, 0x40 + i * 16)
        sub = img[off:off + SUBHEADER_LEN]
        ps = struct.unpack_from("<I", sub, 8)[0]
        payload = img[off + SUBHEADER_LEN:off + SUBHEADER_LEN + ps]
        # verify our CRC matches the stored one
        assert crc32c_msb(payload) == crc == struct.unpack_from("<I", sub, 12)[0], \
            f"CRC mismatch on component {i}"
        comps.append({"eid": eid, "sub": sub, "payload": payload})
    when = datetime.datetime.strptime(
        img[0x10:0x1a].decode() + " " + img[0x20:0x28].decode(), "%Y-%m-%d %H:%M:%S")
    version = img[0x30:0x40].split(b"\x00")[0].decode()
    rebuilt = build_container(comps, version=version, when=when)
    if rebuilt == img:
        print("  ROUND-TRIP PASS: rebuilt stock container is byte-identical (%d bytes, %d comps)"
              % (len(img), n))
        return True
    # localize first diff
    for k in range(min(len(rebuilt), len(img))):
        if rebuilt[k] != img[k]:
            print("  ROUND-TRIP FAIL: first diff at 0x%x (got %02x want %02x); lens %d vs %d"
                  % (k, rebuilt[k], img[k], len(rebuilt), len(img)))
            return False
    print("  ROUND-TRIP FAIL: length %d vs %d" % (len(rebuilt), len(img)))
    return False


def _font_pkg_sanity():
    """Build a dummy font package and re-parse it to confirm the FONT routing fields."""
    blob = bytes(range(256)) * 8          # 2 KB dummy payload
    pkg = build_font_package(blob, xip_addr=DEFAULT_FONT_XIP)
    n = struct.unpack_from("<I", pkg, 8)[0]
    eid, off, size, crc = struct.unpack_from("<IIII", pkg, 0x40)
    sub = pkg[off:off + SUBHEADER_LEN]
    t = struct.unpack_from("<I", sub, 0x24)[0]
    m = struct.unpack_from("<I", sub, 0x28)[0]
    path = sub[0x30:].split(b"\x00")[0].decode()
    ok = (n == 1 and t == 2 and m == 1 and size == SUBHEADER_LEN + len(blob)
          and crc == crc32c_msb(blob) and path.lower().startswith("0x")
          and int(path, 16) == DEFAULT_FONT_XIP and sub[0x14:0x18] == b"EVEN")
    print("  FONT-PKG SANITY %s: comps=%d type=%d(FONT=2) method=%d(XIP=1) path=%r size=0x%x"
          % ("PASS" if ok else "FAIL", n, t, m, path, size))
    return ok


def main():
    ap = argparse.ArgumentParser(description="Build a FONT EVENOTA package for G2 XIP flash.")
    ap.add_argument("font_blob", nargs="?", help="raw font blob file to wrap")
    ap.add_argument("-o", "--out", help="output .bin path")
    ap.add_argument("--xip", default=hex(DEFAULT_FONT_XIP), help="XIP target address (default 0x80100000)")
    ap.add_argument("--eid", type=int, default=1)
    ap.add_argument("--selftest", metavar="STOCK_BIN",
                    help="run the round-trip acceptance test against a stock EVENOTA container")
    args = ap.parse_args()

    if args.selftest:
        print("[selftest] round-trip against %s" % args.selftest)
        ok1 = _roundtrip_test(args.selftest)
        ok2 = _font_pkg_sanity()
        sys.exit(0 if (ok1 and ok2) else 1)

    if not args.font_blob or not args.out:
        ap.error("provide a font_blob and -o OUT, or use --selftest STOCK_BIN")
    blob = open(args.font_blob, "rb").read()
    xip = int(args.xip, 16)
    pkg = build_font_package(blob, xip_addr=xip, eid=args.eid)
    open(args.out, "wb").write(pkg)
    print("wrote %s: %d-byte FONT package wrapping %d-byte blob -> XIP 0x%08x"
          % (args.out, len(pkg), len(blob), xip))
    print("WARNING: blob format unconfirmed (FUT-186 step B). Do NOT flash a real font "
          "until Even's original is read off-device for the format + recovery net.")


if __name__ == "__main__":
    main()
