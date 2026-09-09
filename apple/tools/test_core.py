#!/usr/bin/env python3
"""Compare the Apple core with current Android constants and independent Python wire encoders."""
import ast
import base64
import binascii
import json
import re
import struct
import subprocess
import zlib
from pathlib import Path

APPLE = Path(__file__).resolve().parents[1]
WORKSPACE = APPLE.parent.parent
OUT = APPLE / 'build/tests'
OUT.mkdir(parents=True, exist_ok=True)
def b64(d): return base64.b64encode(d).decode()
def wire(body):
    chunks = [body[i:i+236] for i in range(0,len(body),236)] or [b'']
    if len(chunks[-1]) == 236: chunks.append(b'')
    crc = struct.pack('<H', binascii.crc_hqx(body, 0xffff))
    return [(bytes([0xaa,0x21,7,len(c)+(2 if i==len(chunks)-1 else 0),len(chunks),i+1,0x90,0])+c+(crc if i==len(chunks)-1 else b'')).hex() for i,c in enumerate(chunks)]
source = (WORKSPACE/'g2flash/g2flash.py').read_text()
tree = ast.parse(source)
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ['crc16','frames']]
namespace = {'struct':struct, 'CHUNK':232}
exec(compile(ast.Module(body=functions,type_ignores=[]),'g2flash.py','exec'),namespace)
kt = (APPLE.parent/'modules/ffs-ble/android/src/main/java/expo/modules/ffsble/G2Flash.kt').read_text()
vectors = re.findall(r'val golden\w+ = GoldenVector\(\s*"([0-9a-f]{64})",\s*(\d+)L,\s*(0x[0-9A-Fa-f]+)L,',kt)
body = b'hello'
ffsc = b'FFSC'+struct.pack('<BBHHHI',1,0,14,2,len(body),zlib.crc32(body))+body
fxp1 = b'FXP1'+struct.pack('<II',len(ffsc),zlib.crc32(ffsc))+ffsc
fixtures = {'wire':[], 'ota':[], 'goldenCount':len(vectors),'goldens':{sha:{'ps':int(ps),'end':int(end,16)} for sha,ps,end in vectors},'ffsc':fxp1.hex(),'buzzerHeader':(b'FBSQ'+struct.pack('<BBBBHHHHII',2,2,5,0,42,3,1024,128,zlib.crc32(b'\xaa'*1024),32768)).hex()}
for length in [0,1,40,234,235,236,237,472,1024,4096,6144]:
    payload = bytes(i%251 for i in range(length))
    fixtures['wire'].append({'body':b64(payload),'packets':wire(payload)})
    fixtures['ota'].append({'body':b64(payload),'packets':[p.hex() for p in namespace['frames'](0xc1,payload,seq=9)]})
fixture_path=OUT/'fixtures.json'; fixture_path.write_text(json.dumps(fixtures))
core = APPLE/'FFSBridge/Core'
sources = [core/n for n in ['Wire.swift','PeerRecovery.swift','Firmware.swift','Framebuffer.swift','BuzzerWire.swift','DeveloperCrypto.swift','STT.swift']]
subprocess.run(['xcrun','swiftc','-O',*[str(s) for s in sources],str(APPLE/'Tests/CoreTests.swift'),'-o',str(OUT/'core-tests')],check=True)
subprocess.run([str(OUT/'core-tests'),str(fixture_path),str(WORKSPACE/'g2flash/g2_2.2.7.14.bin')],check=True)
