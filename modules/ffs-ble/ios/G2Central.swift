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
    let b64 = data.base64EncodedString()
    // Compact log — full payload goes to JS as base64 via onNotify, tagged side.
    log("Notify \(characteristic.uuid.uuidString) (side=\(s.rawValue), \(data.count) bytes)")
    onNotify?(b64, characteristic.uuid.uuidString, s.rawValue)

    // Reassemble the 0xAA transport per side (once), then interpret an EvenHub
    // (0xE0) message as either a touch gesture OR an image-fragment ACK.
    if characteristic.uuid == G2Central.CHAR_NOTIFY, let lens = lens(for: peripheral),
      let (svc, payload) = lens.rx.feed(data), svc == G2ServiceID.evenHub.rawValue {
      if let gesture = G2EvenHub.parseGesture(payload) {
        handleGestureLocked(gesture, side: s)
      } else if let ack = G2EvenHub.parseImageAck(payload) {
        log("img: ack session=\(ack.session) fragment=\(ack.fragment) success=\(ack.success)")
        handleImageAckLocked(session: ack.session, fragment: ack.fragment, success: ack.success)
      }
    }
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
