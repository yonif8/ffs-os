import Foundation
import Combine

/// Both lenses must send their final END within the same few seconds when flashing
/// concurrently: END of the main component schedules that lens's own reboot 3 s later
/// (firmware ota_service END handler -> update flag -> DmConnClose -> SWPOR reset). Holding
/// the two ENDs until both lenses have every block acknowledged keeps the pair from running
/// two firmware versions for minutes, which is what a serial flash does today. A lens that
/// fails before arriving releases the barrier so the survivor still completes.
@MainActor
final class EndBarrier {
    private let expected: Int
    private var arrived = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(expected: Int) { self.expected = expected }
    func arrive() async {
        arrived += 1
        if arrived >= expected { resumeAll(); return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() { arrived = expected; resumeAll() }
    private func resumeAll() { let w = waiters; waiters = []; w.forEach { $0.resume() } }
}

@MainActor
final class FirmwareFlasher: ObservableObject {
    static let mainComponent = "ota/s200_firmware_ota.bin"
    @Published private(set) var active = false
    @Published private(set) var message = "No firmware selected"
    @Published private(set) var progress = 0.0
    @Published private(set) var success: Bool?
    private let link: GlassesLink
    private var replies: [String: [Data]] = ["L": [], "R": []]
    private var sideProgress: [String: Double] = [:]
    private var task: Task<Void, Never>?
    private var validatedSHA: String?
    private let acknowledgementTimeout: TimeInterval
    var event: ((String, [String: Any]) -> Void)?
    init(link: GlassesLink, acknowledgementTimeout: TimeInterval = 5) {
        self.link = link
        self.acknowledgementTimeout = acknowledgementTimeout
        link.otaMessage = { [weak self] d, side in
            guard let self else { return }
            if self.replies[side, default: []].count >= 256 { self.replies[side]?.removeFirst() }
            self.replies[side, default: []].append(d)
        }
    }
    private func report(_ text: String, _ fraction: Double? = nil) {
        message = text; if let fraction { progress = fraction }
        event?("flash", ["message": text, "progress": progress, "active": active, "ok": success as Any? ?? NSNull()])
    }
    /// `concurrent` drives both lenses at once (each lens's OTA session is independent in the
    /// firmware: own staging file, own CRC check, own reboot). `mainOnly` sends just the main
    /// application component; the five stock components never change between our builds.
    /// Both default to the proven serial, full-container behaviour.
    func start(file: URL, sha: String, dry: Bool, allowUnknown: Bool, concurrent: Bool = false, mainOnly: Bool = false, autoPanic: Bool = false) throws {
        guard !active else { throw BridgeError.unavailable("A flash is already active") }
        active = true; success = nil; progress = 0; sideProgress = [:]
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
                let segments = mainOnly ? validated.segments.filter { $0.fn == Self.mainComponent } : validated.segments
                guard !segments.isEmpty else { throw BridgeError.invalid("Image has no \(Self.mainComponent) component") }
                guard ["L", "R"].allSatisfy(link.otaReady) else { throw BridgeError.unavailable("Both lenses need subscribed OTA channels") }
                let mode = "\(concurrent ? "concurrent" : "serial"), \(mainOnly ? "main component only" : "all \(segments.count) components")"
                if dry {
                    validatedSHA = validated.sha; success = true
                    report("DRY-RUN OK — SHA, CRCs, MRAM guard and both lenses checked (\(mode)). No writes.", 1)
                } else {
                    guard validatedSHA == validated.sha else { throw BridgeError.invalid("Run a successful dry-run for this exact image first") }
                    guard link.pairAuthenticated else { throw BridgeError.unavailable("Both current connections must complete authentication before flashing") }
                    try link.acquireFlash()
                    defer { link.releaseFlash() }
                    validatedSHA = nil
                    replies = ["L": [], "R": []]
                    if concurrent {
                        let barrier = EndBarrier(expected: 2)
                        var failures: [Error] = []
                        await withTaskGroup(of: Error?.self) { group in
                            for side in ["L", "R"] {
                                group.addTask { @MainActor in
                                    do { try await self.flashLens(side, image: validated, segments: segments, index: 0, concurrent: true, barrier: barrier); return nil }
                                    catch { barrier.release(); return error }
                                }
                            }
                            for await failure in group { if let failure { failures.append(failure) } }
                        }
                        if let first = failures.first { throw first }
                    } else {
                        for (index, side) in ["L", "R"].enumerated() {
                            try await flashLens(side, image: validated, segments: segments, index: index, concurrent: false, barrier: nil)
                        }
                    }
                    report("Both lenses verified; waiting for reboot and reconnection", 0.98)
                    link.releaseFlash(); link.reconnectAfterFlash()
                    let deadline = Date().addingTimeInterval(45)
                    while !link.pairReady && Date() < deadline { try await Task.sleep(for: .milliseconds(250)) }
                    guard link.pairReady else { throw BridgeError.timeout("Transfer finished; both-lens reconnection not verified") }
                    try await link.settings("info")
                    let shellUp = await summonShellAfterReconnect()
                    if autoPanic { try await panicResetPair() }
                    success = true
                    let note = autoPanic ? ", panic-reset" : (shellUp ? ", shell summoned" : ", shell NOT confirmed — a panic may be needed")
                    report("FLASH COMPLETE — both lenses reconnected\(note) (\(mode))", 1)
                }
            } catch {
                success = false; validatedSHA = nil
                report("Stopped: \(error.localizedDescription)")
            }
            active = false
            event?("flash", ["message": message, "progress": progress, "active": false, "ok": success ?? false])
        }
    }
    /// A raw OTA-reconnect boot leaves each lens's base display page PARKED: `dash_state` stays
    /// NONE, so `ffs_pair_tick` early-returns per lens — no peer link, no journal, no 0x91 trace,
    /// and no paired command frames (op8 launch, `librarySync`). The one cold-over-BLE summon that
    /// un-parks it is FWAK -> `RequestDisplayStartUp` on the BLE-thread gate. The bridge otherwise
    /// sends FWAK on pairReady only when a flash is not active and the library is non-empty, so a
    /// post-flash reconnect misses it. We therefore always send FWAK here — PER SIDE, because
    /// GlassesLink.send guards `allSatisfy(ready)` and refuses a both-sides wake outright if either
    /// lens is momentarily not ready on the reconnect, which would leave NEITHER lens waked. Each
    /// side is waked as soon as it is ready (both need it: the master to build the shell, the
    /// follower to un-park and join the peer session), then we wait for the master readback to show
    /// the shell built and the follower peer session up before declaring the flash done. Proven
    /// 2026-09-12: on a raw OTA boot the readback is `dash=none peer=down`; FWAK builds the shell.
    /// Belt-and-suspenders with the firmware self-wake from the BLE gate. Returns whether the shell
    /// + peer were confirmed within the window. Best-effort: a flash that transferred and reconnected
    /// is still a success; an unconfirmed shell is reported, not thrown, so an operator can enable the
    /// `autoPanic` fallback or panic manually.
    @discardableResult
    private func summonShellAfterReconnect() async -> Bool {
        report("Summoning the display shell on both lenses (FWAK) after the OTA reconnect", 0.985)
        // Wake each side independently, retrying until it is both ready and accepts the write (the
        // bridge's own on-pairReady sync may momentarily own the loader), up to a shared window.
        let wakeDeadline = Date().addingTimeInterval(25)
        var waked: Set<String> = []
        while waked.count < 2 && Date() < wakeDeadline {
            for side in ["L", "R"] where !waked.contains(side) {
                guard link.lenses[side]?.ready == true else { continue }
                do { try await link.settings("wake", side: side); waked.insert(side) }
                catch { /* lens flapped or loader busy; retry on the next pass */ }
            }
            if waked.count < 2 { try? await Task.sleep(for: .milliseconds(500)) }
        }
        if waked.count < 2 {
            report("FWAK reached \(waked.sorted().joined(separator: "+").isEmpty ? "neither lens" : waked.sorted().joined(separator: "+")) only — other lens not ready in time")
        }
        // Wait for the master readback to show the shell built AND the follower peer session up.
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            try? await link.settings("info", side: "R")
            let ld = link.lenses["R"]?.diagnostics["loader"] ?? ""
            let caps = link.lenses["R"]?.diagnostics["capabilities"] ?? ""
            let peerUp = caps.contains("peer=") && !caps.contains("peer=down")
            if ld.contains("dash=built") && peerUp { report("Shell built and follower peer up after FWAK", 0.99); return true }
            try? await Task.sleep(for: .milliseconds(500))
        }
        report("Shell/peer NOT confirmed after FWAK (\(link.lenses["R"]?.diagnostics["loader"] ?? "no readback")) — a panic may be needed")
        return false
    }
    /// Heavier fallback (opt-in via `autoPanic`): panic-reset both lenses and wait for the pair to
    /// reconnect and re-authenticate. A clean (panic) boot builds the shell and completes command
    /// frames, so this recovers a boot the FWAK summon could not. A panic write may throw if the
    /// lens has already begun its reset — that is the intended effect, not a failure, so log and
    /// continue; the manufactured reconnect follows.
    private func panicResetPair() async throws {
        for side in ["L", "R"] {
            report("Panic-resetting \(side) lens (autoPanic fallback)", 0.99)
            do { try await link.settings("panic", side: side) }
            catch { report("\(side): panic write returned \(error.localizedDescription) — reset likely already underway", 0.99) }
        }
        // Re-arm the same reboot/reconnect window the flash uses; it tears the pair down and
        // reconnects after the SWPOR window regardless of exactly when each lens dropped.
        link.reconnectAfterFlash()
        let deadline = Date().addingTimeInterval(60)
        while !link.pairAuthenticated && Date() < deadline { try await Task.sleep(for: .milliseconds(250)) }
        guard link.pairAuthenticated else { throw BridgeError.timeout("Panic reset issued; both-lens reconnection + re-auth not verified") }
        try await link.settings("info")
    }
    private func transmit(_ frames: [[UInt8]], side: String, control: Bool = false) async throws {
        try await link.write(frames.map { Data($0) }, sides: [side], characteristic: control ? GlassesLink.writeID : GlassesLink.otaWriteID, owner: true)
    }
    private func ack(_ op: UInt8, side: String, seconds: Double? = nil) async throws -> UInt8 {
        let deadline = Date().addingTimeInterval(seconds ?? acknowledgementTimeout)
        while Date() < deadline {
            while let raw = replies[side]?.first {
                replies[side]?.removeFirst()
                if let reply = G2Flash.parseRx([UInt8](raw)), reply.sid == 0xc0 || reply.sid == 0xc1,
                   reply.pb.count >= 2, reply.pb[0] == op { return reply.pb[1] }
            }
            guard link.lenses[side]?.ready == true else { throw BridgeError.unavailable("\(side): link lost during OTA") }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw BridgeError.timeout("\(side): OTA acknowledgement timed out")
    }
    private func command(_ op: UInt8, data: [UInt8] = [], side: String, timeout: Double = 5) async throws -> UInt8 {
        replies[side] = []
        try await transmit(G2Flash.ctrlFrames(op, data, seq: link.nextSeq()), side: side)
        return try await ack(op, side: side, seconds: timeout)
    }
    private func progressed(_ side: String, _ fraction: Double, index: Int, concurrent: Bool, text: String) {
        // Serial: L owns 0.05..0.50, R owns 0.50..0.95. Concurrent: both advance together.
        sideProgress[side] = fraction
        let overall: Double
        if concurrent { overall = 0.05 + (sideProgress.values.reduce(0, +) / 2) * 0.90 }
        else { overall = 0.05 + Double(index) * 0.45 + fraction * 0.45 }
        report(text, overall)
    }
    private func flashLens(_ side: String, image: G2Flash.Validated, segments: [G2Flash.Segment], index: Int, concurrent: Bool, barrier: EndBarrier?) async throws {
        progressed(side, 0, index: index, concurrent: concurrent, text: "Flashing \(side) lens")
        // Authentication must precede BEGIN. Upstream's official-app capture has
        // no control-channel heartbeat between BEGIN and final END; OTA data
        // refreshes the transfer watchdog. Keep other traffic out of this phase.
        let begin = try await command(0, side: side)
        guard begin == 0 else { throw BridgeError.invalid("\(side): OTA begin refused (\(begin))") }
        for (componentIndex, segment) in segments.enumerated() {
            let off = Int(segment.off) + 128
            let payload = Array(image.bytes[off..<off + Int(segment.ps)])
            let blockCount = (payload.count + 4095) / 4096
            let holdEnd = barrier != nil && segment.fn == Self.mainComponent
            var completed = false
            for attempt in 0..<3 {
                do {
                    if attempt > 0 { try await Task.sleep(for: .milliseconds(1500)) }
                    guard try await command(1, data: segment.sub, side: side) == 0 else { throw BridgeError.invalid("FILE_CHECK refused") }
                    for block in 0..<blockCount {
                        let bytes = Array(payload[block * 4096..<min(payload.count, (block + 1) * 4096)])
                        var accepted = false
                        for _ in 0..<5 {
                            replies[side] = []; let seq = link.nextSeq()
                            // One indivisible write job: marker and data share a sequence.
                            try await transmit(G2Flash.ctrlFrames(2, seq: seq) + G2Flash.dataFrames(bytes, seq: seq), side: side)
                            // Only an explicit rejection permits an in-place retry.
                            // A missing ACK may describe a committed block; replaying
                            // it would advance the device's implicit cursor twice.
                            if try await ack(2, side: side) == 0 { accepted = true; break }
                        }
                        guard accepted else { throw BridgeError.timeout("Block \(block) not acknowledged") }
                        if block % 20 == 0 || block == blockCount - 1 {
                            let fraction = (Double(componentIndex) + Double(block + 1) / Double(blockCount)) / Double(segments.count)
                            progressed(side, fraction, index: index, concurrent: concurrent, text: "\(side): \(segment.fn) · \(block + 1)/\(blockCount)")
                        }
                    }
                    if holdEnd, let barrier {
                        report("\(side): all blocks acknowledged; waiting for the other lens before END")
                        await barrier.arrive()
                    }
                    let end = try await command(3, side: side, timeout: 15)
                    guard [0, 8, 9].contains(end) else { throw BridgeError.invalid("Component END refused") }
                    completed = true; break
                } catch {
                    if case BridgeError.timeout = error { throw error }
                    if case BridgeError.unavailable = error { throw error }
                    if link.lenses[side]?.ready != true || attempt == 2 { throw error }
                    report("\(side): retrying component (\(attempt + 2)/3)")
                }
            }
            guard completed else { throw BridgeError.invalid("Component verification failed") }
        }
    }
}
