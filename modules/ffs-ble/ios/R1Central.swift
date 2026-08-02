//
//  R1Central.swift
//  ffs-ble
//
//  CoreBluetooth central for the Even Realities R1 smart ring — the FFS SDK's
//  INPUT device (FUT-233).
//
//  ── Why this is a separate central from G2Central ──────────────────────────
//  The ring is its own BLE peripheral on its own service (BAE80001-…), not a
//  third channel on the glasses link. G2Central is hard-wired to a PAIR of G2
//  lenses (enum G2Side L/R, protocol notify on the right lens only); bending it
//  around a single-peripheral device with a different service would corrupt both.
//
//  ── Route decision (LOCKED 2026-07-28, FUT-233) ────────────────────────────
//  The ring talks to the PHONE, and the phone is the input hub. The alternative
//  — letting the ring talk to the glasses and forwarding gestures up through the
//  firmware — was rejected: it needs CFW (gesture forwarding is compiled OUT of
//  our loader build), and it is structurally source-blind, because the firmware's
//  `eventSource` field exists only on Sys events, so a tap landing on a text or
//  list container can never be attributed to ring vs temple.
//
//  Crucially the two routes are NOT mutually exclusive at the transport level:
//  `connectToGlasses(mac:)` below is the phone COMMANDING the ring to also hold a
//  link to the glasses. We consume the phone link; that other link is something we
//  can drive, not something we depend on.
//
//  ── Provenance ─────────────────────────────────────────────────────────────
//  Protocol constants, the init sequence, the gesture encoding and the advStart
//  command are ported from MentraOS `R1.swift` (MIT — copy permitted with
//  attribution; notice retained), itself reverse-engineered from BTSnoop captures.
//  The structure, threading, logging and callback surface are original FFS code
//  and follow G2Central.
//
//  ⚠️ UNRESOLVED, and the first thing to test on hardware: sources disagree on
//  whether the phone link carries ALL FIVE gestures. MentraOS parses five;
//  openCFW's BTSnoop capture saw only hold + double-tap reach the phone, with
//  single-tap and swipes going ring→glasses directly. Hence `rawHexLog` — every
//  frame is surfaced verbatim so the live test answers this by observation rather
//  than by trusting either source. If only a subset arrives: HARD STOP, reassess.
//

import CoreBluetooth
import Foundation

// MARK: - Protocol constants (ported from MentraOS R1.swift, MIT)

enum R1BLE {
  /// The ring's custom service.
  static let SERVICE = CBUUID(string: "BAE80001-4F05-4503-8E65-3AF1F7329D1F")

  /// Channel 1.
  static let WRITE_1 = CBUUID(string: "BAE80010-4F05-4503-8E65-3AF1F7329D1F")
  static let NOTIFY_1 = CBUUID(string: "BAE80011-4F05-4503-8E65-3AF1F7329D1F")
  /// Channel 2 — the channel gestures have been observed on.
  static let WRITE_2 = CBUUID(string: "BAE80012-4F05-4503-8E65-3AF1F7329D1F")
  static let NOTIFY_2 = CBUUID(string: "BAE80013-4F05-4503-8E65-3AF1F7329D1F")

  /// Standard BLE battery service — the ring MAY expose it.
  static let BATTERY_SVC = CBUUID(string: "180F")
  static let BATTERY_CHAR = CBUUID(string: "2A19")

  /// The ring does not reliably advertise its custom service, so discovery is by
  /// name (MentraOS scans with `withServices: nil` for the same reason).
  static let NAME_FILTERS = ["EVEN R1", "BCL60"]

  /// Init handshake: 0xFC then 0x11, 200ms apart, written to BOTH write chars.
  static let CONFIG_FC = Data([0xFC])
  static let CONFIG_11 = Data([0x11])
  static let INIT_GAP_SEC = 0.2

  /// BleRing1 advStart (cmd=system 0, module=system 0, subCmd=advStart 9).
  static let CMD_SYSTEM: UInt8 = 0x00
  static let MODULE_SYSTEM: UInt8 = 0x00
  static let SUBCMD_ADV_START: UInt8 = 0x09

  /// First byte of a gesture frame: [0xFF][type][param].
  static let GESTURE_MARKER: UInt8 = 0xFF

  static let SCAN_TIMEOUT_SEC: TimeInterval = 15.0
  /// Battery re-read interval. NOTE: this matches MentraOS's ACTUAL driver (a 30s
  /// battery read). Our own FUT-233 spec claimed "0x11 keepalive every 5s" — that
  /// is not what the source does; corrected here and on the issue 2026-07-28.
  static let HEARTBEAT_SEC: TimeInterval = 30.0
}

