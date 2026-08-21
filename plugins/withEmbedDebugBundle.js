/**
 * withEmbedDebugBundle — force the JS bundle to embed in the DEBUG variant.
 *
 * Why: this project's on-glass proof loop is `assembleDebug → adb install → run`,
 * not a Metro dev server. By default RN skips bundling for the `debug` variant
 * (debuggableVariants defaults to ["debug"]) so the app expects Metro; on this
 * device that fell back to a STALE embedded bundle and JS edits silently didn't
 * ship (cost ~40 min once). Setting `debuggableVariants = []` makes debug embed a
 * fresh bundle every build, so `fbshot.ts` (and any JS) fix ships deterministically.
 * When embedded, console.log lands in `adb logcat`, not the Metro console.
 *
 * android/ is Expo-generated + gitignored, so this must live as a config plugin to
 * survive `expo prebuild`. Escape hatch: set FFS_METRO_DEBUG=1 to keep the RN
 * default (load from Metro, hot-reload) for a fast pure-JS iteration session.
 *
 * See memory `fast-onglass-screenshot` (Trap 2).
 */
const { withAppBuildGradle } = require("@expo/config-plugins");

const withEmbedDebugBundle = (config) => {
  return withAppBuildGradle(config, (cfg) => {
    if (process.env.FFS_METRO_DEBUG === "1") return cfg; // opt out: load from Metro
    if (cfg.modResults.language !== "groovy") return cfg;
    let src = cfg.modResults.contents;
    if (src.includes("debuggableVariants")) return cfg; // already set
    // Insert into the react { ... } block so the RN gradle plugin sees it.
    src = src.replace(
      /(\n\s*)react\s*\{/,
      `$1react {\n    // injected by plugins/withEmbedDebugBundle.js — embed JS in debug\n    debuggableVariants = []`
    );
    cfg.modResults.contents = src;
    return cfg;
  });
};

module.exports = withEmbedDebugBundle;
