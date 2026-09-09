#!/usr/bin/env python3
"""Exercise production OTA sequencing against an in-memory peer; no hardware."""
from pathlib import Path
import subprocess
import sys

APPLE = Path(__file__).resolve().parents[1]
OUT = APPLE / 'build/flash-tests'
OUT.mkdir(parents=True, exist_ok=True)
image = Path(sys.argv[1]) if len(sys.argv) > 1 else APPLE.parents[1] / 'g2flash/g2_2.2.7.14.bin'
sources = [APPLE / 'FFSBridge/Core' / name for name in ['Wire.swift', 'Firmware.swift']]
sources += [APPLE / 'FFSBridge/Services/FirmwareFlasher.swift', APPLE / 'Tests/FlashTransferTests.swift']
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O', *map(str, sources), '-o', str(OUT / 'flash-tests')], check=True)
subprocess.run([str(OUT / 'flash-tests'), str(image)], check=True, timeout=40)
