//
//  G2Central.swift
//  ffs-ble
//
//  From-scratch CoreBluetooth central for the Even Realities G2 glasses.
//
//  Phase 2 scope: the G2 is TWO independent CBPeripherals (left + right lens),
//  each exposing the same GATT. This manager scans → filters G2 lenses →
//  connects BOTH → discovers services/characteristics per side → subscribes to
//  the protocol + audio notify characteristics → and coordinates the pair.
//  It adds per-side, 6ms-paced FIFO write queues (all .withoutResponse) drained
//  by independent loops behind a per-side write-lock, and a `send(_:to:)` API
//  that targets one side or both. It tracks a combined `pairReady` (both sides
//  connected AND their required characteristics discovered). Each side's
//  disconnect is handled independently — one lens dropping never nukes the
//  other's state. No MTU negotiation, no protocol/protobuf, no state
//  restoration yet (those land in later phases).
//
//  Protocol facts (GATT UUIDs, advertisement layout, side identification) are
//  mirrored from MentraOS's driver — specifically
//  mobile/modules/bluetooth-sdk/ios/Source/sgcs/G2.swift — which is MIT
//  licensed (Copyright (c) Mentra). We reimplement the CoreBluetooth plumbing
//  from scratch; only the wire-protocol constants are carried over verbatim.
//
//  Asymmetry (P0/FUT-159): the RIGHT lens carries the protocol notify + ACK
//  channel; the LEFT arm is SILENT on async protocol events. We still discover
//  characteristics on both sides (and subscribe on whichever side actually
//  exposes the notify char), but we expect protocol notifications on the RIGHT.
//
//  MIT attribution: portions of the BLE protocol constants below are derived
//  from MentraOS (https://github.com/Mentra-Community/MentraOS), MIT License.
//

import CoreBluetooth
import Foundation
import CryptoKit

/// Which physical lens a peripheral is.
enum G2Side: String {
  case left = "L"
  case right = "R"
  case unknown = "?"
}

/// Command target for `send(_:to:)`: a single side or both lenses.
enum G2Target {
  case left
  case right
  case both
}

/// Parsed manufacturer-data record advertised by a G2 lens.
struct G2Manufacturer {
  let sn: String   // 14-char ASCII serial number
  let mac: String  // "AA:BB:CC:DD:EE:FF" big-endian colon-hex
}

/// A discovered G2 lens (before/independent of a connection).
struct G2Discovery {
  let peripheral: CBPeripheral
  let name: String
  let side: G2Side
  let rssi: Int
  let manufacturer: G2Manufacturer?
}

/// All per-lens state: the peripheral, its matched characteristics, its paced
/// write queue, and the flag/lock that serialize a multi-packet message.
///
/// Every field here is touched ONLY on `G2Central.queue` (the single serial
/// CoreBluetooth queue), so no additional locking is needed — the "write-lock"
/// is the `draining` flag guarding the paced drain loop, which is also
/// queue-confined. The lock's job is to keep a multi-fragment message on one
/// side contiguous: once a drain loop starts emptying a side's queue it holds
/// that side until the queue is empty, so a second message enqueued mid-drain
/// can never interleave its packets with the first.
private final class G2Lens {
  let peripheral: CBPeripheral
  let side: G2Side
  let name: String

  var writeChar: CBCharacteristic?
  var notifyChar: CBCharacteristic?
  var audioChar: CBCharacteristic?

  /// FIFO of packets waiting to go out on this side, oldest first.
  var writeQueue: [Data] = []
  /// The paced drain loop is currently running for this side (the write-lock).
  var draining = false

  /// Inbound transport reassembler for this side (independent syncId stream).
  let rx = G2RxReassembler()

  init(peripheral: CBPeripheral, side: G2Side, name: String) {
    self.peripheral = peripheral
    self.side = side
    self.name = name
  }

  /// Connected + all required characteristics discovered.
  /// WRITE is required on every side; NOTIFY is required on the side that
  /// carries the protocol channel (the RIGHT lens, per FUT-159). We treat a
  /// side as "chars ready" once it has a write char AND — if it advertised a
  /// notify char — that notify char is bound. In practice the right lens has
  /// both; the left typically has only write. See `requiredCharsFound`.
  var connected: Bool { peripheral.state == .connected }
}

/// The CoreBluetooth central + delegate. All CoreBluetooth interaction happens
/// on `queue` (a dedicated serial queue); callbacks out to the Expo module are
/// invoked on that same queue — the module hops back to JS via sendEvent, which
/// is thread-safe in the Expo Modules API.
final class G2Central: NSObject {
  // MARK: - Protocol constants (mirrored from MentraOS G2.swift, MIT)

  /// EvenHub GATT service. G2.swift:43
  static let SERVICE_UUID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0000")
  /// phone → glasses (write, .withoutResponse). G2.swift:37
  static let CHAR_WRITE = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")
  /// glasses → phone protocol/acks (notify). G2.swift:38
  static let CHAR_NOTIFY = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5402")
  /// glasses → phone LC3 mic audio (notify). G2.swift:39
  static let AUDIO_NOTIFY = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E6402")
  // OTA firmware-flash channels (FUT-167 Stage 2). DATA svc e1001: write e0001 / notify
  // e0002. CTRL write e5401 == CHAR_WRITE. All acks arrive on the DATA notify (e0002).
  static let FLASH_DATA_SVC = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E1001")
  static let FLASH_DATA_WRITE = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0001")
  static let FLASH_DATA_NOTIFY = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0002")

  /// Substring every G2 peripheral name contains, e.g. "Even G2_XX_L_XXXXXX".
  private static let NAME_MATCH = "G2"

  /// Inter-packet pacing for the per-side write queues (P0 spec: 6ms).
  private static let WRITE_PACING_MS = 6

  // MARK: - Callback closures (wired by the Expo module)

  /// (message) — every log line, already timestamped by `log(_:)`.
  var onLog: ((String) -> Void)?
  /// (stateDescription) — CBManagerState transitions ("poweredOn", ...).
  var onStateChange: ((String) -> Void)?
  /// (name, side, rssi, sn?, mac?) — a G2 lens seen in a scan.
  var onDeviceFound: ((String, String, Int, String?, String?) -> Void)?
  /// (name, side) — a lens finished connecting.
  var onConnected: ((String, String) -> Void)?
  /// (side, charUUIDs) — a side's services discovered; the UUIDs we matched.
  var onServicesDiscovered: ((String, [String]) -> Void)?
  /// () — BOTH lenses connected AND required chars found. Fires once per pair-up.
  var onPairReady: (() -> Void)?
  /// (base64Payload, characteristicUUID, side) — a notification arrived.
  var onNotify: ((String, String, String) -> Void)?
  /// (name, side, reason?) — a lens disconnected.
  var onDisconnected: ((String, String, String?) -> Void)?
  /// (gesture, side) — a decoded touch gesture ("tap"/"double_tap"/"swipe_up"/"swipe_down").
  var onGesture: ((String, String) -> Void)?
  /// (leftVersion?, rightVersion?, battery?, charging?) — a device-info response
  /// (FUT-169 real battery + FUT-167 canary firmware-version read-back). Any field may
  /// be nil if the glasses omitted it.
  var onDeviceInfo: ((String?, String?, Int?, Bool?) -> Void)?
  /// (leftReady, rightReady, detail) — result of the zero-write flash-channel probe
  /// (FUT-167 Stage 1). `*Ready` = all 4 OTA flash characteristics present on that lens.
  var onFlashProbe: ((Bool, Bool, String) -> Void)?
  /// (message, progress 0…1, done, ok) — FUT-167 Stage 2 CFW flash/validate progress.
  var onFlashProgress: ((String, Double, Bool, Bool) -> Void)?

  // ---- FUT-167 Stage 2 flash state (internal so the G2CentralFlash extension file
  // can reach it; the OTA state machine runs on `flashQueue`, off the CB queue). ----
  let flashQueue = DispatchQueue(label: "com.ffs.g2flash")
  /// True while an OTA flash session owns the link (suspends display/gesture/heartbeat).
  var flashActive = false
  /// Raw frames captured on the DATA notify char (e0002) during a flash, FIFO.
  var flashRx: [[UInt8]] = []
  let flashRxLock = NSLock()
  let flashSem = DispatchSemaphore(value: 0)
  /// Rolling transport seq for the OTA session (guarded by flashRxLock).
  var flashSeq: UInt8 = 0

  // MARK: - State

  /// Dedicated serial queue — all CoreBluetooth work runs here.
  private let queue = DispatchQueue(label: "FfsBleQueue", qos: .userInitiated)
  private var central: CBCentralManager!

  /// Discovered lenses keyed by side (deduped as the same lens re-advertises).
  private var discovered: [G2Side: G2Discovery] = [:]

  /// The connected lenses, keyed by side. Held STRONGLY (via the G2Lens box) —
  /// CoreBluetooth does not retain peripherals, so dropping these references
  /// would silently kill the connection.
  private var lenses: [G2Side: G2Lens] = [:]

  /// Whether we've already emitted onPairReady for the current pair-up (so it
  /// fires exactly once per transition into the ready state).
  private var pairReadyFired = false

  /// Connect intent. When set we connect BOTH lenses as they're discovered.
  private var wantsPair = false
  /// Single-side connect intent (testing convenience): connect only this side.
  private var wantsSingleSide: G2Side?
  private var isScanning = false

  // MARK: - Init

  override init() {
    super.init()
    // Tag our serial queue so queueSync can detect (and skip re-entrant) sync.
    queue.setSpecific(key: G2Central.queueKey, value: ())
    // showPowerAlert:false — we surface BT-off via onStateChange, not a system alert.
    central = CBCentralManager(
      delegate: self,
      queue: queue,
      options: [CBCentralManagerOptionShowPowerAlertKey: false]
    )
    log("G2Central initialized (dual-radio / P2)")
  }

