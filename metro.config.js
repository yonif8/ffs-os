// Metro config — Expo default + a blockList that keeps the quarantined `legacy/` tree out
// of the bundle. `legacy/` holds the retired phone-OS UI (see docs/APK-CLEANUP-PLAN.md); it
// is kept for the on-glass parity record but must never be resolved or bundled.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// A single RegExp is the portable form of Metro's blockList (equivalent to exclusionList of
// one pattern). Matches any module path inside a top-level or nested `legacy/` directory.
config.resolver.blockList = /[\\/]legacy[\\/].*/;

module.exports = config;
