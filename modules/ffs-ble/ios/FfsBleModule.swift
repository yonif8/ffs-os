//
//  FfsBleModule.swift
//  ffs-ble
//
//  Expo Modules API surface for the FFS G2 BLE driver. Owns a single
//  G2Central instance and forwards its callbacks to JS as typed events.
//
//  Phase 2: the driver is a dual-radio (L/R) manager. `connect` now connects
//  the PAIR (both lenses); events are side-aware; a new `onPairReady` fires when
//  both lenses are up with their required characteristics. A single-side connect
//  is retained for testing via `connectSide`.
//
//  Portions of the underlying BLE protocol constants (see G2Central.swift)
//  are derived from MentraOS (MIT). This module file is original FFS code.
//

import ExpoModulesCore

public class FfsBleModule: Module {
  /// The single BLE central for the whole app. Created lazily on first use so
  /// we don't spin up CoreBluetooth (and trigger the permission prompt) at import.
  private var central: G2Central?

  public func definition() -> ModuleDefinition {
    Name("FfsBleModule")

    Events(
      "onLog",
      "onStateChange",
      "onDeviceFound",
      "onConnected",
      "onServicesDiscovered",
      "onPairReady",
      "onNotify",
      "onGesture",
      "onDeviceInfo",
      "onDisconnected",
      "onFlashProbe",
      "onFlashProgress"
    )

    Function("startScan") { [weak self] in
      self?.ensureCentral().startScan()
    }

    Function("stopScan") { [weak self] in
      self?.central?.stopScan()
    }

    // Connect the PAIR (both lenses). This is the primary P2 entry point.
    Function("connect") { [weak self] in
      self?.ensureCentral().connectPair()
    }

    // Connect a SINGLE side only (testing convenience). `side` is "L" or "R".
    Function("connectSide") { [weak self] (side: String) in
      self?.ensureCentral().connectSide(Self.parseSide(side))
    }

    Function("disconnect") { [weak self] in
      self?.central?.disconnect()
    }

    // True once BOTH lenses are connected + required characteristics discovered.
    Function("isPairReady") { [weak self] () -> Bool in
      return self?.central?.isPairReady() ?? false
    }

    // Per-side readiness probe. `side` is "L" or "R".
    Function("isSideReady") { [weak self] (side: String) -> Bool in
      return self?.central?.isSideReady(Self.parseSide(side)) ?? false
    }

    // P3: run the auth handshake if needed, then render `text` on the HUD.
    // Connect the pair first (isPairReady == true).
    Function("showText") { [weak self] (text: String) in
      self?.ensureCentral().showText(text)
    }

    // P4: render a test image through our own raw-image path (FUT-153).
    Function("showImage") { [weak self] in
      self?.ensureCentral().showImage()
    }

    // FUT-165: toggle the firmware's NATIVE Even-AI "thinking" swirl (GPU-smooth,
    // dual-lens) via the even_ai session lifecycle. `on` starts it, false stops it.
    Function("showAiSwirl") { [weak self] (on: Bool) in
      self?.ensureCentral().aiSwirl(on: on)
    }

    // FUT-167 Stage 1: zero-write flash-channel probe (proves the in-app flasher can
    // reach both lenses' OTA characteristics — no writes, no brick risk).
    Function("flashDryRun") { [weak self] in
      self?.ensureCentral().flashDryRun()
    }

    // FUT-167 Stage 2: CFW OTA flash. Downloads `url`, verifies `sha256`, runs the MRAM
    // brick-guard + golden-vector self-test, then flashes (dryRun=false) or stops before
    // any write (dryRun=true). Progress via onFlashProgress. The real write path (dryRun
    // false) must be gated in JS behind the warranty confirmation.
    Function("startCfwFlash") { [weak self] (url: String, sha256: String, dryRun: Bool) in
      self?.ensureCentral().startCfwFlash(url: url, expectedSha256: sha256, dryRun: dryRun)
    }

    // FUT-165: play an on-glass pixel animation by id (see G2Anim.ids). Streams CFW mode-2
    // frames to a persistent 576×288 container. Connect the pair first.
    Function("playAnimation") { [weak self] (id: String) in
      self?.ensureCentral().playAnimation(id)
    }

    // FUT-165: stop the running animation.
    Function("stopAnimation") { [weak self] in
      self?.central?.stopAnimation()
    }

    // FUT-170 PoC: push custom text into the firmware's native head-up dashboard over BLE
    // (Schedule widget). Re-enables head-up + puts Schedule first. Look UP to see it.
    Function("pushDashboardDemo") { [weak self] (text: String) in
      self?.ensureCentral().pushDashboardDemo(text: text)
    }

    // FUT-170: reveal Even's OWN native head-up dashboard by releasing our EvenHub page
    // (the firmware dashboard can't surface while we hold a page). Re-enables head-up +
    // applies our widget layout over BLE. Any gesture returns to our OS. Connect first.
    Function("showStockDashboard") { [weak self] in
      self?.ensureCentral().showStockDashboard()
    }

    // FUT-169 / FUT-167: request real device info (battery %, charging, per-lens firmware
    // version) from the glasses. Answer arrives async via `onDeviceInfo`. Connect the pair
    // first. This is the real battery source (the HUD 82% was a stub) and the canary
    // flash's firmware-version read-back.
    Function("requestDeviceInfo") { [weak self] in
      self?.ensureCentral().requestDeviceInfo()
    }

    // P3: tear down the EvenHub session (stops the keep-alive heartbeat).
    Function("stopSession") { [weak self] in
      self?.central?.stopSession()
    }
  }

