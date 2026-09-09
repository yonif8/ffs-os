import Foundation
import Network
import CryptoKit
import Combine

// Encrypted, authenticated RPC. The pairing key never travels over the LAN.
// One connection, one bounded request. No shell execution or arbitrary file paths.
@MainActor
final class DeveloperServer: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var status = "Developer connection off"
    let key: Data
    #if os(macOS)
    let port: UInt16 = 8766
    #else
    let port: UInt16 = 8765
    #endif
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ffs.developer.network")
    private var connections: [UUID: NWConnection] = [:]
    private var seen: [String: Date] = [:]
    var command: ((String, [String: Any]) async throws -> [String: Any])?
    init(root: URL) {
        let file = root.appendingPathComponent("developer-pair.json")
        if let bytes = try? Data(contentsOf: file), let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
           let base64 = json["key"] as? String, let existing = Data(base64Encoded: base64), existing.count == 32 { key = existing }
        else {
            key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
            if let data = try? JSONSerialization.data(withJSONObject: ["key": key.base64EncodedString(), "port": Int(port)]) {
                try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
    }
    var pairingKey: String { key.base64EncodedString() }
    func start() throws {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        #if os(macOS)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        #endif
        #if os(macOS)
        let listener = try NWListener(using: parameters)
        #else
        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        #endif
        #if !os(macOS)
        listener.service = NWListener.Service(name: "FFS iPhone", type: "_ffsbridge._tcp")
        #endif
        listener.newConnectionHandler = { [weak self] c in Task { @MainActor in self?.accept(c) } }
        listener.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready: self?.enabled = true; self?.status = "Developer connection ready · port \(self?.port ?? 0)"
                case .failed: self?.status = "Developer connection failed"; self?.stop()
                default: break
                }
            }
        }
        self.listener = listener; listener.start(queue: queue)
    }
    func stop() { listener?.cancel(); listener = nil; for c in connections.values { c.cancel() }; connections.removeAll(); enabled = false; status = "Developer connection off" }
    private func accept(_ c: NWConnection) {
        guard connections.count < 4 else { c.cancel(); return }
        let id = UUID(); connections[id] = c; c.start(queue: queue)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            if let c = self?.connections.removeValue(forKey: id) { c.cancel() }
        }
        receive(c, id: id, buffer: Data())
    }
    private func receive(_ c: NWConnection, id: UUID, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] bytes, _, complete, error in
            Task { @MainActor in
                guard let self, self.connections[id] != nil else { return }
                var buffer = buffer; if let bytes { buffer.append(bytes) }
                guard buffer.count <= 48 * 1024 * 1024 else { self.close(id); return }
                if let separator = buffer.range(of: Data("\r\n\r\n".utf8)) {
                    guard separator.lowerBound <= 8192, let header = String(data: buffer.prefix(separator.lowerBound), encoding: .utf8) else { self.close(id); return }
                    let lines = header.components(separatedBy: "\r\n")
                    guard lines.first == "POST /rpc HTTP/1.1" else { self.close(id); return }
                    let lengths = lines.dropFirst().filter { $0.lowercased().hasPrefix("content-length:") }
                    guard lengths.count == 1, let length = Int(lengths[0].dropFirst(15).trimmingCharacters(in: .whitespaces)), length > 28, length <= 47 * 1024 * 1024,
                          !lines.contains(where: { $0.lowercased().hasPrefix("transfer-encoding:") }) else { self.close(id); return }
                    let start = separator.upperBound
                    if buffer.count >= start + length {
                        guard buffer.count == start + length else { self.close(id); return }
                        await self.handle(c, id: id, body: buffer.subdata(in: start..<start + length)); return
                    }
                } else if buffer.count > 8192 { self.close(id); return }
                if complete || error != nil { self.close(id) }
                else { self.receive(c, id: id, buffer: buffer) }
            }
        }
    }
    private func handle(_ c: NWConnection, id: UUID, body: Data) async {
        let envelope: [String: Any]
        do { envelope = try DeveloperCrypto.open(body, key: key) }
        catch { close(id); return }
        guard let requestID = envelope["id"] as? String, UUID(uuidString: requestID) != nil,
              let time = envelope["time"] as? Double, abs(Date().timeIntervalSince1970 - time) < 120,
              let name = envelope["command"] as? String else { close(id); return }
        seen = seen.filter { Date().timeIntervalSince($0.value) < 240 }
        guard seen[requestID] == nil, seen.count < 10000 else { close(id); return }
        seen[requestID] = Date()
        let response: [String: Any]
        do {
            guard let command else { throw BridgeError.unavailable("Bridge starting") }
            let result = try await command(name, envelope["args"] as? [String: Any] ?? [:])
            response = ["id": requestID, "ok": true, "result": result]
        } catch { response = ["id": requestID, "ok": false, "error": error.localizedDescription] }
        guard let encrypted = try? DeveloperCrypto.seal(response, key: key) else { close(id); return }
        var output = Data("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: \(encrypted.count)\r\nConnection: close\r\n\r\n".utf8)
        output.append(encrypted)
        c.send(content: output, completion: .contentProcessed { [weak self] _ in Task { @MainActor in self?.close(id) } })
    }
    private func close(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }
}
