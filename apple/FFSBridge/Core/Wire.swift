// Current Android G2Protocol / FfscFrame wire contracts. No EvenHub page builders.
import Foundation

enum BridgeError: Error, LocalizedError {
    case invalid(String), unavailable(String), timeout(String)
    var errorDescription: String? {
        switch self { case .invalid(let s), .unavailable(let s), .timeout(let s): return s }
    }
}

extension Data {
    func u16(_ o: Int) -> Int { Int(self[o]) | Int(self[o + 1]) << 8 }
    func u32(_ o: Int) -> UInt32 {
        UInt32(self[o]) | UInt32(self[o + 1]) << 8 | UInt32(self[o + 2]) << 16 | UInt32(self[o + 3]) << 24
    }
    mutating func le16(_ n: Int) { append(UInt8(truncatingIfNeeded: n)); append(UInt8(truncatingIfNeeded: n >> 8)) }
    mutating func le32(_ n: UInt32) { for i in 0..<4 { append(UInt8(truncatingIfNeeded: n >> (8 * i))) } }
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

enum Wire {
    static func crc16(_ data: Data) -> UInt16 {
        var c: UInt16 = 0xffff
        for b in data {
            c = ((c >> 8) | (c << 8)) ^ UInt16(b)
            c ^= (c & 0xff) >> 4; c ^= c << 12; c ^= (c & 0xff) << 5
        }
        return c
    }
    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xffffffff
        for b in data { c ^= UInt32(b); for _ in 0..<8 { c = (c >> 1) ^ ((c & 1) == 1 ? 0xedb88320 : 0) } }
        return ~c
    }
    static func packets(_ data: Data, sid: UInt8, seq: UInt8, reserve: Bool = false) throws -> [Data] {
        // Android's exact 236-byte framing, including the separate CRC packet at the boundary.
        let count = data.count / 236 + 1
        guard count <= 255 else { throw BridgeError.invalid("Service payload exceeds transport capacity") }
        let crc = crc16(data)
        return (0..<count).map { i in
            let start = i * 236, end = min(start + 236, data.count), last = i == count - 1
            var p = Data([0xaa, 0x21, seq, UInt8(end - start + (last ? 2 : 0)), UInt8(count), UInt8(i + 1), sid, reserve ? 0x20 : 0])
            p.append(data.subdata(in: start..<end))
            if last { p.le16(Int(crc)) }
            return p
        }
    }
    static func fxp1(_ body: Data) -> Data {
        var out = Data("FXP1".utf8); out.le32(UInt32(body.count)); out.le32(crc32(body)); out.append(body); return out
    }
    static func appData(id: Int, seq: Int, blob: Data, clear: Bool = false) throws -> Data {
        guard (1...65534).contains(id), blob.count <= 1024, clear || !blob.isEmpty else { throw BridgeError.invalid("Invalid FFSC data") }
        let body = clear ? Data() : blob
        var d = Data("FFSC".utf8); d.append(contentsOf: [1, clear ? 1 : 0]); d.le16(id); d.le16(seq)
        d.le16(body.count); d.le32(crc32(body)); d.append(body); return fxp1(d)
    }
}

