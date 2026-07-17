//
//  G2Protocol.swift
//  ffs-ble
//
//  Phase 3: our own EvenHub wire protocol for the Even Realities G2 — the
//  hand-rolled protobuf encoder + the 0xAA-header transport framing (with
//  CRC16), plus the minimal EvenHub message + auth builders needed to put the
//  first pixels on the HUD (a text page) through our own driver.
//
//  This is a from-scratch reimplementation of the wire protocol. The field
//  numbers, command IDs, CRC16 polynomial-mix and the 0xAA framing are the G2's
//  own protocol (Even's EvenHub.proto / dev_config_protocol.proto), cross-read
//  from MentraOS's MIT-licensed driver (mobile/modules/bluetooth-sdk/ios/Source/
//  sgcs/G2.swift) and confirmed against our P0 spec (FUT-148) + the community RE
//  superset (FUT-159). We own every line here.
//
//  MIT attribution: protocol constants/field numbers derived from MentraOS
//  (https://github.com/Mentra-Community/MentraOS), MIT License.
//

import Foundation

// MARK: - Transport constants

enum G2Wire {
  static let HEADER_BYTE: UInt8 = 0xAA
  static let SOURCE_PHONE: UInt8 = 1
  static let DEST_GLASSES: UInt8 = 2
  static let MAX_PACKET_PAYLOAD = 236
}

/// BLE service IDs (byte [6] of the transport header).
enum G2ServiceID: UInt8 {
  case dashboard = 1
  case evenAI = 7
  case navigation = 8
  case g2Setting = 9
  case gestureCtrl = 13
  case onboarding = 16
  case deviceSettings = 0x80
  case evenHubCtrl = 0x81
  case evenHub = 0xE0
}

/// EvenHub command IDs (field 1 of an evenhub_main_msg_ctx).
enum G2EvenHubCmd: Int32 {
  case createStartupPage = 0
  case updateImageRawData = 3
  case updateTextData = 5
  case rebuildPage = 7
  case shutdownPage = 9
  case heartbeat = 12
  case audioControl = 15
  case imuControl = 19
}

/// DevCfg command IDs (field 1 of a DevCfgDataPackage on service 0x80).
enum G2DevCfgCmd: Int32 {
  case authentication = 4
  case pipeRoleChange = 5
  case timeSync = 128
  case baseConnHeartBeat = 14
}

// MARK: - CRC16 (G2's custom bit-mix; init 0xFFFF — confirmed CCITT-FALSE-family, FUT-159 §8)

func g2CRC16(_ data: Data) -> UInt16 {
  var crc: UInt16 = 0xFFFF
  for byte in data {
    crc = ((crc >> 8) | ((crc << 8) & 0xFF00)) ^ UInt16(byte)
    crc ^= (crc & 0xFF) >> 4
    crc ^= (crc << 12) & 0xFFFF
    crc ^= ((crc & 0xFF) << 5) & 0xFFFF
  }
  return crc & 0xFFFF
}

// MARK: - Minimal protobuf writer (hand-rolled, field-number-pinned)

struct G2ProtobufWriter {
  private(set) var data = Data()

  mutating func writeVarint(_ value: UInt64) {
    var v = value
    while v > 0x7F {
      data.append(UInt8(v & 0x7F) | 0x80)
      v >>= 7
    }
    data.append(UInt8(v))
  }

  mutating func writeInt32Field(_ field: Int, _ value: Int32) {
    writeVarint(UInt64(field << 3) | 0)  // wire type 0 (varint)
    if value >= 0 {
      writeVarint(UInt64(value))
    } else {
      writeVarint(UInt64(bitPattern: Int64(value)))  // negative → 10-byte varint
    }
  }

  mutating func writeInt64Field(_ field: Int, _ value: Int64) {
    writeVarint(UInt64(field << 3) | 0)
    writeVarint(UInt64(bitPattern: value))
  }

  mutating func writeBoolField(_ field: Int, _ value: Bool) {
    writeInt32Field(field, value ? 1 : 0)
  }

  mutating func writeStringField(_ field: Int, _ value: String) {
    writeVarint(UInt64(field << 3) | 2)  // wire type 2 (length-delimited)
    let utf8 = Array(value.utf8)
    writeVarint(UInt64(utf8.count))
    data.append(contentsOf: utf8)
  }

