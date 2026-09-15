import Foundation

/// Compact, versioned state shared by the Codex bridge and the on-glasses app.
/// The firmware mailbox stores one latest value, so every packet is a complete,
/// independently decodable snapshot rather than a delta that can be lost.
enum CodexWire {
    static let appID = 16
    static let maximumSnapshotBytes = 1024
    static let magic = Data("CDX1".utf8)

    struct Row: Equatable {
        var handle: UInt16
        var title: String
        var project: Bool
        /// 0 unknown, 1 active/thinking, 2 completed/waiting for the user.
        var status: UInt8
    }

    struct Snapshot: Equatable {
        var revision: UInt32 = 0
        var selected: UInt16 = 0
        var connected = false
        var thinking = false
        var hasOlder = false
        var recording = false
        var paused = false
        var confirming = false
        var hasPreviousRows = false
        var hasNextRows = false
        var historyIndex: UInt8 = 0
        var conversation = ""
        var rows: [Row] = []
        var draft = ""
        var question = ""
        var options: [String] = []
    }

    enum EventKind: UInt8 {
        case sync = 0x10
        case selectConversation = 0x11
        case olderPage = 0x12
        case pushToTalkStart = 0x13
        case pushToTalkPause = 0x14
        case discardDraft = 0x15
        case confirmDraft = 0x16
        case stopTurn = 0x17
        case answer = 0x18
        case refreshThreads = 0x19
    }

    struct Event: Equatable {
        var kind: EventKind
        var sessionID: UInt32
        var commandID: UInt32
        var value: UInt16 = 0
    }

    /// Envelope emitted by firmware on service 0x91.
    struct GlassesEvent: Equatable {
        var source: UInt8
        var type: UInt8
        var sequence: UInt16
        var payload: Data

        init?(_ data: Data) {
            guard data.count >= 8, data[0] == 1,
                  data.count == 8 + data.u16(6) else { return nil }
            source = data[1]
            type = data[2]
            sequence = UInt16(data.u16(4))
            payload = Data(data.dropFirst(8))
        }
    }

    static func decodeEvent(_ envelope: GlassesEvent) -> Event? {
        guard envelope.source == UInt8(appID),
              let kind = EventKind(rawValue: envelope.type),
              envelope.payload.count >= 8 else { return nil }
        let value = envelope.payload.count >= 10 ? UInt16(envelope.payload.u16(8)) : 0
        return Event(kind: kind, sessionID: envelope.payload.u32(0), commandID: envelope.payload.u32(4), value: value)
    }

    static func encodeEvent(_ event: Event) -> Data {
        var data = Data()
        data.le32(event.sessionID); data.le32(event.commandID)
        if event.value != 0 || event.kind == .selectConversation || event.kind == .answer {
            data.le16(Int(event.value))
        }
        return data
    }

    static func encode(_ input: Snapshot) throws -> Data {
        var snapshot = input
        snapshot.rows = Array(snapshot.rows.prefix(32))
        snapshot.options = Array(snapshot.options.prefix(3))
        snapshot.rows = snapshot.rows.map {
            Row(handle: $0.handle, title: utf8Prefix($0.title, bytes: 48), project: $0.project,
                status: min(2, $0.status))
        }
        snapshot.options = snapshot.options.map { utf8Prefix($0, bytes: 64) }
        snapshot.draft = utf8Suffix(snapshot.draft, bytes: 700)
        snapshot.question = utf8Prefix(snapshot.question, bytes: 220)

        // Rows, questions and draft are control state. Conversation history gets
        // whatever remains and is cropped from the oldest side so the latest reply
        // is what survives constrained BLE/mailbox capacity.
        var fixed = body(snapshot, conversation: "")
        if fixed.count > maximumSnapshotBytes {
            while fixed.count > maximumSnapshotBytes && !snapshot.rows.isEmpty {
                snapshot.rows.removeLast()
                fixed = body(snapshot, conversation: "")
            }
            while fixed.count > maximumSnapshotBytes && !snapshot.options.isEmpty {
                snapshot.options.removeLast()
                fixed = body(snapshot, conversation: "")
            }
            if fixed.count > maximumSnapshotBytes {
                snapshot.draft = utf8Suffix(snapshot.draft, bytes: max(0, snapshot.draft.utf8.count - (fixed.count - maximumSnapshotBytes)))
                fixed = body(snapshot, conversation: "")
            }
        }
        guard fixed.count <= maximumSnapshotBytes else {
            throw BridgeError.invalid("Codex control state exceeds the glasses mailbox")
        }
        let available = maximumSnapshotBytes - fixed.count
        snapshot.conversation = utf8Suffix(snapshot.conversation, bytes: available)
        let encoded = body(snapshot, conversation: snapshot.conversation)
        guard encoded.count <= maximumSnapshotBytes else {
            throw BridgeError.invalid("Codex snapshot exceeds the glasses mailbox")
        }
        return encoded
    }