/// The five discrete gestures. ⚠️ There is NO rotary/scroll-wheel on the R1 — an
/// earlier claim to the contrary was our own inference and was retracted.
enum R1Gesture: String {
  case hold
  case singleTap = "single_tap"
  case doubleTap = "double_tap"
  case swipeUp = "swipe_up"
  case swipeDown = "swipe_down"

  /// Parse `[0xFF, type, param]`.
  /// ⚠️ The 0x05 threshold is MentraOS's: param <0x80 up, >=0x80 down. It is possible
  /// the param carries swipe MAGNITUDE rather than just direction — which would buy us
  /// proportional scrolling — so the raw param is logged separately and not discarded.
  static func parse(_ data: Data) -> R1Gesture? {
    guard data.count >= 3, data[0] == R1BLE.GESTURE_MARKER else { return nil }
    switch data[1] {
    case 0x03: return .hold
    case 0x04: return data[2] == 0x01 ? .singleTap : (data[2] == 0x02 ? .doubleTap : nil)
    case 0x05: return data[2] < 0x80 ? .swipeUp : .swipeDown
    default: return nil
    }
  }
}

// MARK: - The central

/// All CoreBluetooth interaction happens on `queue` (a dedicated serial queue),
/// and callbacks out to the Expo module are invoked on that same queue — matching
/// G2Central, whose module hops back to JS via `sendEvent`.
final class R1Central: NSObject {

  // MARK: Callbacks (wired by the Expo module)

  /// (message) — every log line, already timestamped.
  var onLog: ((String) -> Void)?
  /// (stateDescription) — CBManagerState transitions.
  var onStateChange: ((String) -> Void)?
  /// (name, rssi) — a ring seen in a scan.
  var onDeviceFound: ((String, Int) -> Void)?
  /// (name) — the ring finished connecting AND completed its init handshake.
  var onConnected: ((String) -> Void)?
  /// (gesture, rawHex) — a decoded gesture, with the frame that produced it.
  var onGesture: ((String, String) -> Void)?
  /// (charSuffix, hex) — EVERY inbound frame, decoded or not. This is the evidence
  /// channel for the live test; do not filter it.
  var onRaw: ((String, String) -> Void)?
  /// (percent)
  var onBattery: ((Int) -> Void)?
  /// (reason?)
  var onDisconnected: ((String?) -> Void)?

  // MARK: State

  private var central: CBCentralManager?
  private var ring: CBPeripheral?
  private var writeChar1: CBCharacteristic?
  private var writeChar2: CBCharacteristic?
  private var notifyChar1: CBCharacteristic?
  private var notifyChar2: CBCharacteristic?
  private var batteryChar: CBCharacteristic?

  /// How many notify chars have confirmed subscription. The init handshake must not
  /// run until BOTH are up, or the ring's first replies land on an unsubscribed char
  /// and are lost — which would look exactly like "the ring sent nothing".
  private var notifySubscriptions = 0
  private var expectedSubscriptions = 0
  private var initSequenceRun = false
  private var isDisconnecting = false
  private var scanTimeoutWork: DispatchWorkItem?
  private var initSettleWork: DispatchWorkItem?
  private var heartbeatTimer: DispatchSourceTimer?

  /// Persisted so a reconnect doesn't need a fresh scan.
  private var ringUUID: UUID? {
    get { UserDefaults.standard.string(forKey: "ffs_r1_uuid").flatMap(UUID.init(uuidString:)) }
    set {
      if let v = newValue { UserDefaults.standard.set(v.uuidString, forKey: "ffs_r1_uuid") }
      else { UserDefaults.standard.removeObject(forKey: "ffs_r1_uuid") }
    }
  }

  let queue = DispatchQueue(label: "com.ffs.r1", qos: .userInitiated)

  // MARK: Logging

  private func log(_ message: String) {
    let ts = R1Central.tsFormatter.string(from: Date())
    onLog?("[\(ts)] R1: \(message)")
  }

