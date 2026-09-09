import Foundation
import CryptoKit

@main
struct BridgeCLI {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args.first == "--help" || args.isEmpty {
                print("Usage: ffs-iphone <command> [JSON args | @file]\nSet FFS_IPHONE_CONFIG to a private JSON file containing host, port, and base64 key. FFS_IPHONE_TIMEOUT overrides the 12-second request timeout.\nCommands: status, events, connect, disconnect, deviceInfo, setting, push, appData, screenshotReset, screenshot, uploadFirmware, flash, flashProbe, voiceStart, voiceStop, voiceStatus, voiceConfig, voiceConfigStatus, voiceSearch, voiceSessions, voiceExport, voiceClear, buzzerSpeak, buzzerPlay, buzzerStop.")
                return
            }
            let env = ProcessInfo.processInfo.environment
            let path = env["FFS_IPHONE_CONFIG"] ?? NSHomeDirectory() + "/.config/ffs/iphone.json"
            guard let cfg = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any],
                  let host = cfg["host"] as? String, let encoded = cfg["key"] as? String,
                  let key = Data(base64Encoded: encoded), key.count == 32 else { throw BridgeError.invalid("Pair this Mac first; invalid iPhone config") }
            let arguments: [String: Any]
            if args.count > 1 {
                let bytes = args[1].hasPrefix("@") ? try Data(contentsOf: URL(fileURLWithPath: String(args[1].dropFirst()))) : Data(args[1].utf8)
                guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw BridgeError.invalid("Arguments must be a JSON object") }
                arguments = object
            } else { arguments = [:] }
            let id = UUID().uuidString
            let body = try DeveloperCrypto.seal(["id": id, "time": Date().timeIntervalSince1970, "command": args[0], "args": arguments], key: key)
            var components = URLComponents(); components.scheme = "http"; components.host = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host; components.port = cfg["port"] as? Int ?? 8765; components.path = "/rpc"
            guard let url = components.url else { throw BridgeError.invalid("Invalid iPhone host") }
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            // Paired FFSA/FFSC execution can legitimately use most of its 8-second
            // bridge deadline after a multi-packet BLE upload. Keep the client
            // alive long enough to receive that authoritative execution result.
            request.timeoutInterval = min(30, max(1, Double(env["FFS_IPHONE_TIMEOUT"] ?? "12") ?? 12))
            let sessionConfig = URLSessionConfiguration.ephemeral; sessionConfig.connectionProxyDictionary = [:]
            let (data, response) = try await URLSession(configuration: sessionConfig).data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BridgeError.unavailable("iPhone HTTP response failed") }
            let reply = try DeveloperCrypto.open(data, key: key)
            guard reply["id"] as? String == id else { throw BridgeError.invalid("Mismatched response ID") }
            guard reply["ok"] as? Bool == true else { throw BridgeError.unavailable(reply["error"] as? String ?? "Command failed") }
            let out = try JSONSerialization.data(withJSONObject: reply["result"] ?? [:], options: [.sortedKeys])
            FileHandle.standardOutput.write(out); FileHandle.standardOutput.write(Data([10]))
        } catch {
            FileHandle.standardError.write(Data("ffs-iphone: \(error.localizedDescription)\n".utf8)); exit(1)
        }
    }
}