  // MARK: - Logging

  private static let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  /// Timestamp (ISO8601 + millis) + forward to the module. Also NSLog for Xcode.
  func log(_ message: String) {
    let line = "[\(G2Central.isoFormatter.string(from: Date()))] \(message)"
    NSLog("[ffs-ble] %@", line)
    onLog?(line)
  }

  // MARK: - Public API (called from the module; may be off-queue → hop onto queue)

  func startScan() {
    queue.async { [weak self] in self?.startScanLocked() }
  }

  private func startScanLocked() {
    guard central.state == .poweredOn else {
      log("startScan deferred — central not powered on (state=\(describe(central.state)))")
      // Will auto-start once powered on if a connect is pending; otherwise just note it.
      return
    }
    guard !isScanning else {
      log("startScan ignored — already scanning")
      return
    }
    isScanning = true
    // Scan with NO service filter — the container service is only usable via
    // retrieveConnectedPeripherals, not for advertising discovery. We filter by
    // name in didDiscover instead. (G2.swift discovery note.)
    central.scanForPeripherals(
      withServices: nil,
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )
    log("Scanning started (no service filter; name-matching '\(G2Central.NAME_MATCH)')")
  }

  func stopScan() {
    queue.async { [weak self] in self?.stopScanLocked() }
  }

  private func stopScanLocked() {
    guard isScanning else { return }
    central.stopScan()
    isScanning = false
    log("Scanning stopped")
  }

  /// Connect BOTH lenses (the pair). This is the primary P2 entry point: we
  /// connect each side as it's discovered and only consider the driver "ready"
  /// once both are up with their required characteristics.
  func connectPair() {
    queue.async { [weak self] in
      guard let self = self else { return }
      self.wantsPair = true
      self.wantsSingleSide = nil
      self.log("connectPair requested")
      self.connectDiscoveredLocked()
      if self.lenses[.left] == nil || self.lenses[.right] == nil {
        // Missing at least one side — make sure we're scanning; connects fire
        // from didDiscover as each lens shows up.
        self.startScanLocked()
      }
    }
  }

  /// Connect a SINGLE side only (testing convenience — e.g. connect the right
  /// lens in isolation). Does not gate on the pair. `side` must be .left/.right.
  func connectSide(_ side: G2Side) {
    queue.async { [weak self] in
      guard let self = self, side == .left || side == .right else { return }
      self.wantsPair = false
      self.wantsSingleSide = side
      self.log("connectSide requested (side=\(side.rawValue))")
      if let disc = self.discovered[side], self.lenses[side] == nil {
        self.beginConnect(to: disc)
      } else if self.lenses[side] == nil {
        self.log("Side \(side.rawValue) not discovered yet — ensuring scan is active")
        self.startScanLocked()
      }
    }
  }

  /// Disconnect BOTH lenses and drop all intent.
  func disconnect() {
    queue.async { [weak self] in
      guard let self = self else { return }
      self.wantsPair = false
      self.wantsSingleSide = nil
      guard !self.lenses.isEmpty else {
        self.log("disconnect ignored — nothing connected")
        return
      }
      for lens in self.lenses.values {
        self.log("Disconnecting from \(lens.name) (side=\(lens.side.rawValue))")
        self.central.cancelPeripheralConnection(lens.peripheral)
      }
    }
  }

  /// Both lenses connected AND their required characteristics discovered.
  func isPairReady() -> Bool {
    return queueSync { self.pairReadyLocked() }
  }

  /// Is a given side currently connected + chars ready?
  func isSideReady(_ side: G2Side) -> Bool {
    return queueSync {
      guard let lens = self.lenses[side] else { return false }
      return lens.connected && self.requiredCharsFound(lens)
    }
  }

  // MARK: - Writes (per-side paced FIFO queues behind the write-lock)

  /// Enqueue `data` (one already-formed packet) to be written to the target
  /// side(s). Each side drains its own FIFO at 6ms spacing, all
  /// .withoutResponse. The drain loop holds a side until its queue is empty, so
  /// a multi-fragment message enqueued as consecutive `send` calls on the same
  /// side is written contiguously — no interleaving with a later message.
  ///
  /// NOTE: to send a multi-fragment message atomically, enqueue all its
  /// fragments in ONE call to `send(fragments:to:)` (below), or issue the
  /// per-fragment `send` calls back-to-back from the queue — both guarantee the
  /// fragments sit consecutively in the FIFO before any drain interleaves.
  func send(_ data: Data, to target: G2Target) {
    queue.async { [weak self] in self?.enqueueLocked([data], to: target) }
  }

  /// Enqueue an ordered list of fragments as ONE contiguous message to the
  /// target side(s). The fragments are appended together under the serial
  /// queue, so they can never be split by another message's packets.
  func send(fragments: [Data], to target: G2Target) {
    queue.async { [weak self] in self?.enqueueLocked(fragments, to: target) }
  }

  private func sides(for target: G2Target) -> [G2Side] {
    switch target {
    case .left: return [.left]
    case .right: return [.right]
    case .both: return [.left, .right]
    }
  }

  private func enqueueLocked(_ fragments: [Data], to target: G2Target) {
    guard !fragments.isEmpty else { return }
    for side in sides(for: target) {
      guard let lens = lenses[side] else {
        log("send dropped — side \(side.rawValue) not connected (\(fragments.count) pkt)")
        continue
      }
      // Append the whole message contiguously, THEN kick the drain. Because
      // both the append and every drain step run on the same serial queue, the
      // fragments are guaranteed adjacent in the FIFO before any packet leaves.
      lens.writeQueue.append(contentsOf: fragments)
      startDrainLocked(lens)
    }
  }

  /// Start the paced drain loop for a side if it isn't already running. The
  /// `draining` flag IS the per-side write-lock: only one drain loop per side.
  private func startDrainLocked(_ lens: G2Lens) {
    guard !lens.draining else { return }
    guard lens.writeChar != nil else {
      log("drain skipped — side \(lens.side.rawValue) has no write characteristic")
      return
    }
    lens.draining = true
    drainStepLocked(lens)
  }

  /// Write one packet, then reschedule the next after WRITE_PACING_MS. Runs on
  /// `queue`. Holds the side (draining=true) until the queue empties.
  private func drainStepLocked(_ lens: G2Lens) {
    // The lens may have disconnected between steps — bail and release the lock.
    guard lens.connected, let writeChar = lens.writeChar else {
      lens.draining = false
      lens.writeQueue.removeAll()
      return
    }
    guard !lens.writeQueue.isEmpty else {
      lens.draining = false
      return
    }
    let packet = lens.writeQueue.removeFirst()
    lens.peripheral.writeValue(packet, for: writeChar, type: .withoutResponse)

    let deadline = DispatchTime.now() + .milliseconds(G2Central.WRITE_PACING_MS)
    queue.asyncAfter(deadline: deadline) { [weak self, weak lens] in
      guard let self = self, let lens = lens else { return }
      self.drainStepLocked(lens)
    }
  }

  // MARK: - Pair / readiness helpers

  /// Required chars for a side: WRITE always; NOTIFY only on the side that
  /// actually exposes it (the RIGHT lens carries the protocol channel — the
  /// LEFT is silent, so we do NOT require a notify char on the left).
  private func requiredCharsFound(_ lens: G2Lens) -> Bool {
    guard lens.writeChar != nil else { return false }
    if lens.side == .right {
      // The protocol channel lives on the right; require its notify char too.
      return lens.notifyChar != nil
    }
    return true
  }

  private func pairReadyLocked() -> Bool {
    guard let l = lenses[.left], let r = lenses[.right] else { return false }
    return l.connected && r.connected
      && requiredCharsFound(l) && requiredCharsFound(r)
  }

  /// Re-check the pair after any connect/char-discovery/disconnect. Fires
  /// onPairReady exactly once on the transition into the ready state, and
  /// re-arms once the pair is no longer ready (so a reconnect can fire again).
  private func evaluatePairLocked() {
    let ready = pairReadyLocked()
    if ready && !pairReadyFired {
      pairReadyFired = true
      log("PAIR READY — both lenses connected + required characteristics bound")
      onPairReady?()
    } else if !ready && pairReadyFired {
      pairReadyFired = false
    }
  }

  // MARK: - Connect helpers

  /// Connect whatever discovered lenses satisfy the current intent.
  private func connectDiscoveredLocked() {
    if wantsPair {
      for side in [G2Side.left, .right] {
        if lenses[side] == nil, let disc = discovered[side] {
          beginConnect(to: disc)
        }
      }
    } else if let side = wantsSingleSide,
              lenses[side] == nil, let disc = discovered[side] {
      beginConnect(to: disc)
    }
  }

  private func beginConnect(to disc: G2Discovery) {
    let side = disc.side
    guard side == .left || side == .right else {
      log("Refusing to connect lens with unknown side: \(disc.name)")
      return
    }
    guard lenses[side] == nil else { return }  // already connecting/connected
    let lens = G2Lens(peripheral: disc.peripheral, side: side, name: disc.name)
    lens.peripheral.delegate = self
    lenses[side] = lens                        // strong retain BEFORE connecting
    log("Connecting to \(disc.name) (side=\(side.rawValue))")
    central.connect(disc.peripheral, options: nil)

    // Once we've initiated connects for every side we still want, stop scanning
    // to save power. For a single-side connect, stop as soon as it's underway;
    // for the pair, stop only once both sides are accounted for.
    maybeStopScanningLocked()
  }

  /// Stop scanning once we've initiated a connect for every side the current
  /// intent wants (both sides for a pair, the one side for a single-side test).
  private func maybeStopScanningLocked() {
    if wantsPair {
      if lenses[.left] != nil && lenses[.right] != nil { stopScanLocked() }
    } else if let side = wantsSingleSide {
      if lenses[side] != nil { stopScanLocked() }
    }
  }

