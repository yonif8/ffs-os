import Foundation
import Combine

@MainActor
final class FirmwareFlasher: ObservableObject {
    @Published private(set) var active = false
    @Published private(set) var message = "No firmware selected"
    @Published private(set) var progress = 0.0
    @Published private(set) var success: Bool?
    private let link: GlassesLink
    private var replies: [(String, Data)] = []
    private var task: Task<Void, Never>?
    private var validatedSHA: String?
    var event: ((String, [String: Any]) -> Void)?
    init(link: GlassesLink) {
        self.link = link
        link.otaMessage = { [weak self] d, side in
            guard let self else { return }
            if self.replies.count >= 256 { self.replies.removeFirst() }
            self.replies.append((side, d))
        }
    }
    private func report(_ text: String, _ fraction: Double? = nil) {
        message = text; if let fraction { progress = fraction }
        event?("flash", ["message": text, "progress": progress, "active": active, "ok": success as Any? ?? NSNull()])
    }
    func start(file: URL, sha: String, dry: Bool, allowUnknown: Bool) throws {
        guard !active else { throw BridgeError.unavailable("A flash is already active") }
        active = true; success = nil; progress = 0
        task = Task {
            #if os(macOS)
            let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "FFS firmware transfer")
            defer { ProcessInfo.processInfo.endActivity(activity) }
            #endif
            do {
                report("Checking firmware SHA-256 and component integrity", 0.01)
                let validated = try await Task.detached(priority: .userInitiated) {
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size > 0, size <= 32 * 1024 * 1024 else { throw BridgeError.invalid("Invalid firmware file size") }
                    return try G2Flash.validate(Data(contentsOf: file), sha: sha, allowUnknown: allowUnknown)
                }.value
                guard ["L", "R"].allSatisfy(link.otaReady) else { throw BridgeError.unavailable("Both lenses need subscribed OTA channels") }
                if dry {
                    validatedSHA = validated.sha; success = true
                    report("DRY-RUN OK — SHA, CRCs, MRAM guard and both lenses checked. No writes.", 1)
                } else {
                    guard validatedSHA == validated.sha else { throw BridgeError.invalid("Run a successful dry-run for this exact image first") }
                    try link.acquireFlash()
                    defer { link.releaseFlash() }
                    validatedSHA = nil
                    for (index, side) in ["L", "R"].enumerated() {
                        try await flashLens(side, image: validated, index: index)
                    }
                    report("Both lenses verified; waiting for reboot and reconnection", 0.98)
                    link.releaseFlash(); link.reconnectAfterFlash()
                    let deadline = Date().addingTimeInterval(45)
                    while !link.pairReady && Date() < deadline { try await Task.sleep(for: .milliseconds(250)) }
                    guard link.pairReady else { throw BridgeError.timeout("Transfer finished; both-lens reconnection not verified") }
                    try await link.settings("info")
                    success = true; report("FLASH COMPLETE — both lenses reconnected", 1)
                }
            } catch {
                success = false; validatedSHA = nil
                report("Stopped: \(error.localizedDescription)")
            }
            active = false
            event?("flash", ["message": message, "progress": progress, "active": false, "ok": success ?? false])
        }
    }
    private func transmit(_ frames: [[UInt8]], side: String, control: Bool = false) async throws {
        try await link.write(frames.map { Data($0) }, sides: [side], characteristic: control ? GlassesLink.writeID : GlassesLink.otaWriteID, owner: true)
    }
    private func ack(_ op: UInt8, side: String, seconds: Double = 5) async throws -> UInt8 {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            while !replies.isEmpty {
                let (source, raw) = replies.removeFirst()
                if source == side, let reply = G2Flash.parseRx([UInt8](raw)), reply.sid == 0xc0 || reply.sid == 0xc1,
                   reply.pb.count >= 2, reply.pb[0] == op { return reply.pb[1] }
            }
            guard link.lenses[side]?.ready == true else { throw BridgeError.unavailable("\(side): link lost during OTA") }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw BridgeError.timeout("\(side): OTA acknowledgement timed out")
    }
    private func command(_ op: UInt8, data: [UInt8] = [], side: String, timeout: Double = 5) async throws -> UInt8 {
        replies.removeAll()
        try await transmit(G2Flash.ctrlFrames(op, data, seq: link.nextSeq()), side: side)
        return try await ack(op, side: side, seconds: timeout)
    }
    private func flashLens(_ side: String, image: G2Flash.Validated, index: Int) async throws {
        report("Flashing \(side) lens", 0.05 + Double(index) * 0.45)
        // The workspace forbids sid 0x80 even for the old Android heartbeat. Use the
        // normal read-only settings query on sid 0x09 to keep the control link active.
        let keepalive = Task {
            while !Task.isCancelled {
                try await Task.sleep(for: .seconds(12))
                try Task.checkCancellation()
                try await link.write(Wire.packets(SettingsWire.query(false, magic: link.nextMagic()), sid: 9, seq: link.nextSeq(), reserve: true), sides: [side], characteristic: GlassesLink.writeID, owner: true)
            }
        }
        defer { keepalive.cancel() }
        let begin = try await command(0, side: side)
        guard begin == 0 else { throw BridgeError.invalid("\(side): OTA begin refused (\(begin))") }
        for (componentIndex, segment) in image.segments.enumerated() {
            let off = Int(segment.off) + 128
            let payload = Array(image.bytes[off..<off + Int(segment.ps)])
            let blockCount = (payload.count + 4095) / 4096
            var completed = false
            for attempt in 0..<3 {
                do {
                    if attempt > 0 { try await Task.sleep(for: .milliseconds(1500)) }
                    guard try await command(1, data: segment.sub, side: side) == 0 else { throw BridgeError.invalid("FILE_CHECK refused") }
                    for block in 0..<blockCount {
                        let bytes = Array(payload[block * 4096..<min(payload.count, (block + 1) * 4096)])
                        var accepted = false
                        for _ in 0..<5 {
                            do {
                                replies.removeAll(); let seq = link.nextSeq()
                                // One indivisible write job: marker and data share a sequence.
                                try await transmit(G2Flash.ctrlFrames(2, seq: seq) + G2Flash.dataFrames(bytes, seq: seq), side: side)
                                if try await ack(2, side: side) == 0 { accepted = true; break }
                            } catch { if link.lenses[side]?.ready != true { throw error } }
                        }
                        guard accepted else { throw BridgeError.timeout("Block \(block) not acknowledged") }
                        if block % 20 == 0 || block == blockCount - 1 {
                            let fraction = (Double(componentIndex) + Double(block + 1) / Double(blockCount)) / Double(image.segments.count)
                            report("\(side): \(segment.fn) · \(block + 1)/\(blockCount)", 0.05 + Double(index) * 0.45 + fraction * 0.45)
                        }
                    }
                    let end = try await command(3, side: side, timeout: 15)
                    guard [0, 8, 9].contains(end) else { throw BridgeError.invalid("Component END refused") }
                    completed = true; break
                } catch {
                    if link.lenses[side]?.ready != true || attempt == 2 { throw error }
                    report("\(side): retrying component (\(attempt + 2)/3)")
                }
            }
            guard completed else { throw BridgeError.invalid("Component verification failed") }
        }
    }
}
