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
    var blocksBySide = ["L": 0, "R": 0], endsBySide = ["L": 0, "R": 0]
    // Every OTA control op in arrival order: (side, op). Lets a test check END ordering.
    var trace: [(side: String, op: UInt8)] = []
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
        let op = first[8], side = sides[0]
        trace.append((side, op))
        var status: UInt8 = 0
        if op == 0 { begins += 1 }
        if op == 1 { fileChecks += 1 }
        if op == 3 { endsBySide[side, default: 0] += 1 }
        if op == 2 {
            blocks += 1; blocksBySide[side, default: 0] += 1
            precondition(frames.dropFirst().allSatisfy { $0[6] == 0xc1 && $0[2] == first[2] })
            if rejectedPayload != nil && retriedPayload == nil { retriedPayload = frames.map { Data($0.dropFirst(8)) } }
            if !injected {
                injected = true
                switch fault {
                case .lostBlockACK: return // Peer committed the block; only its reply was lost.
                case .lostLink: lenses[side]?.ready = false; return
                case .rejectedBlock: status = 3; rejectedPayload = frames.map { Data($0.dropFirst(8)) }
                case .none: break
                }
            }
        }
        // Yield so a concurrent flash of the other lens interleaves the way a real radio does.
        await Task.yield()
        var reply = G2Flash.frames(sid: 0xc0, pb: [op, status], seq: first[2])[0]
        reply[1] = 0x12
        otaMessage?(Data(reply), side)
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
    static func run(_ link: GlassesLink, file: URL, sha: String, concurrent: Bool = false, mainOnly: Bool = false, timeout: Double = 0.03) async throws -> FirmwareFlasher {
        let flasher = FirmwareFlasher(link: link, acknowledgementTimeout: timeout)
        try flasher.start(file: file, sha: sha, dry: true, allowUnknown: true, concurrent: concurrent, mainOnly: mainOnly)
        try await finish(flasher)
        precondition(flasher.success == true && link.begins == 0, "Dry run wrote to peer")
        try flasher.start(file: file, sha: sha, dry: false, allowUnknown: true, concurrent: concurrent, mainOnly: mainOnly)
        try await finish(flasher)
        precondition(link.controlWrites == 0, "Control traffic interleaved with OTA")
        return flasher
    }
    @MainActor
    static func main() async throws {
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        let data = try Data(contentsOf: file)
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let image = try G2Flash.validate(data, sha: sha, allowUnknown: true)
        let main = image.segments.first { $0.fn == FirmwareFlasher.mainComponent }!
        let mainBlocks = (Int(main.ps) + 4095) / 4096
        let allBlocks = image.segments.reduce(0) { $0 + (Int($1.ps) + 4095) / 4096 }

        // ---- serial, full container (the proven default) ----
        for fault in [GlassesLink.Fault.none, .lostBlockACK, .rejectedBlock, .lostLink] {
            let link = GlassesLink(fault)
            let flasher = try await run(link, file: file, sha: sha)
            switch fault {
            case .none: precondition(flasher.success == true && link.begins == 2 && link.blocks == 2 * allBlocks)
            case .rejectedBlock:
                precondition(flasher.success == true && link.rejectedPayload == link.retriedPayload)
            case .lostBlockACK, .lostLink:
                precondition(flasher.success == false && link.blocks == 1 && link.fileChecks == 1 && link.begins == 1,
                             "An uncertain write was replayed")
            }
            print("PASS: serial \(fault), block writes=\(link.blocks), success=\(flasher.success == true)")
        }

        // ---- main component only: exactly one FILE_CHECK per lens, only the main blocks ----
        do {
            let link = GlassesLink(.none)
            let flasher = try await run(link, file: file, sha: sha, mainOnly: true)
            precondition(flasher.success == true && link.begins == 2 && link.fileChecks == 2 && link.blocks == 2 * mainBlocks)
            print("PASS: serial mainOnly, block writes=\(link.blocks) (main=\(mainBlocks)/lens)")
        }

        // ---- concurrent: both lenses interleave; each lens's final END lands only after the
        //      OTHER lens has every block acknowledged (the END barrier) ----
        for mainOnly in [false, true] {
            let link = GlassesLink(.none)
            let flasher = try await run(link, file: file, sha: sha, concurrent: true, mainOnly: mainOnly)
            let want = mainOnly ? mainBlocks : allBlocks
            precondition(flasher.success == true && link.begins == 2 && link.blocksBySide["L"] == want && link.blocksBySide["R"] == want)
            precondition(link.fileChecks == (mainOnly ? 2 : 2 * image.segments.count))
            let ops = link.trace
            let interleaved = zip(ops, ops.dropFirst()).contains { $0.side != $1.side }
            precondition(interleaved, "Concurrent flash never interleaved the two lenses")
            for side in ["L", "R"] {
                let other = side == "L" ? "R" : "L"
                let lastEnd = ops.lastIndex { $0.side == side && $0.op == 3 }!
                let otherLastBlock = ops.lastIndex { $0.side == other && $0.op == 2 }!
                precondition(lastEnd > otherLastBlock, "\(side) sent its final END before \(other) finished its blocks")
            }
            print("PASS: concurrent mainOnly=\(mainOnly), blocks L=\(link.blocksBySide["L"]!) R=\(link.blocksBySide["R"]!), ENDs held until both done")
        }

        // ---- concurrent with one lens losing its link: no replay on that lens, the other
        //      still completes, overall result is failure ----
        do {
            let link = GlassesLink(.lostLink)
            let flasher = try await run(link, file: file, sha: sha, concurrent: true, mainOnly: true)
            let lost = link.lenses["L"]!.ready ? "R" : "L", survivor = lost == "L" ? "R" : "L"
            precondition(flasher.success == false, "Concurrent flash reported success with a lost lens")
            precondition(link.blocksBySide[lost] == 1, "An uncertain write was replayed on the lost lens")
            precondition(link.blocksBySide[survivor] == mainBlocks && link.endsBySide[survivor] == 1, "Survivor did not complete after the barrier was released")
            print("PASS: concurrent lostLink on \(lost): survivor \(survivor) completed, no replay")
        }

        let link = GlassesLink(.none); link.pairAuthenticated = false
        let flasher = FirmwareFlasher(link: link)
        try flasher.start(file: file, sha: sha, dry: true, allowUnknown: true); try await finish(flasher)
        try flasher.start(file: file, sha: sha, dry: false, allowUnknown: true); try await finish(flasher)
        precondition(flasher.success == false && link.begins == 0, "Unauthenticated connection reached OTA")
        print("PASS: unauthenticated connection writes nothing")
    }
}