  private static let tsFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss.SSS"
    return f
  }()

  private static func hex(_ data: Data) -> String {
    data.map { String(format: "%02X", $0) }.joined(separator: " ")
  }

  // MARK: - Public API

  /// Begin scanning for the ring. Reconnects by stored UUID first when possible.
  func startScan() {
    if central == nil {
      central = CBCentralManager(
        delegate: self, queue: queue,
        options: [CBCentralManagerOptionShowPowerAlertKey: false])
      // The delegate's didUpdateState will call back into here once powered on.
      return
    }
    guard let central, central.state == .poweredOn else {
      log("scan requested but Bluetooth is not powered on")
      return
    }
    isDisconnecting = false

    if let uuid = ringUUID,
      let known = central.retrievePeripherals(withIdentifiers: [uuid]).first
    {
      log("reconnecting by UUID to \(known.name ?? "ring")")
      connect(known)
      return
    }

    // withServices: nil — the ring does not reliably advertise its custom service.
    log("scanning (name filters: \(R1BLE.NAME_FILTERS.joined(separator: ", ")))")
    central.scanForPeripherals(
      withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])

    scanTimeoutWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.ring == nil else { return }
      self.log("scan timed out after \(Int(R1BLE.SCAN_TIMEOUT_SEC))s — no ring found")
      self.central?.stopScan()
    }
    scanTimeoutWork = work
    queue.asyncAfter(deadline: .now() + R1BLE.SCAN_TIMEOUT_SEC, execute: work)
  }

  func stopScan() {
    scanTimeoutWork?.cancel()
    central?.stopScan()
  }

  func disconnect() {
    isDisconnecting = true
    stopHeartbeat()
    stopScan()
    if let ring { central?.cancelPeripheralConnection(ring) }
    resetConnectionState()
  }

  /// Forget the stored ring so the next scan pairs fresh.
  func forget() {
    disconnect()
    ringUUID = nil
  }

  func readBattery() {
    guard let batteryChar, let ring else { return }
    ring.readValue(for: batteryChar)
  }

  /// Command the ring to ALSO connect to the glasses — `advStart` with the 6-byte
  /// glasses MAC, written to WRITE_2. Ported from MentraOS `R1.swift:261-289`,
  /// which RE'd it from Even's own app (BleRing1CmdProto::advStart).
  ///
  /// This is deliberately NOT automatic. Our input path is the phone link; this
  /// exists so we can drive the ring→glasses link when we want it (and so we can
  /// test whether the ring will hold both links at once — an open question, though
  /// MentraOS shipping this alongside its own phone link implies it does).
  @discardableResult
  func connectToGlasses(mac: String) -> Bool {
    guard let macBytes = R1Central.parseMac(mac) else {
      log("connectToGlasses: could not parse MAC '\(mac)'")
      return false
    }
    guard let wc = writeChar2 ?? writeChar1, let ring else {
      log("connectToGlasses: no write characteristic / not connected")
      return false
    }
    var payload = Data([R1BLE.CMD_SYSTEM, R1BLE.MODULE_SYSTEM, R1BLE.SUBCMD_ADV_START])
    payload.append(macBytes)
    ring.writeValue(payload, for: wc, type: .withoutResponse)
    log("advStart -> \(R1Central.hex(payload))")
    return true
  }

  /// "AA:BB:CC:DD:EE:FF" or "AABBCCDDEEFF" -> 6 raw bytes.
  static func parseMac(_ s: String) -> Data? {
    let cleaned =
      s.replacingOccurrences(of: ":", with: "").replacingOccurrences(of: "-", with: "")
    guard cleaned.count == 12 else { return nil }
    var out = Data()
    out.reserveCapacity(6)
    var idx = cleaned.startIndex
    for _ in 0..<6 {
      let next = cleaned.index(idx, offsetBy: 2)
      guard let byte = UInt8(cleaned[idx..<next], radix: 16) else { return nil }
      out.append(byte)
      idx = next
    }
    return out
  }

  // MARK: - Init handshake

  /// Runs ONCE, only after every notify subscription is confirmed:
  /// write 0xFC to both write chars → wait 200ms → write 0x11 → connected.
  private func runInitSequence() {
    guard !initSequenceRun else { return }
    initSequenceRun = true

    let writeChars = [writeChar1, writeChar2].compactMap { $0 }
    guard !writeChars.isEmpty, let ring else {
      log("init: no write characteristics — the ring will not be driveable")
      markConnected()
      return
    }

    log("init: writing 0xFC to \(writeChars.count) char(s)")
    for wc in writeChars { ring.writeValue(R1BLE.CONFIG_FC, for: wc, type: .withoutResponse) }

    queue.asyncAfter(deadline: .now() + R1BLE.INIT_GAP_SEC) { [weak self] in
      guard let self, let ring = self.ring else { return }
      self.log("init: writing 0x11")
      for wc in writeChars { ring.writeValue(R1BLE.CONFIG_11, for: wc, type: .withoutResponse) }
      self.markConnected()
    }
  }

  private func markConnected() {
    let name = ring?.name ?? "ring"
    log("READY — \(name). Gestures should now arrive on \(shortUUID(R1BLE.NOTIFY_2)).")
    onConnected?(name)
    readBattery()
    startHeartbeat()
  }

  private func startHeartbeat() {
    stopHeartbeat()
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + R1BLE.HEARTBEAT_SEC, repeating: R1BLE.HEARTBEAT_SEC)
    t.setEventHandler { [weak self] in self?.readBattery() }
    t.resume()
    heartbeatTimer = t
  }

  private func stopHeartbeat() {
    heartbeatTimer?.cancel()
    heartbeatTimer = nil
  }

  private func resetConnectionState() {
    initSettleWork?.cancel()
    initSettleWork = nil
    ring?.delegate = nil
    ring = nil
    writeChar1 = nil
    writeChar2 = nil
    notifyChar1 = nil
    notifyChar2 = nil
    batteryChar = nil
    notifySubscriptions = 0
    expectedSubscriptions = 0
    initSequenceRun = false
  }

  private func connect(_ peripheral: CBPeripheral) {
    stopScan()
    ring = peripheral
    peripheral.delegate = self
    central?.connect(peripheral, options: nil)
  }

  private func shortUUID(_ uuid: CBUUID) -> String {
    String(uuid.uuidString.prefix(8))
  }

  private func matchesNameFilter(_ name: String?) -> Bool {
    guard let name else { return false }
    return R1BLE.NAME_FILTERS.contains { name.uppercased().contains($0) }
  }

  // MARK: - Inbound frames

  /// Every notification lands here. The raw hex is emitted FIRST and unconditionally,
  /// before any interpretation — the point of the live test is to see what the ring
  /// actually sends, including frames our parser does not understand.
  private func handle(_ data: Data, from characteristic: CBCharacteristic) {
    let hex = R1Central.hex(data)
    let ch = String(characteristic.uuid.uuidString.prefix(8))
    log("rx \(ch) <- \(hex)")
    onRaw?(ch, hex)

    // Gesture: [0xFF, type, param]
    if data.count >= 3, data[0] == R1BLE.GESTURE_MARKER {
      if let g = R1Gesture.parse(data) {
        log("GESTURE: \(g.rawValue)  [raw \(hex)]")
        onGesture?(g.rawValue, hex)
      } else {
        // Not a failure to report loudly — an unmapped gesture code is a FINDING.
        log(
          "UNKNOWN gesture frame type=0x\(String(format: "%02X", data[1])) "
            + "param=0x\(String(format: "%02X", data[2])) [raw \(hex)]")
      }
      return
    }

    // Battery: 2 bytes, first is percent.
    if data.count == 2, data[0] <= 100 {
      log("battery \(data[0])%")
      onBattery?(Int(data[0]))
      return
    }

    // State: 1 byte — 0x01 ready, 0x00 menu.
    if data.count == 1 {
      let state =
        data[0] == 0x01 ? "ready" : (data[0] == 0x00 ? "menu" : "unknown(\(data[0]))")
      log("state \(state)")
      return
    }

    // A longer frame may still carry a gesture triplet embedded in it.
    if data.count > 3, let ffIndex = data.firstIndex(of: R1BLE.GESTURE_MARKER),
      ffIndex + 2 < data.count
    {
      let triplet = Data(data[ffIndex...ffIndex + 2])
      if let g = R1Gesture.parse(triplet) {
        log("GESTURE (embedded): \(g.rawValue)  [raw \(hex)]")
        onGesture?(g.rawValue, hex)
      }
    }
  }
}