    static func decode(_ data: Data) -> Snapshot? {
        // Header: magic(4), version(1), flags(1), selected(2), revision(4),
        // row/option counts(2), three string lengths(6), and history index(1).
        guard data.count >= 21, data.prefix(4) == magic, data[4] == 2 else { return nil }
        let flags = data[5]
        var snapshot = Snapshot(revision: data.u32(8), selected: UInt16(data.u16(6)),
            connected: flags & 1 != 0, thinking: flags & 2 != 0,
            hasOlder: flags & 4 != 0, recording: flags & 8 != 0,
            paused: flags & 16 != 0, confirming: flags & 32 != 0,
            hasPreviousRows: flags & 64 != 0, hasNextRows: flags & 128 != 0,
            historyIndex: data[20])
        let rowCount = Int(data[12]), optionCount = Int(data[13])
        let conversationLength = data.u16(14), draftLength = data.u16(16), questionLength = data.u16(18)
        var offset = 21
        for _ in 0..<rowCount {
            guard offset + 4 <= data.count else { return nil }
            let handle = UInt16(data.u16(offset)), rowFlags = data[offset + 2], length = Int(data[offset + 3])
            offset += 4
            guard offset + length <= data.count,
                  let title = String(data: data.subdata(in: offset..<offset + length), encoding: .utf8) else { return nil }
            snapshot.rows.append(Row(handle: handle, title: title, project: rowFlags & 1 != 0,
                                     status: (rowFlags >> 1) & 3))
            offset += length
        }
        for _ in 0..<optionCount {
            guard offset < data.count else { return nil }
            let length = Int(data[offset]); offset += 1
            guard offset + length <= data.count,
                  let option = String(data: data.subdata(in: offset..<offset + length), encoding: .utf8) else { return nil }
            snapshot.options.append(option); offset += length
        }
        func string(_ length: Int) -> String? {
            guard offset + length <= data.count,
                  let value = String(data: data.subdata(in: offset..<offset + length), encoding: .utf8) else { return nil }
            offset += length; return value
        }
        guard let conversation = string(conversationLength),
              let draft = string(draftLength), let question = string(questionLength),
              offset == data.count else { return nil }
        snapshot.conversation = conversation; snapshot.draft = draft; snapshot.question = question
        return snapshot
    }

    private static func body(_ snapshot: Snapshot, conversation: String) -> Data {
        let conversationData = Data(conversation.utf8), draftData = Data(snapshot.draft.utf8)
        let questionData = Data(snapshot.question.utf8)
        var flags: UInt8 = 0
        if snapshot.connected { flags |= 1 }; if snapshot.thinking { flags |= 2 }
        if snapshot.hasOlder { flags |= 4 }; if snapshot.recording { flags |= 8 }
        if snapshot.paused { flags |= 16 }; if snapshot.confirming { flags |= 32 }
        if snapshot.hasPreviousRows { flags |= 64 }; if snapshot.hasNextRows { flags |= 128 }
        var data = magic
        data.append(2); data.append(flags); data.le16(Int(snapshot.selected)); data.le32(snapshot.revision)
        data.append(UInt8(snapshot.rows.count)); data.append(UInt8(snapshot.options.count))
        data.le16(conversationData.count); data.le16(draftData.count); data.le16(questionData.count)
        data.append(snapshot.historyIndex)
        for row in snapshot.rows {
            let title = Data(row.title.utf8)
            data.le16(Int(row.handle)); data.append((row.project ? 1 : 0) | ((row.status & 3) << 1))
            data.append(UInt8(title.count)); data.append(title)
        }
        for option in snapshot.options {
            let value = Data(option.utf8); data.append(UInt8(value.count)); data.append(value)
        }
        data.append(conversationData); data.append(draftData); data.append(questionData)
        return data
    }

    static func utf8Prefix(_ value: String, bytes: Int) -> String {
        guard value.utf8.count > bytes else { return value }
        var result = ""
        for character in value {
            let next = result + String(character)
            if next.utf8.count > bytes { break }
            result = next
        }
        return result
    }

    static func utf8Suffix(_ value: String, bytes: Int) -> String {
        guard bytes > 0 else { return "" }
        guard value.utf8.count > bytes else { return value }
        var result = ""
        for character in value.reversed() {
            let next = String(character) + result
            if next.utf8.count > bytes { break }
            result = next
        }
        return result
    }
}
