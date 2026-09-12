import Foundation

struct PairedCommandRefusal: LocalizedError {
    let right: UInt32, left: UInt32
    var errorDescription: String? { "Glasses refused command (right \(right), left \(left))" }
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
    /// Sides (e.g. "L"/"R") that produced any 0x91 traffic since the current command started.
    /// A lens that completes the frame is necessarily heard from; one that stays silent is not,
    /// so on a timeout the absent side is the lens that never acted.
    private var sawSides: Set<String> = []
    private var queue: Task<Void, Error>?
    private var timer: Task<Void, Never>?
    private var failure: Error?
    private(set) var busy = false
    var transport: ((Data) async throws -> Void)?
    var timeout: Duration = .seconds(8)
    init(session: UInt32 = UInt32.random(in: 1...UInt32.max)) { self.session = session }

    static func accepts(_ d: Data) -> Bool {
        d.count >= 16 && d.prefix(4) == Data("FXP1".utf8) &&
        [Data("FFSA".utf8), Data("FFSC".utf8)].contains(d.subdata(in: 12..<16))
    }
    func send(_ frame: Data) async throws {
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
            var envelope = Data("FFSQ".utf8)
            envelope.le32(session); envelope.le32(seq); envelope.le32(crc); envelope.append(body)
            busy = true; defer { busy = false }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                sawSides = []
                pending = Pending(sequence: seq, crc: crc, removingCatalogEntry: body.count == 48 && body.prefix(4) == Data("FFSA".utf8) && body[4] == 3, continuation: continuation)
                timer = Task { [weak self] in
                    guard let self else { return }
                    do { try await Task.sleep(for: timeout) } catch { return }
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
        failure = error; pending = nil; timer?.cancel(); p.continuation.resume(throwing: error)
    }
    func disconnected() {
        fail(BridgeError.unavailable("Connection lost during paired command. Restart the glasses and bridge before continuing."))
    }
    /// Names the silent lens when a paired command times out. A lens that completes the frame
    /// is heard from on 0x91; whichever side produced no traffic since the command started is the
    /// one that never acted. Falls back to the generic wording when both or neither were heard.
    private func timeoutMessage() -> String {
        let silent = ["L": "left", "R": "right"].compactMap { sawSides.contains($0.key) ? nil : $0.value }
        let tail = "Restart the glasses and bridge before continuing; if one lens stays silent, power-cycle the glasses (both in the case, then out)."
        switch (silent.contains("left"), silent.contains("right")) {
        case (true, false): return "The left lens went silent — it produced no events during the command while the right lens responded. \(tail)"
        case (false, true): return "The right lens went silent — it produced no events during the command while the left lens responded. \(tail)"
        case (true, true):  return "Neither lens produced any events during the command. \(tail)"
        default:            return "Both lenses responded but neither reported completion of the command. \(tail)"
        }
    }
    func receive(_ d: Data, side: String? = nil) {
        if pending != nil, let side { sawSides.insert(side) }
        guard d.count == 32, d[0] == 1, d[1] == 0, d[2] == 0x25,
              d[3] & 1 == 1, d.u16(6) == 24, let p = pending,
              d.u32(8) == session, d.u32(12) == p.sequence, d.u32(16) == p.crc else { return }
        pending = nil; timer?.cancel()
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
