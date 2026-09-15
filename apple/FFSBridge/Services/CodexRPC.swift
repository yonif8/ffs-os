import Foundation

/// WebSocket transport to the existing Codex app-server control socket on KJDev.
/// The process is only an SSH byte pipe; it never launches or hosts Codex locally.
final class CodexSSHPipe {
    private let host: String
    private let socketPath: String
    private var process: Process?
    private var input: FileHandle?
    private let reader = CodexPipeReader()

    init(host: String = "codex-server",
         socketPath: String = "/home/claude-bot/.codex/app-server-control/app-server-control.sock") {
        self.host = host; self.socketPath = socketPath
    }

    func connect() async throws {
        guard process == nil else { return }
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                             host, "nc", "-U", socketPath]
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [reader] handle in
            let data = handle.availableData
            Task { await reader.feed(data) }
        }
        process.terminationHandler = { [reader] _ in Task { await reader.close() } }
        do { try process.run() } catch { throw BridgeError.unavailable("Could not start the KJDev SSH bridge") }
        self.process = process; input = stdin.fileHandleForWriting

        var key = Data(count: 16)
        key.withUnsafeMutableBytes { raw in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            for i in 0..<16 { base[i] = UInt8.random(in: 0...255) }
        }
        let request = "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key.base64EncodedString())\r\nSec-WebSocket-Version: 13\r\n\r\n"
        try write(Data(request.utf8))
        let response = try await reader.read(until: Data("\r\n\r\n".utf8), limit: 8192)
        guard let header = String(data: response, encoding: .utf8),
              header.hasPrefix("HTTP/1.1 101") || header.hasPrefix("HTTP/1.0 101"),
              header.lowercased().contains("upgrade: websocket") else {
            stop(); throw BridgeError.unavailable("KJDev rejected the Codex WebSocket upgrade")
        }
    }

    func send(_ data: Data, opcode: UInt8 = 1) throws {
        guard process?.isRunning == true else { throw BridgeError.unavailable("KJDev transport is disconnected") }
        var frame = Data([0x80 | opcode])
        let count = data.count
        if count < 126 { frame.append(0x80 | UInt8(count)) }
        else if count <= 0xffff {
            frame.append(0x80 | 126); frame.append(UInt8(count >> 8)); frame.append(UInt8(count))
        } else {
            frame.append(0x80 | 127)
            let n = UInt64(count); for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8(n >> UInt64(shift))) }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        for i in 0..<4 { mask[i] = UInt8.random(in: 0...255) }
        frame.append(contentsOf: mask)
        for (i, byte) in data.enumerated() { frame.append(byte ^ mask[i & 3]) }
        try write(frame)
    }

    func receive() async throws -> Data {
        var message = Data(), initialOpcode: UInt8 = 0
        while true {
            let h = try await reader.read(count: 2)
            let final = h[0] & 0x80 != 0, opcode = h[0] & 0x0f, masked = h[1] & 0x80 != 0
            var length = UInt64(h[1] & 0x7f)
            if length == 126 {
                let x = try await reader.read(count: 2); length = UInt64(x[0]) << 8 | UInt64(x[1])
            } else if length == 127 {
                let x = try await reader.read(count: 8); length = x.reduce(0) { ($0 << 8) | UInt64($1) }
            }
            guard length <= 8 * 1024 * 1024 else { throw BridgeError.invalid("Oversize Codex WebSocket frame") }
            let mask = masked ? try await reader.read(count: 4) : Data()
            var payload = try await reader.read(count: Int(length))
            if masked { for i in payload.indices { payload[i] ^= mask[i & 3] } }
            switch opcode {
            case 0: guard initialOpcode != 0 else { throw BridgeError.invalid("Unexpected WebSocket continuation") }
            case 1, 2: guard initialOpcode == 0 else { throw BridgeError.invalid("Nested WebSocket message") }; initialOpcode = opcode
            case 8: throw BridgeError.unavailable("KJDev closed the Codex connection")
            case 9: try send(payload, opcode: 10); continue
            case 10: continue
            default: throw BridgeError.invalid("Unsupported WebSocket opcode")
            }
            message.append(payload)
            if final { return message }
        }
    }

    func stop() {
        try? send(Data(), opcode: 8)
        input?.closeFile(); input = nil
        process?.terminate(); process = nil
        Task { await reader.close() }
    }

    private func write(_ data: Data) throws {
        guard let input else { throw BridgeError.unavailable("KJDev transport is disconnected") }
        do { try input.write(contentsOf: data) }
        catch { throw BridgeError.unavailable("KJDev transport write failed") }
    }
}

