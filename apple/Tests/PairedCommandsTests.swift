import Foundation

@main struct PairedCommandsTests {
    @MainActor static func main() async throws {
        let frame = try Wire.appData(id: 1, seq: 2, blob: Data([4]))
        func ack(_ f: Data, session: UInt32? = nil, seq: UInt32? = nil, crc: UInt32? = nil, right: UInt32 = 0, left: UInt32 = 0) -> Data {
            var d = Data([1, 0, 0x25, 1, 0, 0, 24, 0])
            d.le32(session ?? f.u32(16)); d.le32(seq ?? f.u32(20)); d.le32(crc ?? f.u32(24))
            d.le32(7); d.le32(right); d.le32(left); return d
        }
        let q = PairedCommands(session: 42)
        var sent: [Data] = [], completed = 0
        q.transport = { f in
            precondition(f.u32(8) == Wire.crc32(Data(f.dropFirst(12))))
            precondition(f.subdata(in: 12..<16) == Data("FFSQ".utf8))
            precondition(f.subdata(in: 28..<f.count) == Data(frame.dropFirst(12)))
            sent.append(f)
        }
        let a = Task { try await q.send(frame); completed += 1 }
        let b = Task { try await q.send(frame); completed += 1 }
        try await Task.sleep(for: .milliseconds(20))
        precondition(sent.count == 1 && completed == 0)
        q.receive(ack(sent[0], session: 41)); q.receive(ack(sent[0], seq: 9)); q.receive(ack(sent[0], crc: 9))
        var wrongLens = ack(sent[0]); wrongLens[3] = 0; q.receive(wrongLens)
        precondition(completed == 0 && q.busy)
        q.receive(ack(sent[0])); try await a.value
        try await Task.sleep(for: .milliseconds(20))
        precondition(sent.count == 2 && sent[1].u32(20) == 2 && completed == 1)
        q.receive(ack(sent[0])); precondition(q.busy) // delayed ACK cannot complete the next operation
        q.receive(ack(sent[1])); try await b.value
        precondition(completed == 2 && !q.busy)

        let bad = PairedCommands(session: 43)
        bad.transport = { bad.receive(ack($0, left: 6)) }
        do { try await bad.send(frame); fatalError("One-eye failure accepted") } catch {}
        var reused = false; bad.transport = { _ in reused = true }
        do { try await bad.send(frame); fatalError("Diverged queue reused") } catch {}
        precondition(!reused)

        var removeBody = Data(repeating: 0, count: 48)
        removeBody.replaceSubrange(0..<4, with: Data("FFSA".utf8)); removeBody[4]=3;removeBody[5]=4;removeBody[6]=48;removeBody[8]=1
        let removeFrame = Wire.fxp1(removeBody)
        for (right, left): (UInt32, UInt32) in [(0,9),(9,0),(9,9)] {
            let removal = PairedCommands(session: 46)
            removal.transport = { removal.receive(ack($0, right: right, left: left)) }
            try await removal.send(removeFrame)
            removal.transport = { removal.receive(ack($0)) }
            try await removal.send(frame) // a converged removal must leave the queue usable
        }
        let failedRemoval = PairedCommands(session: 47)
        failedRemoval.transport = { failedRemoval.receive(ack($0, right: 14, left: 0)) }
        do { try await failedRemoval.send(removeFrame); fatalError("Storage failure accepted") } catch {}
        var afterFailure = false; failedRemoval.transport = { _ in afterFailure = true }
        do { try await failedRemoval.send(frame); fatalError("Uncertain removal reused") } catch {}
        precondition(!afterFailure)

        let timeout = PairedCommands(session: 44); timeout.timeout = .milliseconds(30)
        var count = 0; timeout.transport = { _ in count += 1 }
        let first = Task { try await timeout.send(frame) }, second = Task { try await timeout.send(frame) }
        do { try await first.value; fatalError("Missing ACK accepted") } catch {}
        do { try await second.value; fatalError("Uncertain arena overwritten") } catch {}
        precondition(count == 1)

        let disconnected = PairedCommands(session: 45)
        disconnected.transport = { _ in disconnected.disconnected() }
        do { try await disconnected.send(frame); fatalError("Disconnect accepted") } catch {}
        print("Paired commands: serialization, exact identity, wrong-eye/stale ACKs, split refusal, timeout and disconnect passed")
    }
}