  // MARK: - Advertisement parsing

  /// Derive the lens side from a peripheral name like "Even G2_XX_L_XXXXXX".
  private func side(from name: String) -> G2Side {
    if name.contains("_L_") { return .left }
    if name.contains("_R_") { return .right }
    return .unknown
  }

  /// Parse the manufacturer-specific advertisement blob:
  ///   "ER"(2) + SN(14 ASCII) + MAC(6, little-endian) + flag(1), ≥22 bytes.
  /// MAC is reversed → big-endian colon-hex. (Mirrored from G2.swift, MIT.)
  private func parseManufacturer(_ data: Data?) -> G2Manufacturer? {
    guard let data = data, data.count >= 22 else { return nil }
    let bytes = [UInt8](data)
    // bytes[0..<2] == "ER" magic; we don't hard-require it but note if absent.
    let snBytes = bytes[2..<16]
    let sn = String(bytes: snBytes, encoding: .ascii)?
      .trimmingCharacters(in: CharacterSet(charactersIn: "\0")) ?? ""
    let macLE = bytes[16..<22]                 // little-endian
    let mac = macLE.reversed()
      .map { String(format: "%02X", $0) }
      .joined(separator: ":")
    return G2Manufacturer(sn: sn, mac: mac)
  }

  // MARK: - Small queue helpers

  /// Run `body` synchronously on the CB queue and return its value. Used only by
  /// the synchronous status probes (isPairReady / isSideReady). Guards against a
  /// deadlock if somehow already on the queue.
  private func queueSync<T>(_ body: @escaping () -> T) -> T {
    if DispatchQueue.getSpecific(key: G2Central.queueKey) != nil {
      return body()
    }
    return queue.sync(execute: body)
  }

  private static let queueKey = DispatchSpecificKey<Void>()

  // MARK: - EvenHub session + display (P3)

  /// Rolling syncId/magicRandom for the wire protocol.
  private let counters = G2SendCounters()
  /// The auth handshake has completed (secAuth accepted); EvenHub commands OK.
  private var sessionAuthed = false
  /// The keep-alive heartbeat loop is running.
  private var heartbeatRunning = false
  /// A startup page has been created this session — subsequent pages must use
  /// rebuildPage (createStartupPage only takes once per session). Reset on drop.
  private var pageCreated = false
  // FFS Dashboard (FUT-176) — our own dashboard app state.
  private var dashModel = FfsDashboard.Model()
  private var dashActive = false

  // MARK: - Image transfer state (P4, FUT-153)
  /// Rolling per-image session id (firmware keys reassembly on it).
  private var imgSessionCounter: Int32 = 0
  /// The (session, fragment) we're currently awaiting an ACK for, plus its
  /// resolver + timeout. Only one image fragment is ever in flight.
  private var imgAckExpect: (session: Int32, fragment: Int32)?
  private var imgAckResolve: ((Bool) -> Void)?
  private var imgAckTimer: DispatchWorkItem?
  private static let IMG_FRAGMENT_SIZE = 4096
  private static let IMG_MAX_ATTEMPTS = 3
  private static let IMG_ACK_TIMEOUT_MS = 2000