  mutating func writeBytesField(_ field: Int, _ value: Data) {
    writeVarint(UInt64(field << 3) | 2)
    writeVarint(UInt64(value.count))
    data.append(value)
  }

  /// Embed a length-delimited sub-message.
  mutating func writeMessageField(_ field: Int, _ sub: Data) {
    writeBytesField(field, sub)
  }
}

// MARK: - Transport framing (0xAA header + CRC16; fork of the G2 chunker)

enum G2Transport {
  /// Split `payload` into ≤236-byte transport packets. Byte layout per packet:
  /// [0]=0xAA · [1]=(dst<<4)|src=0x21 · [2]=syncId · [3]=payloadLen(+2 on last, for CRC)
  /// · [4]=packetTotalNum · [5]=packetSerialNum(1-based) · [6]=serviceId
  /// · [7]=status(bit5=reserveFlag) · payload chunk · (CRC16 LE on last packet).
  /// Edge: if the last chunk is EXACTLY 236 bytes, append an empty packet to
  /// carry the CRC (so a full final chunk isn't mistaken for a non-terminal one).
  static func buildPackets(
    syncId: UInt8, serviceId: UInt8, payload: Data, reserveFlag: Bool = false
  ) -> [Data] {
    let maxPayload = G2Wire.MAX_PACKET_PAYLOAD

    var chunks: [Data] = []
    var offset = 0
    while offset < payload.count {
      let end = min(offset + maxPayload, payload.count)
      chunks.append(payload.subdata(in: (payload.startIndex + offset)..<(payload.startIndex + end)))
      offset = end
    }
    if chunks.isEmpty { chunks.append(Data()) }
    if chunks.last!.count == maxPayload { chunks.append(Data()) }  // extra-CRC-packet edge

    let totalPackets = UInt8(chunks.count)
    let crc = g2CRC16(payload)
    let status: UInt8 = reserveFlag ? 0x20 : 0x00

    var packets: [Data] = []
    for (i, chunk) in chunks.enumerated() {
      let serialNum = UInt8(i + 1)
      let isLast = (serialNum == totalPackets)
      let payloadLen = UInt8(chunk.count + (isLast ? 2 : 0))

      var pkt = Data()
      pkt.append(G2Wire.HEADER_BYTE)
      pkt.append((G2Wire.DEST_GLASSES << 4) | G2Wire.SOURCE_PHONE)
      pkt.append(syncId)
      pkt.append(payloadLen)
      pkt.append(totalPackets)
      pkt.append(serialNum)
      pkt.append(serviceId)
      pkt.append(status)
      pkt.append(chunk)
      if isLast {
        pkt.append(UInt8(crc & 0xFF))
        pkt.append(UInt8((crc >> 8) & 0xFF))
      }
      packets.append(pkt)
    }
    return packets
  }
}

// MARK: - EvenHub message builders (service 0xE0)

