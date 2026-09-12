import Foundation

struct PairedCommandRefusal: LocalizedError {
    let right: UInt32, left: UInt32
    /// The per-lens result codes are the loader's G2A_ERR_* values (patches/ffs_appload.h). Name the
    /// reason the way the on-glass shell now does, so the library message and the glasses agree.
    static func reason(_ code: UInt32) -> String {
        switch code {
        case 0:            return "no error"
        case 1, 3, 4:      return "the app file is invalid"          // SHORT / HDR / SIZE
        case 2:            return "the app is too new for this firmware" // ABI
        case 5:            return "the app file is corrupted"        // CRC
        case 6, 7, 8, 13:  return "there is not enough room for the app" // SLOTS/OOM/ARENA/BUDGET
        case 9:            return "the app was not found"            // NOAPP
        case 10:           return "the app is missing its entry point" // ENTRY
        case 11:           return "the app refused to start (init)"  // INIT
        case 12:           return "another app is already running"   // BUSY
        case 14:           return "the app data could not be saved"  // STORAGE
        default:           return "an unrecognized error"
        }
    }
    var errorDescription: String? {
        right == left
            ? "Glasses refused the command: \(Self.reason(right)) (code \(right))."
            : "Glasses refused the command: right lens — \(Self.reason(right)) (code \(right)); left lens — \(Self.reason(left)) (code \(left))."
    }
}

/// One queue for every FFSA/FFSC producer. A BLE write is delivery, not execution.
/// Firmware event 0x25 is emitted only after both lenses complete the same frame.
@MainActor
final class PairedCommands {
    private struct Pending {
        let sequence: UInt32, crc: UInt32
        let removingCatalogEntry: Bool
        let continuation: CheckedContinuation<Void, Error>
    }
    private let session: UInt32
    private var sequence: UInt32 = 0
    private var pending: Pending?
    private var queue: Task<Void, Error>?
    private var timer: Task<Void, Never>?
    private var failure: Error?
    private(set) var busy = false
    var transport: ((Data) async throws -> Void)?
    var timeout: Duration = .seconds(8)
    /// Fired once per paired command outcome: `true` when a 0x25 arrived (success OR a per-side
    /// refusal — either way the command path is alive), `false` when the command timed out with no
    /// 0x25. The bridge uses `false` to detect the reconnect wedge (master journal stuck, no 0x25).
    var onCompleted: ((Bool) -> Void)?
    init(session: UInt32 = UInt32.random(in: 1...UInt32.max)) { self.session = session }

    static func accepts(_ d: Data) -> Bool {
        d.count >= 16 && d.prefix(4) == Data("FXP1".utf8) &&
        [Data("FFSA".utf8), Data("FFSC".utf8)].contains(d.subdata(in: 12..<16))
    }
    /// `timeout` overrides the instance default for THIS frame only. The cold-boot catalog-reset
    /// write can take far longer than an ordinary paired frame, so its caller passes a longer budget;
    /// everything else stays on the 8 s default by passing nil.
    func send(_ frame: Data, timeout deadline: Duration? = nil) async throws {
        guard Self.accepts(frame), frame.u32(4) == frame.count - 12,
              frame.u32(8) == Wire.crc32(Data(frame.dropFirst(12))) else {
            throw BridgeError.invalid("Invalid paired command")
        }
        let previous = queue
        let work = Task { [self] in
            _ = try? await previous?.value
            if let failure { throw failure }
            try Task.checkCancellation()
            guard let transport else { throw BridgeError.unavailable("Paired transport unavailable") }
            guard sequence < UInt32.max else { throw BridgeError.unavailable("Restart the bridge to renew its command session") }
            sequence += 1
            let seq = sequence, body = Data(frame.dropFirst(12)), crc = Wire.crc32(body)
            let budget = deadline ?? timeout
            var envelope = Data("FFSQ".utf8)
            envelope.le32(session); envelope.le32(seq); envelope.le32(crc); envelope.append(body)
            busy = true; defer { busy = false }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                pending = Pending(sequence: seq, crc: crc, removingCatalogEntry: body.count == 48 && body.prefix(4) == Data("FFSA".utf8) && body[4] == 3, continuation: continuation)
                timer = Task { [weak self] in
                    guard let self else { return }
                    do { try await Task.sleep(for: budget) } catch { return }
                    fail(BridgeError.timeout(timeoutMessage()), sequence: seq)
                }
                Task { [weak self] in
                    do { try await transport(Wire.fxp1(envelope)) }
                    catch { self?.fail(error, sequence: seq) }
                }
            }
        }
        queue = work
        try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
    }
    private func fail(_ error: Error, sequence: UInt32? = nil) {
        guard let p = pending, sequence == nil || sequence == p.sequence else { return }
        // Ownership is uncertain after a missing ACK or partial BLE delivery.
        // Do not overwrite either lens's command arena with queued work.
        if case BridgeError.timeout = error { onCompleted?(false) }
        failure = error; pending = nil; timer?.cancel(); p.continuation.resume(throwing: error)
    }
    func disconnected() {
        fail(BridgeError.unavailable("Connection lost during paired command. Restart the glasses and bridge before continuing."))
    }
    /// Clear a poisoned queue at a FRESH connection boundary (a new pairReady). A transient failure
    /// in the previous session — a missing ACK, a cold-boot timeout — otherwise wedges every later
    /// paired command until the bridge process restarts, because `failure` is sticky by design. The
    /// arena-ownership doubt that justifies that stickiness belongs to the OLD connection, so on a new
    /// one we start clean. Only at the boundary, and only with nothing in flight: mid-session the
    /// poison must stand.
    func renew() {
        guard pending == nil else { return }
        failure = nil
    }
    /// A paired command timed out: no 0x25 completion arrived from the master within the budget.
    /// Do NOT name a single lens here. The 0x91 event bus is right-lens-only (the follower relays
    /// its state through the master, so it never appears as its own 0x91 origin), so "which side
    /// produced no traffic" can only ever accuse the left lens — a false positive by construction.
    /// A lens is named only from evidence that can implicate it: a 0x25 that arrives with a per-side
    /// error code (handled as a refusal, not a timeout). With no completion at all, stay neutral.
    private func timeoutMessage() -> String {
        "No completion (event 0x25) arrived from the pair within the command budget — the master never reported both lenses finishing this frame. Reconnect and retry; if it persists, reboot the glasses over the link (panic write, then reflash the last known-good)."
    }
    func receive(_ d: Data, side: String? = nil) {
        guard d.count == 32, d[0] == 1, d[1] == 0, d[2] == 0x25,
              d[3] & 1 == 1, d.u16(6) == 24, let p = pending,
              d.u32(8) == session, d.u32(12) == p.sequence, d.u32(16) == p.crc else { return }
        pending = nil; timer?.cancel(); onCompleted?(true)
        let right = d.u32(24), left = d.u32(28)
        // FFSA uninstall is idempotent: success or NOAPP on either endpoint
        // establishes the same absent entry. Every other mixed result still poisons
        // the queue, because its resulting arena/UI ownership may diverge.
        let removed = p.removingCatalogEntry && [UInt32(0), 9].contains(right) && [UInt32(0), 9].contains(left)
        if right == 0 && left == 0 || removed { p.continuation.resume() }
        else {
            let error = PairedCommandRefusal(right: right, left: left)
            if right != left { failure = error }
            p.continuation.resume(throwing: error)
        }
    }
}
