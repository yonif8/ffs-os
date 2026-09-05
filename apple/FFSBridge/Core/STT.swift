import Foundation

struct STTConfig {
    let values: [String: Any]
    init(_ json: String) throws {
        if json.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { values = [:]; return }
        guard let d = json.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: d) as? [String: Any] else { throw BridgeError.invalid("Invalid provider configuration") }
        values = object
        guard ["none", "mock", "http"].contains(kind) else { throw BridgeError.invalid("Provider must be none, mock, or http") }
        if kind == "http" { guard URL(string: string("endpointUrl"))?.scheme == "https" else { throw BridgeError.invalid("STT endpoint must use HTTPS") } }
        if !string("streamUrl").isEmpty { guard URL(string: string("streamUrl"))?.scheme == "wss" else { throw BridgeError.invalid("Live STT endpoint must use WSS") } }
        guard ["wav", "raw-pcm"].contains(string("audioEncoding", "wav")), ["body", "multipart"].contains(string("audioCarrier", "body")), ["query", "multipart", "json-body"].contains(string("paramsIn", "query")) else { throw BridgeError.invalid("Unsupported STT request format") }
    }
    var kind: String { string("providerKind", "none") }
    var streaming: Bool { !string("streamUrl").isEmpty }
    func string(_ key: String, _ fallback: String = "") -> String { values[key] as? String ?? fallback }
    func number(_ key: String, _ fallback: Double) -> Double { (values[key] as? NSNumber)?.doubleValue ?? fallback }
    func map(_ key: String) -> [String: String] { values[key] as? [String: String] ?? [:] }
    var summary: String { "Provider: \(kind); live: \(streaming ? "configured" : "off"); credentials hidden" }
    func endpoint(live: Bool) throws -> URL {
        guard var u = URLComponents(string: string(live ? "streamUrl" : "endpointUrl")) else { throw BridgeError.invalid("Invalid STT URL") }
        var query = map(live ? "streamParams" : "queryParams")
        if !live && string("paramsIn", "query") == "query" { query.merge(map("extraParams")) { _, n in n } }
        u.queryItems = (u.queryItems ?? []) + query.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = u.url else { throw BridgeError.invalid("Invalid STT URL") }; return url
    }
    func request(pcm: Data) throws -> URLRequest {
        guard Double(pcm.count) / 32000 <= number("maxClipSeconds", 60) else { throw BridgeError.invalid("clip-too-long") }
        var r = URLRequest(url: try endpoint(live: false)); r.httpMethod = string("method", "POST")
        r.timeoutInterval = max(1, number("readTimeoutMs", 60000) / 1000)
        for (k, v) in map("headers") { r.setValue(v, forHTTPHeaderField: k) }
        let wav = string("audioEncoding", "wav") == "wav"
        let audio = wav ? Wav.encode(pcm) : pcm
        let contentType = string("audioContentType", wav ? "audio/wav" : "application/octet-stream")
        if string("paramsIn", "query") == "json-body" {
            var body: [String: Any] = map("extraParams"); body[string("jsonAudioField", "audio")] = audio.base64EncodedString()
            r.httpBody = try JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if string("audioCarrier", "body") == "multipart" {
            let boundary = "ffs-" + UUID().uuidString
            var body = Data()
            func clean(_ s: String) throws -> String { guard !s.contains("\r"), !s.contains("\n"), !s.contains("\"") else { throw BridgeError.invalid("Invalid multipart field") }; return s }
            if string("paramsIn", "query") == "multipart" {
                for (k, v) in map("extraParams").sorted(by: { $0.key < $1.key }) {
                    body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(try clean(k))\"\r\n\r\n\(v)\r\n".utf8))
                }
            }
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(try clean(string("multipartFieldName", "file")))\"; filename=\"\(try clean(string("multipartFileName", "clip.wav")))\"\r\nContent-Type: \(try clean(contentType))\r\n\r\n".utf8))
            body.append(audio); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            r.httpBody = body; r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        } else { r.httpBody = audio; r.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return r
    }
    static func path(_ root: Any, _ path: String) -> Any? {
        guard !path.isEmpty else { return nil }; var node: Any = root
        for piece in path.split(separator: ".") {
            if let map = node as? [String: Any], let n = map[String(piece)] { node = n }
            else if let array = node as? [Any], let i = Int(piece), array.indices.contains(i) { node = array[i] }
            else { return nil }
        }
        return node
    }
}
enum Wav {
    static func encode(_ pcm: Data) -> Data {
        var d = Data("RIFF".utf8); d.le32(UInt32(pcm.count + 36)); d.append(Data("WAVEfmt ".utf8))
        d.le32(16); d.le16(1); d.le16(1); d.le32(16000); d.le32(32000); d.le16(2); d.le16(16)
        d.append(Data("data".utf8)); d.le32(UInt32(pcm.count)); d.append(pcm); return d
    }
}
