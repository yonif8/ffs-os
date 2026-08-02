#!/usr/bin/env python3
"""
Fail the build if a source file under src/ is NOT reachable from the app entry point.

WHY THIS EXISTS (FUT-233, 2026-07-28)
-------------------------------------
A ring-input test UI was added to `src/os/FfsBleTestApp.tsx`, built, signed, published
and installed on Yoni's phone — and there was nothing to tap, because `index.ts` does
`registerRootComponent(App)` and that harness had not been rendered by the app in
months. Types checked, CI was green, the IPA was valid. Every signal was green and the
feature did not exist for the user.

Static reachability is the cheapest possible check for that class of bug: if a screen
cannot be reached from the entry point's import graph, nobody can ever see it.

WHAT IT DOES
------------
Walks imports transitively from ENTRY, then reports any .ts/.tsx under ROOTS that was
never reached. Unreached files are either dead code (delete them) or a feature the user
cannot get to (wire them up). Both are worth failing a build over.

Deliberately dumb — a regex over import/export/require specifiers, no TS compiler, no
node_modules, no deps. It only needs to answer "is this file in the graph at all".

Genuinely-orphaned-but-wanted files go in ALLOWLIST with a REASON. Adding an entry is a
deliberate act that shows up in review; forgetting to wire up a screen is not.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENTRY = REPO / "index.ts"
ROOTS = [REPO / "src", REPO / "modules"]
EXTS = (".ts", ".tsx", ".js", ".jsx")

# Files allowed to be unreachable. Keep this SHORT and always say why.
ALLOWLIST: dict[str, str] = {
    # FLAGGED, not endorsed. This check's first run found hud.ts has ZERO importers
    # anywhere in the repo — despite describing itself as "OUR OS surface" and being
    # cited in index.ts's own header comment. It is either dead (delete) or a surface
    # that was silently dropped during the Phase 1 port (restore). Allowlisted ONLY so
    # this guard can start enforcing today; it is a real finding awaiting triage, not
    # an exemption. See FUT-233.
    "src/os/hud.ts": "orphan found 2026-07-28 by this check; awaiting triage — do not copy this pattern",
}

# Matches: import ... from "X" / export ... from "X" / require("X") / import("X")
SPEC_RE = re.compile(
    r"""(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]"""
)
# Bare side-effect import:  import "./foo";
BARE_RE = re.compile(r"""^\s*import\s*['"]([^'"]+)['"]""", re.M)


def resolve(spec: str, importer: Path) -> Path | None:
    """Resolve a relative import specifier to a real file. Package imports are ignored."""
    if not spec.startswith("."):
        return None  # node_modules / bare package — not our source
    base = (importer.parent / spec).resolve()
    # Exact file, then extension guesses, then directory index.
    if base.is_file():
        return base
    for ext in EXTS:
        cand = base.with_suffix(base.suffix + ext) if base.suffix else Path(str(base) + ext)
        if cand.is_file():
            return cand
    for ext in EXTS:
        cand = Path(str(base) + ext)
        if cand.is_file():
            return cand
    if base.is_dir():
        for ext in EXTS:
            cand = base / f"index{ext}"
            if cand.is_file():
                return cand
    return None


def walk(entry: Path) -> set[Path]:
    seen: set[Path] = set()
    stack = [entry.resolve()]
    while stack:
        cur = stack.pop()
        if cur in seen or not cur.is_file():
            continue
        seen.add(cur)
        try:
            text = cur.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for spec in set(SPEC_RE.findall(text)) | set(BARE_RE.findall(text)):
            nxt = resolve(spec, cur)
            if nxt is not None:
                stack.append(nxt)
    return seen


def main() -> int:
    if not ENTRY.is_file():
        print(f"✖ entry point not found: {ENTRY}", file=sys.stderr)
        return 2

    reachable = walk(ENTRY)

    all_files: list[Path] = []
    for root in ROOTS:
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            if (
                p.is_file()
                and p.suffix in EXTS
                and "node_modules" not in p.parts
                and not p.name.endswith(".d.ts")
                # iOS/Android native sources aren't part of the JS graph.
                and "ios" not in p.parts
                and "android" not in p.parts
            ):
                all_files.append(p)

    orphans = []
    for p in sorted(all_files):
        if p.resolve() in reachable:
            continue
        rel = p.relative_to(REPO).as_posix()
        if rel in ALLOWLIST:
            continue
        orphans.append(rel)

    print(f"entry     : {ENTRY.relative_to(REPO)}")
    print(f"reachable : {len(reachable)} files")
    print(f"scanned   : {len(all_files)} files under {', '.join(r.name for r in ROOTS)}")

    if orphans:
        print()
        print("✖ UNREACHABLE from the app entry point:")
        for o in orphans:
            print(f"    {o}")
        print()
        print("  Nothing here can ever be seen or used by the app.")
        print("  Either wire it into the import graph, delete it, or — with a stated")
        print("  reason — add it to ALLOWLIST in scripts/check-reachable.py.")
        return 1

    print("✔ every source file is reachable from the entry point")
    return 0


if __name__ == "__main__":
    sys.exit(main())
