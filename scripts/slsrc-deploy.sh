#!/usr/bin/env bash
# FFS Glasses OS — publish a native build to the SideStore source (FUT-141).
#
# Native rebuilds (runtimeVersion bump / new native module / permission / plugin)
# can't go OTA — they need a fresh IPA installed. This script takes an unsigned IPA
# built by the GitHub macOS runner and publishes it to slsrc.x36.site so Yoni's
# SideStore one-taps the update. Everyday JS/TS changes DON'T use this — they go OTA
# via scripts/ota-publish.sh (no new IPA).
#
# Delivery is server-side PULL (zero GitHub secrets): the box's gh CLI (authed as
# yonif8) downloads the IPA artifact from the repo's latest successful CI run.
# NB: the repo is PUBLIC — don't assume anything fetched here is access-controlled.
#
# Usage:
#   scripts/slsrc-deploy.sh                 # pull IPA from the latest successful CI run
#   scripts/slsrc-deploy.sh <path-to.ipa>   # publish a local IPA directly
#
# Effect: copies the IPA into /var/www/slsrc, regenerates apps.json (AltStore/
# SideStore source schema: version, size, downloadURL), served at
# https://slsrc.x36.site/apps.json  (add this URL as a source in SideStore).
set -euo pipefail

SRV=/var/www/slsrc
IPA_NAME=FFSGlassesOS.ipa
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOW=ios-unsigned.yml
ARTIFACT=FFSGlassesOS-unsigned-ipa
# Repo to pull CI artifacts from — derive it from THIS checkout's git remote so it can
# never drift (the repo was renamed ffs-glasses-os → ffs-os during the Phase-0 extraction;
# the old hardcode pulled a stale v0.9.0 build). Falls back to the current repo name.
REPO=$(cd "$APP_DIR" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo yonif8/ffs-os)

RTV=$(python3 -c "import json,sys; print(json.load(open('$APP_DIR/app.json'))['expo'].get('runtimeVersion','1.0.0'))")
APP_VERSION=$(python3 -c "import json,sys; print(json.load(open('$APP_DIR/app.json'))['expo'].get('version','0.1.0'))")

src_ipa="${1:-}"
if [[ -z "$src_ipa" ]]; then
  echo "→ Pulling IPA from latest successful '$WORKFLOW' run (gh, private repo)…"
  tmp=$(mktemp -d)
  echo "  repo: $REPO"
  run_id=$(gh run list --workflow "$WORKFLOW" --status success --limit 1 --json databaseId -q '.[0].databaseId' -R "$REPO")
  [[ -n "$run_id" ]] || { echo "ERROR: no successful $WORKFLOW run found"; exit 1; }
  echo "  run id: $run_id"
  gh run download "$run_id" -n "$ARTIFACT" -D "$tmp" -R "$REPO"
  src_ipa=$(find "$tmp" -name '*.ipa' | head -1)
  [[ -n "$src_ipa" ]] || { echo "ERROR: artifact had no .ipa"; exit 1; }
fi

[[ -f "$src_ipa" ]] || { echo "ERROR: IPA not found: $src_ipa"; exit 1; }

# SideStore validates the manifest's version/buildVersion against the IPA's actual
# CFBundleShortVersionString / CFBundleVersion — so read them FROM the IPA, never guess.
# Read from the SOURCE ipa, BEFORE copying: the guard below must be able to abort without
# having already overwritten the served binary (which would leave apps.json describing a
# file of a different size).
pl=$(mktemp)
unzip -p "$src_ipa" 'Payload/*.app/Info.plist' > "$pl" 2>/dev/null
read APP_VERSION BUILD_VERSION < <(python3 -c "import plistlib,sys;d=plistlib.load(open('$pl','rb'));print(d.get('CFBundleShortVersionString','0.0.0'),d.get('CFBundleVersion','1'))")
rm -f "$pl"
echo "  version=$APP_VERSION build=$BUILD_VERSION (from IPA Info.plist)"

