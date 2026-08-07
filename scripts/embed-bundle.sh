#!/usr/bin/env bash
# Embed the JS bundle into the DEBUG apk so the app no longer needs Metro.
#
# WHY THIS MATTERS FOR UNATTENDED WORK
# ------------------------------------
# A stock debug APK carries no JS: it fetches the bundle from Metro at launch. If Metro dies
# (or the machine reboots, or `adb reverse` is lost — it is per-transport and vanishes on every
# reconnect), the app opens to a blank white screen, the native BLE driver is never constructed,
# and every glasses experiment stops. That is a silent, total stall with no error to notice.
#
# WHY NOT JUST BUILD RELEASE, which embeds a bundle by default:
# the debug BroadcastReceiver in FfsBleModule (SHOW_LIST / BRIGHTNESS / PUSH_PAYLOAD / SETTING)
# registers ONLY when ApplicationInfo.FLAG_DEBUGGABLE is set. A release build is not debuggable,
# so it would silently remove the entire remote-control surface these experiments run on.
#
# So: keep the debug build, give it an embedded bundle. Best of both.
#
# VERIFIED 2026-08-08: with Metro killed AND `adb reverse --remove-all`, the app still launches
# and logs "G2Central initialized".
#
# Re-run after any JS change, then rebuild + reinstall the APK.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p android/app/src/main/assets
npx expo export:embed \
  --platform android --dev false \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res
echo "bundle embedded — now: (cd android && ./gradlew :app:assembleDebug) && adb install -r ..."