enum G2EvenHub {
  /// TextContainerProperty. `isEventCapture` (field 11) is THE gate for input:
  /// the firmware only forwards single-press + swipe to the app when a container
  /// on the page has isEventCapture=1 (SDK: "only the container with isEventCapture:1
  /// receives input events"). Without it, only the system-level double-press
  /// (SYS event, container-independent) reaches us — everything else is consumed by
  /// the firmware's own on-glass UI. Only ONE container per page may capture. (FUT-160)
  static func textContainer(
    x: Int32, y: Int32, width: Int32, height: Int32, containerID: Int32,
    content: String, containerName: String? = nil, isEventCapture: Bool = false,
    borderWidth: Int32 = 0, borderColor: Int32 = 0, borderRadius: Int32 = 0,
    paddingLength: Int32 = 0
  ) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, x)
    w.writeInt32Field(2, y)
    w.writeInt32Field(3, width)
    w.writeInt32Field(4, height)
    w.writeInt32Field(5, borderWidth)
    w.writeInt32Field(6, borderColor)
    w.writeInt32Field(7, borderRadius)
    w.writeInt32Field(8, paddingLength)
    w.writeInt32Field(9, containerID)
    if let name = containerName { w.writeStringField(10, name) }
    w.writeInt32Field(11, isEventCapture ? 1 : 0)
    w.writeStringField(12, content)
    return w.data
  }

  /// CreateStartUpPageContainer: field1=total, field3=repeated TextObject,
  /// field4=repeated ImageObject.
  private static func createStartupPageContainer(
    textContainers: [Data], imageContainers: [Data] = []
  ) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, Int32(textContainers.count + imageContainers.count))
    for tc in textContainers { w.writeMessageField(3, tc) }
    for ic in imageContainers { w.writeMessageField(4, ic) }
    return w.data
  }

  /// evenhub_main_msg_ctx wrapper: f1=Cmd, f2=MagicRandom, f<sub>=payload.
  private static func message(cmd: G2EvenHubCmd, subField: Int, sub: Data, magicRandom: Int32) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, cmd.rawValue)
    w.writeInt32Field(2, magicRandom)
    w.writeMessageField(subField, sub)
    return w.data
  }

  /// A dedicated 1×1 invisible event-capture container. Every page needs EXACTLY one
  /// container with isEventCapture=1 or the firmware rejects input binding
  /// ("no container with Is_event_capture=1 found") and only the system double-press
  /// survives. Putting the flag on a REAL container paints a visible artifact, so we
  /// use a 1×1 empty one on every page (matches MentraOS "evt-0"). FUT-160/FUT-153.
  private static func eventCaptureContainer() -> Data {
    return textContainer(
      x: 0, y: 0, width: 1, height: 1, containerID: 0,
      content: "", containerName: "evt-0", isEventCapture: true)
  }

  /// Build a page from real text + image containers, always prepending the evt-0
  /// capture container so gestures work on EVERY page. `rebuild=false` →
  /// createStartupPage (cmd 0, only valid for the FIRST page of a session);
  /// `rebuild=true` → rebuildPage (cmd 7, for every page after). Sending
  /// createStartupPage twice is silently ignored by the firmware — that was the
  /// "stuck on the image, can't show text again" bug (FUT-153).
  static func pageMessage(
    textContainers: [Data], imageContainers: [Data], rebuild: Bool, magicRandom: Int32
  ) -> Data {
    let page = createStartupPageContainer(
      textContainers: [eventCaptureContainer()] + textContainers,
      imageContainers: imageContainers)
    return rebuild
      ? message(cmd: .rebuildPage, subField: 7, sub: page, magicRandom: magicRandom)
      : message(cmd: .createStartupPage, subField: 3, sub: page, magicRandom: magicRandom)
  }

  /// Full text page (create or rebuild). The visible text container does NOT capture
  /// events — the evt-0 container does.
  static func textPageMessage(text: String, rebuild: Bool, magicRandom: Int32) -> Data {
    let tc = textContainer(
      x: 0, y: 0, width: 576, height: 288, containerID: 1,
      content: text.isEmpty ? " " : text, containerName: "ffs-txt")
    return pageMessage(
      textContainers: [tc], imageContainers: [], rebuild: rebuild, magicRandom: magicRandom)
  }

  /// TextContainerUpgrade (updateTextData, sub-field 9): update a live container.
  static func updateText(containerID: Int32, content: String, magicRandom: Int32) -> Data {
    var u = G2ProtobufWriter()
    u.writeInt32Field(1, containerID)
    u.writeInt32Field(3, 0)  // contentOffset
    u.writeInt32Field(4, Int32(content.utf8.count))  // contentLength
    u.writeStringField(5, content)
    return message(cmd: .updateTextData, subField: 9, sub: u.data, magicRandom: magicRandom)
  }

  /// EvenHub heartbeat (keep-alive; FUT-159 wants ~5s cadence).
  static func heartbeat(magicRandom: Int32) -> Data {
    let empty = G2ProtobufWriter().data
    return message(cmd: .heartbeat, subField: 14, sub: empty, magicRandom: magicRandom)
  }
}

// MARK: - EvenHub image containers (P4, FUT-153)