// MARK: - CBCentralManagerDelegate

extension R1Central: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let desc: String
    switch central.state {
    case .poweredOn: desc = "poweredOn"
    case .poweredOff: desc = "poweredOff"
    case .unauthorized: desc = "unauthorized"
    case .unsupported: desc = "unsupported"
    case .resetting: desc = "resetting"
    default: desc = "unknown"
    }
    log("bluetooth \(desc)")
    onStateChange?(desc)
    if central.state == .poweredOn, ring == nil, !isDisconnecting { startScan() }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
    let name = peripheral.name ?? advName
    guard matchesNameFilter(name) else { return }
    log("found '\(name ?? "?")' rssi=\(RSSI)")
    onDeviceFound?(name ?? "ring", RSSI.intValue)
    ringUUID = peripheral.identifier
    connect(peripheral)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    log("connected \(peripheral.name ?? "ring") — discovering ALL services")
    // nil = discover EVERYTHING. Do not narrow this to the services we think we need:
    // gestures may arrive on a characteristic we haven't catalogued, and a filtered
    // discovery makes that invisible by construction — indistinguishable from "the ring
    // sent nothing". (FUT-233: a filtered discovery produced exactly that false negative.)
    peripheral.discoverServices(nil)
  }

  func centralManager(
    _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
  ) {
    log("connect FAILED: \(error?.localizedDescription ?? "unknown")")
    resetConnectionState()
  }

  func centralManager(
    _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
  ) {
    let reason = error?.localizedDescription
    log("disconnected\(reason.map { " (\($0))" } ?? "")")
    stopHeartbeat()
    resetConnectionState()
    onDisconnected?(reason)
    if !isDisconnecting { startScan() }
  }
}

