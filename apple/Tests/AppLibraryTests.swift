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
        lib.send={_ in throw BridgeError.unavailable("Glasses refused command") }
        lib.sync();try await Task.sleep(for:.milliseconds(100));precondition(lib.message.contains("refused"))
        print("App library: corruption refusal, catalog ACK, durable save/reload, token load, and clear passed")
    }
}