extension G2EvenHub {
  /// ImageContainerProperty: f1=x, f2=y, f3=width, f4=height, f5=containerID, f6=name.
  /// Firmware max per container/tile = 200×100 (MentraOS `maxImageTile`); larger images
  /// must be tiled. Max 4 image containers per page.
  static func imageContainer(
    x: Int32, y: Int32, width: Int32, height: Int32, containerID: Int32,
    containerName: String? = nil
  ) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, x)
    w.writeInt32Field(2, y)
    w.writeInt32Field(3, width)
    w.writeInt32Field(4, height)
    w.writeInt32Field(5, containerID)
    if let name = containerName { w.writeStringField(6, name) }
    return w.data
  }

  /// A page (create OR rebuild) containing one image container. Routes through
  /// `pageMessage`, so it also carries the evt-0 capture container — gestures keep
  /// working while an image is shown (the image container itself can't capture). FUT-153.
  static func imagePageMessage(imageContainer ic: Data, rebuild: Bool, magicRandom: Int32) -> Data {
    return pageMessage(
      textContainers: [], imageContainers: [ic], rebuild: rebuild, magicRandom: magicRandom)
  }

  /// ImageRawDataUpdate: f1=containerID, f2=name, f3=mapSessionId, f4=mapTotalSize,
  /// f5=compressMode, f6=mapFragmentIndex, f7=mapFragmentPacketSize, f8=mapRawData.
  static func imageRawDataUpdate(
    containerID: Int32, containerName: String?, mapSessionId: Int32, mapTotalSize: Int32,
    compressMode: Int32 = 0, mapFragmentIndex: Int32, mapFragmentPacketSize: Int32,
    mapRawData: Data
  ) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, containerID)
    if let name = containerName { w.writeStringField(2, name) }
    w.writeInt32Field(3, mapSessionId)
    w.writeInt32Field(4, mapTotalSize)
    w.writeInt32Field(5, compressMode)
    w.writeInt32Field(6, mapFragmentIndex)
    w.writeInt32Field(7, mapFragmentPacketSize)
    w.writeBytesField(8, mapRawData)
    return w.data
  }

  /// Wrap an ImageRawDataUpdate as an evenhub message (cmd updateImageRawData=3, sub-field 5).
  static func updateImageMessage(_ update: Data, magicRandom: Int32) -> Data {
    return message(cmd: .updateImageRawData, subField: 5, sub: update, magicRandom: magicRandom)
  }

  /// Parse an inbound image-fragment ACK (ImgResCmd = response field 6):
  /// inner f8=errorCode (success == 4), f3=session, f6=fragmentIndex. Returns nil if
  /// the payload isn't an image ACK.
  static func parseImageAck(_ payload: Data) -> (session: Int32, fragment: Int32, success: Bool)? {
    var r = G2ProtobufReader(payload)
    let f = r.parseFields()
    guard let resData = f[6] as? Data else { return nil }
    var rr = G2ProtobufReader(resData)
    let rf = rr.parseFields()
    guard let errorCode = rf[8] as? Int32, let session = rf[3] as? Int32 else { return nil }
    let fragment = (rf[6] as? Int32) ?? 0
    return (session, fragment, errorCode == 4)
  }

  /// Encode 8-bit grayscale pixels (row-major, top-down) as a 4-bit-indexed BMP
  /// (16-level grayscale palette) — the raw-image format the G2 firmware's
  /// updateImageRawData path expects (matches MentraOS `build4BitBmp`).
  static func build4BitBmp(grayscalePixels: Data, width: Int, height: Int) -> Data? {
    guard width > 0, height > 0, grayscalePixels.count >= width * height else { return nil }
    let bytesPerRow4bit = (width + 1) / 2
    let paddedRowSize = (bytesPerRow4bit + 3) & ~3
    let pixelDataSize = paddedRowSize * height
    let headerSize = 14 + 40 + 64
    let fileSize = headerSize + pixelDataSize

    var bmp = Data(capacity: fileSize)
    // BMP file header (14)
    bmp.append(contentsOf: [0x42, 0x4D])  // "BM"
    bmp.appendLE32(UInt32(fileSize))
    bmp.appendLE16(0); bmp.appendLE16(0)
    bmp.appendLE32(UInt32(headerSize))
    // DIB header BITMAPINFOHEADER (40)
    bmp.appendLE32(40)
    bmp.appendLE32s(Int32(width))
    bmp.appendLE32s(Int32(height))  // positive → bottom-up
    bmp.appendLE16(1)   // planes
    bmp.appendLE16(4)   // bpp
    bmp.appendLE32(0)   // compression
    bmp.appendLE32(UInt32(pixelDataSize))
    bmp.appendLE32s(2835); bmp.appendLE32s(2835)  // ~72 DPI
    bmp.appendLE32(16)  // colors used
    bmp.appendLE32(0)   // important colors
    // Color table: 16 grayscale entries (B,G,R,0)
    for i in 0..<16 {
      let v = UInt8(i * 17)
      bmp.append(contentsOf: [v, v, v, 0])
    }
    // Pixel data (bottom-up, 4-bit packed, rows padded to 4 bytes)
    for row in 0..<height {
      let srcRow = height - 1 - row
      var rowBuf = [UInt8](repeating: 0, count: paddedRowSize)
      for col in 0..<width {
        let gray8 = grayscalePixels[grayscalePixels.startIndex + srcRow * width + col]
        let index4 = gray8 >> 4
        let bytePos = col / 2
        if col % 2 == 0 { rowBuf[bytePos] = index4 << 4 } else { rowBuf[bytePos] |= index4 }
      }
      bmp.append(contentsOf: rowBuf)
    }
    return bmp
  }

  /// A recognizable 200×100 test bitmap through the raw-image path: white background,
  /// 4px black border, black filled circle centered. Proves encode → container → send.
  static func testImageBmp(width: Int = 200, height: Int = 100) -> Data? {
    var px = [UInt8](repeating: 255, count: width * height)
    let cx = width / 2, cy = height / 2
    let r = min(width, height) / 2 - 12
    for y in 0..<height {
      for x in 0..<width {
        let border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4
        let dx = x - cx, dy = y - cy
        if border || (dx * dx + dy * dy <= r * r) { px[y * width + x] = 0 }
      }
    }
    return build4BitBmp(grayscalePixels: Data(px), width: width, height: height)
  }
}

