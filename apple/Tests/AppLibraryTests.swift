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
        precondition(app.id==1 && app.name=="Test")
        var bad=frame;bad[bad.count-1] ^= 1
        do { _=try AppPackage(frame:bad); fatalError("Corrupt package accepted") }catch{}
        let lib=AppLibrary(root:root);try lib.add(frame)
        var operations:[Int]=[];var frames:[Data]=[]
        func event(_ type:UInt8,_ payload:Data)->Data {var e=Data([1,0,type,1,0,0]);e.le16(payload.count);e.append(payload);return e}
        lib.available={true}
        lib.send={ f in
            let image=Data(f.dropFirst(12));let op=Int(image[4]);operations.append(op);frames.append(image)
            precondition(Wire.crc32(image)==f.u32(8))

        }
        lib.sync();try await Task.sleep(for:.milliseconds(100));precondition(operations==[5])
        var saved=Data();saved.le16(1);saved.le32(crc);saved.append(contentsOf:[5,0,0,0])
        lib.receive(event(0x21,saved));precondition(lib.entries[0].saved)
        var wrongCRC=saved;wrongCRC[2] ^= 1
        lib.receive(event(0x21,wrongCRC));precondition(lib.entries[0].saved)
        var wrongLens=event(0x21,Data(saved.prefix(6)));wrongLens[3]=0
        lib.receive(wrongLens);precondition(lib.entries[0].saved)
        let reopened=AppLibrary(root:root);precondition(reopened.entries.count==1 && reopened.entries[0].saved)
        operations.removeAll();frames.removeAll()
        lib.sync();try await Task.sleep(for:.milliseconds(100))
        precondition(operations == [5] && frames[0].count == 48, "Catalog must not preload code or saved content")
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
        try lib.setListed(id: 1, listed: false)
        try await Task.sleep(for:.milliseconds(100))
        precondition(operations == [3] && frames[0].count == 48)
        precondition(!lib.entries[0].listed && lib.entries[0].saved && lib.message == "0 apps available on glasses")
        request[2]=8;lib.receive(event(0x20,request));try await Task.sleep(for:.milliseconds(20))
        precondition(operations == [3], "A stale selection must not resurrect a removed app")
        let hiddenRestart = AppLibrary(root:root)
        precondition(hiddenRestart.entries.count == 1 && !hiddenRestart.entries[0].listed && hiddenRestart.entries[0].saved)
        hiddenRestart.available={true};hiddenRestart.send={f in operations.append(Int(f[16]));frames.append(Data(f.dropFirst(12)))}
        operations.removeAll();frames.removeAll();hiddenRestart.sync()
        try await Task.sleep(for:.milliseconds(100));precondition(operations == [3])
        operations.removeAll();frames.removeAll();try hiddenRestart.setListed(id:1,listed:true)
        try await Task.sleep(for:.milliseconds(100));precondition(operations == [5] && frames[0].count == 48)
        precondition(hiddenRestart.entries[0].saved && hiddenRestart.entries[0].listed)
        precondition(AppLibrary(root:root).entries[0].listed)
        hiddenRestart.available={false};try hiddenRestart.setListed(id:1,listed:false)
        try await Task.sleep(for:.milliseconds(20));precondition(!AppLibrary(root:root).entries[0].listed)
        precondition(hiddenRestart.message.contains("Connect both"))
        do { try hiddenRestart.setListed(id:99,listed:true);fatalError("Unknown app accepted") } catch {}

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
        lib.sync();try await Task.sleep(for:.milliseconds(100));precondition(lib.message.contains("refused"))
        print("App library: catalog/save/load/removal, offline preferences, acknowledged settings deduplication, failure retry and reconnect refresh passed")
    }
}
