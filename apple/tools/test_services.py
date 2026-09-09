#!/usr/bin/env python3
"""Run native service integration tests on macOS using synthetic audio only."""
from pathlib import Path
import subprocess
APPLE = Path(__file__).resolve().parents[1]
OUT = APPLE / 'build/service-tests'
OUT.mkdir(parents=True, exist_ok=True)
CORE = APPLE / 'FFSBridge/Core'
LC3 = APPLE.parent / 'modules/ffs-ble/android/src/main/cpp/third_party/liblc3'
objects = []
for source in [CORE/'LC3Bridge.c'] + [LC3/'liblc3'/f'{name}.c' for name in ['attdet','bits','bwdet','energy','lc3','ltpf','mdct','plc','sns','spec','tables','tns']]:
    obj = OUT/(source.stem+'.o'); objects.append(str(obj))
    subprocess.run(['xcrun','clang','-O2','-I'+str(LC3/'include'),'-I'+str(LC3/'liblc3'),'-c',str(source),'-o',str(obj)],check=True)
sources = [CORE/f'{n}.swift' for n in ['Wire','Framebuffer','STT','DeveloperCrypto']]
sources += [APPLE/'FFSBridge/Services'/f'{n}.swift' for n in ['VoiceService','DeveloperServer']]
subprocess.run(['xcrun','swiftc','-swift-version','5','-import-objc-header',str(CORE/'LC3Bridge.h'),*[str(s) for s in sources],str(APPLE/'Tests/ServiceTests.swift'),*objects,'-lsqlite3','-o',str(OUT/'services')],check=True)
subprocess.run([str(OUT/'services')],check=True,timeout=20)