# ---- GUARD: refuse a publish that SideStore will ignore (FUT-233, 2026-07-28) ----
# SideStore keys a release on `version`. Publishing an IPA whose version equals the one
# already being served is a silent no-op: the file changes, the manifest reports success,
# and no update button ever appears. That happened TWICE in one session — a build was
# published under a label already installed, and the tooling said "Published" both times.
# `buildVersion` is NOT enough: bumping only the build number reproduced the same silence.
# Override with FORCE_SAME_VERSION=1 for a deliberate re-publish (e.g. a corrupted upload).
prev_version=$(python3 - "$SRV/apps.json" <<'PY' 2>/dev/null || true
import json, sys
try:
    print(json.load(open(sys.argv[1]))["apps"][0]["versions"][0]["version"])
except Exception:
    pass
PY
)
if [[ -n "${prev_version:-}" && "$prev_version" == "$APP_VERSION" && "${FORCE_SAME_VERSION:-0}" != "1" ]]; then
  cat >&2 <<EOM

✖ REFUSING TO PUBLISH — this would be invisible in SideStore.
  currently served : $prev_version
  this build       : $APP_VERSION   (identical)

  SideStore compares 'version'. Republishing the same version shows NO update button,
  no matter how much the binary changed. Bumping only ios.buildNumber does NOT help.

  Fix: bump "version" in app.json, rebuild in CI, then re-run this script.
  Deliberate re-publish of the same version: FORCE_SAME_VERSION=1 $0
EOM
  exit 1
fi

# Only now is it safe to touch what's being served.
[[ "$(readlink -f "$src_ipa")" == "$(readlink -f "$SRV/$IPA_NAME")" ]] || cp "$src_ipa" "$SRV/$IPA_NAME"
size=$(stat -c%s "$SRV/$IPA_NAME")
today=$(date -u +%Y-%m-%d)
# Integrity: AltStore/SideStore verifies `sha256` from the manifest against the downloaded
# IPA and refuses the install on mismatch. Without it, size is the only check — anyone who
# can write to $SRV (or MITM the download) swaps the binary silently. The IPA is served
# unauthenticated, so this is the one thing standing between a tampered file and Yoni's phone.
sha256=$(sha256sum "$SRV/$IPA_NAME" | cut -d' ' -f1)
echo "  IPA: $size bytes → $SRV/$IPA_NAME"
echo "  sha256: $sha256"

# AltStore / SideStore source manifest.
python3 - "$SRV/apps.json" "$APP_VERSION" "$BUILD_VERSION" "$RTV" "$size" "$today" "$sha256" <<'PY'
import json, sys
out, appver, build, rtv, size, today, sha256 = sys.argv[1:8]
src = {
  "name": "FFS Glasses OS",
  "identifier": "site.x36.slsrc",
  "subtitle": "Rico's OS for the Even Realities G2",
  "apps": [{
    "name": "FFS Glasses OS",
    "bundleIdentifier": "com.futurefounders.glassesos",
    "developerName": "Future Founders Systems",
    "subtitle": "Direct-BLE companion OS for the G2 glasses.",
    "localizedDescription": "Our own iPhone companion OS for the Even Realities G2. Talks directly to the glasses over Bluetooth. JS/TS updates arrive over-the-air; this source delivers native rebuilds.",
    "iconURL": "https://slsrc.x36.site/icon.png",
    "tintColor": "1f6feb",
    "category": "utilities",
    "versions": [{
      "version": appver,
      "buildVersion": build,
      "date": today,
      "downloadURL": "https://slsrc.x36.site/FFSGlassesOS.ipa",
      "size": int(size),
      "sha256": sha256,
      "localizedDescription": f"Native build v{appver} ({build}), OTA runtimeVersion {rtv}."
    }],
    "appPermissions": {
      "entitlements": [],
      "privacy": {
        "NSBluetoothAlwaysUsageDescription": "Connects to your G2 glasses over Bluetooth.",
        "NSMicrophoneUsageDescription": "Uses the glasses microphone for voice input."
      }
    }
  }]
}
json.dump(src, open(out, "w"), indent=2)
print("  wrote", out)
PY

echo "✔ Published. SideStore source: https://slsrc.x36.site/apps.json"
