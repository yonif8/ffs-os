import Foundation
import Combine

@MainActor
final class CodexService: ObservableObject {
    struct ThreadRow {
        var id: String, title: String, cwd: String, projectID: String?
        var status: UInt8, updatedAt: Int
    }
    struct ProjectRoot {
        var name: String, path: String
    }

    @Published private(set) var connected = false
    @Published private(set) var statusMessage = "Codex bridge idle"
    @Published private(set) var threadCount = 0
    @Published private(set) var activeThreadID = ""

    private let root: URL
    private let rpc = CodexRPC()
    private let voice: VoiceService
    private var host = "codex-server"
    private var socketPath = "/home/claude-bot/.codex/app-server-control/app-server-control.sock"
    private var configuredRoots: [ProjectRoot] = []
    private var projects: [String: String] = [:]
    private var threads: [ThreadRow] = []
    private var handles: [String: UInt16] = [:]
    private var idsByHandle: [UInt16: String] = [:]
    private var nextHandle: UInt16 = 1
    private var revision: UInt32 = 0
    private var sequence = 0
    private var conversation = ""
    private var olderCursor: String?
    private var activeTurnID = ""
    private var lastSessionID: UInt32 = 0
    private var lastCommandID: UInt32 = 0
    private var reconnectTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var pttSession = false
    private var confirming = false
    private var drawerPage = 0
    private var refreshing = false
    private var resumedThreads = Set<String>()
    private var latestConversation = ""
    private var historyPages: [String] = []
    private var historyIndex = 0

    private struct PendingQuestion {
        var requestID: Any
        var threadID: String
        var questions: [[String: Any]]
        var answers: [String: [String: [String]]]
        var index: Int
    }
    private var pendingQuestion: PendingQuestion?

    var send: ((Data) async throws -> Void)?
    var setMicrophone: ((Bool) async throws -> Void)?
    var event: ((String, [String: Any]) -> Void)?

    init(root: URL, voice: VoiceService) {
        self.root = root.appendingPathComponent("codex", isDirectory: true)
        self.voice = voice
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        loadConfig(); loadState()
        rpc.notification = { [weak self] method, params in self?.notification(method, params) }
        rpc.serverRequest = { [weak self] id, method, params in self?.serverRequest(id, method, params) }
        rpc.disconnected = { [weak self] error in self?.lost(error) }
        voice.liveTranscript = { [weak self] transcript, isFinal in
            guard let self, self.pttSession else { return }
            self.statusMessage = isFinal ? "Transcription ready" : "Transcribing"
            self.queueSnapshot()
        }
    }

