import Foundation

struct Framebuffer {
    static let width = 576, height = 288, size = width * height / 2
    private(set) var bytes = Data(repeating: 0, count: size)
    private var seen = [Bool](repeating: false, count: size)
    private(set) var received = 0
    private(set) var generation = 0
    private(set) var updated: Date?
    var complete: Bool { received == Self.size }
    mutating func reset() { bytes = Data(repeating: 0, count: Self.size); seen = [Bool](repeating: false, count: Self.size); received = 0; updated = nil; generation += 1 }
    mutating func feed(_ d: Data) -> Bool {
        guard d.count >= 10, d.prefix(4) == Data("FBSH".utf8), d[6] == 2 else { return false }
        let offset = Int(d[7]) | Int(d[8]) << 8 | Int(d[9]) << 16
        guard offset + d.count - 10 <= Self.size else { return false }
        if offset == 0 && (complete || (updated.map { Date().timeIntervalSince($0) > 1 } ?? false)) { reset() }
        for i in 10..<d.count {
            let j = offset + i - 10
            if !seen[j] { received += 1; seen[j] = true }
            bytes[j] = d[i]
        }
        updated = Date(); return true
    }
}

struct VoiceFramer {
    private var head: Int?
    private(set) var received = 0, duplicates = 0, malformed = 0, concealed = 0, resyncs = 0, lost = 0
    // nil drops duplicates/malformed packets; otherwise PLC frame count before five real frames.
    mutating func offer(_ d: Data) -> Int? {
        guard d.count == 205 else { malformed += 1; return nil }
        received += 1
        let n = Int(d[204])
        guard let h = head else { head = n; return 0 }
        let delta = ((n - h + 384) & 255) - 128
        if (-8...0).contains(delta) { duplicates += 1; return nil }
        head = n
        if delta == 1 { return 0 }
        if (2...8).contains(delta) { lost += delta - 1; concealed += (delta - 1) * 5; return (delta - 1) * 5 }
        lost += max(0, delta - 1); resyncs += 1; return 0
    }
}