// MARK: - Little-endian byte helpers (BMP construction)

extension Data {
  mutating func appendLE16(_ v: UInt16) {
    append(UInt8(v & 0xff)); append(UInt8((v >> 8) & 0xff))
  }
  mutating func appendLE32(_ v: UInt32) {
    for i in 0..<4 { append(UInt8((v >> (8 * UInt32(i))) & 0xff)) }
  }
  mutating func appendLE32s(_ v: Int32) { appendLE32(UInt32(bitPattern: v)) }
}

// MARK: - DevSettings (auth handshake, service 0x80)

enum G2DevSettings {
  /// AUTHENTICATION — AuthMgr{secAuth=true, phoneType=PHONE_IOS(3)}.
  static func authCmd(magicRandom: Int32) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, G2DevCfgCmd.authentication.rawValue)
    w.writeInt32Field(2, magicRandom)
    var auth = G2ProtobufWriter()
    auth.writeBoolField(1, true)
    auth.writeInt32Field(2, 3)  // PHONE_IOS
    w.writeMessageField(3, auth.data)
    return w.data
  }

  /// PIPE_ROLE_CHANGE — asCmdRole = RIGHT(1).
  static func pipeRoleChange(magicRandom: Int32) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, G2DevCfgCmd.pipeRoleChange.rawValue)
    w.writeInt32Field(2, magicRandom)
    var role = G2ProtobufWriter()
    role.writeInt32Field(1, 1)  // RIGHT
    w.writeMessageField(4, role.data)
    return w.data
  }

  /// TIME_SYNC — f1 = (unix seconds + tz offset), pre-shifted so UTC reads local.
  static func timeSync(magicRandom: Int32) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, G2DevCfgCmd.timeSync.rawValue)
    w.writeInt32Field(2, magicRandom)
    var ts = G2ProtobufWriter()
    let nowSec = Int64(Date().timeIntervalSince1970)
    let tzSec = Int64(TimeZone.current.secondsFromGMT())
    ts.writeInt32Field(1, Int32(truncatingIfNeeded: nowSec + tzSec))
    w.writeMessageField(128, ts.data)
    return w.data
  }
}

// MARK: - Onboarding (service 0x10)

