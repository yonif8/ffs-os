import Foundation

/// FFSA native application package. Executable bytes stay local to the companion
/// until the wearer selects this app; all pixels are drawn by the glasses.
struct AppPackage {
    let image: Data
    var id: Int { image.u16(8) }
    var crc: UInt32 { image.u32(16) }
    var name: String { String(bytes: image[36..<48].prefix { $0 != 0 }, encoding: .ascii) ?? "App" }
    init(frame: Data) throws {
        guard frame.count >= 60, frame.prefix(4) == Data("FXP1".utf8), frame.u32(4) == UInt32(frame.count - 12) else { throw BridgeError.invalid("Invalid app frame") }
        let body = Data(frame.dropFirst(12))
        guard Wire.crc32(body) == frame.u32(8), body.prefix(4) == Data("FFSA".utf8), body.u16(6) == 48,
              body[5] <= 4, [0,4].contains(body[4]), body.u16(8) > 0, body.u16(8) < 65535,
              body.u32(12) > 0, body.u32(12) <= 6144, body.count == 48 + Int(body.u32(12)),
              body.u32(28) <= 4096, Wire.crc32(Data(body.dropFirst(48))) == body.u32(16) else { throw BridgeError.invalid("Invalid or incompatible native app package") }
        for offset in [20,22,24,26] { let entry = body.u16(offset); guard entry == 65535 || entry < Int(body.u32(12)) else { throw BridgeError.invalid("Invalid app entry") } }
        guard body.u16(20) != 65535 else { throw BridgeError.invalid("App has no entry point") }
        image = body
    }
    func frame(op: UInt8, token: Int = 0, state: Data = Data()) -> Data {
        var body = op == 8 ? image : Data(image.prefix(48))
        body[4] = op; body[10] |= 8 // hosted: unload code on close
        body[34] = UInt8(truncatingIfNeeded: token); body[35] = UInt8(truncatingIfNeeded: token >> 8)
        if op == 6 { body.append(state) }
        return Wire.fxp1(body)
    }
    static func settingsFrame(brightness: Int?, wear: Int?, headup: Int?) -> Data {
        var b = Data(repeating: 0, count: 48); b.replaceSubrange(0..<4, with: Data("FFSA".utf8)); b[4]=7; b[5]=4; b[6]=48
        b.append(UInt8(clamping: brightness ?? 255)); b.append(UInt8(clamping: wear ?? 255)); b.append(UInt8(clamping: headup ?? 255))
        return Wire.fxp1(b)
    }
}
