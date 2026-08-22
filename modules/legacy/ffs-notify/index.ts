// ffs-notify — local Expo native module: allowlist-only Android notification bridge.
//
// Public entry point. Prefer `src/notifications/native.ts` in app code: it wraps this with the
// "not available on this platform / listener not granted" fallbacks, so nothing has to
// try/catch a native import.

export { default } from "./src/FfsNotifyModule";
export * from "./src/FfsNotifyModule";
