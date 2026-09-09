# FFS Glasses OS

Native software for the Even Realities G2 glasses: custom firmware renders the UI
on the glasses, while a companion supplies Bluetooth transport, data and developer
control. Apps are built in C and installed over BLE without reflashing firmware.

- **[Native Mac and iPhone apps](apple/README.md):** shared Swift/CoreBluetooth bridge,
  native desktop and phone interfaces, local developer commands, firmware validation
  and OTA, framebuffer capture, LC3 voice recording/transcription, and buzzer streaming.
  The Mac app connects directly to both lenses with no phone involved. The iPhone app
  installs directly from Xcode using a Personal Team.
- **Android:** current Expo status shell under `src/os`, with its native Kotlin bridge
  in `modules/ffs-ble/android`. This is the behavior baseline for the Apple migration,
  including the recent headless bridge and buzzer work.
- **Legacy iOS Expo module:** `modules/ffs-ble/ios` and the unsigned-IPA CI workflow are
  historical. They are not the active Apple app or installation route.

The phone/Mac is the bridge; the glasses render their own 576×288 surface and handle
local navigation. The active design does not depend on EvenHub text/image containers.
On-glass proof is tracked in the full workspace's STATUS.md. Building an app or sending
a BLE packet alone is not evidence that every feature works on the hardware.

See [LICENSE](LICENSE).