// MARK: - CBPeripheralDelegate

extension R1Central: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let error {
      log("service discovery failed: \(error.localizedDescription)")
      return
    }
    let services = peripheral.services ?? []
    log("services: \(services.map { shortUUID($0.uuid) }.joined(separator: ", "))")
    for service in services {
      peripheral.discoverCharacteristics(nil, for: service)  // nil = all
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
  ) {
    if let error {
      log("characteristic discovery failed: \(error.localizedDescription)")
      return
    }
    for c in service.characteristics ?? [] {
      // Catalogue the ones we know how to drive…
      switch c.uuid {
      case R1BLE.WRITE_1: writeChar1 = c
      case R1BLE.WRITE_2: writeChar2 = c
      case R1BLE.NOTIFY_1: notifyChar1 = c
      case R1BLE.NOTIFY_2: notifyChar2 = c
      case R1BLE.BATTERY_CHAR: batteryChar = c
      default: break
      }

      let p = c.properties
      var props: [String] = []
      if p.contains(.read) { props.append("read") }
      if p.contains(.write) { props.append("write") }
      if p.contains(.writeWithoutResponse) { props.append("writeNoResp") }
      if p.contains(.notify) { props.append("notify") }
      if p.contains(.indicate) { props.append("indicate") }
      log("char \(shortUUID(c.uuid)) props=[\(props.joined(separator: ","))]")

      // …but subscribe to EVERY notifying characteristic, known or not. If the ring
      // reports gestures somewhere we didn't anticipate, this is what catches it.
      if p.contains(.notify) || p.contains(.indicate) {
        expectedSubscriptions += 1
        peripheral.setNotifyValue(true, for: c)
      }

      // And READ every readable characteristic. This is not for the value: a read of an
      // encrypted characteristic is what triggers iOS to BOND. Without it, a ring that
      // was unpaired can connect and accept subscriptions while never delivering a
      // single notification — silence that looks identical to a dead protocol.
      if p.contains(.read) {
        peripheral.readValue(for: c)
      }
    }

    // Discovery arrives per-service, so "all subscriptions confirmed" can't be known
    // up front. Kick the handshake on a settle timer instead of an exact count — a ring
    // exposing no notify characteristic at all must not hang here forever.
    scheduleInitAfterDiscovery()
  }

  /// Run the init handshake once discovery has stopped producing new characteristics.
  private func scheduleInitAfterDiscovery() {
    initSettleWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.initSequenceRun else { return }
      self.log(
        "discovery settled — \(self.notifySubscriptions)/\(self.expectedSubscriptions) subscriptions confirmed")
      self.runInitSequence()
    }
    initSettleWork = work
    queue.asyncAfter(deadline: .now() + 1.2, execute: work)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    if let error {
      log("subscribe FAILED on \(shortUUID(characteristic.uuid)): \(error.localizedDescription)")
      return
    }
    guard characteristic.isNotifying else { return }
    notifySubscriptions += 1
    log("subscribed \(shortUUID(characteristic.uuid)) (\(notifySubscriptions)/\(expectedSubscriptions))")
    // Push the settle timer out on every confirmation, so the handshake waits for
    // discovery to genuinely finish rather than firing after the first service.
    scheduleInitAfterDiscovery()
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    if let error {
      log("read failed on \(shortUUID(characteristic.uuid)): \(error.localizedDescription)")
      return
    }
    guard let data = characteristic.value, !data.isEmpty else { return }

    if characteristic.uuid == R1BLE.BATTERY_CHAR {
      let pct = Int(data[0])
      log("battery \(pct)% (standard service)")
      onBattery?(pct)
      return
    }
    handle(data, from: characteristic)
  }
}
