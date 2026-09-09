import Foundation

@main struct AppLibraryTests {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var body = Data(repeating: 0, count: 48)
        body.replaceSubrange(0..<4, with: Data("FFSA".utf8)); body[5]=4;body[6]=48;body[8]=1;body[10]=12;body[12]=2;body[28]=32
        body.replaceSubrange(36..<40,with:Data("Test".utf8)); let code=Data([0x70,0x47]);let crc=Wire.crc32(code)
        var c=Data();c.le32(crc);body.replaceSubrange(16..<20,with:c);body.append(code)
        let frame=Wire.fxp1(body), app=try AppPackage(frame:frame)
        func makeFrame(_ id: Int) -> Data {
            var image = body
            image[8] = UInt8(truncatingIfNeeded: id); image[9] = UInt8(truncatingIfNeeded: id >> 8)
            image.replaceSubrange(36..<48, with: Data(repeating: 0, count: 12))
            image.replaceSubrange(36..<40, with: Data(String(format: "T%03d", id).utf8))
            return Wire.fxp1(image)
        }
        precondition(app.id==1 && app.name=="Test")
        var bad=frame;bad[bad.count-1] ^= 1
        do { _=try AppPackage(frame:bad); fatalError("Corrupt package accepted") }catch{}
        let lib=AppLibrary(root:root);try lib.add(frame)
        var operations:[Int]=[];var frames:[Data]=[]
        var catalogs = [Set([1, 77]), Set([88])]
        func event(_ type:UInt8,_ payload:Data)->Data {var e=Data([1,0,type,1,0,0]);e.le16(payload.count);e.append(payload);return e}
        lib.available={true}
        lib.send={ f in
            let image=Data(f.dropFirst(12));let op=Int(image[4]);operations.append(op);frames.append(image)
            precondition(Wire.crc32(image)==f.u32(8))
            if op == 9 { catalogs = [[], []] }
            if op == 5 { for i in catalogs.indices { catalogs[i].insert(image.u16(8)) } }
        }
        let firstSync = await lib.sync().value;precondition(firstSync)
        precondition(operations==[9,5] && catalogs[0] == Set([1]) && catalogs[1] == Set([1]), "Snapshot reset must converge divergent unknown entries")
        let reset = frames[0]
        precondition(reset.count == 48 && reset.prefix(4) == Data("FFSA".utf8) && reset[4] == 9 && reset[5] == 4 && reset.u16(6) == 48 && reset.u16(8) == 65535)
        precondition(reset[10...].allSatisfy { $0 == 0 }, "Catalog reset must contain no package metadata or code")
        var saved=Data();saved.le16(1);saved.le32(crc);saved.append(contentsOf:[5,0,0,0])
        lib.receive(event(0x21,saved));precondition(lib.entries[0].saved)
        var wrongCRC=saved;wrongCRC[2] ^= 1
        lib.receive(event(0x21,wrongCRC));precondition(lib.entries[0].saved)
        var wrongLens=event(0x21,Data(saved.prefix(6)));wrongLens[3]=0
        lib.receive(wrongLens);precondition(lib.entries[0].saved)
        let reopened=AppLibrary(root:root);precondition(reopened.entries.count==1 && reopened.entries[0].saved)
        operations.removeAll();frames.removeAll()
        let secondSync = await lib.sync().value;precondition(secondSync)
        precondition(operations == [9,5] && frames[0].count == 48 && frames[1].count == 48, "Catalog must reset then send metadata without code or saved content")
        operations.removeAll();frames.removeAll()
        var request=Data();request.le16(1);request.le16(7);lib.receive(event(0x20,request))
        try await Task.sleep(for:.milliseconds(100));precondition(operations == [5,6,8])
        precondition(frames[0].count == 48 && Data(frames[1].dropFirst(48)) == Data([5,0,0,0]))
        precondition(Data(frames[2].dropFirst(48)) == code && frames[2].u16(34) == 7)
        lib.receive(event(0x20,request));try await Task.sleep(for:.milliseconds(20));precondition(operations.filter{$0==8}.count==1)
        let encoded=app.frame(op:8,token:7);precondition(encoded.u16(46)==7 && encoded.count==frame.count)
        lib.receive(event(0x21,Data(saved.prefix(6))));precondition(!lib.entries[0].saved)
        let cleared=AppLibrary(root:root);precondition(!cleared.entries[0].saved)
        // Remove only catalog metadata; keep package and saved session for re-adding.
        lib.receive(event(0x21,saved));operations.removeAll();frames.removeAll()
        let removed = await (try lib.setListed(id: 1, listed: false)).value;precondition(removed)
        precondition(operations == [9] && frames[0].count == 48)
        precondition(!lib.entries[0].listed && lib.entries[0].saved && lib.message == "0 apps available on glasses")
        request[2]=8;lib.receive(event(0x20,request));try await Task.sleep(for:.milliseconds(20))
        precondition(operations == [9], "A stale selection must not resurrect a removed app")
        let hiddenRestart = AppLibrary(root:root)
        precondition(hiddenRestart.entries.count == 1 && !hiddenRestart.entries[0].listed && hiddenRestart.entries[0].saved)
        hiddenRestart.available={true};hiddenRestart.send={f in operations.append(Int(f[16]));frames.append(Data(f.dropFirst(12)))}
        operations.removeAll();frames.removeAll();let hiddenSync = await hiddenRestart.sync().value;precondition(hiddenSync)
        precondition(operations == [9])
        operations.removeAll();frames.removeAll();let relisted = await (try hiddenRestart.setListed(id:1,listed:true)).value;precondition(relisted)
        precondition(operations == [9,5] && frames[0].count == 48 && frames[1].count == 48)
        precondition(hiddenRestart.entries[0].saved && hiddenRestart.entries[0].listed)
        precondition(AppLibrary(root:root).entries[0].listed)
        hiddenRestart.available={false};let offline = await (try hiddenRestart.setListed(id:1,listed:false)).value;precondition(!offline)
        precondition(!AppLibrary(root:root).entries[0].listed)
        precondition(hiddenRestart.message.contains("Connect both"))
        do { try hiddenRestart.setListed(id:99,listed:true);fatalError("Unknown app accepted") } catch {}

