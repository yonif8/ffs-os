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
# yonif8) downloads the IPA artifact from the private repo's latest successful CI run.
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

RTV=$(python3 -c "import json,sys; print(json.load(open('$APP_DIR/app.json'))['expo'].get('runtimeVersion','1.0.0'))")
APP_VERSION=$(python3 -c "import json,sys; print(json.load(open('$APP_DIR/app.json'))['expo'].get('version','0.1.0'))")

src_ipa="${1:-}"
if [[ -z "$src_ipa" ]]; then
  echo "→ Pulling IPA from latest successful '$WORKFLOW' run (gh, private repo)…"
  tmp=$(mktemp -d)
  run_id=$(gh run list --workflow "$WORKFLOW" --status success --limit 1 --json databaseId -q '.[0].databaseId' -R yonif8/ffs-glasses-os)
  [[ -n "$run_id" ]] || { echo "ERROR: no successful $WORKFLOW run found"; exit 1; }
  echo "  run id: $run_id"
  gh run download "$run_id" -n "$ARTIFACT" -D "$tmp" -R yonif8/ffs-glasses-os
  src_ipa=$(find "$tmp" -name '*.ipa' | head -1)
  [[ -n "$src_ipa" ]] || { echo "ERROR: artifact had no .ipa"; exit 1; }
fi

[[ -f "$src_ipa" ]] || { echo "ERROR: IPA not found: $src_ipa"; exit 1; }
[[ "$(readlink -f "$src_ipa")" == "$(readlink -f "$SRV/$IPA_NAME")" ]] || cp "$src_ipa" "$SRV/$IPA_NAME"
size=$(stat -c%s "$SRV/$IPA_NAME")
today=$(date -u +%Y-%m-%d)
echo "  IPA: $size bytes → $SRV/$IPA_NAME"

# SideStore validates the manifest's version/buildVersion against the IPA's actual
# CFBundleShortVersionString / CFBundleVersion — so read them FROM the IPA, never guess.
pl=$(mktemp)
unzip -p "$SRV/$IPA_NAME" 'Payload/*.app/Info.plist' > "$pl" 2>/dev/null
read APP_VERSION BUILD_VERSION < <(python3 -c "import plistlib,sys;d=plistlib.load(open('$pl','rb'));print(d.get('CFBundleShortVersionString','0.0.0'),d.get('CFBundleVersion','1'))")
rm -f "$pl"
echo "  version=$APP_VERSION build=$BUILD_VERSION (from IPA Info.plist)"

# AltStore / SideStore source manifest.
python3 - "$SRV/apps.json" "$APP_VERSION" "$BUILD_VERSION" "$RTV" "$size" "$today" <<'PY'
import json, sys
out, appver, build, rtv, size, today = sys.argv[1:7]
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
