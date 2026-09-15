#!/usr/bin/env python3
"""Codex glasses wire tests; pass --live for a read-only KJDev handshake/list probe."""
from pathlib import Path
import subprocess
import sys

APPLE = Path(__file__).resolve().parents[1]
OUT = APPLE / 'build/codex-tests'
OUT.mkdir(parents=True, exist_ok=True)
core = APPLE / 'FFSBridge/Core'
services = APPLE / 'FFSBridge/Services'
sources = [core/'Wire.swift', core/'CodexWire.swift', services/'CodexRPC.swift', APPLE/'Tests/CodexTests.swift']
binary = OUT/'codex-tests'
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', *map(str, sources), '-o', str(binary)], check=True)
mode = '--soak' if '--soak' in sys.argv else '--live' if '--live' in sys.argv else None
subprocess.run([str(binary), *([mode] if mode else [])], check=True,
               timeout=75 if mode == '--soak' else 45)
