import Foundation

enum BuzzerWire {
    struct Ack {
        let code: Int, stream: Int, next: Int, queued: Int, underruns: Int, completed: Int, refused: Int
        let right: Bool
    }
    static func frame(op: Int, stream: Int, seq: Int = 0, payload: Data = Data()) -> Data {
        var d = Data("FBSQ".utf8); d.append(contentsOf: [2, UInt8(op), 5, 0])
        d.le16(stream); d.le16(seq); d.le16(payload.count); d.le16(op == 1 ? 2 : payload.count / 8)
        d.le32(Wire.crc32(payload)); d.le32(32768); d.append(payload); return d
    }
    static func ack(_ d: Data) -> Ack? {
        guard d.count == 24, d[0] == 1, d[1] == 0, d[2] == 6, d.u16(6) == 16, d[8] == 2 else { return nil }
        return Ack(code: Int(d[9]), stream: d.u16(10), next: d.u16(12), queued: Int(d[14]), underruns: d.u16(18), completed: d.u16(20), refused: d.u16(22), right: d[3] & 1 != 0)
    }
}

// Same integer speech conditioning and LSB-first sigma-delta packing as Android BuzzerPdmEncoder.
struct PdmEncoder {
    private var low: Int64 = 0, dc: Int64 = 0, envelope: Int64 = 2048, error: Int64 = 0, phase: Int64 = 0
    private var packed: UInt8 = 0, bits = 0, outputBits = 0
    private(set) var data = Data()
    mutating func consume(_ samples: [Int16], rate: Int) {
        for value in samples {
            low += (Int64(value) - low) / 4; dc += (low - dc) / 256
            var speech = low - dc
            envelope = max(abs(speech), envelope - max(1, envelope / 4096))
            let gain = min(8192, max(512, 18_000 * 1024 / max(2048, envelope)))
            speech = min(30_000, max(-30_000, speech * gain / 1024))
            phase += 32768
            while phase >= rate { emit(speech); phase -= Int64(rate) }
        }
    }
    mutating func finish() { while outputBits % 64 != 0 { emit(0) } }
    private mutating func emit(_ sample: Int64) {
        error += sample
        if error >= 0 { packed |= 1 << bits; error -= 32767 } else { error += 32768 }
        bits += 1; outputBits += 1
        if bits == 8 { data.append(packed); packed = 0; bits = 0 }
    }
}
