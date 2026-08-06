#!/usr/bin/env python3
"""
Fail the build if the iOS and Android native modules do not expose the same API surface.

WHY THIS EXISTS (2026-08-06)
----------------------------
`src/FfsBleModule.ts` is a *declaration* — a hand-written TypeScript contract over a
native module. The compiler checks that JS calls match that declaration; nothing checks
that either platform actually implements it. So a capability added to the Swift driver
and forgotten on the Kotlin one (or vice versa) type-checks, builds clean on both
platforms, ships — and then throws at runtime the first time the shared UI calls it, on
one platform only.

That is the same failure shape as check-reachable.py's: every signal green, feature does
not exist for the user. It gets structurally more likely now that Android is the primary
development platform and iOS follows, because the natural workflow is to add a binding
where you are working and port it "later".

WHAT IT DOES
------------
Extracts the exported function names and event names from all three files and asserts the
three sets are identical:

    src/FfsBleModule.ts   the contract shared JS is written against
    ios/FfsBleModule.swift          Function("x") / Events("onY", ...)
    android/.../FfsBleModule.kt     Function("x") / Events("onY", ...)

Deliberately dumb — regex over the binding names, no Swift/Kotlin/TS parser. It only
needs to answer "does this name exist on both sides". Comments are stripped first,
because both module files legitimately mention `Events(` and `)` in prose.

This checks NAMES, not behaviour or argument types. A Phase-0 stub that logs "not
implemented" counts as present here and that is intended: the point is that the shared UI
can always *call* it without crashing. Whether the radio actually does anything is what
on-glass proof is for (cardinal rule #1) — this guard is the cheap half.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MODULE = Path(__file__).resolve().parent.parent / "modules" / "ffs-ble"
TS = MODULE / "src" / "FfsBleModule.ts"
SWIFT = MODULE / "ios" / "FfsBleModule.swift"
KOTLIN = MODULE / "android" / "src" / "main" / "java" / "expo" / "modules" / "ffsble" / "FfsBleModule.kt"

# Names allowed to exist on one platform only. Keep this SHORT and always say why.
# An entry here is a deliberate act that shows up in review; forgetting to port a
# binding is not.
ALLOWLIST: dict[str, str] = {}


def strip_comments(src: str) -> str:
    """Remove // line comments and /* */ blocks. Crude but sufficient: none of the three
    files contain a `//` or `/*` inside a string literal that matters to us."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//.*", "", src)


def native_surface(path: Path) -> tuple[set[str], set[str]]:
    """(functions, events) declared by a Swift or Kotlin Expo module definition."""
    src = strip_comments(path.read_text(encoding="utf-8"))
    fns = set(re.findall(r'\bFunction\(\s*"(\w+)"\s*\)', src))
    block = re.search(r"\bEvents\(\s*(.*?)\)", src, re.S)
    events = set(re.findall(r'"(\w+)"', block.group(1))) if block else set()
    return fns, events


def ts_surface(path: Path) -> tuple[set[str], set[str]]:
    """(functions, events) declared by the TypeScript contract."""
    src = strip_comments(path.read_text(encoding="utf-8"))
    # Interface members at one indent level: `  name(args): Ret;`
    fns = set(re.findall(r"^\s{2}(\w+)\(", src, re.M))
    # Event map members: `  onThing: (e: ...) => void;`
    events = set(re.findall(r"^\s{2}(on[A-Z]\w+)\s*:", src, re.M))
    return fns - events, events


def report(kind: str, ts: set[str], ios: set[str], android: set[str]) -> list[str]:
    errs: list[str] = []
    for name in sorted(ts | ios | android):
        if name in ALLOWLIST:
            continue
        where = {"contract": name in ts, "iOS": name in ios, "Android": name in android}
        if all(where.values()):
            continue
        have = ", ".join(k for k, v in where.items() if v) or "nowhere"
        miss = ", ".join(k for k, v in where.items() if not v)
        errs.append(f"  {kind} {name!r}: present in [{have}] - MISSING from [{miss}]")
    return errs


def main() -> int:
    for p in (TS, SWIFT, KOTLIN):
        if not p.exists():
            print(f"check-native-parity: missing file {p}", file=sys.stderr)
            return 2

    ts_fns, ts_events = ts_surface(TS)
    ios_fns, ios_events = native_surface(SWIFT)
    and_fns, and_events = native_surface(KOTLIN)

    errs = report("function", ts_fns, ios_fns, and_fns)
    errs += report("event", ts_events, ios_events, and_events)

    if errs:
        print("Native module API surface is NOT in parity:\n", file=sys.stderr)
        print("\n".join(errs), file=sys.stderr)
        print(
            "\nAdd the missing binding (a stub that logs is fine - see the Kotlin "
            "notYet() helper),\nor allowlist it in scripts/check-native-parity.py with "
            "a reason.",
            file=sys.stderr,
        )
        return 1

    print(
        f"native parity OK - {len(ts_fns)} functions, {len(ts_events)} events "
        f"across contract / iOS / Android"
        + (f" ({len(ALLOWLIST)} allowlisted)" if ALLOWLIST else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
