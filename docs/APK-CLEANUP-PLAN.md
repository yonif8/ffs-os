# APK cleanup plan — the app is a BLE bridge, not a product

**Decided 2026-08-22 (Yoni).** The Android app is no longer a phone-OS that renders onto the
glasses. Its two jobs are:

1. **A headless BLE bridge that Claude drives** — connect/disconnect the pair, carry the FXP1 push
   route (sid `0x90`) Claude pushes native payloads over, return the framebuffer screenshot (sid
   `0x30`), surface inbound gestures / device-info, and flash CFW. Claude drives it over the adb
   broadcast control surface; the app does not initiate pushes.
2. **A thin status screen for Yoni** — connection state + a Connect/Disconnect button, battery +
   firmware, a live activity log of what the bridge is doing, and a mic-open privacy indicator.

Everything else — the on-glass phone-OS UI, pixel-streaming, EvenHub page rendering, and the
automatic data-in features (notifications + now-playing forwarding) — is **retired**. Data-in will
be rebuilt natively on-glass later; it does not belong in the phone app.

Legacy code is **quarantined, not deleted** (`legacy/` dirs, clearly marked, excluded from the
build) so the on-glass parity record survives. The app must build and connect after every chunk.

---

## Target architecture

```
  Claude (adb broadcasts) ─┐
                           ▼
  ┌─────────────────────── FfsBleModule (control surface + JS bridge) ───────────────────────┐
  │  PUSH_PAYLOAD(via svc, sid 0x90) · connect · DEVICE_INFO · FLASH · SETTING                │
  │        │                                                                                  │
  │        ▼                                                                                  │
  │  G2Central (trimmed): scan/connect/disconnect · per-side write queues · inbound reassembly│
  │        · pushToService(0x90) · screenshot return (0x30) · device-info · mic-detect · flash│
  └───────────────────────────────────────────────────────────────────────────────────────── ┘
                           ▲
  Thin status screen ──────┘   (connection · battery/fw · activity log · mic indicator + button)
```

No `showText`/`showImage`, no phone-nav, no page builders, no raster/pixel-streaming, no data-in.

---

## KEEP (the bridge + its status surface)

**Native (`modules/ffs-ble`):**
- `G2Central.kt` — **trim in place.** Keep: adapter/scan, connect/disconnect/reclaim, per-side
  paced write queues, inbound transport reassembly + `onServiceRaw`, gesture decode passthrough,
  device-info (battery/fw), `micStats`/`onMicUnexpected`, `pushToService(0x90)`, flash hooks.
- `FfsBleModule.kt` — keep the broadcast receiver (PUSH_PAYLOAD/connect/DEVICE_INFO/FLASH/SETTING)
  and the Function exports the status screen binds (connect/disconnect, isPairReady/isSideReady,
  requestDeviceInfo, and the `on*` event emitters for connected/disconnected/deviceInfo/rssi/mtu/
  micUnexpected/serviceRaw/gesture/log).
- `G2Protocol.kt` — keep transport framing (packets/counters/CRC) + inbound decode (gesture,
  device-info, service-raw).
- `G2Flash.kt`, `G2Flasher.kt` — keep (CFW flash).
- `G2Types.kt`, `G2MicStats.kt` — keep.

**Frontend (`src/`):**
- New thin `App.tsx` (rewrite) — the four status widgets + Connect/Disconnect.
- `useFfsBluetooth.ts`, `connection.ts`, `connectionCore.ts` — keep, trimmed to state/health only.
- `log.ts` — keep as the activity-log source.
- `theme.ts`, `ui.tsx` — keep the shared primitives the new screen uses.

## CUT → `legacy/` (quarantine, marked, out of build)

**Native:** the EvenHub-page + render machinery inside `G2Central.kt`
(`pushPayloadViaImage`/anim/image/`sendImagePageLocked`/`sendTextPageLocked`/`sendEvenHubFromSdk`/
`sdkTakeoverPage`/`pushDashboardDemo`/`showStockDashboard`/`aiSwirl`/page-state latches) → extracted
to a legacy file; the EvenHub page builders block in `G2Protocol.kt`; `EvenHubPageLatches.kt`; the
entire **`ffs-notify`** module (data-in retired); **`R1Central.kt`** (ring input — pending the
wiring check below).

**Frontend:** `src/os/phone/`, `src/os/calibration/`, `src/os/devtools/`, `runtime.ts`,
`dashboard.tsx`, `reclaim.ts`, `pushAck*.ts`, `usePushAck.ts`; the entire **`src/sdk/`** in-app
render/encode stack (program, wire, screen, os, templates, native, raster, bmp, deflate, events,
launcher, session, proto, settings, evenai, sound, dictation, ffsc, ffsm, telemetry, commands,
envelope, fxp1, types); the entire **`src/data/`** and **`src/notifications/`**.

## VERIFY before cutting (execution flags — do not assume)
- **`src/sdk/fbshot.ts`** — is the in-app sid-`0x30` assembler load-bearing for Claude's screenshot,
  or does `g2flash/tools/fb_shot.py` assemble entirely PC-side from the adb-forwarded return? Keep
  until proven redundant.
- **`R1Central.kt`** — confirm `FfsBleModule` never instantiates it before quarantining.
- **Exact `FfsBleModule` Function keep-list** — enumerate which exports the new screen imports; cut
  only unreferenced ones.
- **`log.ts`** — keep the loopback collector target (`ws://127.0.0.1:8795`); the activity-log widget
  reads the same stream.

---

## Thin status screen (design)

One scrollable card, dense, no ceremony (Yoni's standing UX preference):
1. **Link** — L ● / R ● connected dots + RSSI, one **Connect / Disconnect** button.
2. **Device** — battery %, per-lens firmware (from device-info), CFW/loader badge.
3. **Activity log** — live tail of bridge events (pushes, screenshots, flashes, connect/drop).
4. **Mic** — a privacy light: lit when the glasses opened their mic unprompted (`onMicUnexpected`).

---

## Execution — work-streams (after approval)

| Stream | Scope | Definition of done |
|---|---|---|
| **A — Frontend strip + rebuild** | Quarantine `src/os/phone`, calibration, devtools, runtime, dashboard, reclaim, pushAck\*; write the thin `App.tsx` + the 4 widgets wired to kept hooks. | App builds; status screen renders; Connect/Disconnect works; no import of a cut module. |
| **B — SDK/data/notifications quarantine** | Move `src/sdk/*` (render/encode), `src/data/*`, `src/notifications/*` to `legacy/`; resolve `fbshot.ts` per the flag. | `tsc`/build clean; nothing in the kept graph imports `legacy/`. |
| **C — Native trim** | Extract the EvenHub/render/anim/page code out of `G2Central.kt`/`G2Protocol.kt` into `legacy/`; quarantine `EvenHubPageLatches.kt`, `ffs-notify`, `R1Central.kt` (after the wiring check); prune the dead `FfsBleModule` Function exports. | Module compiles; broadcast control surface + `pushToService(0x90)` + screenshot + flash intact. |
| **D — Verify on-glass** | Build the APK, install, connect, push a test payload over `0x90`, screenshot. | HUD renders the pushed payload; status screen shows the live link. (Yoni at the glasses.) |

Streams A/B/C touch disjoint file sets and can run in parallel; D gates the result. Public-repo
rules apply throughout: explicit-path staging, no captures/firmware-URLs, LF.
