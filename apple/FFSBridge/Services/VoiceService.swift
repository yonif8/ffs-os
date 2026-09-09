import Foundation
import Combine
import SQLite3

@MainActor
final class VoiceService: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var sessionID = ""
    @Published private(set) var packetCount = 0
    @Published private(set) var pendingCount = 0
    @Published private(set) var statusMessage = "Ready to capture"
    @Published var captureSide = "R"
    @Published var liveOnGlasses = true
    private(set) var config = try! STTConfig("")
    private let root: URL
    private var decoder: UnsafeMutableRawPointer?
    private var framer = VoiceFramer()
    private var master: FileHandle?, pcmFile: FileHandle?
    private var pcm = Data(), startTime = Date(), clipStartMs = 0
    private var lastArrival: Date?
    private var database: OpaquePointer?
    private var queueGeneration = UUID(), liveGeneration = UUID()
    private var queueTask: Task<Void, Never>?, liveTask: Task<Void, Never>?, faceTask: Task<Void, Never>?, idleTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var liveBytes = Data(), settled = "", tail = "", lastFace = ""
    private var faceSeq = 0
    var send: ((Data) async throws -> Void)?
    var event: ((String, [String: Any]) -> Void)?
    init(root: URL) {
        self.root = root.appendingPathComponent("voice", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: self.root.appendingPathComponent("sessions"), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: self.root.appendingPathComponent("pending"), withIntermediateDirectories: true)
            let cfg = self.root.appendingPathComponent("stt-config.json")
            if let text = try? String(contentsOf: cfg, encoding: .utf8) { config = try STTConfig(text) }
            guard sqlite3_open(self.root.appendingPathComponent("transcripts.sqlite").path, &database) == SQLITE_OK else { throw BridgeError.unavailable("Transcript database unavailable") }
            try sql("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, session TEXT, startMs INTEGER, endMs INTEGER, text TEXT, provider TEXT); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, text);")
            recoverSessions(); refreshPending(); drain()
        } catch { statusMessage = "Voice storage unavailable" }
    }
    private func log(_ message: String) { event?("voice", ["message": message, "packets": packetCount, "pending": pendingCount]) }
    func setConfig(_ json: String) throws {
        let next = try STTConfig(json)
        let file = root.appendingPathComponent("stt-config.json")
        try Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        config = next; queueGeneration = UUID(); queueTask?.cancel(); queueTask = nil
        liveGeneration = UUID(); socket?.cancel(with: .goingAway, reason: nil); socket = nil; liveTask?.cancel(); liveBytes.removeAll()
        drain(); if running { startLive() }; log("Provider configuration updated")
    }
    func start() throws -> String {
        if running { return sessionID }
        guard ["L", "R", "both"].contains(captureSide) else { throw BridgeError.invalid("Capture side must be L, R, or both") }
        guard database != nil else { throw BridgeError.unavailable("Voice storage unavailable") }
        decoder = ffs_lc3_create(); guard decoder != nil else { throw BridgeError.unavailable("LC3 decoder unavailable") }
        sessionID = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
        let dir = sessionDirectory(sessionID)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let rawURL = dir.appendingPathComponent("master.g2a"), pcmURL = dir.appendingPathComponent("master.pcm")
        FileManager.default.createFile(atPath: rawURL.path, contents: nil); FileManager.default.createFile(atPath: pcmURL.path, contents: nil)
        master = try FileHandle(forWritingTo: rawURL); pcmFile = try FileHandle(forWritingTo: pcmURL)
        packetCount = 0; framer = VoiceFramer(); pcm = Data(); clipStartMs = 0; startTime = Date(); lastArrival = nil
        running = true; statusMessage = "Capturing · waiting for glasses audio"; settled = ""; tail = ""; lastFace = ""
        try metadata(ended: false); startLive(); startFaceLoop()
        idleTask?.cancel(); idleTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self, self.running else { return }
                if let last = self.lastArrival, Date().timeIntervalSince(last) > 1, !self.pcm.isEmpty { try? self.finishClip() }
            }
        }
        log("Capture started"); return sessionID
    }
    func stop() {
        guard running else { return }
        running = false; idleTask?.cancel()
        do { try finishClip(); try metadata(ended: true); try master?.synchronize(); try pcmFile?.synchronize(); try master?.close(); try pcmFile?.close() }
        catch { log("Archive finalization failed") }
        master = nil; pcmFile = nil; ffs_lc3_destroy(decoder); decoder = nil
        liveTask?.cancel()
        if let socket {
            let close = config.string("streamCloseMessage", "{\"type\":\"CloseStream\"}")
            Task { if !close.isEmpty { try? await socket.send(.string(close)) }; socket.cancel(with: .normalClosure, reason: nil) }
        }
        socket = nil; faceTask?.cancel(); Task { await flushFace() }; statusMessage = "Capture stopped"; log("Capture stopped")
    }
    func submit(_ data: Data, side: String) {
        guard running, captureSide == "both" || captureSide == side else { return }
        guard let conceal = framer.offer(data) else { return }
        do {
            // Archive the original accepted packet BEFORE decoding. All bytes stay native/private.
            try master?.write(contentsOf: data); packetCount += 1; lastArrival = Date()
            var decoded = Data()
            func decode(_ frame: Data?) throws {
                var samples = [Int16](repeating: 0, count: 160)
                let rc = samples.withUnsafeMutableBufferPointer { samples in
                    frame?.withUnsafeBytes { raw in ffs_lc3_frame(decoder, raw.bindMemory(to: UInt8.self).baseAddress, samples.baseAddress) } ?? ffs_lc3_frame(decoder, nil, samples.baseAddress)
                }
                guard rc >= 0 else { throw BridgeError.invalid("LC3 decode failed") }
                for s in samples { decoded.le16(Int(s)) }
            }
            for _ in 0..<conceal { try decode(nil) }
            for i in 0..<5 { try decode(data.subdata(in: i * 40..<(i + 1) * 40)) }
            try pcmFile?.write(contentsOf: decoded); pcm.append(decoded); feedLive(decoded)
            if pcm.count >= 32000 * 15 { try finishClip() }
            if packetCount % 20 == 0 { try master?.synchronize(); try pcmFile?.synchronize(); try metadata(ended: false) }
            statusMessage = "Capturing · \(packetCount) packets"
        } catch { statusMessage = "Voice processing error; raw packets preserved"; log("Voice processing failed") }
    }
    private func sessionDirectory(_ id: String) -> URL { root.appendingPathComponent("sessions").appendingPathComponent(id) }
    private func metadata(ended: Bool) throws {
        let meta: [String: Any] = ["id": sessionID, "startedAt": startTime.timeIntervalSince1970 * 1000,
            "endedAt": ended ? Date().timeIntervalSince1970 * 1000 : NSNull(), "packets": packetCount,
            "durationMs": clipStartMs + pcm.count / 32, "sampleRate": 16000, "packetBytes": 205,
            "lostPackets": framer.lost, "concealedFrames": framer.concealed, "resyncs": framer.resyncs]
        try JSONSerialization.data(withJSONObject: meta).write(to: sessionDirectory(sessionID).appendingPathComponent("meta.json"), options: .atomic)
    }
    private func finishClip() throws {
        guard !pcm.isEmpty else { return }
        let id = "\(sessionID)_\(clipStartMs)", end = clipStartMs + pcm.count / 32
        let pending = root.appendingPathComponent("pending")
        try pcm.write(to: pending.appendingPathComponent(id + ".pcm"), options: .atomic)
        let item: [String: Any] = ["id": id, "session": sessionID, "startMs": clipStartMs, "endMs": end]
        try JSONSerialization.data(withJSONObject: item).write(to: pending.appendingPathComponent(id + ".json"), options: .atomic)
        clipStartMs = end; pcm.removeAll(keepingCapacity: true); refreshPending(); drain()
    }
    private func refreshPending() { pendingCount = ((try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("pending"), includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "json" }.count }
    private func recoverSessions() {
        // Rebuild any unqueued tail from the durable PCM master after an app termination.
        for session in sessions(limit: 100000) {
            guard let id = session["id"] as? String else { continue }
            let dir = sessionDirectory(id), pcmURL = dir.appendingPathComponent("master.pcm")
            guard let total = (try? pcmURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, total > 0 else { continue }
            let pending = root.appendingPathComponent("pending")
            var end = 0
            if let row = try? queryRows("SELECT MAX(endMs) FROM segments WHERE session=?", values: [id]).first { end = Int(row.first ?? "0") ?? 0 }
            for f in ((try? FileManager.default.contentsOfDirectory(at: pending, includingPropertiesForKeys: nil)) ?? []) where f.pathExtension == "json" {
                if let d = try? Data(contentsOf: f), let m = try? JSONSerialization.jsonObject(with: d) as? [String: Any], m["session"] as? String == id { end = max(end, m["endMs"] as? Int ?? 0) }
            }
            guard end * 32 < total, let handle = try? FileHandle(forReadingFrom: pcmURL) else { continue }
            defer { try? handle.close() }
            try? handle.seek(toOffset: UInt64(end * 32))
            while end * 32 < total {
                guard let data = try? handle.read(upToCount: 32000 * 15), !data.isEmpty else { break }
                let aligned = Data(data.prefix(data.count - data.count % 2)), next = end + aligned.count / 32
                let itemID = "\(id)_\(end)", item: [String: Any] = ["id": itemID, "session": id, "startMs": end, "endMs": next]
                do {
                    try aligned.write(to: pending.appendingPathComponent(itemID + ".pcm"), options: .atomic)
                    try JSONSerialization.data(withJSONObject: item).write(to: pending.appendingPathComponent(itemID + ".json"), options: .atomic)
                } catch { break }
                guard next > end else { break }; end = next
            }
        }
    }
    private func drain() {
        guard queueTask == nil, config.kind != "none", database != nil else { return }
        let generation = queueGeneration
        queueTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.queueGeneration == generation { self.queueTask = nil } }
            var backoff = max(0.1, config.number("retryBackoffMs", 2000) / 1000)
            while !Task.isCancelled {
                let folder = root.appendingPathComponent("pending")
                let files = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
                guard !files.isEmpty, config.kind != "none" else { return }
                var failed = false
                for file in files {
                    do {
                        try Task.checkCancellation()
                        guard let item = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                              let id = item["id"] as? String, let session = item["session"] as? String,
                              let start = item["startMs"] as? Int, let end = item["endMs"] as? Int else { throw BridgeError.invalid("Invalid pending clip") }
                        let pcm = try Data(contentsOf: file.deletingPathExtension().appendingPathExtension("pcm")), cfg = config
                        let text: String
                        if cfg.kind == "mock" { text = "[mock] synthetic transcript for \(end - start) milliseconds" }
                        else {
                            let request = try cfg.request(pcm: pcm)
                            let (data, response) = try await URLSession.shared.data(for: request)
                            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count <= 4 * 1024 * 1024 else { throw BridgeError.unavailable("Provider request failed") }
                            let root = try JSONSerialization.jsonObject(with: data)
                            if let error = STTConfig.path(root, cfg.string("errorPath")), !(error is NSNull), String(describing: error) != "" { throw BridgeError.unavailable("Provider reported failure") }
                            guard let words = STTConfig.path(root, cfg.string("textPath", "text")) as? String else { throw BridgeError.invalid("Provider transcript path missing") }
                            text = words
                        }
                        try Task.checkCancellation()
                        guard generation == queueGeneration else { return }
                        try sql("BEGIN IMMEDIATE")
                        do {
                            try execute("INSERT OR REPLACE INTO segments VALUES(?,?,?,?,?,?)", [id, session, String(start), String(end), text, cfg.kind == "mock" ? "mock" : cfg.string("displayName", "http")])
                            try execute("DELETE FROM search WHERE id=?", [id]); try execute("INSERT INTO search(id,text) VALUES(?,?)", [id, text]); try sql("COMMIT")
                        } catch { try? sql("ROLLBACK"); throw error }
                        // Master PCM/raw and indexed text remain permanently. Only completed work items leave the queue.
                        try FileManager.default.removeItem(at: file)
                        if !cfg.streaming && liveOnGlasses && session == sessionID { settle(text) }
                        refreshPending(); log("Transcript indexed"); backoff = max(0.1, config.number("retryBackoffMs", 2000) / 1000)
                    } catch is CancellationError { return }
                    catch { failed = true; log("STT clip remains pending") }
                }
                if !failed { continue }
                try? await Task.sleep(for: .seconds(backoff)); backoff = min(max(backoff, config.number("retryMaxBackoffMs", 300000) / 1000), backoff * 2)
            }
        }
    }
    func sessions(limit: Int = 100) -> [[String: Any]] {
        let folder = root.appendingPathComponent("sessions")
        return ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).sorted { $0.lastPathComponent > $1.lastPathComponent }.prefix(max(0, limit)).compactMap {
            guard let data = try? Data(contentsOf: $0.appendingPathComponent("meta.json")) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }
    func search(_ query: String, limit: Int = 30) throws -> [[String: Any]] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let terms = query.split(whereSeparator: \.isWhitespace).map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: " AND ")
        let rows = try queryRows("SELECT s.session,s.startMs,s.endMs,s.text,s.provider,snippet(search,1,'[',']','…',20) FROM search JOIN segments s ON s.id=search.id WHERE search MATCH ? ORDER BY rank LIMIT ?", values: [terms, String(max(1, min(100, limit)))])
        return rows.map { ["sessionId": $0[0], "startMs": Int($0[1]) ?? 0, "endMs": Int($0[2]) ?? 0, "text": $0[3], "provider": $0[4], "snippet": $0[5]] }
    }
    func export(_ id: String) throws -> URL {
        guard sessions(limit: 100000).contains(where: { $0["id"] as? String == id }) else { throw BridgeError.invalid("Unknown recording") }
        let dir = sessionDirectory(id), file = dir.appendingPathComponent("recording.wav")
        try pcmFile?.synchronize()
        let pcm = try Data(contentsOf: dir.appendingPathComponent("master.pcm"))
        try Wav.encode(pcm).write(to: file, options: .atomic); return file
    }
    func status() -> [String: Any] {
        ["running": running, "sessionId": sessionID, "packets": packetCount, "duplicates": framer.duplicates,
         "malformed": framer.malformed, "concealedFrames": framer.concealed, "resyncs": framer.resyncs,
         "lostPackets": framer.lost, "sttPending": pendingCount, "sttProvider": config.kind, "decoderAvailable": decoder != nil || !running]
    }
    func clearFace() async throws { settled = ""; tail = ""; lastFace = ""; faceSeq += 1; try await send?(Wire.appData(id: 14, seq: faceSeq, blob: Data(), clear: true)) }
    private func settle(_ text: String) { settled = String((settled + " " + text).suffix(880)); tail = "" }
    private func startFaceLoop() {
        faceTask?.cancel(); faceTask = Task { [weak self] in
            while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(300)); await self?.flushFace() }
        }
    }
    private func flushFace() async {
        guard liveOnGlasses else { return }
        var face = String((settled + " " + tail).suffix(880)).trimmingCharacters(in: .whitespacesAndNewlines)
        while face.utf8.count > 1024 { face.removeFirst() }
        guard !face.isEmpty, face != lastFace else { return }
        faceSeq += 1
        do { try await send?(Wire.appData(id: 14, seq: faceSeq, blob: Data(face.utf8))); lastFace = face }
        catch { log("Live text delivery pending") }
    }
    private func feedLive(_ pcm: Data) {
        guard config.streaming else { return }; liveBytes.append(pcm)
        let chunk = max(640, min(32000, Int(config.number("streamChunkMs", 100)) * 32))
        if liveBytes.count > 64000 { liveBytes = Data(liveBytes.suffix(64000)) }
        guard let socket, socket.state == .running else { return }
        while liveBytes.count >= chunk {
            let bytes = Data(liveBytes.prefix(chunk)); liveBytes.removeFirst(chunk)
            socket.send(.data(bytes)) { _ in } // Disposable path only; durable PCM is already on disk.
        }
    }
    private func startLive() {
        guard config.streaming else { return }
        liveGeneration = UUID(); let generation = liveGeneration
        liveTask?.cancel(); liveTask = Task { [weak self] in
            guard let self else { return }
            var backoff = max(0.1, config.number("streamReconnectMs", 1000) / 1000)
            while running && !Task.isCancelled {
                do {
                    var request = URLRequest(url: try config.endpoint(live: true))
                    for (k, v) in config.map("headers") { request.setValue(v, forHTTPHeaderField: k) }
                    let ws = URLSession.shared.webSocketTask(with: request); socket = ws; ws.resume()
                    while running && !Task.isCancelled {
                        let message = try await ws.receive()
                        try Task.checkCancellation()
                        guard generation == liveGeneration else { return }
                        let data: Data
                        switch message { case .data(let d): data = d; case .string(let s): data = Data(s.utf8); @unknown default: continue }
                        guard data.count <= 1024 * 1024, let object = try? JSONSerialization.jsonObject(with: data),
                              let text = STTConfig.path(object, config.string("streamTextPath", "channel.alternatives.0.transcript")) as? String else { continue }
                        let final = (STTConfig.path(object, config.string("streamFinalPath", "is_final")) as? Bool) == true
                        if final { settle(text) } else { tail = text }
                        backoff = max(0.1, config.number("streamReconnectMs", 1000) / 1000)
                    }
                } catch { if !Task.isCancelled && running { log("Live STT disconnected; durable archive unaffected") } }
                guard generation == liveGeneration else { return }
                socket?.cancel(with: .goingAway, reason: nil); socket = nil
                if !running || Task.isCancelled { break }
                try? await Task.sleep(for: .seconds(backoff)); backoff = min(config.number("streamReconnectMaxMs", 30000) / 1000, backoff * 2)
            }
        }
    }
    private func sql(_ sql: String) throws { guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw BridgeError.unavailable("Voice database operation failed") } }
    private func statement(_ text: String, _ values: [String]) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, text, -1, &statement, nil) == SQLITE_OK, let statement else { throw BridgeError.unavailable("Voice query unavailable") }
        for (i, value) in values.enumerated() { _ = value.withCString { sqlite3_bind_text(statement, Int32(i + 1), $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) } }
        return statement
    }
    private func execute(_ text: String, _ values: [String]) throws {
        let stmt = try statement(text, values); defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw BridgeError.unavailable("Voice index write failed") }
    }
    private func queryRows(_ text: String, values: [String]) throws -> [[String]] {
        let stmt = try statement(text, values); defer { sqlite3_finalize(stmt) }; var out: [[String]] = []
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return out }
            guard status == SQLITE_ROW else { throw BridgeError.unavailable("Voice search failed") }
            out.append((0..<sqlite3_column_count(stmt)).map { col in sqlite3_column_text(stmt, col).map { String(cString: $0) } ?? "" })
        }
    }
}