        // Package retention is not the on-glass limit: hiding one of twelve frees a
        // listed slot while keeping its package and checkpoint on the companion.
        let capacityRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: capacityRoot) }
        let capacity = AppLibrary(root:capacityRoot);capacity.available={true};capacity.send={_ in}
        for id in 1...12 { try capacity.add(makeFrame(id)) }
        do { try capacity.add(makeFrame(13));fatalError("Thirteenth listed app accepted") } catch {}
        let capacityRemoved = await (try capacity.setListed(id:1,listed:false)).value;precondition(capacityRemoved)
        try capacity.add(makeFrame(13))
        precondition(capacity.entries.count == 13 && capacity.entries.filter(\.listed).count == 12)
        do { try capacity.setListed(id:1,listed:true);fatalError("Catalog overfill accepted") } catch {}
        let secondRemoved = await (try capacity.setListed(id:2,listed:false)).value;precondition(secondRemoved)
        let firstRelisted = await (try capacity.setListed(id:1,listed:true)).value;precondition(firstRelisted)
        precondition(capacity.entries.filter(\.listed).count == 12)

        // A failed automatic attempt never closes the gate. A later trigger retries,
        // while a completed attempt latches and suppresses duplicates until disconnect.
        let retryRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: retryRoot) }
        let retryLibrary = AppLibrary(root:retryRoot), gate = CatalogSyncGate();var syncAttempts=0
        retryLibrary.available={true};retryLibrary.send={_ in syncAttempts += 1;if syncAttempts == 1 { throw BridgeError.unavailable("Transient catalog failure") }}
        gate.request { retryLibrary.sync() };try await Task.sleep(for:.milliseconds(30))
        precondition(!gate.synchronized && !gate.running && syncAttempts == 1)
        gate.request { retryLibrary.sync() };try await Task.sleep(for:.milliseconds(30))
        precondition(gate.synchronized && !gate.running && syncAttempts == 2)
        gate.request { retryLibrary.sync() };try await Task.sleep(for:.milliseconds(10));precondition(syncAttempts == 2)
        gate.disconnected();gate.request { retryLibrary.sync() };try await Task.sleep(for:.milliseconds(30))
        precondition(gate.synchronized && syncAttempts == 3)

        operations.removeAll();frames.removeAll()
        let settings = ["brightness":15,"wearDetection":0,"headUp":1]
        lib.syncSettings(settings);lib.syncSettings(settings);lib.syncSettings(settings)
        try await Task.sleep(for:.milliseconds(100));precondition(operations == [7])
        lib.syncSettings(["brightness":16,"wearDetection":0,"headUp":1])
        try await Task.sleep(for:.milliseconds(100));precondition(operations == [7,7] && frames.last?[48] == 16)
        lib.disconnected();lib.syncSettings(["brightness":16,"wearDetection":0,"headUp":1])
        try await Task.sleep(for:.milliseconds(100));precondition(operations == [7,7,7])
        var settingsAttempts = 0
        lib.send={_ in settingsAttempts += 1; if settingsAttempts == 1 { throw BridgeError.unavailable("Retry settings") } }
        lib.syncSettings(settings);lib.syncSettings(settings)
        try await Task.sleep(for:.milliseconds(100));precondition(settingsAttempts == 2)
        lib.disconnected();settingsAttempts=0
        lib.send={_ in settingsAttempts += 1; if settingsAttempts == 1 { lib.disconnected() } }
        lib.syncSettings(settings);lib.syncSettings(settings)
        try await Task.sleep(for:.milliseconds(100));precondition(settingsAttempts == 2, "An old connection's completion must not suppress new readback")
        lib.send={_ in throw BridgeError.unavailable("Glasses refused command") }
        let refused = await lib.sync().value;precondition(!refused);precondition(lib.message.contains("refused"))
        print("App library: exact snapshot convergence, capacity rotation, automatic retry, save/load/removal and settings refresh passed")
    }
}