private actor CodexPipeReader {
    private var buffer = Data(), closed = false
    private var waiter: CheckedContinuation<Void, Never>?

    func feed(_ data: Data) {
        if data.isEmpty { closed = true } else { buffer.append(data) }
        waiter?.resume(); waiter = nil
    }
    func close() { closed = true; waiter?.resume(); waiter = nil }

    func read(count: Int) async throws -> Data {
        while buffer.count < count {
            if closed { throw BridgeError.unavailable("KJDev SSH stream ended") }
            await withCheckedContinuation { waiter = $0 }
        }
        let data = Data(buffer.prefix(count)); buffer.removeFirst(count); return data
    }

    func read(until marker: Data, limit: Int) async throws -> Data {
        while true {
            if let range = buffer.range(of: marker) {
                let end = range.upperBound, data = Data(buffer.prefix(end)); buffer.removeFirst(end); return data
            }
            if buffer.count > limit { throw BridgeError.invalid("Oversize KJDev transport header") }
            if closed { throw BridgeError.unavailable("KJDev SSH stream ended") }
            await withCheckedContinuation { waiter = $0 }
        }
    }
}

@MainActor
final class CodexRPC {
    typealias JSON = [String: Any]
    private var pipe: CodexSSHPipe?
    private var receiveTask: Task<Void, Never>?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Any, Error>] = [:]
    var notification: ((String, JSON) -> Void)?
    var serverRequest: ((Any, String, JSON) -> Void)?
    var disconnected: ((Error) -> Void)?

    func connect(host: String, socketPath: String) async throws {
        disconnect()
        let pipe = CodexSSHPipe(host: host, socketPath: socketPath)
        try await pipe.connect(); self.pipe = pipe
        receiveTask = Task { [weak self] in await self?.receiveLoop(pipe) }
        _ = try await request("initialize", [
            "clientInfo": ["name": "ffs-glasses", "title": "FFS Glasses", "version": "1.0"],
            "capabilities": ["experimentalApi": true]
        ])
        try notify("initialized", [:])
    }

    func disconnect() {
        receiveTask?.cancel(); receiveTask = nil; pipe?.stop(); pipe = nil
        let error = BridgeError.unavailable("Codex connection closed")
        let values = pending.values; pending.removeAll(); for continuation in values { continuation.resume(throwing: error) }
    }

    func request(_ method: String, _ params: JSON) async throws -> Any {
        guard let pipe else { throw BridgeError.unavailable("Codex is not connected") }
        let id = nextID; nextID += 1
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try pipe.send(data) }
            catch { pending.removeValue(forKey: id); continuation.resume(throwing: error) }
        }
    }

    func notify(_ method: String, _ params: JSON) throws {
        guard let pipe else { throw BridgeError.unavailable("Codex is not connected") }
        try pipe.send(try JSONSerialization.data(withJSONObject: ["method": method, "params": params]))
    }

    func respond(id: Any, result: Any) throws {
        guard let pipe else { throw BridgeError.unavailable("Codex is not connected") }
        try pipe.send(try JSONSerialization.data(withJSONObject: ["id": id, "result": result]))
    }

    private func receiveLoop(_ pipe: CodexSSHPipe) async {
        do {
            while !Task.isCancelled {
                let data = try await pipe.receive()
                let decoded: Any
                do { decoded = try JSONSerialization.jsonObject(with: data) }
                catch {
                    let prefix = data.prefix(4).map { String(format: "%02x", $0) }.joined()
                    throw BridgeError.invalid("Invalid Codex JSON WebSocket message (\(data.count) bytes, prefix \(prefix))")
                }
                guard let object = decoded as? JSON else { continue }
                if let id = object["id"] as? Int, object["method"] == nil {
                    guard let continuation = pending.removeValue(forKey: id) else { continue }
                    if let error = object["error"] as? JSON {
                        continuation.resume(throwing: BridgeError.unavailable(error["message"] as? String ?? "Codex request failed"))
                    } else { continuation.resume(returning: object["result"] ?? NSNull()) }
                    continue
                }
                guard let method = object["method"] as? String else { continue }
                let params = object["params"] as? JSON ?? [:]
                if let id = object["id"] { serverRequest?(id, method, params) }
                else { notification?(method, params) }
            }
        } catch {
            guard !Task.isCancelled else { return }
            let values = pending.values; pending.removeAll()
            for continuation in values { continuation.resume(throwing: error) }
            self.pipe = nil; disconnected?(error)
        }
    }
}