enum G2Onboarding {
  /// Tell the glasses onboarding is FINISHED. Until the firmware considers
  /// onboarding complete, the touchpad drives its own on-glass onboarding UI and
  /// only the reserved double-tap reaches the host — single-tap + swipe are
  /// consumed locally. Matches MentraOS OnboardingProto.skipOnboarding (service
  /// 0x10): OnboardingDataPackage{cmd=CONFIG(1), magic, config{processId=FINISH(4)}}.
  static func skip(magicRandom: Int32) -> Data {
    var config = G2ProtobufWriter()
    config.writeInt32Field(1, 4)  // processId = FINISH
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, 1)  // commandId = CONFIG
    w.writeInt32Field(2, magicRandom)
    w.writeMessageField(3, config.data)
    return w.data
  }
}

// MARK: - Gesture control (service 0x0D)

enum G2GestureCtrl {
  /// Register the app with the on-glass gesture controller. This is what makes the
  /// firmware FORWARD single-tap + swipe to the host — without it, the firmware
  /// consumes those for its own on-glass UI and only the reserved double-tap reaches
  /// us. Matches MentraOS G2.swift `sendGestureCtrlCommand` (gesture_ctrl init:
  /// f1=0 opcode, f2=magicRandom) sent on connect. (FUT-160.)
  static func initCmd(magicRandom: Int32) -> Data {
    var w = G2ProtobufWriter()
    w.writeInt32Field(1, 0)  // init/register opcode
    w.writeInt32Field(2, magicRandom)
    return w.data
  }
}

// MARK: - Sequence counters

/// Rolling syncId (per transport packet) + magicRandom (per message). magicRandom
/// stays a low byte on purpose — the firmware only checks the low byte (FUT-159).
final class G2SendCounters {
  private var syncId: UInt8 = 0
  private var magic: UInt8 = 0

  func nextSyncId() -> UInt8 {
    let v = syncId; syncId = syncId &+ 1; return v
  }

  func nextMagic() -> Int32 {
    let v = magic; magic = magic &+ 1; return Int32(v)
  }

  /// Build the transport packets for a service-framed payload, consuming a syncId.
  func packets(serviceId: UInt8, payload: Data, reserveFlag: Bool = false) -> [Data] {
    return G2Transport.buildPackets(
      syncId: nextSyncId(), serviceId: serviceId, payload: payload, reserveFlag: reserveFlag
    )
  }
}

// MARK: - Minimal protobuf reader (field# → value)

struct G2ProtobufReader {
  private let data: Data
  private var offset = 0
  init(_ d: Data) { data = d }
  private var hasMore: Bool { offset < data.count }

  private mutating func readVarint() -> UInt64? {
    var result: UInt64 = 0, shift: UInt64 = 0
    while offset < data.count {
      let b = data[data.startIndex + offset]; offset += 1
      result |= UInt64(b & 0x7F) << shift
      if b & 0x80 == 0 { return result }
      shift += 7
      if shift > 63 { return nil }
    }
    return nil
  }

  private mutating func readBytes() -> Data? {
    guard let len = readVarint() else { return nil }
    let n = Int(len)
    guard offset + n <= data.count else { return nil }
    let r = data.subdata(in: (data.startIndex + offset)..<(data.startIndex + offset + n))
    offset += n
    return r
  }

  private mutating func skip(_ wire: Int) {
    switch wire {
    case 0: _ = readVarint()
    case 1: offset += 8
    case 2: _ = readBytes()
    case 5: offset += 4
    default: offset = data.count
    }
  }

  /// Parse into field# → Int32 (varint) or Data (length-delimited). Matches the
  /// subset we need to walk EvenHub response messages.
  mutating func parseFields() -> [Int: Any] {
    var out: [Int: Any] = [:]
    while hasMore {
      guard let tag = readVarint() else { break }
      let field = Int(tag >> 3), wire = Int(tag & 0x07)
      switch wire {
      case 0: if let v = readVarint() { out[field] = Int32(truncatingIfNeeded: v) }
      case 2: if let d = readBytes() { out[field] = d }
      default: skip(wire)
      }
    }
    return out
  }
}

// MARK: - Inbound: transport reassembly + gesture decode

/// Reassembles inbound 0xAA transport packets (one instance per side — L/R have
/// independent syncId counters). Mirrors the TX framing in reverse.
final class G2RxReassembler {
  private var partials: [String: Data] = [:]

