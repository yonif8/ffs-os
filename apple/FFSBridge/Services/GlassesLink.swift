import Foundation
import CoreBluetooth
import Combine

struct LensStatus: Identifiable {
    var id: String
    var name = "Not connected", state = "disconnected", version = "—"
    var ready = false, battery: Int?, charging: Bool?, rssi: Int?, writeLimit = 0
    var diagnostics: [String: String] = [:]
    var receiveCount = 0
    var infoReceivedAt: Date?
    var settingsSnapshot: [String: Int] = [:]
    mutating func invalidateReadback() {
        diagnostics = [:]; settingsSnapshot = [:]; version = "—"; battery = nil; charging = nil; infoReceivedAt = nil
    }
}

@MainActor
final class GlassesLink: NSObject, ObservableObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    static let service = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0000")
    static let writeID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")
    static let notifyID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5402")
    static let audioID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E6402")
    static let otaWriteID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0001")
    static let otaNotifyID = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0002")
    @Published var lenses = ["L": LensStatus(id: "L"), "R": LensStatus(id: "R")]
    @Published var bluetooth = "Starting Bluetooth"
    @Published var scanning = false
    @Published private(set) var flashOwned = false
    @Published var micLive = false
    var pairReady: Bool { lenses.values.allSatisfy(\.ready) }
    var event: ((String, [String: Any]) -> Void)?
    var audio: ((Data, String) -> Void)?
    var serviceMessage: ((UInt8, Data, String) -> Void)?
    var otaMessage: ((Data, String) -> Void)?
    private var manager: CBCentralManager!
    private var peripherals: [String: CBPeripheral] = [:]
    private var chars: [String: [CBUUID: CBCharacteristic]] = [:]
    private var assemblers: [String: Reassembler] = [:]
    private var wanted = Set<String>()
    private var connecting: String?
    private var connectingGeneration = UUID()
    private var seq: UInt8 = 0
    private var magic = 0
    private var scanGeneration = UUID()
    private var pumping = false
    private struct Job {
        let frames: [Data], sides: [String], characteristic: CBUUID, owner: Bool
        let done: CheckedContinuation<Void, Error>
    }
    private var jobs: [Job] = []
    private var micGeneration = UUID()
    private var lastMic: Date?
    private var requestedMic = false
    private var rssiTask: Task<Void, Never>?
    private var recovery = PeerRecovery()
    private var recoveryTask: Task<Void, Never>?

    override init() {
        super.init()
        #if os(macOS)
        manager = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: true])
        #else
        manager = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionRestoreIdentifierKey: "ffs-current-bridge",
            CBCentralManagerOptionShowPowerAlertKey: true
        ])
        #endif
    }
    func log(_ text: String) { event?("log", ["message": text]) }
    func nextMagic() -> Int { magic = (magic + 1) & 0xffff; return magic }
    func nextSeq() -> UInt8 { seq &+= 1; return seq }
    func startScan() throws {
        guard manager.state == .poweredOn else { throw BridgeError.unavailable(bluetooth) }
        guard !scanning, !flashOwned else { return }
        // G2 advertises its name, not its GATT container service (same as Android).
        manager.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        scanning = true; log("Scanning for G2 lenses")
        scanGeneration = UUID(); let generation = scanGeneration
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, self.scanGeneration == generation, self.scanning else { return }
            self.stopScan(); self.log("Discovery window ended; reconnect explicitly if lenses were unavailable")
        }
    }
    func stopScan() { manager.stopScan(); scanning = false }
    func connect(_ side: String? = nil) throws {
        guard !flashOwned else { throw BridgeError.unavailable("Firmware flash owns the link") }
        if let side { guard ["L", "R"].contains(side) else { throw BridgeError.invalid("Side must be L or R") } }
        wanted = side.map { Set([$0]) } ?? Set(["L", "R"])
        UserDefaults.standard.set(Array(wanted), forKey: "wantedSides")
        guard manager.state == .poweredOn else { throw BridgeError.unavailable(bluetooth) }
        for s in wanted where peripherals[s] == nil {
            if let id = UserDefaults.standard.string(forKey: "peripheral.\(s)").flatMap(UUID.init(uuidString:)),
               let p = manager.retrievePeripherals(withIdentifiers: [id]).first { peripherals[s] = p; p.delegate = self }
        }
        for p in manager.retrieveConnectedPeripherals(withServices: [Self.service]) {
            if let s = sideOfName(p.name ?? "") { peripherals[s] = p; p.delegate = self }
        }
        try startScan(); connectNext()
    }
    func disconnect() throws {
        guard !flashOwned else { throw BridgeError.unavailable("Firmware flash owns the link") }
        recovery.reset(); recoveryTask?.cancel()
        wanted.removeAll(); UserDefaults.standard.removeObject(forKey: "wantedSides")
        stopScan(); connecting = nil; connectingGeneration = UUID(); rssiTask?.cancel()
        for p in peripherals.values { manager.cancelPeripheralConnection(p) }
        failJobs(BridgeError.unavailable("Disconnected")); micLive = false
    }
    private func sideOfName(_ name: String) -> String? {
        guard name.contains("G2") else { return nil }
        return name.contains("_L_") ? "L" : name.contains("_R_") ? "R" : nil
    }
    private func sideOf(_ p: CBPeripheral) -> String? { peripherals.first { $0.value.identifier == p.identifier }?.key }
    private func connectNext() {
        guard !flashOwned, manager.state == .poweredOn, connecting == nil else { return }
        for s in ["R", "L"] where wanted.contains(s) && lenses[s]?.ready != true {
            guard let p = peripherals[s], p.state != .disconnecting else { continue }
            connecting = s; connectingGeneration = UUID(); let generation = connectingGeneration
            p.delegate = self; lenses[s]?.state = "connecting"; lenses[s]?.name = p.name ?? "G2 \(s)"
            if p.state == .connected { p.discoverServices(nil) } else { manager.connect(p) }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(12))
                guard let self, self.connectingGeneration == generation, self.connecting == s else { return }
                self.log("\(s): connection timed out; explicit reconnect available")
                // Cancel this attempt before starting another; never race two initiators.
                self.wanted.remove(s); self.manager.cancelPeripheralConnection(p)
                self.connecting = nil; self.lenses[s]?.state = "connection timed out"; self.connectNext()
            }
            return
        }
        if pairReady { observeRecovery(); stopScan(); event?("pairReady", [:]); startRSSI() }
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: bluetooth = "Bluetooth ready"
        case .poweredOff: bluetooth = "Bluetooth is off"
        case .unauthorized: bluetooth = "Bluetooth permission required"
        case .unsupported: bluetooth = "Bluetooth unavailable"
        default: bluetooth = "Bluetooth starting"
        }
        if central.state == .poweredOn {
            if !wanted.isEmpty { try? startScan(); connectNext() }
        } else {
            recovery.reset(); recoveryTask?.cancel()
            scanning = false; connecting = nil; connectingGeneration = UUID()
            for s in ["L", "R"] { lenses[s]?.ready = false; lenses[s]?.state = "disconnected"; lenses[s]?.invalidateReadback() }
            failJobs(BridgeError.unavailable(bluetooth))
        }
        event?("bluetooth", ["state": bluetooth])
    }
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        wanted = Set(UserDefaults.standard.stringArray(forKey: "wantedSides") ?? [])
        for p in dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? [] {
            let s = ["L", "R"].first { UserDefaults.standard.string(forKey: "peripheral.\($0)") == p.identifier.uuidString } ?? sideOfName(p.name ?? "")
            guard let s else { continue }
            peripherals[s] = p; p.delegate = self
            lenses[s]?.name = p.name ?? "G2 \(s)"; lenses[s]?.state = "restoring"
            if p.state == .connected { p.discoverServices(nil) }
        }
        log("Restoring Bluetooth state")
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
        guard let s = sideOfName(name) else { return }
        if let existing = peripherals[s], existing.identifier != peripheral.identifier, existing.state != .disconnected { return }
        peripherals[s] = peripheral; peripheral.delegate = self
        lenses[s]?.name = name; lenses[s]?.rssi = RSSI.intValue
        UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: "peripheral.\(s)")
        event?("discovered", ["side": s, "name": name, "rssi": RSSI.intValue]); connectNext()
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard let s = sideOf(peripheral) else { return }
        lenses[s]?.invalidateReadback()
        lenses[s]?.state = "discovering"; peripheral.delegate = self
        peripheral.discoverServices(nil); log("\(s): connected; discovering channels")
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        dropped(peripheral, error: error, retry: false)
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        dropped(peripheral, error: error, retry: true)
    }
    private func dropped(_ p: CBPeripheral, error: Error?, retry: Bool) {
        guard let s = sideOf(p) else { return }
        lenses[s]?.ready = false; lenses[s]?.state = "disconnected"; lenses[s]?.invalidateReadback(); chars[s] = [:]; assemblers[s] = Reassembler()
        if connecting == s { connecting = nil; connectingGeneration = UUID() }
        event?("disconnected", ["side": s, "code": (error as NSError?)?.code ?? 0])
        log("\(s): disconnected"); observeRecovery()
        if !retry { wanted.remove(s) }
        if wanted.contains(s) && !flashOwned {
            // CoreBluetooth owns the pending reconnect, with one attempt at a time.
            Task { [weak self] in try? await Task.sleep(for: .seconds(2)); self?.connectNext() }
        } else { connectNext() }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = sideOf(peripheral) else { return }
        guard error == nil else { log("\(s): service discovery failed"); manager.cancelPeripheralConnection(peripheral); return }
        chars[s] = [:]
        for service in peripheral.services ?? [] { peripheral.discoverCharacteristics(nil, for: service) }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let s = sideOf(peripheral), error == nil else { return }
        for c in service.characteristics ?? [] {
            chars[s, default: [:]][c.uuid] = c
            if [Self.notifyID, Self.audioID, Self.otaNotifyID].contains(c.uuid), c.properties.contains(.notify) || c.properties.contains(.indicate) {
                peripheral.setNotifyValue(true, for: c)
            }
        }
        evaluate(s)
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard let s = sideOf(peripheral) else { return }
        event?("subscription", ["side": s, "characteristic": characteristic.uuid.uuidString, "on": characteristic.isNotifying])
        if error != nil { log("\(s): subscription failed") }
        evaluate(s)
    }
    private func evaluate(_ s: String) {
        guard let p = peripherals[s] else { return }
        let limit = p.maximumWriteValueLength(for: .withoutResponse)
        let ready = p.state == .connected && chars[s]?[Self.writeID]?.properties.contains(.writeWithoutResponse) == true && chars[s]?[Self.notifyID]?.isNotifying == true && limit >= 244
        let changed = ready != lenses[s]?.ready
        lenses[s]?.writeLimit = limit; lenses[s]?.ready = ready
        if ready {
            lenses[s]?.state = "ready"
            if connecting == s { connecting = nil; connectingGeneration = UUID() }
            if changed { log("\(s): ready (write limit \(limit))"); connectNext() }
        } else if p.state == .connected && limit < 244 {
            lenses[s]?.state = "write limit too small"; log("\(s): refusing 244-byte packets at write limit \(limit)")
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        guard let s = sideOf(peripheral), error == nil else { return }; lenses[s]?.rssi = RSSI.intValue
    }
    private func startRSSI() {
        rssiTask?.cancel()
        rssiTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !self.flashOwned { for p in self.peripherals.values where p.state == .connected { p.readRSSI() } }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let s = sideOf(peripheral), error == nil, let data = characteristic.value else { return }
        if characteristic.uuid == Self.audioID {
            // Microphone bytes never enter generic events, developer logs or raw-service output.
            let now = Date(), gap = lastMic.map { now.timeIntervalSince($0) } ?? -1
            if gap < 0 || gap > 0.9 { event?("mic", ["side": s, "requestedByUs": requestedMic]) }
            lastMic = now; micLive = true; micGeneration = UUID(); let gen = micGeneration
            Task { [weak self] in try? await Task.sleep(for: .seconds(1)); if self?.micGeneration == gen { self?.micLive = false } }
            audio?(data, s); return
        }
        lenses[s]?.receiveCount += 1
        if (lenses[s]?.receiveCount ?? 0) <= 8 {
            event?("transport", ["side": s, "characteristic": characteristic.uuid.uuidString, "bytes": data.count, "packet": data.base64EncodedString()])
        }
        if characteristic.uuid == Self.otaNotifyID, flashOwned { otaMessage?(data, s); return }
        var a = assemblers[s] ?? Reassembler()
        let message = a.feed(data); assemblers[s] = a
        guard let (sid, body) = message else { return }
        serviceMessage?(sid, body, s)
        if sid == 9 { decodeInfo(body, side: s) }
        event?("service", ["side": s, "serviceId": Int(sid), "payload": body.base64EncodedString()])
    }
    private func decodeInfo(_ d: Data, side s: String) {
        guard let f = try? Proto.fields(d) else { return }
        if f.bytes(104) != nil || f.string(100) != nil || f.bytes(4) != nil { lenses[s]?.infoReceivedAt = Date() }
        if let snapshot = SettingsWire.snapshot(d) { lenses[s]?.settingsSnapshot = snapshot }
        if let silent = SettingsWire.silentModeUpdate(d) { lenses[s]?.settingsSnapshot["silentMode"] = silent }
        if let inner = f.bytes(4) ?? f.bytes(5), let inf = try? Proto.fields(inner) {
            if let v = inf.string(s == "L" ? 5 : 6) { lenses[s]?.version = v }
            if let v = inf.number(12), (0...100).contains(v) { lenses[s]?.battery = v }
            if let v = inf.number(13) { lenses[s]?.charging = v != 0 }
        }
        if let caps = f.string(100) { lenses[s]?.diagnostics["capabilities"] = caps }
        if let ld = f.bytes(104), ld.count >= 20 {
            var out = "gen=\(ld.u32(4)) ran=\(ld.u32(8)) ret=0x\(String(ld.u32(12), radix:16)) len=\(ld.u32(16))"
            if ld.count >= 32 { out += " calls=\(ld.u32(20)) rxlen=\(ld.u32(24)) first4=0x\(String(ld.u32(28), radix:16))" }
            if ld.count >= 68 { out += " rej=\(ld.u32(52))/\(ld.u32(56))" }
            if ld.count >= 88 { out += " id=\(ld.u16(76)) gates=\(ld[78]) lens=\(ld[79])" }
            if ld.count >= 120, ld.subdata(in: 88..<92) == Data("AP01".utf8) {
                let dash = Int(ld[92] >> 4), names = ["none","built","notop","nocfg","noimg","nobuf"]
                out += " dash=\(dash < names.count ? names[dash] : "unknown") apps=\(ld[95] & 15) run=\(ld[93])"
                out += " shell=\(ld[94] & 0x20 != 0 ? 2 : 1) codeBytes=\(ld.u16(108))"
                out += " live=\((ld[95] >> 6) & 1) hidden=\(ld[95] >> 7)"
            }
            lenses[s]?.diagnostics["loader"] = out; log("\(s): \(out)")
        }
        event?("deviceInfo", ["side": s, "version": lenses[s]?.version ?? "—", "battery": lenses[s]?.battery as Any? ?? NSNull()])
    }
    func send(_ body: Data, sid: UInt8 = 0x90, side: String? = nil) async throws {
        guard sid != 0x80 else { throw BridgeError.invalid("Service 0x80 is forbidden") }
        guard !flashOwned else { throw BridgeError.unavailable("Firmware flash owns the link") }
        let sides = side.map { [$0] } ?? ["L", "R"]
        guard sides.allSatisfy({ lenses[$0]?.ready == true }) else { throw BridgeError.unavailable("Requested lenses are not ready") }
        let packets = try Wire.packets(body, sid: sid, seq: nextSeq(), reserve: sid == 9)
        try await write(packets, sides: sides, characteristic: Self.writeID)
    }
    func write(_ frames: [Data], sides: [String], characteristic: CBUUID, owner: Bool = false) async throws {
        guard owner == flashOwned else { throw BridgeError.unavailable("Radio ownership changed") }
        try await withCheckedThrowingContinuation { continuation in
            jobs.append(Job(frames: frames, sides: sides, characteristic: characteristic, owner: owner, done: continuation))
            if !pumping { pumping = true; Task { await pump() } }
        }
    }
    private func pump() async {
        defer { pumping = false }
        while !jobs.isEmpty {
            let job = jobs.removeFirst()
            do {
                for frame in job.frames {
                    for s in job.sides {
                        guard job.owner == flashOwned, let p = peripherals[s], p.state == .connected, let c = chars[s]?[job.characteristic] else { throw BridgeError.unavailable("\(s): link lost during write") }
                        guard frame.count <= p.maximumWriteValueLength(for: .withoutResponse) else { throw BridgeError.invalid("Packet exceeds negotiated write limit") }
                        let deadline = Date().addingTimeInterval(2)
                        while !p.canSendWriteWithoutResponse {
                            guard Date() < deadline, p.state == .connected else { throw BridgeError.timeout("\(s): Bluetooth backpressure timeout") }
                            try await Task.sleep(for: .milliseconds(5))
                        }
                        p.writeValue(frame, for: c, type: .withoutResponse)
                    }
                    if !job.owner { try await Task.sleep(for: .milliseconds(6)) }
                }
                job.done.resume()
            } catch { job.done.resume(throwing: error) }
        }
    }
    private func failJobs(_ error: Error) { let pending = jobs; jobs.removeAll(); for j in pending { j.done.resume(throwing: error) } }
    private func observeRecovery() {
        recoveryTask?.cancel()
        let observation = recovery.observe(now: ProcessInfo.processInfo.systemUptime, wanted: wanted == Set(["L", "R"]), flashing: flashOwned, left: lenses["L"]?.ready == true, right: lenses["R"]?.ready == true)
        if let side = observation.side {
            recoveryTask = Task { [weak self] in
                guard let self, !Task.isCancelled, !self.flashOwned, self.wanted == Set(["L", "R"]), !self.pairReady else { return }
                self.log("Asymmetric link loss: one-shot panic reset of surviving \(side) lens")
                do { try await self.settings("panic", value: 1, side: side) }
                catch { self.log("Peer recovery write failed") }
            }
        } else if let deadline = observation.deadline {
            recoveryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(0, deadline - ProcessInfo.processInfo.systemUptime)))
                guard !Task.isCancelled else { return }; self?.observeRecovery()
            }
        }
    }
    func otaReady(_ s: String) -> Bool {
        lenses[s]?.ready == true && chars[s]?[Self.otaWriteID]?.properties.contains(.writeWithoutResponse) == true && chars[s]?[Self.otaNotifyID]?.isNotifying == true
    }
    func acquireFlash() throws {
        guard !flashOwned, !pumping, jobs.isEmpty, ["L","R"].allSatisfy(otaReady) else { throw BridgeError.unavailable("Flash needs an idle link and both subscribed OTA channels") }
        flashOwned = true; recovery.reset(); recoveryTask?.cancel(); stopScan()
    }
    func releaseFlash() { flashOwned = false }
    func reconnectAfterFlash() {
        for s in ["L", "R"] { lenses[s]?.ready = false; chars[s] = [:] }
        connecting = nil; connectingGeneration = UUID()
        for p in peripherals.values { manager.cancelPeripheralConnection(p) }
        Task { [weak self] in try? await Task.sleep(for: .seconds(10)); try? self?.connect() }
    }
    func settings(_ key: String, value: Int = 0, side: String? = nil, auto: Bool = false) async throws {
        let m = nextMagic()
        let body: Data
        switch key.lowercased() {
        case "query", "info": body = SettingsWire.query(false, magic: m)
        case "brightness-query": body = SettingsWire.query(true, magic: m)
        case "brightness":
            try await send(SettingsWire.brightnessMode(false, magic: m), sid: 9, side: side)
            try await send(SettingsWire.brightnessLevel(value, magic: nextMagic()), sid: 9, side: side)
            if auto { try await send(SettingsWire.brightnessMode(true, magic: nextMagic()), sid: 9, side: side) }
            return
        case "headup": body = SettingsWire.set(4, Proto.integer(1, value == 0 ? 0 : 1), magic: m)
        case "wear": body = SettingsWire.set(5, Proto.integer(1, value == 0 ? 0 : 1), magic: m)
        case "silent": body = SettingsWire.set(6, Proto.integer(1, value == 0 ? 0 : 1), magic: m)
        case "lensx": body = SettingsWire.set(3, Proto.integer(1, value), magic: m)
        case "lensy": body = SettingsWire.set(2, Proto.integer(1, value), magic: m)
        case "panic": body = SettingsWire.set(100, Data("FFSPANICRST!".utf8), magic: m)
        case "wake":
            for step in SettingsWire.displayWake(UInt8(clamping: value), magic: m) {
                try await send(step.body, sid: step.sid, side: side)
                try await Task.sleep(for: .milliseconds(200))
            }
            try await settings("info", side: side)
            return
        case "mic":
            requestedMic = value != 0
            do { try await send(Data("FMIC".utf8) + Data([value == 0 ? 0 : 1]), side: side) }
            catch { requestedMic = false; throw error }; return
        case "imu": try await send(SettingsWire.imu(value != 0, pace: value > 1 ? value : 100, magic: m), sid: 0xe0, side: side ?? "R"); return
        default: throw BridgeError.invalid("Unknown setting")
        }
        try await send(body, sid: 9, side: side)
    }
}
