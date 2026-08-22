# ffs-ble/legacy — quarantined 2026-08-22, see docs/APK-CLEANUP-PLAN.md

Not compiled. This directory sits OUTSIDE `android/src/main/java`, so Gradle never
builds it, and it is not a source root. It preserves the on-glass parity record for the
EvenHub-page / render / animation / image machinery and the R1 ring after the app was
trimmed to a pure BLE bridge (Plane 1 render moves on-glass; data-in retires).

Contents:
- `EvenHubPageLatches.kt` / `EvenHubPageLatchesTest.kt` — the EvenHub page-state latches.
- `R1Central.kt` — the R1 ring BLE central + `R1Gesture` decoder.
- `G2Central-evenhub-render.kt` — the render/page/anim/image/dashboard/SDK-page methods and
  state extracted from `G2Central.kt` (reference only; will not compile in isolation).
- `G2EvenHub-pages.kt` — the EvenHub page/image builders extracted from `G2Protocol.kt`
  (`pageMessage`/`listPageMessage`/`textPageMessage`/`textPageAt`/`listWithHeaderPage`/
  `shutdownPage`/`imagePageMessage`/`imageContainer`/`imageRawDataUpdate`/`updateImageMessage`/
  `textContainer`/`listContainer`/`createStartupPageContainer`/`build4BitBmp`/`testImageBmp`/
  `parseImageAck` + `G2ImageAck`).
