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

export EXPO_TOKEN="${EXPO_TOKEN:-$(cat /home/claude-bot/.claude/secrets/expo_token)}"

# Telemetry auth token (FUT-144/FUT-252). EXPO_PUBLIC_* is inlined into the JS bundle at
# export time; if unset here, a locally-published OTA ships an EMPTY token and the glasses-
# log collector 401-rejects every connection — silently killing all telemetry (incl. the
# on-glass wizard's capture pipe). This bit us once: the token only lived in the GitHub
# Actions env, never in local publishes. Source it from the collector's local .token
# secret (NOT committed to this public repo) and FAIL LOUD rather than ship empty.
if [[ -z "${EXPO_PUBLIC_GLOG_TOKEN:-}" ]]; then
  _glog_token_file=/home/claude-bot/ClaudeProjects/rico/tools/glasses-log-collector/.token
  if [[ -r "$_glog_token_file" ]]; then
    export EXPO_PUBLIC_GLOG_TOKEN="$(tr -d '[:space:]' < "$_glog_token_file")"
  fi
fi
if [[ -z "${EXPO_PUBLIC_GLOG_TOKEN:-}" ]]; then
  echo "✖ REFUSING TO PUBLISH — EXPO_PUBLIC_GLOG_TOKEN is empty." >&2
  echo "  A local OTA with no glog token ships telemetry that the collector rejects (401)," >&2
  echo "  which silently breaks the on-glass wizard capture. Set the env var or restore" >&2
  echo "  the collector .token, then retry. (Override for a deliberate no-telemetry push:" >&2
  echo "  ALLOW_EMPTY_GLOG_TOKEN=1 $0 …)" >&2
  [[ "${ALLOW_EMPTY_GLOG_TOKEN:-0}" == "1" ]] || exit 1
fi

# We publish from a working branch with intentionally-uncommitted sibling work in the
# tree; EAS_NO_VCS makes eas bundle the working dir as-is instead of the git HEAD.
export EAS_NO_VCS=1

echo "→ Publishing OTA to branch 'production' (runtimeVersion 1.0.0): $MSG"
bunx eas-cli update --branch production --message "$MSG" --environment production --non-interactive