  /// Send an EvenHub (0xE0) payload as paced packets to the target side(s).
  private func sendEvenHubLocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(
      serviceId: G2ServiceID.evenHub.rawValue, payload: payload, reserveFlag: true)
    enqueueLocked(pkts, to: target)
  }

  /// Send a DevSettings (0x80) payload to the target side(s).
  private func sendDevSettingsLocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(serviceId: G2ServiceID.deviceSettings.rawValue, payload: payload)
    enqueueLocked(pkts, to: target)
  }

  /// Send a gesture-control (0x0D) payload to the target side(s).
  private func sendGestureCtrlLocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(serviceId: G2ServiceID.gestureCtrl.rawValue, payload: payload)
    enqueueLocked(pkts, to: target)
  }

  /// Send an onboarding (0x10) payload to the target side(s).
  private func sendOnboardingLocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(serviceId: G2ServiceID.onboarding.rawValue, payload: payload)
    enqueueLocked(pkts, to: target)
  }

  /// Send an even_ai (service 7) payload to the target side(s). `reserveFlag: true`
  /// matches MentraOS's even_ai path. The swirl is dual-lens, so we send to BOTH.
  private func sendEvenAILocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(
      serviceId: G2ServiceID.evenAI.rawValue, payload: payload, reserveFlag: true)
    enqueueLocked(pkts, to: target)
  }

  /// Send a G2 device-settings (service 0x09) payload to the target side(s). Matches
  /// MentraOS's g2Setting send (reserveFlag: true).
  private func sendG2SettingLocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(
      serviceId: G2ServiceID.g2Setting.rawValue, payload: payload, reserveFlag: true)
    enqueueLocked(pkts, to: target)
  }

  /// Public: request real device info (battery %, charging, per-lens firmware version)
  /// from the glasses. The answer arrives asynchronously via `onDeviceInfo`. No-op during
  /// a flash (the OTA session owns the link exclusively) or before the pair is ready.
  /// Sent to BOTH lenses so whichever answers is captured; the reply is deduped. This is
  /// the real battery source (FUT-169) and the canary flash's version read-back (FUT-167).
  func requestDeviceInfo() {
    queue.async { [weak self] in
      guard let self = self else { return }
      if self.flashActive {
        self.log("requestDeviceInfo ignored — flash in progress")
        return
      }
      guard self.pairReadyLocked() else {
        self.log("requestDeviceInfo ignored — pair not ready (connect both lenses first)")
        return
      }
      self.sendG2SettingLocked(
        G2Setting.requestDeviceInfo(magicRandom: self.counters.nextMagic()), to: .both)
      self.log("requestDeviceInfo → both (service 0x09)")
    }
  }

  /// Send a stock-dashboard (service 0x01) payload to the target side(s). (FUT-170)
  private func sendDashboardLocked(_ payload: Data, to target: G2Target) {
    let pkts = counters.packets(
      serviceId: G2ServiceID.dashboard.rawValue, payload: payload, reserveFlag: true)
    enqueueLocked(pkts, to: target)
  }

  /// Public (FUT-170 PoC): push CUSTOM content into the firmware's native head-up dashboard
  /// over BLE — no firmware patch. Re-enables the head-up trigger (we disable it by default),
  /// puts the Schedule widget first, then pushes `text` as a Schedule entry. Look UP on the
  /// glasses to see it. Proves we can drive the stock dashboard's content.
  func pushDashboardDemo(text: String) {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else {
        self.log("pushDashboardDemo ignored — pair not ready (connect both lenses first)"); return
      }
      let fire: () -> Void = { [weak self] in
        guard let self = self else { return }
        // 1) enable the head-up trigger so the dashboard renders on look-up.
        self.sendG2SettingLocked(
          G2Setting.setHeadUpSwitch(magicRandom: self.counters.nextMagic(), enabled: true), to: .both)
        // 2) Schedule widget first.
        self.sendDashboardLocked(
          G2Dashboard.displayConfig(magicRandom: self.counters.nextMagic(), widgetOrder: [3, 1, 2, 4, 5]),
          to: .both)
        // 3) push our custom text as a Schedule entry.
        let tz = Int32(TimeZone.current.secondsFromGMT())
        let end = Int32(truncatingIfNeeded: Int64(Date().timeIntervalSince1970)) &+ tz &+ 3600
        self.sendDashboardLocked(
          G2Dashboard.pushSchedule(
            magicRandom: self.counters.nextMagic(), scheduleId: 1, title: text,
            location: "FFS OS", time: "now", endTimestamp: end),
          to: .both)
        self.log("dashboard demo: head-up ON + schedule-first + pushed '\(text)' — look UP to see it")
      }
      if self.sessionAuthed { fire() } else { self.runAuthLocked { [weak self] in
        self?.startHeartbeatsLocked(); fire() } }
    }
  }

  /// Reveal the FIRMWARE'S OWN native head-up dashboard (Even's real LVGL UI) by RELEASING
  /// our EvenHub page. While our OS holds a page the stock dashboard can never surface; this
  /// shuts our page down (cmd 9), re-enables the head-up trigger (we disable it by default),
  /// and arranges the widgets our way over BLE (service 0x01) — so the user sees Even's
  /// gorgeous dashboard, styled by us, NO firmware patch. Touchpad gestures still arrive over
  /// BLE, so the next screen (showText/showImage re-creates a fresh page) is the way back.
  /// This is the real FUT-170 deliverable — bring THEIR dashboard in, not a text clone.
  func showStockDashboard() {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else {
        self.log("showStockDashboard ignored — pair not ready (connect both lenses first)"); return
      }
      let reveal: () -> Void = { [weak self] in
        guard let self = self else { return }
        // stop any pixel loop, then release our page so the firmware owns the HUD.
        self.stopAnimationLocked()
        self.sendEvenHubLocked(
          G2EvenHub.shutdownPage(magicRandom: self.counters.nextMagic()), to: .right)
        self.pageCreated = false  // next page re-creates fresh — that's the way back
        // re-enable the head-up trigger so Even's native dashboard renders on look-up.
        self.sendG2SettingLocked(
          G2Setting.setHeadUpSwitch(magicRandom: self.counters.nextMagic(), enabled: true), to: .both)
        // arrange the widgets our way over BLE — styling THEIR UI, no firmware patch.
        self.sendDashboardLocked(
          G2Dashboard.displayConfig(magicRandom: self.counters.nextMagic(), widgetOrder: [3, 1, 2, 4, 5]),
          to: .both)
        self.log("showStockDashboard: released our page + head-up ON — Even's native dashboard now shows (look up)")
      }
      if self.sessionAuthed { reveal() } else { self.runAuthLocked { [weak self] in
        self?.startHeartbeatsLocked(); reveal() } }
    }
  }

  // MARK: - FFS Dashboard (FUT-176) — our OWN dashboard, our pixels, on the mode-2 pipeline

  /// Show our dashboard app: auth if needed, ensure the persistent 576×288 container,
  /// then render the current model as a static mode-2 frame (reuses the FUT-165 pipeline).
  func showDashboard() {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else { self.log("showDashboard ignored — pair not ready"); return }
      let start: () -> Void = { [weak self] in
        guard let self = self else { return }
        self.startHeartbeatsLocked()
        self.stopAnimationLocked()       // no frame loop; the dashboard is static-on-demand
        self.dashActive = true
        self.log("dashboard: show (tile \(self.dashModel.tile))")
        self.ensureAnimContainerLocked { [weak self] in self?.renderDashboardLocked() }
      }
      if self.sessionAuthed { start() } else { self.runAuthLocked(start) }
    }
  }

  func hideDashboard() { queue.async { [weak self] in self?.dashActive = false } }

  /// Gesture from JS: "next" | "prev" | "select" | "back".
  func dashboardInput(_ action: String) {
    queue.async { [weak self] in
      guard let self = self, self.dashActive else { return }
      switch action {
      case "next":   if !self.dashModel.expanded { self.dashModel.tile = (self.dashModel.tile + 1) % FfsDashboard.TILE_COUNT }
      case "prev":   if !self.dashModel.expanded { self.dashModel.tile = (self.dashModel.tile + FfsDashboard.TILE_COUNT - 1) % FfsDashboard.TILE_COUNT }
      case "select": self.dashModel.expanded = true
      case "back":   self.dashModel.expanded = false
      case "toggle": self.dashModel.expanded.toggle()
      default: break
      }
      self.renderDashboardLocked()
    }
  }

  /// Update dashboard model fields from a JSON blob supplied by the phone, then re-render.
  func setDashboardData(_ json: String) {
    queue.async { [weak self] in
      guard let self = self else { return }
      self.applyDashboardJSONLocked(json)
      if self.dashActive && self.animContainerReady { self.renderDashboardLocked() }
    }
  }

  private func renderDashboardLocked() {
    guard dashActive, pairReadyLocked() else { return }
    let model = dashModel
    animQueue.async { [weak self] in
      guard let self = self else { return }
      let pixels = FfsDashboard.render(model)
      let payload = G2Anim.mode2Payload(pixels)
      self.queue.async { [weak self] in
        guard let self = self, self.dashActive, self.animContainerReady else { return }
        guard let p = payload else { self.log("dashboard: mode2 encode FAILED"); return }
        self.sendAnimFrameLocked(p)
        self.schedule(120) { [weak self] in
          guard let self = self, self.dashActive else { return }
          self.sendAnimFrameLocked(p)   // 2nd send: static-frame drop-robustness
        }
        self.log("dashboard: rendered tile=\(model.tile) expanded=\(model.expanded) \(p.count)B")
      }
    }
  }

  private func applyDashboardJSONLocked(_ json: String) {
    guard let data = json.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    var m = dashModel
    if let v = obj["time"] as? String { m.time = v }
    if let v = obj["date"] as? String { m.date = v }
    if let v = obj["battery"] as? Int { m.battery = v }
    else if let v = obj["battery"] as? Double { m.battery = Int(v) }
    if let v = obj["tile"] as? Int { m.tile = max(0, min(FfsDashboard.TILE_COUNT - 1, v)) }
    if let v = obj["calendarTitle"] as? String { m.calendarTitle = v }
    if let v = obj["calendarSub"] as? String { m.calendarSub = v }
    if let v = obj["stockA"] as? String { m.stockA = v }
    if let v = obj["stockB"] as? String { m.stockB = v }
    if let v = obj["newsTitle"] as? String { m.newsTitle = v }
    if let v = obj["newsSub"] as? String { m.newsSub = v }
    if let v = obj["healthA"] as? String { m.healthA = v }
    if let v = obj["healthB"] as? String { m.healthB = v }
    if let v = obj["todo1"] as? String { m.todo1 = v }
    if let v = obj["todo2"] as? String { m.todo2 = v }
    if let v = obj["statusA"] as? String { m.statusA = v }
    if let v = obj["statusB"] as? String { m.statusB = v }
    if let rows = obj["calendarRows"] as? [[String]] {
      m.calendarRows = rows.compactMap { $0.count >= 2 ? ($0[0], $0[1]) : nil }
    }
    dashModel = m
  }

  /// Run `body` on the CB queue after `ms` milliseconds.
  private func schedule(_ ms: Int, _ body: @escaping () -> Void) {
    queue.asyncAfter(deadline: .now() + .milliseconds(ms), execute: body)
  }

  /// Public: run the auth handshake if needed, then render `text` on the HUD.
  /// This is our P3 "first pixel" path — connect the pair, then call this.
  func showText(_ text: String) {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else {
        self.log("showText ignored — pair not ready (connect both lenses first)")
        return
      }
      if self.sessionAuthed {
        self.sendTextPageLocked(text)
      } else {
        self.runAuthLocked { [weak self] in
          guard let self = self else { return }
          self.sendTextPageLocked(text)
          self.startHeartbeatsLocked()
        }
      }
    }
  }

  private func sendTextPageLocked(_ text: String) {
    stopAnimationLocked()  // a text surface replaces the page — never push frames into it
    let rebuild = pageCreated
    let msg = G2EvenHub.textPageMessage(
      text: text, rebuild: rebuild, magicRandom: counters.nextMagic())
    // Display content goes to the RIGHT lens (the protocol channel); the firmware
    // mirrors the page to both lenses. (P0 spec: default target = RIGHT.)
    sendEvenHubLocked(msg, to: .right)
    pageCreated = true
    log("showText: \(rebuild ? "rebuilt" : "created") text page (\(text.utf8.count)B) → right")
  }

  // MARK: - Image display (P4, FUT-153)

  /// Public: render a test image on the HUD through our own raw-image path.
  /// Auths if needed, creates (or rebuilds) a page with one image container, waits
  /// ~700ms for the container to settle, then streams the 4-bit BMP as ACK-gated
  /// fragments. This is our P4 "first image pixel".
  func showImage() {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else {
        self.log("showImage ignored — pair not ready (connect both lenses first)")
        return
      }
      if self.sessionAuthed {
        self.sendImagePageLocked()
      } else {
        self.runAuthLocked { [weak self] in
          guard let self = self else { return }
          self.startHeartbeatsLocked()
          self.sendImagePageLocked()
        }
      }
    }
  }

  /// Public: FUT-167 Stage 1 — a ZERO-WRITE flash-channel probe. Confirms the OTA
  /// firmware-flash characteristics (CTRL write/notify + DATA write/notify) are
  /// discoverable on BOTH lenses — the g2flash "discover" stage, no writes, no brick
  /// risk. Proves the in-app flasher can reach the glasses before any write path exists
  /// (Stage 2). Reads already-discovered GATT state only; sends nothing.
  func flashDryRun() {
    queue.async { [weak self] in
      guard let self = self else { return }
      // The four OTA flash characteristics (from g2flash: CTRL svc e5450, DATA svc e1001).
      let want: [(String, CBUUID)] = [
        ("CTRL.write", CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")),
        ("CTRL.notify", CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5402")),
        ("DATA.write", CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0001")),
        ("DATA.notify", CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0002")),
      ]

      func probe(_ side: G2Side) -> (ready: Bool, line: String) {
        guard let lens = self.lenses[side], lens.connected else {
          return (false, "\(side.rawValue): not connected")
        }
        var found = Set<CBUUID>()
        for svc in lens.peripheral.services ?? [] {
          for ch in svc.characteristics ?? [] { found.insert(ch.uuid) }
        }
        let present = want.map { found.contains($0.1) }
        let ready = present.allSatisfy { $0 }
        let missing = zip(want, present).filter { !$0.1 }.map { $0.0.0 }
        let line = ready
          ? "\(side.rawValue): all 4 flash channels present ✓"
          : "\(side.rawValue): MISSING \(missing.joined(separator: ", "))"
        return (ready, line)
      }

      let l = probe(.left)
      let r = probe(.right)
      let detail = "FLASH DRY-RUN (zero-write, no data sent)\n\(l.line)\n\(r.line)"
      self.log("flashDryRun — \(l.line); \(r.line)")
      self.onFlashProbe?(l.ready, r.ready, detail)
    }
  }

  /// Public: toggle the firmware's NATIVE "Even AI" swirl (GPU-smooth, dual-lens) by
  /// driving the even_ai session lifecycle over BLE — no pixel streaming. `on` sends
  /// CTRL{ENTER} (firmware shows the AI card + its processing animation) then, after a
  /// beat, ASK to hold the "thinking" (awaiting-reply) state; `off` sends CTRL{EXIT}.
  /// Auths first if needed. (FUT-165, Path A — the native-animation trigger.)
  func aiSwirl(on: Bool) {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else {
        self.log("aiSwirl ignored — pair not ready (connect both lenses first)")
        return
      }
      let fire: () -> Void = { [weak self] in
        guard let self = self else { return }
        if on {
          self.sendEvenAILocked(
            G2EvenAI.ctrl(status: .enter, magicRandom: self.counters.nextMagic()), to: .both)
          self.log("aiSwirl: CTRL ENTER → native swirl on")
          // Hold the session in the "thinking" (awaiting-reply) state so the animation
          // keeps running instead of timing straight back out.
          self.schedule(400) { [weak self] in
            guard let self = self else { return }
            self.sendEvenAILocked(
              G2EvenAI.ask(text: " ", magicRandom: self.counters.nextMagic()), to: .both)
            self.log("aiSwirl: ASK sustain")
          }
        } else {
          self.sendEvenAILocked(
            G2EvenAI.ctrl(status: .exit, magicRandom: self.counters.nextMagic()), to: .both)
          self.log("aiSwirl: CTRL EXIT → swirl off")
        }
      }
      if self.sessionAuthed {
        fire()
      } else {
        self.runAuthLocked { [weak self] in
          self?.startHeartbeatsLocked()
          fire()
        }
      }
    }
  }

  private func sendImagePageLocked() {
    stopAnimationLocked()  // the static Image Test replaces the page — stop any anim loop
    guard let bmp = G2EvenHub.testImageBmp() else {
      log("showImage: BMP build failed")
      return
    }
    let cid: Int32 = 1
    let name = "ffs-img"
    // Center a 200×100 image container on the 576×288 canvas.
    let ic = G2EvenHub.imageContainer(
      x: 188, y: 94, width: 200, height: 100, containerID: cid, containerName: name)
    let rebuild = pageCreated
    let page = G2EvenHub.imagePageMessage(
      imageContainer: ic, rebuild: rebuild, magicRandom: counters.nextMagic())
    sendEvenHubLocked(page, to: .right)
    pageCreated = true
    log("showImage: \(rebuild ? "rebuilt" : "created") image page, bmp=\(bmp.count)B — 700ms settle")
    // Firmware needs ~700ms after container create/rebuild before it accepts pixels.
    schedule(700) { [weak self] in
      guard let self = self else { return }
      self.sendImageDataLocked(containerID: cid, name: name, bmp: bmp, attempt: 1) { [weak self] ok in
        self?.log("showImage: transfer done success=\(ok)")
      }
    }
  }

  /// Stream `bmp` as ACK-gated 4096-byte fragments (one image session per attempt;
  /// retry the whole image with a fresh session on any fragment failure/timeout).
  private func sendImageDataLocked(
    containerID: Int32, name: String, bmp: Data, attempt: Int, done: @escaping (Bool) -> Void
  ) {
    guard !bmp.isEmpty else { done(false); return }
    imgSessionCounter = (imgSessionCounter &+ 1) & 0xff
    let session = imgSessionCounter
    log("img: send start session=\(session) attempt=\(attempt) bytes=\(bmp.count)")
    sendImageFragmentLocked(
      containerID: containerID, name: name, bmp: bmp, session: session,
      fragmentIndex: 0, offset: 0, attempt: attempt, done: done)
  }

  private func sendImageFragmentLocked(
    containerID: Int32, name: String, bmp: Data, session: Int32, fragmentIndex: Int32,
    offset: Int, attempt: Int, done: @escaping (Bool) -> Void
  ) {
    if offset >= bmp.count {
      log("img: complete session=\(session) fragments=\(fragmentIndex)")
      done(true)
      return
    }
    let end = min(offset + G2Central.IMG_FRAGMENT_SIZE, bmp.count)
    let fragment = bmp.subdata(in: offset..<end)
    let update = G2EvenHub.imageRawDataUpdate(
      containerID: containerID, containerName: name, mapSessionId: session,
      mapTotalSize: Int32(bmp.count), compressMode: 0, mapFragmentIndex: fragmentIndex,
      mapFragmentPacketSize: Int32(fragment.count), mapRawData: fragment)
    let msg = G2EvenHub.updateImageMessage(update, magicRandom: counters.nextMagic())
    // Arm the ACK gate BEFORE sending so a fast ACK can't race us.
    armImageAckLocked(session: session, fragment: fragmentIndex) { [weak self] ok in
      guard let self = self else { return }
      if ok {
        self.sendImageFragmentLocked(
          containerID: containerID, name: name, bmp: bmp, session: session,
          fragmentIndex: fragmentIndex + 1, offset: end, attempt: attempt, done: done)
      } else {
        self.log("img: fragment \(fragmentIndex) failed (session=\(session)) attempt=\(attempt)")
        if attempt < G2Central.IMG_MAX_ATTEMPTS {
          self.sendImageDataLocked(
            containerID: containerID, name: name, bmp: bmp, attempt: attempt + 1, done: done)
        } else {
          self.log("img: FAILED after \(G2Central.IMG_MAX_ATTEMPTS) attempts")
          done(false)
        }
      }
    }
    sendEvenHubLocked(msg, to: .right)
  }

  /// Register the resolver + timeout for the fragment we're about to send.
  private func armImageAckLocked(
    session: Int32, fragment: Int32, completion: @escaping (Bool) -> Void
  ) {
    imgAckTimer?.cancel()
    imgAckExpect = (session, fragment)
    imgAckResolve = completion
    let timer = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      guard let e = self.imgAckExpect, e.session == session, e.fragment == fragment else { return }
      self.imgAckExpect = nil
      let resolve = self.imgAckResolve
      self.imgAckResolve = nil
      self.imgAckTimer = nil
      self.log("img: ack TIMEOUT session=\(session) fragment=\(fragment)")
      resolve?(false)
    }
    imgAckTimer = timer
    queue.asyncAfter(deadline: .now() + .milliseconds(G2Central.IMG_ACK_TIMEOUT_MS), execute: timer)
  }

  /// Resolve the in-flight fragment ACK (called from the notify handler). Ignores
  /// ACKs that don't match the fragment we're waiting on (stale L/R dup, retry).
  private func handleImageAckLocked(session: Int32, fragment: Int32, success: Bool) {
    guard let e = imgAckExpect, e.session == session, e.fragment == fragment else { return }
    imgAckExpect = nil
    imgAckTimer?.cancel()
    imgAckTimer = nil
    let resolve = imgAckResolve
    imgAckResolve = nil
    resolve?(success)
  }

  // MARK: - FUT-165 animation engine (CFW mode-2 fast frames)

  private var animActive = false
  private var animId = ""
  private var animFrame = 0
  private var animContainerReady = false
  private var animSession: Int32 = 0
  /// Frame generation + zlib compression run HERE, never on the CoreBluetooth queue — a
  /// heavy generator (plasma) on the CB queue starves the write-drain + heartbeat and drops
  /// the link. Only the enqueue hops back to `queue`. (v1.1 crash fix.)
  private let animQueue = DispatchQueue(label: "com.ffs.g2anim", qos: .userInitiated)
  private static let ANIM_CID: Int32 = 2          // distinct from showImage (1) + evt-0 (0)
  private static let ANIM_NAME = "ffs-anim"
  private static let ANIM_FRAME_MS = 35           // ~28fps ceiling; heavy frames self-throttle
  private static let ANIM_GATE_LOW = 5            // push next frame only when the pipe is ~drained

  /// Public: play an on-glass animation by id (see G2Anim.ids). Creates ONE persistent
  /// 576×288 container, then streams CFW mode-2 frames fire-and-forget, drain-gated so the
  /// shared write queue never backs up unbounded. Auths first if needed.
  func playAnimation(_ id: String) {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.pairReadyLocked() else {
        self.log("playAnimation ignored — pair not ready (connect both lenses first)"); return
      }
      let start: () -> Void = { [weak self] in
        guard let self = self else { return }
        self.startHeartbeatsLocked()  // idempotent — keep the link alive during the anim
        self.animId = id
        self.animFrame = 0
        self.animActive = true
        self.log("anim: play \(id)")
        self.ensureAnimContainerLocked { [weak self] in self?.animTickLocked() }
      }
      if self.sessionAuthed { start() } else { self.runAuthLocked(start) }
    }
  }

  /// Public: stop the running animation. The next text/image surface rebuilds the page.
  func stopAnimation() {
    queue.async { [weak self] in self?.stopAnimationLocked() }
  }

  /// Stop the frame loop. Called on tap-back (JS), and on ANY surface change / disconnect /
  /// flash so we never push frames into a container the OS just repurposed. (council fix)
  private func stopAnimationLocked() {
    if animActive { log("anim: stop \(animId)") }
    animActive = false
    animId = ""
    animContainerReady = false
    dashActive = false   // any surface change also stops the dashboard render
  }

  private func ensureAnimContainerLocked(_ done: @escaping () -> Void) {
    if animContainerReady { done(); return }
    let ic = G2EvenHub.imageContainer(
      x: 0, y: 0, width: 576, height: 288,
      containerID: G2Central.ANIM_CID, containerName: G2Central.ANIM_NAME)
    let rebuild = pageCreated
    let page = G2EvenHub.imagePageMessage(
      imageContainer: ic, rebuild: rebuild, magicRandom: counters.nextMagic())
    sendEvenHubLocked(page, to: .right)
    pageCreated = true
    animContainerReady = true
    log("anim: \(rebuild ? "rebuilt" : "created") 576×288 container — 700ms settle")
    schedule(700) { done() }
  }

  private func animTickLocked() {
    guard animActive, !flashActive, pairReadyLocked() else { return }
    // Breathe-gate: push the next frame ONLY once the write pipe is nearly drained, so the
    // BLE link is never held 100% saturated (sustained saturation supervision-times-out the
    // lens — build31's video crash). Big frames self-throttle (they take longer to drain);
    // small frames run near the ANIM_FRAME_MS ceiling.
    let pending = lenses[.right]?.writeQueue.count ?? 0
    if pending > G2Central.ANIM_GATE_LOW {
      schedule(15) { [weak self] in self?.animTickLocked() }
      return
    }
    let id = animId
    let n = animFrame
    animFrame += 1
    let isStatic = G2Anim.isStatic(id)
    // Generate + compress OFF the CB queue (the crash fix), then hop back to enqueue.
    animQueue.async { [weak self] in
      guard let self = self else { return }
      let t0 = Date()
      let pixels = G2Anim.frame(id, n)
      let payload = G2Anim.mode2Payload(pixels)
      let genMs = Int(Date().timeIntervalSince(t0) * 1000)
      self.queue.async { [weak self] in
        guard let self = self, self.animActive, self.animId == id, !self.flashActive else { return }
        if let p = payload {
          self.sendAnimFrameLocked(p)
          if n % 8 == 0 || isStatic {
            let pend = self.lenses[.right]?.writeQueue.count ?? 0
            self.log("anim[\(id)] f\(n) \(p.count)B gen=\(genMs)ms pend=\(pend)\(isStatic ? " static" : "")")
          }
        } else {
          self.log("anim[\(id)] f\(n) mode2 encode FAILED")
        }
        // Static content: a few sends for drop-robustness, then idle (leave it on screen).
        if isStatic && n >= 2 {
          self.log("anim[\(id)] static displayed — loop idle")
          return
        }
        self.schedule(G2Central.ANIM_FRAME_MS) { [weak self] in self?.animTickLocked() }
      }
    }
  }

  /// Fragment a mode-2 payload into updateImageRawData messages and enqueue all their
  /// transport packets as ONE contiguous fire-and-forget message (no per-fragment ACK —
  /// animation accepts drops; the drain-gate bounds the queue).
  private func sendAnimFrameLocked(_ payload: Data) {
    guard !payload.isEmpty else { return }
    animSession = (animSession &+ 1) & 0xff
    let total = Int32(payload.count)
    var packets: [Data] = []
    var offset = 0
    var fragIdx: Int32 = 0
    while offset < payload.count {
      let end = min(offset + G2Central.IMG_FRAGMENT_SIZE, payload.count)
      let chunk = payload.subdata(in: offset..<end)
      let update = G2EvenHub.imageRawDataUpdate(
        containerID: G2Central.ANIM_CID, containerName: G2Central.ANIM_NAME,
        mapSessionId: animSession, mapTotalSize: total, compressMode: 0,
        mapFragmentIndex: fragIdx, mapFragmentPacketSize: Int32(chunk.count), mapRawData: chunk)
      let msg = G2EvenHub.updateImageMessage(update, magicRandom: counters.nextMagic())
      packets.append(contentsOf: counters.packets(
        serviceId: G2ServiceID.evenHub.rawValue, payload: msg, reserveFlag: true))
      offset = end
      fragIdx += 1
    }
    enqueueLocked(packets, to: .right)
  }

  /// Auth handshake: authL→left, authR→right, pipeRoleChange→right, timeSync→both,
  /// spaced 200ms (P0 spec). Fires `done` on the queue after the final step.
  private func runAuthLocked(_ done: @escaping () -> Void) {
    log("runAuth: starting handshake")
    sendDevSettingsLocked(G2DevSettings.authCmd(magicRandom: counters.nextMagic()), to: .left)
    schedule(200) { [weak self] in
      guard let self = self else { return }
      self.sendDevSettingsLocked(
        G2DevSettings.authCmd(magicRandom: self.counters.nextMagic()), to: .right)
      self.schedule(200) { [weak self] in
        guard let self = self else { return }
        self.sendDevSettingsLocked(
          G2DevSettings.pipeRoleChange(magicRandom: self.counters.nextMagic()), to: .right)
        self.schedule(200) { [weak self] in
          guard let self = self else { return }
          self.sendDevSettingsLocked(
            G2DevSettings.timeSync(magicRandom: self.counters.nextMagic()), to: .both)
          self.schedule(200) { [weak self] in
            guard let self = self else { return }
            // Mark onboarding FINISHED — until we do, the firmware runs its own
            // on-glass onboarding UI on the touchpad and only forwards double-tap.
            // This is the gate for single-tap + swipe reaching the host. FUT-160.
            self.sendOnboardingLocked(
              G2Onboarding.skip(magicRandom: self.counters.nextMagic()), to: .both)
            self.log("runAuth: sent skip-onboarding → both")
            self.schedule(200) { [weak self] in
              guard let self = self else { return }
              // Register with the gesture controller (lifecycle handshake). FUT-160.
              self.sendGestureCtrlLocked(
                G2GestureCtrl.initCmd(magicRandom: self.counters.nextMagic()), to: .both)
              self.log("runAuth: sent gesture_ctrl init → both")
              self.schedule(200) { [weak self] in
                guard let self = self else { return }
                // Disable the stock head-up DASHBOARD so it can't pop over our OS (Yoni ask).
                self.sendG2SettingLocked(
                  G2Setting.setHeadUpSwitch(magicRandom: self.counters.nextMagic(), enabled: false),
                  to: .both)
                self.log("runAuth: disabled stock head-up dashboard → both")
                self.schedule(200) { [weak self] in
                  guard let self = self else { return }
                  self.sessionAuthed = true
                  self.log("runAuth: handshake complete (session authed)")
                  done()
                }
              }
            }
          }
        }
      }
    }
  }

  /// 5s EvenHub heartbeat to BOTH arms (FUT-159: the plugin task dies after ~10s
  /// of no traffic; keep the session alive). Gated on sessionAuthed + pairReady.
  private func startHeartbeatsLocked() {
    guard !heartbeatRunning else { return }
    heartbeatRunning = true
    heartbeatTickLocked()
  }

  private func heartbeatTickLocked() {
    guard heartbeatRunning, sessionAuthed, pairReadyLocked() else {
      heartbeatRunning = false
      return
    }
    sendEvenHubLocked(G2EvenHub.heartbeat(magicRandom: counters.nextMagic()), to: .both)
    schedule(5000) { [weak self] in self?.heartbeatTickLocked() }
  }

  /// Reset the EvenHub session (called when a lens drops — the session is broken).
  fileprivate func resetSessionLocked() {
    if sessionAuthed || heartbeatRunning {
      log("session reset (a lens dropped)")
    }
    sessionAuthed = false
    heartbeatRunning = false
    pageCreated = false
    stopAnimationLocked()  // FUT-165: kill the frame loop when a lens drops (council fix)
    // Fail any in-flight image fragment so its transfer chain unwinds.
    imgAckTimer?.cancel()
    imgAckTimer = nil
    imgAckExpect = nil
    let resolve = imgAckResolve
    imgAckResolve = nil
    resolve?(false)
  }

  /// Public: tear down the EvenHub session state (stops heartbeats).
  func stopSession() {
    queue.async { [weak self] in self?.resetSessionLocked() }
  }

  // MARK: - Gestures (inbound)

  private var lastGestureName = ""
  private var lastGestureAt: TimeInterval = 0

  /// A decoded gesture arrived. Dedup L/R duplicates of the SAME gesture within
  /// 100ms (both lenses can deliver the same event — FUT-159), then emit.
  private func handleGestureLocked(_ gesture: String, side: G2Side) {
    let now = Date().timeIntervalSince1970
    if gesture == lastGestureName, now - lastGestureAt < 0.1 { return }
    lastGestureName = gesture
    lastGestureAt = now
    log("GESTURE: \(gesture) (side=\(side.rawValue))")
    onGesture?(gesture, side.rawValue)
  }

  // MARK: - Device info (inbound) — FUT-169 battery + FUT-167 version read-back

  private var lastDeviceInfoAt: TimeInterval = 0

  /// A device-info response arrived. Both lenses may answer the same request, so dedup
  /// duplicates within 300ms (the aggregate battery/version is identical from either),
  /// then emit to JS.
  private func handleDeviceInfoLocked(_ info: G2Setting.DeviceInfo, side: G2Side) {
    let now = Date().timeIntervalSince1970
    if now - lastDeviceInfoAt < 0.3 { return }
    lastDeviceInfoAt = now
    log("DEVICE INFO (side=\(side.rawValue)): batt=\(info.battery.map { String($0) } ?? "?") "
      + "charging=\(info.charging.map { String($0) } ?? "?") "
      + "L=\(info.leftVersion ?? "?") R=\(info.rightVersion ?? "?")")
    onDeviceInfo?(info.leftVersion, info.rightVersion, info.battery, info.charging)
  }
}

