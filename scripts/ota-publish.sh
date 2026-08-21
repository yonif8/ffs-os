#!/usr/bin/env bash
# FFS Glasses OS — publish a JS/TS OTA update (FUT-141).
#
# This is the "one command" for shipping a JS/TS change to Yoni's already-installed
# app. It bundles the current JS with Metro and publishes it to the `production`
# EAS Update branch; the installed app (which embeds expo-updates, runtimeVersion
# 1.2.0 — see app.json, this comment said 1.0.0 until 2026-07-28) fetches it on next
# launch (ON_LOAD) or on foreground re-check. NO re-sideload.
#
# ⚠️ The runtimeVersion here MUST match the one baked into Yoni's INSTALLED app, not
# just the one in app.json. They differ if app.json's rtv was bumped after his last
# IPA install — and then the app silently ignores every OTA.
#
# Usage:  scripts/ota-publish.sh "what changed in this update"
#
# When to NOT use this (native rebuild required instead): if you added/changed a
# native module, an iOS permission, a config-plugin, or anything under ios/ — bump
# app.json expo.runtimeVersion, rebuild the IPA, and have Yoni install it (SideStore).
# runtimeVersion mismatch = the app will correctly IGNORE the OTA.
set -euo pipefail

MSG="${1:-manual OTA update}"
cd "$(dirname "$0")/.."

export EXPO_TOKEN="${EXPO_TOKEN:?EXPO_TOKEN not set — provide the Expo access token via env (GitHub Actions secret, or a local export). Origin-box secret path removed 2026-08-06.}"

# Telemetry auth token (FUT-144/FUT-252). EXPO_PUBLIC_* is inlined into the JS bundle at
# glog telemetry is now IN-HOUSE: the app targets ws://127.0.0.1:8795 reached via
# `adb reverse` (see ffs_os/src/os/log.ts). It is loopback-only, so there is no token to
# ship and nothing to guard here — a published OTA carries no telemetry secret. (The old
# EXPO_PUBLIC_GLOG_TOKEN guard was removed 2026-08-21 when the public tunnel was torn down.)

# We publish from a working branch with intentionally-uncommitted sibling work in the
# tree; EAS_NO_VCS makes eas bundle the working dir as-is instead of the git HEAD.
export EAS_NO_VCS=1

# Read the real runtimeVersion from app.json so this line can never drift again (it said
# "1.0.0" while app.json carried 1.2.0). EAS uses app.json's value, not this echo.
RTV="$(node -e "process.stdout.write(String(require('./app.json').expo.runtimeVersion))" 2>/dev/null || echo '?')"
echo "→ Publishing OTA to branch 'production' (runtimeVersion ${RTV}): $MSG"
bunx eas-cli update --branch production --message "$MSG" --environment production --non-interactive