  private static func parseSide(_ raw: String) -> G2Side {
    switch raw.uppercased() {
    case "L": return .left
    case "R": return .right
    default: return .unknown
    }
  }

  /// Lazily create the central and wire its callbacks to sendEvent.
  private func ensureCentral() -> G2Central {
    if let c = central { return c }
    let c = G2Central()

    c.onLog = { [weak self] message in
      self?.sendEvent("onLog", ["message": message])
    }
    c.onStateChange = { [weak self] state in
      self?.sendEvent("onStateChange", ["state": state])
    }
    c.onDeviceFound = { [weak self] (name, side, rssi, sn, mac) in
      self?.sendEvent("onDeviceFound", [
        "name": name,
        "side": side,
        "rssi": rssi,
        "sn": sn as Any,
        "mac": mac as Any,
      ])
    }
    c.onConnected = { [weak self] (name, side) in
      self?.sendEvent("onConnected", ["name": name, "side": side])
    }
    c.onServicesDiscovered = { [weak self] (side, charUUIDs) in
      self?.sendEvent("onServicesDiscovered", [
        "side": side,
        "characteristics": charUUIDs,
      ])
    }
    c.onPairReady = { [weak self] in
      self?.sendEvent("onPairReady", [:])
    }
    c.onNotify = { [weak self] (base64, characteristic, side) in
      self?.sendEvent("onNotify", [
        "base64": base64,
        "characteristic": characteristic,
        "side": side,
      ])
    }
    c.onGesture = { [weak self] (gesture, side) in
      self?.sendEvent("onGesture", ["gesture": gesture, "side": side])
    }
    c.onDeviceInfo = { [weak self] (leftVersion, rightVersion, battery, charging) in
      self?.sendEvent("onDeviceInfo", [
        "leftVersion": leftVersion as Any,
        "rightVersion": rightVersion as Any,
        "battery": battery as Any,
        "charging": charging as Any,
      ])
    }
    c.onFlashProbe = { [weak self] (leftReady, rightReady, detail) in
      self?.sendEvent("onFlashProbe", [
        "leftReady": leftReady,
        "rightReady": rightReady,
        "detail": detail,
      ])
    }
    c.onFlashProgress = { [weak self] (message, progress, done, ok) in
      self?.sendEvent("onFlashProgress", [
        "message": message,
        "progress": progress,
        "done": done,
        "ok": ok,
      ])
    }
    c.onDisconnected = { [weak self] (name, side, reason) in
      self?.sendEvent("onDisconnected", [
        "name": name,
        "side": side,
        "reason": reason as Any,
      ])
    }

    central = c
    return c
  }
}