// MARK: - CBCentralManagerDelegate

extension G2Central: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let desc = describe(central.state)
    log("Central state → \(desc)")
    onStateChange?(desc)

    if central.state == .poweredOn {
      // If a scan or connect was requested before BT was ready, honor it now.
      if wantsPair || wantsSingleSide != nil || isScanning {
        isScanning = false  // reset; startScanLocked re-sets it
        startScanLocked()
        connectDiscoveredLocked()
      }
    } else {
      // Anything other than poweredOn means our connections (if any) are gone.
      isScanning = false
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    // The advertised local name is the authoritative filter surface.
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
      ?? peripheral.name
      ?? ""
    guard name.contains(G2Central.NAME_MATCH) else { return }

    let s = side(from: name)
    let mfgData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
    let mfg = parseManufacturer(mfgData)

    let disc = G2Discovery(
      peripheral: peripheral,
      name: name,
      side: s,
      rssi: RSSI.intValue,
      manufacturer: mfg
    )
    let isNew = discovered[s] == nil
    discovered[s] = disc  // dedupe by side; keep latest advertisement

    if isNew {
      log("Discovered G2 lens '\(name)' side=\(s.rawValue) rssi=\(RSSI.intValue)"
        + " sn=\(mfg?.sn ?? "?") mac=\(mfg?.mac ?? "?")")
    }
    onDeviceFound?(name, s.rawValue, RSSI.intValue, mfg?.sn, mfg?.mac)

    // If a connect is pending and this side is wanted + not yet connecting,
    // connect it now.
    if s == .left || s == .right, lenses[s] == nil {
      if wantsPair || wantsSingleSide == s {
        beginConnect(to: disc)
      }
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didConnect peripheral: CBPeripheral
  ) {
    let name = peripheral.name ?? "?"
    let s = side(from: name)
    log("Connected to \(name) (side=\(s.rawValue)) — discovering services")
    onConnected?(name, s.rawValue)
    // Discover everything; we match by full UUID afterwards.
    peripheral.discoverServices(nil)
    // A single connect doesn't make the pair ready, but re-evaluate anyway (the
    // char-discovery callback is where readiness actually flips).
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    let s = side(from: peripheral.name ?? "")
    log("Failed to connect to \(peripheral.name ?? "?") (side=\(s.rawValue)): "
      + "\(error?.localizedDescription ?? "unknown")")
    // Drop only THIS side's provisional state; the other lens is untouched.
    if let lens = lenses[s], lens.peripheral.identifier == peripheral.identifier {
      lenses[s] = nil
    }
    evaluatePairLocked()
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    let name = peripheral.name ?? "?"
    let s = side(from: name)
    log("Disconnected from \(name) (side=\(s.rawValue)): "
      + "\(error?.localizedDescription ?? "clean")")
    onDisconnected?(name, s.rawValue, error?.localizedDescription)
    // Tear down ONLY this side. The other lens keeps its connection + state.
    if let lens = lenses[s], lens.peripheral.identifier == peripheral.identifier {
      lens.writeQueue.removeAll()
      lens.draining = false
      lens.writeChar = nil
      lens.notifyChar = nil
      lens.audioChar = nil
      lenses[s] = nil
    }
    resetSessionLocked()  // a dropped lens breaks the EvenHub session
    evaluatePairLocked()
  }
}

