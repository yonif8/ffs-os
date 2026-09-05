import Foundation
import CryptoKit

@main
struct CoreTests {
    static var passed = 0
    static func check(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
        guard try condition() else { throw BridgeError.invalid("FAIL: \(label)") }; passed += 1
    }
    static func refuses(_ label: String, _ action: () throws -> Void) throws {
        do { try action() } catch { passed += 1; return }; throw BridgeError.invalid("FAIL: accepted \(label)")
    }
    static func main() throws {
        try check(SettingsWire.query(false, magic: 1).hex == "0802100122020801", "Android device-info request")
        try check(Wire.packets(SettingsWire.query(false, magic: 1), sid: 9, seq: 1, reserve: true)[0][7] == 0x20, "Settings require reply flag")
        var nak = try Wire.packets(Data([1]), sid: 9, seq: 1)[0]; nak[7] = 2
        var nakReceiver = Reassembler()
        try check(nakReceiver.feed(nak) == nil, "Rejected transport result is not a successful reply")
        var recovery = PeerRecovery()
        try check(recovery.observe(now: 0, wanted: true, flashing: false, left: false, right: true).side == nil, "No reset during initial pairing")
        _ = recovery.observe(now: 1, wanted: true, flashing: false, left: true, right: true)
        try check(recovery.observe(now: 2, wanted: true, flashing: false, left: false, right: true).deadline == 4, "Recovery grace period")
        try check(recovery.observe(now: 4, wanted: true, flashing: false, left: false, right: true).side == "R", "Reset only surviving lens")
        try check(recovery.observe(now: 8, wanted: true, flashing: false, left: false, right: true).side == nil, "Recovery is one-shot")
        recovery.reset()
        try check(recovery.observe(now: 9, wanted: true, flashing: false, left: true, right: false).deadline == nil, "Explicit reset disarms recovery")
        _ = recovery.observe(now: 10, wanted: true, flashing: false, left: true, right: true)
        try check(recovery.observe(now: 11, wanted: true, flashing: true, left: true, right: false).deadline == nil, "No reset during firmware transfer")
        try check(recovery.observe(now: 12, wanted: false, flashing: false, left: true, right: false).deadline == nil, "No reset after intentional disconnect")
        let fixtureURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
        try check(Wire.crc16(Data("123456789".utf8)) == 0x29b1, "CRC16 standard vector")
        try check(Wire.crc32(Data("123456789".utf8)) == 0xcbf43926, "CRC32 standard vector")
        for item in fixtures["wire"] as! [[String: Any]] {
            let body = Data(base64Encoded: item["body"] as! String)!
            let packets = try Wire.packets(body, sid: 0x90, seq: 7)
            try check(packets.map(\.hex) == item["packets"] as! [String], "Android transport boundary \(body.count)")
            var receiver = Reassembler(), result: Data?
            for p in packets { result = receiver.feed(p)?.1 ?? result }
            try check(result == body, "Transport reassembly \(body.count)")
            if let first = packets.first { var corrupt = first; corrupt[corrupt.count - 1] ^= 1; var bad = Reassembler(); try check(bad.feed(corrupt) == nil, "Corrupt/incomplete fragment is rejected") }
        }
        try refuses("oversized transport") { _ = try Wire.packets(Data(repeating: 1, count: 236 * 255), sid: 0x90, seq: 1) }
        var proto = Proto(); proto.int(1, -2); proto.bytes(5, Data("test".utf8))
        let fields = try Proto.fields(proto.data)
        try check(fields.number(1) == -2 && fields.string(5) == "test", "Signed protobuf")
        try refuses("truncated protobuf") { _ = try Proto.fields(Data([0x2a, 0xff])) }
        try refuses("overflow protobuf") { _ = try Proto.fields(Data([8] + Array(repeating: 0xff, count: 10))) }
        let brightness = SettingsWire.brightness(35, auto: false, magic: 1)
        try check(brightness.hex == "080110011a060a0408001023", "Android brightness wire vector")
        var framer = VoiceFramer()
        func packet(_ counter: Int) -> Data { var d = Data(repeating: 0, count: 205); d[204] = UInt8(counter); return d }
        try check(framer.offer(packet(255)) == 0, "Voice first packet")
        try check(framer.offer(packet(0)) == 0, "Voice wrap")
        try check(framer.offer(packet(0)) == nil, "Voice duplicate")
        try check(framer.offer(packet(255)) == nil, "Voice stale other lens")
        try check(framer.offer(packet(3)) == 10 && framer.lost == 2, "Voice gap conceals five frames per packet")
        try check(framer.offer(packet(30)) == 0 && framer.resyncs == 1, "Voice large gap resync")
        try check(framer.offer(Data(repeating: 0, count: 204)) == nil, "Malformed microphone packet")
        var fb = Framebuffer()
        for offset in stride(from: 0, to: Framebuffer.size, by: 216) {
            var frame = Data("FBSH".utf8); frame.append(contentsOf: [UInt8(truncatingIfNeeded: offset / 216), 128, 2, UInt8(truncatingIfNeeded: offset), UInt8(truncatingIfNeeded: offset >> 8), UInt8(truncatingIfNeeded: offset >> 16)])
            frame.append(Data(repeating: 0xa5, count: min(216, Framebuffer.size - offset)))
            try check(fb.feed(frame), "Screenshot chunk accepted")
            if offset > 0 { _ = fb.feed(frame) }
        }
        try check(fb.complete && fb.received == 82944, "Framebuffer counts unique bytes despite wrapped packet count")
        try check(fb.bytes.allSatisfy { $0 == 0xa5 }, "Framebuffer byte integrity")
        let image = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let sha = SHA256.hash(data: image).map { String(format: "%02x", $0) }.joined()
        let validated = try G2Flash.validate(image, sha: sha)
        try check(validated.guardResult.ps == 3557884 && validated.guardResult.progEnd == 0x79c9dc, "Actual 2.2.7.14 stock MRAM guard")
        try check(G2Flash.goldens.count == fixtures["goldenCount"] as! Int, "Current Android golden registry count")
        for golden in G2Flash.goldens {
            let record = (fixtures["goldens"] as! [String: [String: Any]])[golden.sha256]!
            try check(golden.ps == record["ps"] as! UInt32 && golden.progEnd == record["end"] as! UInt32, "Android golden \(golden.label)")
        }
        try refuses("wrong SHA") { _ = try G2Flash.validate(image, sha: String(repeating: "0", count: 64)) }
        var corrupt = image; corrupt[corrupt.count - 1] ^= 0xff
        let corruptSHA = SHA256.hash(data: corrupt).map { String(format: "%02x", $0) }.joined()
        try refuses("corrupt component despite pinned SHA") { _ = try G2Flash.validate(corrupt, sha: corruptSHA, allowUnknown: true) }
        try refuses("truncated firmware") { _ = try G2Flash.parseSegments(Array(image.prefix(100))) }
        for item in fixtures["ota"] as! [[String: Any]] {
            let body = [UInt8](Data(base64Encoded: item["body"] as! String)!)
            try check(G2Flash.frames(sid: 0xc1, pb: body, seq: 9).map { Data($0).hex } == item["packets"] as! [String], "Python OTA reference \(body.count)")
        }
        let blob = Data("hello".utf8)
        try check(try Wire.appData(id: 14, seq: 2, blob: blob).hex == fixtures["ffsc"] as! String, "Python FFSC reference")
        let audio = Data(repeating: 0xaa, count: 1024)
        let buzzer = BuzzerWire.frame(op: 2, stream: 42, seq: 3, payload: audio)
        try check(buzzer.prefix(24).hex == fixtures["buzzerHeader"] as! String, "Android buzzer header")
        var pdm = PdmEncoder(); pdm.consume(Array(repeating: 0, count: 16000), rate: 16000); pdm.finish()
        try check(pdm.data.count == 4096 && pdm.data.allSatisfy { $0 == 0x55 }, "One-second silent PDM")
        let key = Data(repeating: 0x31, count: 32)
        let encrypted = try DeveloperCrypto.seal(["command": "status", "id": "test"], key: key)
        try check(try DeveloperCrypto.open(encrypted, key: key)["command"] as? String == "status", "Encrypted developer roundtrip")
        var modified = encrypted; modified[15] ^= 1
        try refuses("tampered developer packet") { _ = try DeveloperCrypto.open(modified, key: key) }
        try refuses("wrong pairing key") { _ = try DeveloperCrypto.open(encrypted, key: Data(repeating: 0, count: 32)) }
        let cfg = try STTConfig("{\"providerKind\":\"http\",\"endpointUrl\":\"https://example.invalid/stt\",\"headers\":{\"Authorization\":\"secret\"},\"textPath\":\"results.0.text\"}")
        try check(!cfg.summary.contains("secret"), "Provider status redaction")
        let req = try cfg.request(pcm: Data(repeating: 0, count: 320))
        try check(req.httpBody?.prefix(4) == Data("RIFF".utf8), "STT WAV body")
        try check(STTConfig.path(["results": [["text": "hello"]]], "results.0.text") as? String == "hello", "STT configured JSON path")
        try refuses("insecure STT endpoint") { _ = try STTConfig("{\"providerKind\":\"http\",\"endpointUrl\":\"http://example.invalid\"}") }
        print("PASS: \(passed) assertions (Android/Python wire parity, real firmware, voice loss, framebuffer, crypto, STT)")
    }
}
