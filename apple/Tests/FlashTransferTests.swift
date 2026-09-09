import Foundation
import CryptoKit

// Runs the production FirmwareFlasher with an in-memory peer. No Bluetooth.
@MainActor
final class GlassesLink {
    struct Lens { var ready = true }
    static let writeID = 1, otaWriteID = 2
    var lenses = ["L": Lens(), "R": Lens()]
    var pairReady = true, pairAuthenticated = true
    var otaMessage: ((Data, String) -> Void)?
    enum Fault { case none, lostBlockACK, rejectedBlock, lostLink }
    let fault: Fault
    var injected = false, blocks = 0, begins = 0, fileChecks = 0, controlWrites = 0
    var rejectedPayload: [Data]?, retriedPayload: [Data]?
    private var sequence: UInt8 = 0
    init(_ fault: Fault) { self.fault = fault }
    func nextSeq() -> UInt8 { sequence &+= 1; return sequence }
    func otaReady(_ side: String) -> Bool { lenses[side]?.ready == true }
    func acquireFlash() throws {}
    func releaseFlash() {}
    func reconnectAfterFlash() {}
    func settings(_ key: String) async throws {}
    func write(_ frames: [Data], sides: [String], characteristic: Int, owner: Bool) async throws {
        guard characteristic == Self.otaWriteID else { controlWrites += 1; return }
        guard let first = frames.first, first[6] == 0xc0 else { fatalError("Missing control marker") }
        let op = first[8]
        var status: UInt8 = 0
        if op == 0 { begins += 1 }
        if op == 1 { fileChecks += 1 }
        if op == 2 {
            blocks += 1
            precondition(frames.dropFirst().allSatisfy { $0[6] == 0xc1 && $0[2] == first[2] })
            if rejectedPayload != nil && retriedPayload == nil { retriedPayload = frames.map { Data($0.dropFirst(8)) } }
            if !injected {
                injected = true
                switch fault {
                case .lostBlockACK: return // Peer committed the block; only its reply was lost.
                case .lostLink: lenses[sides[0]]?.ready = false; return
                case .rejectedBlock: status = 3; rejectedPayload = frames.map { Data($0.dropFirst(8)) }
                case .none: break
                }
            }
        }
        var reply = G2Flash.frames(sid: 0xc0, pb: [op, status], seq: first[2])[0]
        reply[1] = 0x12
        otaMessage?(Data(reply), sides[0])
    }
}

@main
struct FlashTransferTests {
    @MainActor
    static func finish(_ flasher: FirmwareFlasher) async throws {
        let deadline = Date().addingTimeInterval(15)
        while flasher.active && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        precondition(!flasher.active, "Test timed out")
    }
    @MainActor
    static func main() async throws {
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        let sha = SHA256.hash(data: try Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined()
        for fault in [GlassesLink.Fault.none, .lostBlockACK, .rejectedBlock, .lostLink] {
            let link = GlassesLink(fault)
            let flasher = FirmwareFlasher(link: link, acknowledgementTimeout: 0.03)
            try flasher.start(file: file, sha: sha, dry: true, allowUnknown: true)
            try await finish(flasher)
            precondition(flasher.success == true && link.begins == 0, "Dry run wrote to peer")
            try flasher.start(file: file, sha: sha, dry: false, allowUnknown: true)
            try await finish(flasher)
            precondition(link.controlWrites == 0, "Control traffic interleaved with OTA")
            switch fault {
            case .none: precondition(flasher.success == true && link.begins == 2)
            case .rejectedBlock:
                precondition(flasher.success == true && link.rejectedPayload == link.retriedPayload)
            case .lostBlockACK, .lostLink:
                precondition(flasher.success == false && link.blocks == 1 && link.fileChecks == 1 && link.begins == 1,
                             "An uncertain write was replayed")
            }
            print("PASS: \(fault), block writes=\(link.blocks), success=\(flasher.success == true)")
        }
        let link = GlassesLink(.none); link.pairAuthenticated = false
        let flasher = FirmwareFlasher(link: link)
        try flasher.start(file: file, sha: sha, dry: true, allowUnknown: true); try await finish(flasher)
        try flasher.start(file: file, sha: sha, dry: false, allowUnknown: true); try await finish(flasher)
        precondition(flasher.success == false && link.begins == 0, "Unauthenticated connection reached OTA")
        print("PASS: unauthenticated connection writes nothing")
    }
}
