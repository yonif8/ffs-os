import Foundation

@main struct ServiceTests {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ffs-services-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let voice = VoiceService(root: root)
        voice.liveOnGlasses = false
        let session = try voice.start()
        var packet = Data(repeating: 0, count: 205)
        for counter in [254, 255, 0, 2] { packet[204] = UInt8(counter); voice.submit(packet, side: "R") }
        voice.submit(packet, side: "R") // duplicate
        voice.submit(packet, side: "L") // wrong side
        voice.stop()
        let dir = root.appendingPathComponent("voice/sessions/" + session)
        let raw = try Data(contentsOf: dir.appendingPathComponent("master.g2a"))
        let pcm = try Data(contentsOf: dir.appendingPathComponent("master.pcm"))
        precondition(raw.count == 4 * 205, "Raw packet archive includes duplicates or wrong side")
        precondition(pcm.count == 5 * 5 * 160 * 2, "Missing LC3 or gap concealment samples")
        precondition(voice.pendingCount == 1)
        let wav = try Data(contentsOf: voice.export(session))
        precondition(wav.count == pcm.count + 44 && wav.prefix(4) == Data("RIFF".utf8))
        try voice.setConfig("{\"providerKind\":\"mock\"}")
        try await Task.sleep(for: .milliseconds(200))
        precondition(voice.pendingCount == 0)
        let voiceHits = try voice.search("synthetic"); precondition(voiceHits.count == 1)
        // A restart must preserve searchable text and must not enqueue indexed audio again.
        let recovered = VoiceService(root: root)
        precondition(recovered.pendingCount == 0)
        let recoveredHits = try recovered.search("synthetic"); precondition(recoveredHits.count == 1)
        // Simulate an unqueued master tail left by process termination.
        let handle = try FileHandle(forWritingTo: dir.appendingPathComponent("master.pcm"))
        try handle.seekToEnd(); try handle.write(contentsOf: Data(repeating: 0, count: 3200)); try handle.close()
        try recovered.setConfig("")
        let tail = VoiceService(root: root)
        precondition(tail.pendingCount == 1)
        try tail.setConfig("{\"providerKind\":\"mock\"}")
        try await Task.sleep(for: .milliseconds(200))
        let tailHits = try tail.search("synthetic"); precondition(tailHits.count == 2)
        let server = DeveloperServer(root: root)
        server.command = { name, args in ["echo": name, "value": args["value"] ?? ""] }
        try server.start()
        try await Task.sleep(for: .milliseconds(200))
        precondition(server.enabled)
        let id = UUID().uuidString
        let body = try DeveloperCrypto.seal(["id":id,"time":Date().timeIntervalSince1970,"command":"status","args":["value":"test"]],key:server.key)
        func request(_ body: Data) async throws -> Data {
            var request = URLRequest(url: URL(string:"http://127.0.0.1:\(server.port)/rpc")!)
            request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 2
            let cfg = URLSessionConfiguration.ephemeral; cfg.connectionProxyDictionary = [:]
            return try await URLSession(configuration:cfg).data(for:request).0
        }
        let response = try DeveloperCrypto.open(try await request(body),key:server.key)
        precondition(response["id"] as? String == id && response["ok"] as? Bool == true)
        do { _ = try await request(body); fatalError("Replayed request accepted") } catch {}
        var corrupt = body; corrupt[corrupt.count-1] ^= 1
        do { _ = try await request(corrupt); fatalError("Unauthenticated request accepted") } catch {}
        server.stop()
        print("PASS: native LC3 + PLC archive, duplicate/side filtering, WAV, durable STT/index/recovery, encrypted RPC, replay and tamper rejection")
    }
}