  /// Feed one raw notification packet. Returns (serviceId, fullPayload) when a
  /// message completes, else nil (needs more packets, or not a 0xAA frame).
  func feed(_ raw: Data) -> (serviceId: UInt8, payload: Data)? {
    guard raw.count >= 8, raw[raw.startIndex] == G2Wire.HEADER_BYTE else { return nil }
    func byte(_ i: Int) -> UInt8 { raw[raw.startIndex + i] }
    let payloadLen = Int(byte(3))
    guard raw.count >= payloadLen + 8 else { return nil }
    let totalPackets = byte(4), serialNum = byte(5), serviceId = byte(6), status = byte(7)
    guard ((status >> 1) & 0x0F) == 0 else { return nil }  // resultCode != 0
    let isLast = (serialNum == totalPackets)
    let end = 8 + payloadLen - (isLast ? 2 : 0)  // strip trailing CRC on last
    let chunk = raw.subdata(in: (raw.startIndex + 8)..<(raw.startIndex + end))
    let key = "\(serviceId)-\(byte(2))"  // serviceId-syncId
    if totalPackets > 1 {
      if serialNum == 1 { partials[key] = chunk } else { partials[key, default: Data()].append(chunk) }
    }
    guard isLast else { return nil }
    let full = totalPackets > 1 ? (partials.removeValue(forKey: key) ?? chunk) : chunk
    return (serviceId, full)
  }
}

extension G2EvenHub {
  /// EvenHub response cmd for a touch/gesture event (glasses → phone).
  private static let rspOsNotifyEvent: Int32 = 2

  /// Decode an inbound EvenHub (0xE0) payload into a gesture name, or nil if it's
  /// not a nav gesture (heartbeat ack, foreground/exit, IMU, etc.).
  /// Chain: evenhub_main_msg_ctx{cmd=2, f13=SendDeviceEvent} → one of three
  /// sub-events, each nesting an OsEventType at a DIFFERENT field number:
  ///   f3 = SysEvent  → inner f1  (system gestures: double-tap, swipe, foreground/exit)
  ///   f2 = TextEvent → inner f3  (tap/swipe on a text container — what a tap on our HUD text emits)
  ///   f1 = ListEvent → inner f5  (interaction on a list container)
  /// OsEventType: 0=click(tap), 1=scrollTop(swipe up), 2=scrollBottom(swipe down), 3=doubleClick.
  /// (FUT-160: SysEvent-only decode missed single-tap on text pages — it arrives as TextEvent.)
  static func parseGesture(_ payload: Data) -> String? {
    var r = G2ProtobufReader(payload)
    let f = r.parseFields()
    guard (f[1] as? Int32) == rspOsNotifyEvent, let devEvent = f[13] as? Data else { return nil }
    var dr = G2ProtobufReader(devEvent)
    let df = dr.parseFields()
    // SysEvent: absent eventType => CLICK(0) => tap. Protobuf omits zero-value
    // fields, so a single-press arrives as SysEvent{eventSource} with NO eventType
    // field at all — treating "absent" as "not a gesture" was the single-tap miss.
    if let sysData = df[3] as? Data, let g = gestureName(from: sysData, at: 1, absentIsClick: true) { return g }
    if let textData = df[2] as? Data, let g = gestureName(from: textData, at: 3) { return g }
    if let listData = df[1] as? Data, let g = gestureName(from: listData, at: 5) { return g }
    return nil
  }

  /// Read the OsEventType at `field` inside a sub-event and map it to a nav-gesture
  /// name, or nil if not a nav gesture (foreground/exit/IMU/etc.). For the SysEvent
  /// path, `absentIsClick` makes a MISSING eventType decode as CLICK(0)/tap — the
  /// firmware omits the field when its value is 0 (protobuf zero-omission).
  private static func gestureName(from data: Data, at field: Int, absentIsClick: Bool = false) -> String? {
    var r = G2ProtobufReader(data)
    let f = r.parseFields()
    let eventType = (f[field] as? Int32) ?? (absentIsClick ? 0 : -1)
    switch eventType {
    case 0: return "tap"
    case 1: return "swipe_up"
    case 2: return "swipe_down"
    case 3: return "double_tap"
    default: return nil
    }
  }
}
