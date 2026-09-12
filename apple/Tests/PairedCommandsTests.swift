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

        // #1 A per-send timeout overrides the instance default. The reset-frame case: a LONG per-send
        // budget survives past a short instance default, so a late ACK still completes rather than
        // being abandoned at 8 s. Instance default 30 ms, per-send 1 h, ACK at ~120 ms -> completes.
        let longBudget = PairedCommands(session: 50); longBudget.timeout = .milliseconds(30)
        var lb: [Data] = []; longBudget.transport = { lb.append($0) }
        let lbTask = Task { try await longBudget.send(frame, timeout: .seconds(3600)) }
        try await Task.sleep(for: .milliseconds(120))
        precondition(lb.count == 1 && longBudget.busy, "long per-send timeout did not override the short instance default")
        longBudget.receive(ack(lb[0])); try await lbTask.value

        // #2 The poison clears ONLY at a connection boundary. A timeout poisons the queue; mid-session
        // the poison HOLDS (a later send fails without transmitting); renew() — a fresh pairReady —
        // clears it so the next command transmits and completes.
        let poison = PairedCommands(session: 51); poison.timeout = .milliseconds(30)
        var pt: [Data] = []; poison.transport = { pt.append($0) }
        do { try await poison.send(frame); fatalError("Missing ACK accepted") } catch {}
        do { try await poison.send(frame); fatalError("Poison did not hold mid-session") } catch {}
        precondition(pt.count == 1, "poisoned queue transmitted mid-session")
        poison.renew()
        let afterRenew = Task { try await poison.send(frame) }
        try await Task.sleep(for: .milliseconds(20))
        precondition(pt.count == 2, "renew did not let a new command transmit after a reconnect")
        poison.receive(ack(pt[1])); try await afterRenew.value
        // renew is boundary-only: with a command in flight (pending != nil) it must be a no-op.
        let inflight = PairedCommands(session: 52); inflight.timeout = .seconds(3600)
        var isent: [Data] = []; inflight.transport = { isent.append($0) }
        let held = Task { try await inflight.send(frame) }
        try await Task.sleep(for: .milliseconds(20))
        inflight.renew()
        precondition(inflight.busy, "renew acted while a command was in flight")
        inflight.receive(ack(isent[0])); try await held.value

        // A timeout names the silent lens: a side heard from on 0x91 is not silent, so the absent
        // side is the lens that never acted. Here the right lens speaks (a non-completion frame) and
        // the left stays silent, so the message must name the left lens.
        let named = PairedCommands(session: 48); named.timeout = .milliseconds(40)
        named.transport = { _ in named.receive(Data([0, 1, 2]), side: "R") }
        do { try await named.send(frame); fatalError("Silent-lens timeout accepted") }
        catch { precondition((error as? BridgeError)?.errorDescription?.contains("left lens went silent") == true, "timeout did not name the silent left lens") }
        // With neither lens heard from, the message stays generic — no lens is falsely named.
        let neither = PairedCommands(session: 49); neither.timeout = .milliseconds(40)
        neither.transport = { _ in }
        do { try await neither.send(frame); fatalError("Silent-both timeout accepted") }
        catch { precondition((error as? BridgeError)?.errorDescription?.contains("Neither lens") == true, "timeout misnamed a lens when both were silent") }

        let disconnected = PairedCommands(session: 45)
        disconnected.transport = { _ in disconnected.disconnected() }
        do { try await disconnected.send(frame); fatalError("Disconnect accepted") } catch {}

        // A refusal names the loader's reason (G2A_ERR_*), not a bare number, so the library message
        // agrees with the on-glass shell. Both lenses INIT -> one honest reason; a split names each.
        let bothInit = PairedCommandRefusal(right: 11, left: 11).errorDescription ?? ""
        precondition(bothInit.contains("refused to start (init)") && bothInit.contains("code 11"), "refusal did not name the INIT reason")
        precondition(PairedCommandRefusal.reason(2).contains("too new"), "ABI reason not named")
        precondition(PairedCommandRefusal.reason(8).contains("not enough room"), "no-room reason not named")
        let split = PairedCommandRefusal(right: 11, left: 0).errorDescription ?? ""
        precondition(split.contains("right lens") && split.contains("left lens") && split.contains("(code 0)"), "split refusal did not name both lenses")

        print("Paired commands: serialization, exact identity, wrong-eye/stale ACKs, split refusal, timeout (with silent-lens naming), per-send timeout, poison hold + renew-clears-on-reconnect, refusal reason naming, and disconnect passed")
    }
}
