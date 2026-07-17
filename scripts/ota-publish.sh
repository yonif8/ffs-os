#!/usr/bin/env bash
# FFS Glasses OS — publish a JS/TS OTA update (FUT-141).
#
# This is the "one command" for shipping a JS/TS change to Yoni's already-installed
# app. It bundles the current JS with Metro and publishes it to the `production`
# EAS Update branch; the installed app (which embeds expo-updates, runtimeVersion
# 1.0.0) fetches it on next launch (ON_LOAD) or on foreground re-check. NO re-sideload.
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

export EXPO_TOKEN="${EXPO_TOKEN:-$(cat /home/claude-bot/.claude/secrets/expo_token)}"
# We publish from a working branch with intentionally-uncommitted sibling work in the
# tree; EAS_NO_VCS makes eas bundle the working dir as-is instead of the git HEAD.
export EAS_NO_VCS=1

echo "→ Publishing OTA to branch 'production' (runtimeVersion 1.0.0): $MSG"
bunx eas-cli update --branch production --message "$MSG" --environment production --non-interactive
