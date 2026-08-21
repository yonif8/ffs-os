# FFS Glasses OS

> 🎯 **The goal (two halves, both first-class):**
>
> 1. **Use them.** Do the things a phone gets pulled out for — text, navigate, music, read — natively
>    on the glasses, in our own UI, smoothly enough to wear every day.
> 2. **Build for them in an afternoon.** A toolkit where a new mini app is written in C against a real
>    header, previewed on a PC in seconds, installed over BLE without reflashing, navigated on-glass
>    by temple gestures — with the **full** UI surface of the device's graphics engine available, not
>    just the handful of widgets the stock wrappers expose.
>
> Everything **renders natively on the glasses** (drawn and animated by the glasses themselves, never
> streamed as phone-rendered pixels). Split of responsibility: **phone = the brain** (data, network,
> app logic), **glasses = the face** (render, animate, scroll, handle input). The stock
> text-and-list surface is the floor, not the ceiling. Full statement lives in the private
> workspace's `GOAL.md`.

A clean-room operating layer for the **Even Realities G2** smart glasses, built on our
own from-scratch BLE driver (Kotlin on Android — the primary dev platform; the Swift/CoreBluetooth
driver is parked) — **no `@mentra/bluetooth-sdk`**, no third-party pipes. Drives the G2 display,
touchpad input, and (soon) microphone directly over BLE.

> Standalone, `@mentra`-free extraction of the OS from its original hybrid repo. This repo
> contains **only the OS**: the native driver + the app shell that runs on it.

## What's here

- **`modules/ffs-ble/`** — the driver. A native Expo module (Swift / CoreBluetooth) that
  connects the dual-radio G2 (left + right lenses), runs the auth handshake, and speaks the
  G2 EvenHub wire protocol:
  - `ios/G2Central.swift` — dual-lens CBCentral, connect / pair / keep-alive, write pacing.
  - `ios/G2Protocol.swift` — 0xAA transport + CRC16, protobuf, EvenHub messages: text +
    image containers, `updateImageRawData`, gesture decode.
  - `ios/FfsBleModule.swift` + `src/FfsBleModule.ts` — the React Native bridge.
- **`src/os/FfsBleTestApp.tsx`** — the driver test harness (connect, show text, show image,
  live gesture log) used to exercise the stack on-glass.
- **`src/os/log.ts`** — optional off-device structured telemetry (degrades silently).

## Capabilities (current)

- Connect + dual-radio pairing + auth handshake + keep-alive (all-day stable).
- **Display:** text containers, image containers (4-bit BMP raw-image path).
- **Input:** touchpad gestures — tap, double-tap, swipe-up, swipe-down.

## Build

iOS builds on a macOS runner via GitHub Actions (`.github/workflows/ios-unsigned.yml`),
producing an **unsigned IPA** that SideStore re-signs on-device with a free Apple ID —
$0, no paid Apple Developer account. Trigger via `workflow_dispatch` or a push to `main`.

## License

See `LICENSE`.
