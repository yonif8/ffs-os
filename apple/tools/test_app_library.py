#!/usr/bin/env python3
"""Run the shared native app-library protocol and persistence checks on macOS."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='ffs-library-test-') as d:
    binary=str(Path(d)/'test')
    for name in ['AppLibrary', 'PairedCommands']:
        sources=['FFSBridge/Core/Wire.swift','FFSBridge/Core/AppPackage.swift',
                 'FFSBridge/Services/AppLibrary.swift','FFSBridge/Services/PairedCommands.swift',
                 f'Tests/{name}Tests.swift']
        subprocess.run(['swiftc','-parse-as-library',*[str(root/p)for p in sources],'-o',binary],check=True)
        subprocess.run([binary],check=True,timeout=15)