struct Proto {
    enum Value { case integer(UInt64), bytes(Data) }
    private(set) var data = Data()
    mutating func varint(_ input: UInt64) {
        var n = input
        while n > 127 { data.append(UInt8(n & 127) | 128); n >>= 7 }
        data.append(UInt8(n))
    }
    mutating func int(_ field: Int, _ value: Int) {
        varint(UInt64(field << 3)); varint(UInt64(bitPattern: Int64(value)))
    }
    mutating func bytes(_ field: Int, _ value: Data) {
        varint(UInt64(field << 3 | 2)); varint(UInt64(value.count)); data.append(value)
    }
    static func integer(_ field: Int, _ value: Int) -> Data { var p = Proto(); p.int(field, value); return p.data }
    static func fields(_ d: Data) throws -> [Int: Value] {
        var i = 0, result: [Int: Value] = [:]
        func read() throws -> UInt64 {
            var v: UInt64 = 0
            for shift in stride(from: 0, through: 63, by: 7) {
                guard i < d.count else { throw BridgeError.invalid("Truncated protobuf") }
                let b = d[i]; i += 1
                guard shift < 63 || b < 2 else { throw BridgeError.invalid("Overflowing protobuf") }
                v |= UInt64(b & 127) << shift
                if b < 128 { return v }
            }
            throw BridgeError.invalid("Malformed protobuf")
        }
        while i < d.count {
            let tag = try read(), f = Int(tag >> 3)
            guard f > 0 else { throw BridgeError.invalid("Invalid protobuf field") }
            switch tag & 7 {
            case 0: result[f] = .integer(try read())
            case 2:
                let size = try read()
                guard size <= UInt64(d.count - i) else { throw BridgeError.invalid("Truncated protobuf bytes") }
                result[f] = .bytes(d.subdata(in: i..<i + Int(size))); i += Int(size)
            case 1: guard i + 8 <= d.count else { throw BridgeError.invalid("Truncated fixed64") }; i += 8
            case 5: guard i + 4 <= d.count else { throw BridgeError.invalid("Truncated fixed32") }; i += 4
            default: throw BridgeError.invalid("Unsupported protobuf wire type")
            }
        }
        return result
    }
}
extension Dictionary where Key == Int, Value == Proto.Value {
    func number(_ f: Int) -> Int? { if case .integer(let n) = self[f] { return Int(truncatingIfNeeded: n) }; return nil }
    func bytes(_ f: Int) -> Data? { if case .bytes(let d) = self[f] { return d }; return nil }
    func string(_ f: Int) -> String? { bytes(f).flatMap { String(data: $0, encoding: .utf8) } }
}

struct Reassembler {
    private struct Partial { var next: Int; let total: Int; var data: Data; var time: Date }
    private var pending: [Int: Partial] = [:]
    mutating func reset() { pending.removeAll() }
    mutating func feed(_ raw: Data, now: Date = Date()) -> (UInt8, Data)? {
        guard raw.count >= 8, raw[0] == 0xaa, ((raw[7] >> 1) & 15) == 0, raw.count == 8 + Int(raw[3]), raw[4] > 0, raw[5] > 0, raw[5] <= raw[4] else { return nil }
        pending = pending.filter { now.timeIntervalSince($0.value.time) < 5 }
        let key = Int(raw[6]) << 8 | Int(raw[2]), serial = Int(raw[5]), total = Int(raw[4])
        if serial == 1 { pending[key] = Partial(next: 1, total: total, data: Data(), time: now) }
        guard var p = pending[key], p.next == serial, p.total == total else { pending.removeValue(forKey: key); return nil }
        p.data.append(raw.dropFirst(8)); p.next += 1; p.time = now
        guard p.data.count <= 60200 else { pending.removeValue(forKey: key); return nil }
        if serial < total { pending[key] = p; return nil }
        pending.removeValue(forKey: key)
        guard p.data.count >= 2 else { return nil }
        let body = Data(p.data.dropLast(2))
        guard Wire.crc16(body) == UInt16(p.data.u16(p.data.count - 2)) else { return nil }
        return (raw[6], body)
    }
}

enum SettingsWire {
    static func set(_ subfield: Int, _ data: Data, magic: Int) -> Data {
        var info = Proto(); info.bytes(subfield, data)
        var p = Proto(); p.int(1, 1); p.int(2, magic); p.bytes(3, info.data); return p.data
    }
    static func query(_ brightnessOnly: Bool = false, magic: Int) -> Data {
        var p = Proto(); p.int(1, 2); p.int(2, magic); p.bytes(4, Proto.integer(1, brightnessOnly ? 0 : 1)); return p.data
    }
    static func brightness(_ level: Int, auto: Bool, magic: Int) -> Data {
        var p = Proto(); p.int(1, auto ? 1 : 0); p.int(2, min(100, max(0, level))); return set(1, p.data, magic: magic)
    }
    static func imu(_ enabled: Bool, pace: Int, magic: Int) -> Data {
        var c = Proto(); c.int(1, enabled ? 1 : 0); if enabled { c.int(2, pace) }
        var p = Proto(); p.int(1, 19); p.int(2, magic); p.bytes(22, c.data); return p.data
    }
}
