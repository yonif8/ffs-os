import Foundation
import AVFoundation
import Combine

@MainActor
final class BuzzerAudio: ObservableObject {
    @Published private(set) var state = "idle"
    @Published private(set) var detail = ""
    @Published private(set) var streamID = 0
    private var generation = UUID()
    private var synthesizer = AVSpeechSynthesizer()
    private var encoder = PdmEncoder()
    private var task: Task<Void, Never>?
    private var replies: [BuzzerWire.Ack] = []
    private let link: GlassesLink
    var event: ((String, [String: Any]) -> Void)?
    init(link: GlassesLink) { self.link = link }
    private func report(_ state: String, _ detail: String = "") {
        self.state = state; self.detail = detail
        event?("buzzer", ["state": state, "message": detail, "streamId": streamID])
    }
    func receive(_ d: Data) { if let ack = BuzzerWire.ack(d), ack.right, ack.stream == streamID { replies.append(ack); if replies.count > 64 { replies.removeFirst() } } }
    func stop() {
        let old = streamID
        generation = UUID(); task?.cancel(); synthesizer.stopSpeaking(at: .immediate); replies.removeAll(); streamID = 0
        report("stopped")
        if old != 0 { Task { try? await link.send(BuzzerWire.frame(op: 4, stream: old), sid: 0x92, side: "R") } }
    }
    @discardableResult func speak(_ text: String) throws -> String {
        guard !text.isEmpty, text.utf8.count <= 20000 else { throw BridgeError.invalid("Enter 1–20,000 bytes of text") }
        guard link.lenses["R"]?.ready == true, !link.flashOwned else { throw BridgeError.unavailable("Right lens must be ready") }
        stop(); generation = UUID(); let gen = generation; encoder = PdmEncoder(); report("synthesizing")
        let utterance = AVSpeechUtterance(string: text)
        synthesizer.write(utterance) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            Task { @MainActor in
                guard let self, self.generation == gen else { return }
                if pcm.frameLength == 0 {
                    self.encoder.finish(); let bytes = self.encoder.data
                    guard !bytes.isEmpty else { self.report("error", "Speech synthesis produced no audio"); return }
                    self.stream(bytes, generation: gen)
                } else {
                    guard self.encoder.data.count < 4 * 1024 * 1024 else { self.stop(); self.report("error", "Speech exceeds buffer limit"); return }
                    self.encoder.consume(Self.mono(pcm), rate: Int(pcm.format.sampleRate))
                }
            }
        }
        return gen.uuidString
    }
    @discardableResult func play(_ url: URL) throws -> String {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { throw BridgeError.invalid("Audio URL must use HTTP(S)") }
        guard link.lenses["R"]?.ready == true, !link.flashOwned else { throw BridgeError.unavailable("Right lens must be ready") }
        stop(); generation = UUID(); let gen = generation; report("fetching")
        task = Task {
            do {
                let (file, response) = try await URLSession.shared.download(from: url)
                defer { try? FileManager.default.removeItem(at: file) }
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                      (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 32 * 1024 * 1024 else { throw BridgeError.invalid("Audio download failed or exceeds 32 MB") }
                guard generation == gen else { return }; report("converting")
                let data = try await Task.detached(priority: .userInitiated) {
                    let audio = try AVAudioFile(forReading: file, commonFormat: .pcmFormatFloat32, interleaved: false)
                    guard audio.durationSeconds <= 600, audio.processingFormat.sampleRate >= 4000, audio.processingFormat.sampleRate <= 192000 else { throw BridgeError.invalid("Audio must be at most 10 minutes") }
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: 4096) else { throw BridgeError.unavailable("Audio buffer allocation failed") }
                    var pdm = PdmEncoder()
                    while audio.framePosition < audio.length {
                        try Task.checkCancellation(); try audio.read(into: buffer)
                        pdm.consume(Self.mono(buffer), rate: Int(audio.processingFormat.sampleRate))
                    }
                    pdm.finish(); return pdm.data
                }.value
                guard generation == gen else { return }; stream(data, generation: gen)
            } catch { if generation == gen { report("error", "Audio conversion or download failed") } }
        }
        return gen.uuidString
    }
    nonisolated private static func mono(_ b: AVAudioPCMBuffer) -> [Int16] {
        let channels = Int(b.format.channelCount), count = Int(b.frameLength)
        guard channels > 0 else { return [] }
        return (0..<count).map { i in
            var total: Double = 0
            for c in 0..<channels {
                if let f = b.floatChannelData { total += Double(f[c][i]) * 32767 }
                else if let s = b.int16ChannelData { total += Double(s[c][i]) }
            }
            let v = total / Double(channels)
            return Int16(min(32767, max(-32768, v.isFinite ? v : 0)))
        }
    }
    private func stream(_ data: Data, generation gen: UUID) {
        streamID = Int.random(in: 1...65535); let id = streamID
        report("starting"); replies.removeAll()
        task = Task {
            do {
                _ = try await exchange(BuzzerWire.frame(op: 1, stream: id), id: id, expected: 0, op: 1, gen: gen)
                var seq = 0
                while seq * 1024 < data.count {
                    try Task.checkCancellation()
                    let payload = data.subdata(in: seq * 1024..<min(data.count, (seq + 1) * 1024))
                    let ack = try await exchange(BuzzerWire.frame(op: 2, stream: id, seq: seq, payload: payload), id: id, expected: seq + 1, op: 2, gen: gen)
                    if ack.code == 2 {
                        guard ack.next * 1024 <= data.count else { throw BridgeError.invalid("Invalid receiver rewind") }
                        seq = ack.next
                    } else { seq += 1 }
                    report("streaming", "\(min(seq * 1024, data.count))/\(data.count) bytes")
                }
                _ = try await exchange(BuzzerWire.frame(op: 3, stream: id, seq: seq), id: id, expected: seq, op: 3, gen: gen)
                report("sent", "All audio acknowledged")
            } catch {
                if self.generation == gen {
                    try? await link.send(BuzzerWire.frame(op: 4, stream: id), sid: 0x92, side: "R")
                    report("error", error.localizedDescription)
                }
            }
        }
    }
    private func exchange(_ frame: Data, id: Int, expected: Int, op: Int, gen: UUID) async throws -> BuzzerWire.Ack {
        let overall = Date().addingTimeInterval(20)
        for attempt in 0..<11 {
            try Task.checkCancellation()
            guard generation == gen else { throw CancellationError() }
            try await link.send(frame, sid: 0x92, side: "R")
            let deadline = Date().addingTimeInterval(0.7)
            var busy = false
            while Date() < deadline {
                while !replies.isEmpty {
                    let a = replies.removeFirst()
                    guard a.stream == id else { continue }
                    if a.code == 4 { throw BridgeError.invalid("Glasses rejected audio frame") }
                    if a.code == 3 { busy = true; break }
                    if a.code == 2 && op == 2 { return a }
                    if [0, 1].contains(a.code) && a.next == expected { return a }
                }
                if busy { break }
                try Task.checkCancellation(); try await Task.sleep(for: .milliseconds(10))
            }
            if busy { try await Task.sleep(for: .milliseconds(100)) }
            guard Date() < overall else { break }
            report("retry", "Audio acknowledgement retry \(attempt + 1)")
        }
        throw BridgeError.timeout("Audio acknowledgement timeout")
    }
}
private extension AVAudioFile { var durationSeconds: Double { Double(length) / processingFormat.sampleRate } }
