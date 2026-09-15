import Foundation

@main struct CodexTests {
    @MainActor static func main() async throws {
        var snapshot = CodexWire.Snapshot(revision: 0xfffffff0, selected: 2, connected: true,
            thinking: true, hasOlder: true, recording: false, paused: true, confirming: false,
            hasPreviousRows: true, hasNextRows: true, historyIndex: 2,
            conversation: String(repeating: "Earlier text. ", count: 200) + "LATEST ✅",
            rows: [.init(handle: 0, title: "misc poly", project: true, status: 0),
                   .init(handle: 2, title: "A current task", project: false, status: 1)],
            draft: "hello from the glasses", question: "Proceed?", options: ["Yes", "No"])
        let encoded = try CodexWire.encode(snapshot)
        precondition(encoded.count <= CodexWire.maximumSnapshotBytes)
        let decoded = CodexWire.decode(encoded)!
        precondition(decoded.connected && decoded.thinking && decoded.hasOlder && decoded.paused)
        precondition(decoded.hasPreviousRows && decoded.hasNextRows)
        precondition(decoded.historyIndex == 2)
        precondition(decoded.rows == snapshot.rows && decoded.options == snapshot.options)
        precondition(decoded.conversation.hasSuffix("LATEST ✅"))
        precondition(decoded.draft == snapshot.draft && decoded.question == snapshot.question)
        snapshot.rows = (0..<100).map { .init(handle: UInt16($0 + 1), title: String(repeating: "界", count: 40), project: false, status: 2) }
        let crowded = try CodexWire.encode(snapshot)
        precondition(crowded.count <= CodexWire.maximumSnapshotBytes)

        let event = CodexWire.Event(kind: .selectConversation, sessionID: 0x99887766, commandID: 0x12345678, value: 44)
        var envelope = Data([1, UInt8(CodexWire.appID), event.kind.rawValue, 1, 7, 0])
        let payload = CodexWire.encodeEvent(event); envelope.le16(payload.count); envelope.append(payload)
        precondition(CodexWire.decodeEvent(CodexWire.GlassesEvent(envelope)!) == event)
        var bad = envelope; bad[0] = 2; precondition(CodexWire.GlassesEvent(bad) == nil)

        precondition(CodexSSHPipe.frameHeader(count: 300) == Data([0x81, 0xfe, 0x01, 0x2c]))
        precondition(CodexSSHPipe.frameHeader(count: 70_000) == Data([0x81, 0xff, 0, 0, 0, 0, 0, 1, 0x11, 0x70]))

        if CommandLine.arguments.contains("--live") || CommandLine.arguments.contains("--soak") {
            let rpc = CodexRPC()
            var disconnectError = ""
            rpc.disconnected = { disconnectError = $0.localizedDescription }
            try await rpc.connect(host: "codex-server", socketPath: "/home/claude-bot/.codex/app-server-control/app-server-control.sock")
            let projects = try await rpc.request("project/list", ["limit": 10]) as? [String: Any] ?? [:]
            let threads = try await rpc.request("thread/list", ["limit": 10, "sortDirection": "desc", "archived": false]) as? [String: Any] ?? [:]
            let values = threads["data"] as? [[String: Any]] ?? []
            if let id = ProcessInfo.processInfo.environment["CODEX_TEST_THREAD"] ?? values.first?["id"] as? String {
                let page = try await rpc.request("thread/turns/list", ["threadId": id, "limit": 10,
                    "sortDirection": "desc", "itemsView": "full"]) as? [String: Any] ?? [:]
                print("PASS live KJDev task history page: turns=\((page["data"] as? [Any])?.count ?? -1)")
                if let expected = ProcessInfo.processInfo.environment["CODEX_EXPECT_USER_TEXT"] {
                    let turns = page["data"] as? [[String: Any]] ?? []
                    let messages = turns.flatMap { $0["items"] as? [[String: Any]] ?? [] }
                        .filter { $0["type"] as? String == "userMessage" }
                        .map { item in
                            (item["content"] as? [[String: Any]] ?? [])
                                .compactMap { $0["text"] as? String }.joined(separator: "\n")
                        }
                    let matches = messages.filter { $0.contains(expected) }.count
                    precondition(matches == 1, "Expected one confirmed user message containing '\(expected)', found \(matches)")
                    print("PASS live KJDev confirmed user message exactly once")
                }
                let newest = try await rpc.request("thread/turns/list", ["threadId": id, "limit": 1,
                    "sortDirection": "desc", "itemsView": "full"]) as? [String: Any] ?? [:]
                if let cursor = newest["nextCursor"] as? String {
                    let older = try await rpc.request("thread/turns/list", ["threadId": id, "limit": 1,
                        "cursor": cursor, "sortDirection": "desc", "itemsView": "full"]) as? [String: Any] ?? [:]
                    let turns = older["data"] as? [[String: Any]] ?? []
                    var blocks: [String] = []
                    for turn in turns { for item in turn["items"] as? [[String: Any]] ?? [] {
                        if item["type"] as? String == "agentMessage", let text = item["text"] as? String { blocks.append("CODEX\n" + text) }
                        if item["type"] as? String == "userMessage" {
                            let content = item["content"] as? [[String: Any]] ?? []
                            let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
                            if !text.isEmpty { blocks.append("YOU\n" + text) }
                        }
                    } }
                    let rendered = blocks.joined(separator: "\n\n")
                    let roundTrip = CodexWire.decode(try CodexWire.encode(.init(conversation: rendered)))
                    precondition(roundTrip != nil && !rendered.isEmpty)
                    print("PASS live KJDev cursor page: cursorBytes=\(cursor.utf8.count) textBytes=\(rendered.utf8.count) wireBytes=\((try CodexWire.encode(.init(conversation: rendered))).count)")
                }
            }
            print("PASS live KJDev app-server: projects=\((projects["data"] as? [Any])?.count ?? -1) threads=\((threads["data"] as? [Any])?.count ?? -1)")
            if CommandLine.arguments.contains("--soak") { try await Task.sleep(for: .seconds(25)) }
            precondition(disconnectError.isEmpty, disconnectError)
            rpc.disconnect()
        }
        print("PASS Codex wire: bounded snapshots, UTF-8, newest-text preservation, event validation")
    }
}