// MARK: - CBPeripheralDelegate

extension G2Central: CBPeripheralDelegate {
  private func lens(for peripheral: CBPeripheral) -> G2Lens? {
    return lenses.values.first { $0.peripheral.identifier == peripheral.identifier }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverServices error: Error?
  ) {
    let s = lens(for: peripheral)?.side ?? side(from: peripheral.name ?? "")
    if let error = error {
      log("Service discovery error (side=\(s.rawValue)): \(error.localizedDescription)")
      return
    }
    let services = peripheral.services ?? []
    log("Discovered \(services.count) service(s) on side \(s.rawValue): "
      + services.map { $0.uuid.uuidString }.joined(separator: ", "))
    for service in services {
      // Discover all characteristics; we match by full UUID below.
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    guard let lens = lens(for: peripheral) else { return }
    let s = lens.side
    if let error = error {
      log("Characteristic discovery error for \(service.uuid) (side=\(s.rawValue)): "
        + error.localizedDescription)
      return
    }
    var matched: [String] = []
    for ch in service.characteristics ?? [] {
      switch ch.uuid {
      case G2Central.CHAR_WRITE:
        lens.writeChar = ch
        matched.append(ch.uuid.uuidString)
        log("Found WRITE char \(ch.uuid.uuidString) (side=\(s.rawValue))")
      case G2Central.CHAR_NOTIFY:
        lens.notifyChar = ch
        matched.append(ch.uuid.uuidString)
        // Subscribe on WHICHEVER side exposes the notify char. In practice this
        // is the RIGHT lens (the protocol/ACK channel); the LEFT is silent and
        // typically doesn't expose it. FUT-159.
        peripheral.setNotifyValue(true, for: ch)
        log("Found NOTIFY char \(ch.uuid.uuidString) (side=\(s.rawValue)) — subscribing")
      case G2Central.AUDIO_NOTIFY:
        lens.audioChar = ch
        matched.append(ch.uuid.uuidString)
        peripheral.setNotifyValue(true, for: ch)
        log("Found AUDIO char \(ch.uuid.uuidString) (side=\(s.rawValue)) — subscribing")
      default:
        break
      }
    }
    if !matched.isEmpty {
      onServicesDiscovered?(s.rawValue, matched)
    }
    // Characteristic discovery is where readiness actually flips — re-evaluate.
    evaluatePairLocked()
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let s = lens(for: peripheral)?.side ?? side(from: peripheral.name ?? "")
    if let error = error {
      log("Notify subscribe FAILED for \(characteristic.uuid) (side=\(s.rawValue)): "
        + error.localizedDescription)
    } else {
      log("Notify state for \(characteristic.uuid) (side=\(s.rawValue)) → "
        + "\(characteristic.isNotifying ? "ON" : "OFF")")
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let s = lens(for: peripheral)?.side ?? side(from: peripheral.name ?? "")
    if let error = error {
      log("Notify value error for \(characteristic.uuid) (side=\(s.rawValue)): "
        + error.localizedDescription)
      return
    }
    guard let data = characteristic.value else { return }

    // FUT-167 Stage 2: during an OTA flash, the DATA-notify (e0002) carries the OTA
    // ack frames. Capture them into the flash FIFO + wake the flasher, and DON'T run
    // them through the normal EvenHub gesture/image parsing.
    if flashActive && characteristic.uuid == G2Central.FLASH_DATA_NOTIFY {
      flashRxLock.lock()
      flashRx.append([UInt8](data))
      flashRxLock.unlock()
      flashSem.signal()
      return
    }

    let b64 = data.base64EncodedString()
    // Compact log — full payload goes to JS as base64 via onNotify, tagged side.
    log("Notify \(characteristic.uuid.uuidString) (side=\(s.rawValue), \(data.count) bytes)")
    onNotify?(b64, characteristic.uuid.uuidString, s.rawValue)

    // Reassemble the 0xAA transport per side (once), then interpret an EvenHub
    // (0xE0) message as either a touch gesture OR an image-fragment ACK.
    if characteristic.uuid == G2Central.CHAR_NOTIFY, let lens = lens(for: peripheral),
      let (svc, payload) = lens.rx.feed(data) {
      if svc == G2ServiceID.evenHub.rawValue {
        if let gesture = G2EvenHub.parseGesture(payload) {
          handleGestureLocked(gesture, side: s)
        } else if let ack = G2EvenHub.parseImageAck(payload) {
          log("img: ack session=\(ack.session) fragment=\(ack.fragment) success=\(ack.success)")
          handleImageAckLocked(session: ack.session, fragment: ack.fragment, success: ack.success)
        }
      } else if svc == G2ServiceID.g2Setting.rawValue {
        // FUT-169 / FUT-167: a device-info response (battery / version). Routed purely by
        // service id, so it can never swallow an EvenHub gesture/image-ack frame.
        if let info = G2Setting.parseDeviceInfo(payload) {
          handleDeviceInfoLocked(info, side: s)
        }
      }
    }
  }
}

// MARK: - FUT-167 Stage 2: CFW OTA flasher (over BLE)
//
// Swift port of g2flash.py's flash path. Runs on `flashQueue` (off the CB queue) so it
// can block-wait for OTA acks that the CB queue delivers into `flashRx`. Takes EXCLUSIVE
// ownership of the link: heartbeats are suspended and `flashActive` gates the notify
// handler to capture OTA acks (not run gesture/image parsing). The MRAM brick-guard +
// golden-vector self-test MUST pass before any write. GATED: the real write path only
// runs with dryRun=false, which the UI puts behind the "my warranty is void" phrase.
extension G2Central {
  static let flashCtrlWrite = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")
  static let FLASH_BLOCK_NAK_RETRIES = 5
  static let FLASH_COMPONENT_RETRIES = 3

  private func findChar(_ p: CBPeripheral, _ uuid: CBUUID) -> CBCharacteristic? {
    for svc in p.services ?? [] {
      for ch in svc.characteristics ?? [] where ch.uuid == uuid { return ch }
    }
    return nil
  }

  private func flashProgress(_ msg: String, _ frac: Double, done: Bool = false, ok: Bool = true) {
    log("flash: \(msg)")
    onFlashProgress?(msg, frac, done, ok)
  }

  private func flashNextSeq() -> UInt8 {
    flashRxLock.lock(); flashSeq = flashSeq &+ 1; let s = flashSeq; flashRxLock.unlock(); return s
  }

  private func flashDrainRx() {
    flashRxLock.lock(); flashRx.removeAll(); flashRxLock.unlock()
    while flashSem.wait(timeout: .now()) == .success {}
  }

  /// Download the image synchronously (before any flash — no mid-flash network).
  private func flashDownload(_ url: URL) -> [UInt8]? {
    let sem = DispatchSemaphore(value: 0)
    var out: [UInt8]?
    URLSession.shared.dataTask(with: url) { data, _, _ in
      if let d = data { out = [UInt8](d) }
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 180)
    return out
  }

  /// One withoutResponse write, respecting iOS flow control (poll-capped ~2s).
  private func flashWrite(_ frame: [UInt8], to ch: CBCharacteristic, on p: CBPeripheral) {
    var waited = 0
    while !p.canSendWriteWithoutResponse && waited < 2000 { usleep(1000); waited += 1 }
    queue.sync { p.writeValue(Data(frame), for: ch, type: .withoutResponse) }
  }

  private func flashWriteFrames(_ frames: [[UInt8]], to ch: CBCharacteristic, on p: CBPeripheral) {
    for f in frames { flashWrite(f, to: ch, on: p) }
  }

  /// Block until an OTA ack with opcode `wantOp` lands on the DATA-notify FIFO. Returns
  /// the status byte, or nil on timeout.
  private func flashWaitAck(_ wantOp: UInt8, timeoutMs: Int) -> UInt8? {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while Date() < deadline {
      flashRxLock.lock(); let batch = flashRx; flashRx.removeAll(); flashRxLock.unlock()
      for frame in batch {
        if let (_, pb) = G2Flash.parseRx(frame), pb.count >= 2, pb[0] == wantOp { return pb[1] }
      }
      _ = flashSem.wait(timeout: .now() + 0.2)
    }
    return nil
  }

  private func flashSendDataMsg(_ frames: [[UInt8]], wantOp: UInt8,
                                dataWrite: CBCharacteristic, p: CBPeripheral,
                                timeoutMs: Int = 5000) -> UInt8? {
    flashWriteFrames(frames, to: dataWrite, on: p)
    return flashWaitAck(wantOp, timeoutMs: timeoutMs)
  }

  /// Entry point (JS bridge). Downloads + SHA-verifies + guard + golden-vector self-test,
  /// then (dryRun=false only) runs the real per-lens OTA flash. dryRun=true stops before
  /// any write. Reports via onFlashProgress.
  func startCfwFlash(url urlStr: String, expectedSha256 sha256: String, dryRun: Bool) {
    queue.async { [weak self] in self?.stopAnimationLocked() }  // FUT-165: no frames during a flash
    flashQueue.async { [weak self] in
      guard let self = self else { return }
      self.flashProgress(dryRun ? "validating (dry-run, no writes)…" : "preparing flash…", 0.02)

      guard let url = URL(string: urlStr) else {
        self.flashProgress("bad image URL", 0, done: true, ok: false); return
      }
      guard let img = self.flashDownload(url) else {
        self.flashProgress("image download failed", 0, done: true, ok: false); return
      }
      let sha = SHA256.hash(data: Data(img)).map { String(format: "%02x", $0) }.joined()
      guard sha.lowercased() == sha256.lowercased() else {
        self.flashProgress("SHA mismatch — refusing (got \(sha.prefix(12))…)", 0, done: true, ok: false); return
      }
      self.flashProgress("image SHA-256 verified ✓", 0.10)

      let segs: [G2Flash.Segment]
      do { segs = try G2Flash.parseSegments(img) }
      catch { self.flashProgress("parse failed: \(error)", 0, done: true, ok: false); return }

      let g = G2Flash.checkMainAppFitsMram(img, segs)
      guard g.pass else {
        self.flashProgress("BRICK-GUARD BLOCKED: \(g.reason)", 0, done: true, ok: false); return
      }
      let gv: G2Flash.GoldenVector? =
        sha.lowercased() == G2Flash.goldenCFW.sha256 ? G2Flash.goldenCFW :
        (sha.lowercased() == G2Flash.goldenStock.sha256 ? G2Flash.goldenStock :
        (sha.lowercased() == G2Flash.goldenCanary.sha256 ? G2Flash.goldenCanary :
        (sha.lowercased() == G2Flash.goldenFontpeek.sha256 ? G2Flash.goldenFontpeek : nil)))
      guard let gvec = gv else {
        self.flashProgress("not a known golden build — refusing", 0, done: true, ok: false); return
      }
      if let fail = G2Flash.selfTestGuard(img, expect: gvec) {
        self.flashProgress("SELF-TEST FAILED: \(fail) — refusing", 0, done: true, ok: false); return
      }
      self.flashProgress(String(format: "brick-guard + self-test PASSED (prog_end 0x%08x)", g.progEnd), 0.18)

      guard let left = self.lenses[.left], let right = self.lenses[.right],
            left.connected, right.connected else {
        self.flashProgress("both lenses must be connected", 0, done: true, ok: false); return
      }
      for (label, lens) in [("L", left), ("R", right)] {
        guard self.findChar(lens.peripheral, G2Central.FLASH_DATA_WRITE) != nil,
              self.findChar(lens.peripheral, G2Central.FLASH_DATA_NOTIFY) != nil else {
          self.flashProgress("\(label): OTA channels missing", 0, done: true, ok: false); return
        }
      }

      if dryRun {
        self.flashProgress("DRY-RUN OK — image validated + both lenses ready; NO writes performed ✓",
                           1.0, done: true, ok: true)
        return
      }

      // ===== REAL FLASH (dryRun == false only) =====
      self.queue.sync { self.heartbeatRunning = false }   // suspend EvenHub heartbeat
      self.flashActive = true
      defer {
        self.flashActive = false
        self.queue.async { self.startHeartbeatsLocked() }  // restore keep-alive after
      }
      var okAll = true
      let order: [(String, G2Lens)] = [("L", left), ("R", right)]
      for (i, entry) in order.enumerated() {
        self.flashProgress("flashing \(entry.0) lens…", 0.2 + 0.4 * Double(i))
        if !self.flashOneLens(entry.1.peripheral, img: img, segs: segs, side: entry.0) {
          okAll = false; break
        }
      }
      self.flashProgress(
        okAll ? "FLASH COMPLETE — glasses reboot into new firmware ✓"
              : "FLASH FAILED — see log; run Restore Stock if a lens is half-flashed",
        okAll ? 1.0 : 0.0, done: true, ok: okAll)
    }
  }

  private func flashOneLens(_ p: CBPeripheral, img: [UInt8], segs: [G2Flash.Segment], side: String) -> Bool {
    guard let dataWrite = findChar(p, G2Central.FLASH_DATA_WRITE),
          let dataNotify = findChar(p, G2Central.FLASH_DATA_NOTIFY),
          let ctrlWrite = findChar(p, G2Central.flashCtrlWrite) else {
      flashProgress("\(side): OTA channels missing at flash time", 0, ok: false); return false
    }
    flashRxLock.lock(); flashSeq = 0; flashRxLock.unlock()
    queue.sync { p.setNotifyValue(true, for: dataNotify) }
    Thread.sleep(forTimeInterval: 2.5)
    flashDrainRx()

    // 12s keep-alive on the CTRL write during the transfer (like the official app).
    let hb = DispatchSource.makeTimerSource(queue: queue)
    hb.schedule(deadline: .now() + 12, repeating: 12)
    hb.setEventHandler { [weak self, weak p, weak ctrlWrite] in
      guard let self = self, let p = p, let ctrlWrite = ctrlWrite else { return }
      let f = G2Flash.frames(sid: 0x80, pb: [0x08, 0x0E, 0x10, 0x26, 0x6A, 0x00], seq: self.flashNextSeq())
      for fr in f { p.writeValue(Data(fr), for: ctrlWrite, type: .withoutResponse) }
    }
    hb.resume()
    defer { hb.cancel() }

    // begin
    let bst = flashSendDataMsg(G2Flash.ctrlFrames(0x00, seq: flashNextSeq()), wantOp: 0x00,
                               dataWrite: dataWrite, p: p)
    flashProgress("\(side): begin ack \(bst.map { String($0) } ?? "timeout")", 0.0)

    for (i, seg) in segs.enumerated() {
      if !flashComponent(seg, index: i, total: segs.count, img: img,
                         dataWrite: dataWrite, p: p, side: side) {
        return false
      }
    }
    flashProgress("\(side): all \(segs.count) components verified ✓", 0.0)
    return true
  }

  private func flashComponent(_ seg: G2Flash.Segment, index: Int, total: Int, img: [UInt8],
                              dataWrite: CBCharacteristic, p: CBPeripheral, side: String) -> Bool {
    let off = Int(seg.off) + 128
    let ps = Int(seg.ps)
    guard off + ps <= img.count else { flashProgress("\(side): seg \(seg.fn) past EOF", 0, ok: false); return false }
    let payload = Array(img[off..<off + ps])
    let nb = (payload.count + 4095) / 4096

    for attempt in 0..<G2Central.FLASH_COMPONENT_RETRIES {
      if attempt > 0 { flashProgress("\(side): re-flash \(seg.fn) attempt \(attempt + 1)", 0.0); flashDrainRx(); Thread.sleep(forTimeInterval: 1.5) }
      // FILE_CHECK
      let fc = flashSendDataMsg(G2Flash.ctrlFrames(0x01, seg.sub, seq: flashNextSeq()), wantOp: 0x01,
                                dataWrite: dataWrite, p: p)
      guard fc == 0 else { flashProgress("\(side): \(seg.fn) FILE_CHECK status \(fc.map { String($0) } ?? "timeout")", 0.0); continue }

      var blocksOK = true
      for b in 0..<nb {
        let blk = Array(payload[b * 4096..<min((b + 1) * 4096, payload.count)])
        var acked = false
        for _ in 0..<G2Central.FLASH_BLOCK_NAK_RETRIES {
          let seq = flashNextSeq()
          flashDrainRx()
          flashWriteFrames(G2Flash.ctrlFrames(0x02, seq: seq), to: dataWrite, on: p)   // marker
          flashWriteFrames(G2Flash.dataFrames(blk, seq: seq), to: dataWrite, on: p)     // 4 KB
          if let st = flashWaitAck(0x02, timeoutMs: 5000), st == 0 { acked = true; break }
        }
        if !acked { flashProgress("\(side): \(seg.fn) block \(b)/\(nb) failed", 0.0); blocksOK = false; break }
        if b % 100 == 0 || b == nb - 1 {
          let compFrac = (Double(index) + Double(b + 1) / Double(nb)) / Double(total)
          flashProgress("\(side): \(seg.fn) block \(b + 1)/\(nb)", 0.2 + 0.4 * min(1.0, compFrac))
        }
      }
      if !blocksOK { continue }

      // END
      let est = flashSendDataMsg(G2Flash.ctrlFrames(0x03, seq: flashNextSeq()), wantOp: 0x03,
                                 dataWrite: dataWrite, p: p, timeoutMs: 15000)
      if let e = est, e == 0 || e == 8 || e == 9 {
        flashProgress("\(side): \(seg.fn) END verified (\(e))", 0.0); return true
      }
      flashProgress("\(side): \(seg.fn) END status \(est.map { String($0) } ?? "timeout") — retrying", 0.0)
    }
    flashProgress("\(side): \(seg.fn) FAILED after \(G2Central.FLASH_COMPONENT_RETRIES) attempts", 0, ok: false)
    return false
  }
}

// MARK: - Free helpers

/// Human-readable CBManagerState.
private func describe(_ state: CBManagerState) -> String {
  switch state {
  case .unknown: return "unknown"
  case .resetting: return "resetting"
  case .unsupported: return "unsupported"
  case .unauthorized: return "unauthorized"
  case .poweredOff: return "poweredOff"
  case .poweredOn: return "poweredOn"
  @unknown default: return "unhandled(\(state.rawValue))"
  }
}
