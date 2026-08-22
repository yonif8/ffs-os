# modules/legacy — quarantined 2026-08-22, see docs/APK-CLEANUP-PLAN.md

Not built. Expo autolinking scans only the direct children of `modules/` for a
`package.json` + `expo-module.config.json`; `modules/legacy/` has neither at its own root, so
nothing under here is autolinked or compiled into the app.

- `ffs-notify/` — the allowlist-only Android NotificationListenerService + media/nav/reply
  data-in module. Retired from the phone app (data-in will be rebuilt natively on-glass). Kept
  for reference; removing it from `modules/` is what takes it out of the build.
