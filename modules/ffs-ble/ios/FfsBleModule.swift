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
      "onDisconnected"
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