    func start() {
        guard reconnectTask == nil else { return }
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            var backoff = 1.0
            while !Task.isCancelled {
                if !self.connected {
                    do {
                        self.statusMessage = "Connecting to KJDev"
                        self.resumedThreads.removeAll()
                        try await self.rpc.connect(host: self.host, socketPath: self.socketPath)
                        self.connected = true; self.statusMessage = "Connected to KJDev"; backoff = 1
                        try await self.refresh()
                    } catch {
                        self.statusMessage = "KJDev unavailable; cached conversations remain usable"
                        self.log("connect failed", ["error": error.localizedDescription])
                        try? await Task.sleep(for: .seconds(backoff)); backoff = min(30, backoff * 2)
                    }
                } else { try? await Task.sleep(for: .seconds(5)) }
            }
        }
    }

    func stop() {
        reconnectTask?.cancel(); reconnectTask = nil; refreshTask?.cancel(); refreshTask = nil
        rpc.disconnect(); connected = false
    }

    func receive(_ raw: Data, side: String) {
        guard side == "R", let envelope = CodexWire.GlassesEvent(raw),
              let command = CodexWire.decodeEvent(envelope) else { return }
        // The paired runtime emits once from the master. Persist command IDs before
        // any remote mutation so a reconnect/replayed BLE notify cannot double-send.
        if command.sessionID == lastSessionID {
            guard isNewer(command.commandID, than: lastCommandID) else { return }
        } else {
            lastSessionID = command.sessionID; lastCommandID = 0
        }
        lastCommandID = command.commandID; saveState()
        Task { [weak self] in await self?.handle(command) }
    }

    func pairReady() { start(); queueSnapshot() }
    func disconnectedFromGlasses() { try? setMicrophoneOff() }

    func status() -> [String: Any] {
        ["connected": connected, "message": statusMessage, "threads": threadCount,
         "activeThreadId": activeThreadID, "thinking": !activeTurnID.isEmpty,
         "ptt": pttSession, "draftBytes": voice.currentTranscript.utf8.count]
    }

    func refresh() async throws {
        guard connected else { throw BridgeError.unavailable("Codex is not connected") }
        // Pair-ready and the app's SHOW/SYNC event can arrive together.  App-server
        // permits only one active writer per task, so collapse overlapping refreshes
        // instead of issuing two concurrent thread/resume requests.
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        var projectCursor: String?, serverProjects: [String: String] = [:]
        repeat {
            var params: [String: Any] = ["limit": 100]
            if let projectCursor { params["cursor"] = projectCursor }
            let result = try await rpc.request("project/list", params) as? [String: Any] ?? [:]
            for project in result["data"] as? [[String: Any]] ?? [] {
                if let id = project["id"] as? String, let name = project["name"] as? String { serverProjects[id] = name }
            }
            projectCursor = result["nextCursor"] as? String
        } while projectCursor != nil
        projects = serverProjects

        var cursor: String?, values: [ThreadRow] = []
        repeat {
            var params: [String: Any] = ["limit": 100, "sortKey": "recency_at", "sortDirection": "desc", "archived": false]
            if let cursor { params["cursor"] = cursor }
            let result = try await rpc.request("thread/list", params) as? [String: Any] ?? [:]
            for item in result["data"] as? [[String: Any]] ?? [] {
                guard let id = item["id"] as? String else { continue }
                let status = Self.threadStatus(item["status"])
                let title = (item["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? (item["preview"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? "Untitled task"
                values.append(ThreadRow(id: id, title: title, cwd: item["cwd"] as? String ?? "",
                    projectID: item["projectId"] as? String, status: status,
                    updatedAt: item["recencyAt"] as? Int ?? item["updatedAt"] as? Int ?? 0))
                _ = handle(for: id)
            }
            cursor = result["nextCursor"] as? String
        } while cursor != nil && values.count < 1000
        threads = values; threadCount = values.count; saveHandles()
        if activeThreadID.isEmpty || !values.contains(where: { $0.id == activeThreadID }) {
            activeThreadID = values.first?.id ?? ""
        }
        if !activeThreadID.isEmpty { try await open(activeThreadID) }
        else { conversation = "No Codex conversations are available on KJDev."; queueSnapshot() }
    }

    private func handle(_ command: CodexWire.Event) async {
        do {
            switch command.kind {
            case .sync: if connected { try await refresh() } else { start(); queueSnapshot() }
            case .refreshThreads:
                let pages = drawerPages()
                if command.value == 1 { drawerPage = min(max(0, pages.count - 1), drawerPage + 1) }
                else if command.value == 2 { drawerPage = max(0, drawerPage - 1) }
                else { try await refresh(); return }
                queueSnapshot()
            case .selectConversation:
                guard let id = idsByHandle[command.value] else { throw BridgeError.invalid("Unknown conversation") }
                try await open(id)
            case .olderPage: try await changeHistoryPage(newer: command.value == 1)
            case .pushToTalkStart: try await pttStart()
            case .pushToTalkPause: try await pttPause()
            case .discardDraft: try await discardDraft()
            case .confirmDraft: try await confirmDraft(commandID: command.commandID)
            case .stopTurn: try await interruptTurn()
            case .answer: try answer(index: Int(command.value))
            }
        } catch {
            statusMessage = error.localizedDescription; log("command failed", ["kind": Int(command.kind.rawValue), "error": error.localizedDescription]); queueSnapshot()
        }
    }

    private func open(_ id: String) async throws {
        guard connected else { throw BridgeError.unavailable("KJDev is offline") }
        var readOnly = false
        // A loaded task already has this connection as its writer. Resuming it a
        // second time is rejected by app-server, so attach each task at most once
        // per WebSocket connection; subsequent opens only page its current turns.
        if !resumedThreads.contains(id) {
            do {
                _ = try await rpc.request("thread/resume", ["threadId": id, "excludeTurns": true])
                resumedThreads.insert(id)
            } catch where error.localizedDescription.contains("already has an active writer") {
                // History is still readable while another trusted client owns the
                // writer. A later refresh retries attachment after that client exits.
                readOnly = true
            }
        }
        activeThreadID = id; activeTurnID = ""; conversation = ""; olderCursor = nil
        latestConversation = ""; historyPages = []; historyIndex = 0
        if let page = drawerPages().firstIndex(where: { $0.contains(where: { !$0.project && $0.handle == handle(for: id) }) }) { drawerPage = page }
        saveState()
        let result = try await rpc.request("thread/turns/list", ["threadId": id, "limit": 1,
            "sortDirection": "desc", "itemsView": "full"]) as? [String: Any] ?? [:]
        let turns = result["data"] as? [[String: Any]] ?? []
        latestConversation = Self.render(turns: turns.reversed())
        conversation = latestConversation; historyPages = [latestConversation]
        olderCursor = result["nextCursor"] as? String
        if let turn = turns.first, (turn["status"] as? String) == "inProgress" { activeTurnID = turn["id"] as? String ?? "" }
        statusMessage = readOnly ? "Conversation active elsewhere; viewing read-only" : "Conversation loaded"
        queueSnapshot()
    }

    private func changeHistoryPage(newer: Bool) async throws {
        guard !activeThreadID.isEmpty else { return }
        if newer {
            guard historyIndex > 0 else { return }
            historyIndex -= 1
            conversation = historyIndex == 0 ? latestConversation : historyPages[historyIndex]
            queueSnapshot(); return
        }
        if historyIndex + 1 < historyPages.count {
            historyIndex += 1; conversation = historyPages[historyIndex]; queueSnapshot(); return
        }
        guard let cursor = olderCursor else { return }
        let result = try await rpc.request("thread/turns/list", ["threadId": activeThreadID, "limit": 1,
            "cursor": cursor, "sortDirection": "desc", "itemsView": "full"]) as? [String: Any] ?? [:]
        let page = Self.render(turns: (result["data"] as? [[String: Any]] ?? []).reversed())
        olderCursor = result["nextCursor"] as? String
        if !page.isEmpty { historyPages.append(page); historyIndex += 1; conversation = page }
        queueSnapshot()
    }

    private func pttStart() async throws {
        if !pttSession {
            // The current G2 firmware exposes its processed mono microphone stream
            // on the left/slave BLE link.  The FMIC command still goes to the pair.
            voice.captureSide = "L"; voice.liveOnGlasses = false; _ = try voice.start(); pttSession = true
        }
        voice.resumeCapture(); try await setMicrophone?(true)
        statusMessage = "Recording while held"; queueSnapshot()
    }

    private func pttPause() async throws {
        guard pttSession else { return }
        try await setMicrophone?(false); voice.pauseCapture(); statusMessage = "Paused; hold to continue"
        queueSnapshot()
    }

    private func discardDraft() async throws {
        if voice.capturing { try await setMicrophone?(false) }
        voice.stop(); voice.clearCurrentTranscript(); pttSession = false; confirming = false
        statusMessage = "Draft discarded"; queueSnapshot()
    }

    private func confirmDraft(commandID: UInt32) async throws {
        guard pttSession else { return }
        if voice.capturing { try await setMicrophone?(false); voice.pauseCapture() }
        confirming = true; queueSnapshot()
        let finalized = try await voice.finalizeCurrentTranscript()
        let text = finalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { confirming = false; throw BridgeError.invalid("Nothing was transcribed") }
        guard connected, !activeThreadID.isEmpty else { confirming = false; throw BridgeError.unavailable("KJDev is offline; draft retained") }
        let clientID = "ffs-glasses-\(activeThreadID)-\(commandID)"
        let result = try await rpc.request("turn/start", ["threadId": activeThreadID,
            "input": [["type": "text", "text": text]], "clientUserMessageId": clientID]) as? [String: Any] ?? [:]
        if let turn = result["turn"] as? [String: Any] { activeTurnID = turn["id"] as? String ?? "" }
        updateLatest { $0 += ($0.isEmpty ? "" : "\n\n") + "YOU\n" + text }
        voice.clearCurrentTranscript(); pttSession = false; confirming = false
        statusMessage = "Sent to Codex"; queueSnapshot()
    }

    private func interruptTurn() async throws {
        guard connected, !activeThreadID.isEmpty, !activeTurnID.isEmpty else {
            throw BridgeError.unavailable("No owned Codex turn is currently active")
        }
        _ = try await rpc.request("turn/interrupt", ["threadId": activeThreadID, "turnId": activeTurnID])
        statusMessage = "Stop requested"; queueSnapshot()
    }

    private func serverRequest(_ id: Any, _ method: String, _ params: [String: Any]) {
        guard method == "item/tool/requestUserInput",
              let threadID = params["threadId"] as? String,
              let questions = params["questions"] as? [[String: Any]], !questions.isEmpty else {
            // This glasses client never grants command/file/permission approvals.
            // Leave unsupported requests pending for a richer trusted client.
            log("unsupported server request", ["method": method]); return
        }
        pendingQuestion = PendingQuestion(requestID: id, threadID: threadID, questions: questions, answers: [:], index: 0)
        if threadID == activeThreadID { statusMessage = "Codex is waiting for an answer"; queueSnapshot() }
    }

    private func answer(index: Int) throws {
        guard var pending = pendingQuestion, pending.threadID == activeThreadID,
              pending.index < pending.questions.count else { throw BridgeError.invalid("No Codex question is waiting") }
        let question = pending.questions[pending.index]
        guard let questionID = question["id"] as? String,
              let options = question["options"] as? [[String: Any]], index >= 0, index < options.count,
              let label = options[index]["label"] as? String else { throw BridgeError.invalid("Unknown answer") }
        pending.answers[questionID] = ["answers": [label]]; pending.index += 1
        if pending.index < pending.questions.count { pendingQuestion = pending; queueSnapshot(); return }
        try rpc.respond(id: pending.requestID, result: ["answers": pending.answers])
        pendingQuestion = nil; statusMessage = "Answer sent"; queueSnapshot()
    }

    private func notification(_ method: String, _ params: [String: Any]) {
        guard params["threadId"] as? String == activeThreadID else {
            if method == "thread/status/changed" || method == "thread/statusChanged" { updateRowStatus(params) }
            return
        }
        switch method {
        case "turn/started":
            if let turn = params["turn"] as? [String: Any] { activeTurnID = turn["id"] as? String ?? "" }
            updateLatest { if !$0.hasSuffix("CODEX\n") { $0 += ($0.isEmpty ? "" : "\n\n") + "CODEX\n" } }
            statusMessage = "Codex is thinking"; setActiveRowStatus(1); queueSnapshot()
        case "item/agentMessage/delta":
            if let delta = params["delta"] as? String { updateLatest { $0 += delta }; queueSnapshot(debounce: true) }
        case "item/completed":
            if let item = params["item"] as? [String: Any], item["type"] as? String == "agentMessage",
               let text = item["text"] as? String, !text.isEmpty {
                updateLatest { Self.replaceTrailingAgent(in: &$0, with: text) }; queueSnapshot()
            }
        case "turn/completed":
            activeTurnID = ""; statusMessage = "Codex is waiting for you"; setActiveRowStatus(2); queueSnapshot()
        case "thread/status/changed", "thread/statusChanged": updateRowStatus(params); queueSnapshot()
        default: break
        }
    }

    private func updateRowStatus(_ params: [String: Any]) {
        guard let id = params["threadId"] as? String,
              let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].status = Self.threadStatus(params["status"])
    }
    private func setActiveRowStatus(_ status: UInt8) {
        if let index = threads.firstIndex(where: { $0.id == activeThreadID }) { threads[index].status = status }
    }

    private func queueSnapshot(debounce: Bool = false) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            if debounce { try? await Task.sleep(for: .milliseconds(120)) }
            guard !Task.isCancelled else { return }; await self?.pushSnapshot()
        }
    }

    private func pushSnapshot() async {
        revision &+= 1
        let question = visibleQuestion()
        let pages = drawerPages()
        drawerPage = min(drawerPage, max(0, pages.count - 1))
        let rows = pages.isEmpty ? [] : pages[drawerPage]
        let selected = handles[activeThreadID] ?? 0
        var snapshot = CodexWire.Snapshot(revision: revision, selected: selected, connected: connected,
            thinking: !activeTurnID.isEmpty, hasOlder: historyIndex + 1 < historyPages.count || olderCursor != nil,
            recording: voice.capturing, paused: pttSession && !voice.capturing,
            confirming: confirming, hasPreviousRows: drawerPage > 0,
            hasNextRows: drawerPage + 1 < pages.count,
            historyIndex: UInt8(min(historyIndex, Int(UInt8.max))),
            conversation: conversation, rows: rows,
            draft: pttSession ? voice.currentTranscript : "", question: question.text, options: question.options)
        if !connected && snapshot.conversation.isEmpty { snapshot.conversation = "KJDev is offline. Reconnecting…" }
        do {
            sequence &+= 1; try await send?(Wire.appData(id: CodexWire.appID, seq: sequence, blob: try CodexWire.encode(snapshot)))
        } catch { log("snapshot delivery failed", ["error": error.localizedDescription]) }
    }

    private func drawerPages() -> [[CodexWire.Row]] {
        var grouped: [(String, [ThreadRow])] = []
        for thread in threads {
            let name = projectName(for: thread)
            if let i = grouped.firstIndex(where: { $0.0 == name }) { grouped[i].1.append(thread) }
            else { grouped.append((name, [thread])) }
        }
        grouped.sort { lhs, rhs in
            if lhs.0 == "Unclassified" { return false }; if rhs.0 == "Unclassified" { return true }
            return lhs.0.localizedCaseInsensitiveCompare(rhs.0) == .orderedAscending
        }
        var pages: [[CodexWire.Row]] = [[]]
        // Six rows are all the 288 px drawer can display, and keeping the wire
        // page this small leaves deterministic room for local conversation text.
        let capacity = 6
        for (name, rows) in grouped {
            let heading = CodexWire.Row(handle: 0, title: name, project: true, status: 0)
            if pages[pages.count - 1].count >= capacity { pages.append([]) }
            pages[pages.count - 1].append(heading)
            for thread in rows.sorted(by: { $0.updatedAt > $1.updatedAt }) {
                if pages[pages.count - 1].count >= capacity { pages.append([heading]) }
                pages[pages.count - 1].append(.init(handle: handle(for: thread.id), title: thread.title, project: false, status: thread.status))
            }
        }
        return pages.count == 1 && pages[0].isEmpty ? [] : pages
    }

    private func visibleQuestion() -> (text: String, options: [String]) {
        guard let pending = pendingQuestion, pending.threadID == activeThreadID,
              pending.index < pending.questions.count else { return ("", []) }
        let question = pending.questions[pending.index]
        let text = question["question"] as? String ?? question["header"] as? String ?? "Choose an answer"
        let options = (question["options"] as? [[String: Any]] ?? []).compactMap { $0["label"] as? String }
        return (text, Array(options.prefix(3)))
    }

    private func projectName(for thread: ThreadRow) -> String {
        if let id = thread.projectID, let name = projects[id] { return name }
        let standardized = URL(fileURLWithPath: thread.cwd).standardizedFileURL.path
        if let root = configuredRoots.filter({ standardized == $0.path || standardized.hasPrefix($0.path + "/") })
            .max(by: { $0.path.count < $1.path.count }) { return root.name }
        return "Unclassified"
    }

    private func handle(for id: String) -> UInt16 {
        if let handle = handles[id] { return handle }
        while nextHandle == 0 || idsByHandle[nextHandle] != nil { nextHandle &+= 1 }
        let handle = nextHandle; nextHandle &+= 1; handles[id] = handle; idsByHandle[handle] = id; return handle
    }

    private func lost(_ error: Error) {
        connected = false; resumedThreads.removeAll(); statusMessage = "KJDev disconnected; reconnecting"
        log("disconnected", ["error": error.localizedDescription]); queueSnapshot()
    }

    private func updateLatest(_ mutation: (inout String) -> Void) {
        mutation(&latestConversation)
        if historyPages.isEmpty { historyPages = [latestConversation] }
        else { historyPages[0] = latestConversation }
        if historyIndex == 0 { conversation = latestConversation }
    }

    private static func replaceTrailingAgent(in conversation: inout String, with text: String) {
        if let range = conversation.range(of: "CODEX\n", options: .backwards) {
            conversation.replaceSubrange(range.lowerBound..<conversation.endIndex, with: "CODEX\n" + text)
        } else { conversation += (conversation.isEmpty ? "" : "\n\n") + "CODEX\n" + text }
    }

    static func render<S: Sequence>(turns: S) -> String where S.Element == [String: Any] {
        var blocks: [String] = []
        for turn in turns {
            for item in turn["items"] as? [[String: Any]] ?? [] {
                switch item["type"] as? String {
                case "userMessage":
                    let content = item["content"] as? [[String: Any]] ?? []
                    let text = content.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
                    if !text.isEmpty { blocks.append("YOU\n" + text) }
                case "agentMessage": if let text = item["text"] as? String, !text.isEmpty { blocks.append("CODEX\n" + text) }
                default: break
                }
            }
        }
        return blocks.joined(separator: "\n\n")
    }

    static func threadStatus(_ value: Any?) -> UInt8 {
        if let object = value as? [String: Any] {
            switch object["type"] as? String { case "active": return 1; case "idle": return 2; default: return 0 }
        }
        switch value as? String { case "active": return 1; case "idle": return 2; default: return 0 }
    }

    private func isNewer(_ value: UInt32, than old: UInt32) -> Bool {
        value != old && Int32(bitPattern: value &- old) > 0
    }

    private func setMicrophoneOff() throws { Task { try? await setMicrophone?(false) } }
    private func log(_ message: String, _ details: [String: Any] = [:]) {
        var details = details; details["message"] = message; event?("codex", details)
    }

    private func loadConfig() {
        let file = root.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        host = object["host"] as? String ?? host; socketPath = object["socketPath"] as? String ?? socketPath
        configuredRoots = (object["projects"] as? [[String: Any]] ?? []).compactMap {
            guard let name = $0["name"] as? String, let path = $0["root"] as? String else { return nil }
            return ProjectRoot(name: name, path: URL(fileURLWithPath: path).standardizedFileURL.path)
        }
    }

    private func loadState() {
        if let data = try? Data(contentsOf: root.appendingPathComponent("handles.json")),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Int] {
            for (id, raw) in object where raw > 0 && raw <= Int(UInt16.max) {
                let handle = UInt16(raw); handles[id] = handle; idsByHandle[handle] = id; nextHandle = max(nextHandle, handle &+ 1)
            }
        }
        if let data = try? Data(contentsOf: root.appendingPathComponent("state.json")),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            activeThreadID = object["activeThreadId"] as? String ?? ""
            lastSessionID = UInt32(object["lastSessionId"] as? Int ?? 0)
            lastCommandID = UInt32(object["lastCommandId"] as? Int ?? 0)
        }
    }
    private func saveHandles() {
        let object = handles.mapValues(Int.init)
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
            try? data.write(to: root.appendingPathComponent("handles.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
    private func saveState() {
        let object: [String: Any] = ["activeThreadId": activeThreadID, "lastSessionId": Int(lastSessionID), "lastCommandId": Int(lastCommandID)]
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
            try? data.write(to: root.appendingPathComponent("state.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}
