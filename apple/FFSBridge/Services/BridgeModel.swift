import Foundation
import Combine
#if os(macOS)
import AppKit
typealias UIImage = NSImage
extension NSImage {
    convenience init(cgImage: CGImage) { self.init(cgImage: cgImage, size: .zero) }
    func pngData() -> Data? { tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .png, properties: [:]) }
}
#else
import UIKit
#endif

struct ActivityEntry: Identifiable {
    let id: Int, time: Date, kind: String, message: String
    let details: [String: Any]
}

@MainActor
final class BridgeModel: ObservableObject {
    let link = GlassesLink()
    let flasher: FirmwareFlasher
    let paired = PairedCommands()
    let library: AppLibrary
    let voice: VoiceService
    let buzzer: BuzzerAudio
    let developer: DeveloperServer
    let root: URL
    @Published var activity: [ActivityEntry] = []
    @Published var screenshot: UIImage?
    @Published var screenshotDescription = "No screenshot received"
    @Published var firmwareFile: URL?
    @Published var firmwareSHA = ""
    @Published var allowUnknownFirmware = false
    @Published var errorMessage: String?
    private var fb = Framebuffer()
    private var eventID = 0
    private var eventBuffer: [[String: Any]] = []
    private var subscriptions = Set<AnyCancellable>()
    private var commandBusy = false
    private var librarySynced = false
    private var automaticLibrarySync = true
    private var fbFlush: Task<Void, Never>?
    init() {
        #if os(macOS)
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FFSBridgeMac")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        #else
        root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        #endif
        library = AppLibrary(root: root)
        flasher = FirmwareFlasher(link: link); voice = VoiceService(root: root); buzzer = BuzzerAudio(link: link); developer = DeveloperServer(root: root)
        for publisher in [library.objectWillChange, link.objectWillChange, flasher.objectWillChange, voice.objectWillChange, buzzer.objectWillChange, developer.objectWillChange] {
            publisher.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        }
        let forward: (String, [String: Any]) -> Void = { [weak self] name, details in self?.record(name, details) }
        link.event = forward; flasher.event = forward; voice.event = forward; buzzer.event = forward
        link.audio = { [weak self] data, side in self?.voice.submit(data, side: side) }
        link.serviceMessage = { [weak self] sid, data, side in
            guard let self else { return }
            if sid == 0x91 { self.paired.receive(data); self.library.receive(data); self.buzzer.receive(data); self.decodeEvent(data, side: side) }
            if sid == 0x30, self.fb.feed(data) {
                self.fbFlush?.cancel()
                if self.fb.complete { self.finishScreenshot() }
                else { self.fbFlush = Task { [weak self] in try? await Task.sleep(for: .milliseconds(900)); guard !Task.isCancelled else { return }; self?.finishScreenshot() } }
            }
        }
        paired.transport = { [weak self] d in guard let self else { throw BridgeError.unavailable("Bridge closed") }; try await self.link.send(d) }
        library.send = { [weak self] d in guard let self else { throw BridgeError.unavailable("Bridge closed") }; try await self.paired.send(d) }
        library.available = { [weak self] in self?.link.pairReady == true && self?.flasher.active == false }
        library.setting = { [weak self] key, value in
            guard let self else { return }; try await self.link.settings(key, value: value)
            try await Task.sleep(for: .milliseconds(200)); try await self.link.settings("info")
        }
        voice.send = { [weak self] d in guard let self else { throw BridgeError.unavailable("Bridge closed") }; if PairedCommands.accepts(d) { try await self.paired.send(d) } else { try await self.link.send(d) } }
        developer.command = { [weak self] name, args in guard let self else { throw BridgeError.unavailable("Bridge closed") }; return try await self.command(name, args) }
    }
    func perform(_ action: @escaping () async throws -> Void) {
        Task { do { try await action() } catch { errorMessage = error.localizedDescription } }
    }
    func setForeground(_ foreground: Bool) {
        #if !os(macOS)
        UIApplication.shared.isIdleTimerDisabled = foreground && (developer.enabled || flasher.active)
        if !foreground && developer.enabled { record("log", ["message": "Mac commands require this app in the foreground; Bluetooth restoration remains enabled."]) }
        #endif
    }
    func toggleDeveloper() {
        if developer.enabled { developer.stop() } else { do { try developer.start() } catch { errorMessage = error.localizedDescription } }
    }
    private func record(_ name: String, _ details: [String: Any]) {
        if name == "disconnected" { librarySynced = false; paired.disconnected(); library.disconnected() }
        if name == "pairReady", !flasher.active { perform { try await self.link.settings(self.library.entries.isEmpty ? "info" : "wake", value: 1) } }
        if automaticLibrarySync, name == "deviceInfo", details["side"] as? String == "R", !flasher.active, link.pairReady,
           link.lenses["R"]?.diagnostics["loader"]?.contains("shell=2") == true,
           let values = link.lenses["R"]?.settingsSnapshot, !values.isEmpty {
            if !librarySynced { librarySynced = true; library.sync() }
            library.syncSettings(values)
        }
        eventID += 1
        eventBuffer.append(["id": eventID, "time": Date().timeIntervalSince1970, "event": name, "data": details])
        if eventBuffer.count > 2000 { eventBuffer.removeFirst(eventBuffer.count - 2000) }
        // Raw service packets remain available to authenticated developer tools; never flood the status screen.
        guard name != "service", name != "transport" else { return }
        let text = details["message"] as? String ?? (details["side"] as? String).map { "\($0) · \(name)" } ?? name
        activity.append(ActivityEntry(id: eventID, time: Date(), kind: name, message: text, details: details))
        if activity.count > 200 { activity.removeFirst() }
    }
    private func decodeEvent(_ d: Data, side: String) {
        guard d.count >= 8, d[0] == 1, d.count == 8 + d.u16(6) else { return }
        let origin = d[3] & 1 != 0 ? "R" : "L"
        record("glassesEvent", ["side": side, "origin": origin, "source": Int(d[1]), "type": Int(d[2]), "sequence": d.u16(4), "length": d.u16(6)])
    }
    private func finishScreenshot() {
        guard fb.received > 0 else { return }
        try? fb.bytes.write(to: root.appendingPathComponent("fbshot.a4"), options: .atomic)
        var pixels = Data(capacity: Framebuffer.width * Framebuffer.height * 4)
        for b in fb.bytes {
            for nibble in [b >> 4, b & 15] { let value = nibble * 17; pixels.append(contentsOf: [0, value, 0, 255]) }
        }
        if let provider = CGDataProvider(data: pixels as CFData), let image = CGImage(width: Framebuffer.width, height: Framebuffer.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: Framebuffer.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
            screenshot = UIImage(cgImage: image)
            try? screenshot?.pngData()?.write(to: root.appendingPathComponent("fbshot.png"), options: .atomic)
        }
        screenshotDescription = "Right lens · \(fb.complete ? "complete" : "partial") · \(fb.received)/\(Framebuffer.size) bytes"
        record("screenshot", ["message": screenshotDescription, "complete": fb.complete, "generation": fb.generation])
    }
    func importFirmware(_ url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard data.count <= 32 * 1024 * 1024 else { throw BridgeError.invalid("Firmware too large") }
        let target = root.appendingPathComponent("firmware.bin"); try data.write(to: target, options: .atomic); firmwareFile = target
    }
    static var platformName: String {
        #if os(macOS)
        return "macOS"
        #else
        return "iOS"
        #endif
    }
    func status() -> [String: Any] {
        ["app": "FFS Bridge", "version": "1.0", "platform": Self.platformName, "pairReady": link.pairReady, "pairAuthenticated": link.pairAuthenticated,
         "bluetooth": link.bluetooth, "micLive": link.micLive, "eventCursor": eventID,
         "lenses": ["L", "R"].map { side -> [String: Any] in
             let l = link.lenses[side]!
             return ["side": side, "name": l.name, "state": l.state, "ready": l.ready, "authenticated": l.authenticated, "version": l.version,
                     "battery": l.battery as Any? ?? NSNull(), "rssi": l.rssi as Any? ?? NSNull(), "writeLimit": l.writeLimit, "receiveCount":l.receiveCount, "diagnostics": l.diagnostics,
                     "infoReceivedAt": l.infoReceivedAt?.timeIntervalSince1970 as Any? ?? NSNull(), "settings": l.settingsSnapshot]
         }, "flash": ["active": flasher.active, "message": flasher.message, "progress": flasher.progress, "ok": flasher.success as Any? ?? NSNull()],
         "pairedBusy": paired.busy, "library": library.status(), "voice": voice.status(), "buzzer": ["state": buzzer.state, "message": buzzer.detail]]
    }
    func command(_ name: String, _ args: [String: Any]) async throws -> [String: Any] {
        if name == "status" { return status() }
        if name == "libraryStatus" { return library.status() }
        if name == "events" {
            let since = args["since"] as? Int ?? 0
            let values = eventBuffer.filter { ($0["id"] as? Int ?? 0) > since }
            return ["cursor": eventID, "events": values, "truncated": since > 0 && since < (eventBuffer.first?["id"] as? Int ?? 0) - 1]
        }
        guard !library.busy || ["screenshot", "screenshotReset", "disconnect"].contains(name) else { throw BridgeError.unavailable("App library is using the glasses; retry when it is idle") }
        guard !commandBusy else { throw BridgeError.unavailable("Another developer command owns the bridge") }
        commandBusy = true; defer { commandBusy = false }
        let side = args["side"] as? String
        if let side { guard ["L", "R"].contains(side) else { throw BridgeError.invalid("Side must be L or R") } }
        switch name {
        case "libraryAdd":
            guard let encoded = args["base64"] as? String, let frame = Data(base64Encoded: encoded) else { throw BridgeError.invalid("Native app frame required") }
            try library.add(frame)
            return library.status()
        case "librarySetListed":
            guard let id = args["id"] as? Int, let listed = args["listed"] as? Bool else { throw BridgeError.invalid("Supply app id and listed") }
            try library.setListed(id: id, listed: listed)
            return library.status()
        case "libraryAutoSync": automaticLibrarySync = args["enabled"] as? Bool ?? true; return ["enabled": automaticLibrarySync]
        case "librarySync": library.sync(); return library.status()
        case "connect": try link.connect(side)
        case "disconnect": try link.disconnect()
        case "scan": try link.startScan()
        case "stopScan": link.stopScan()
        case "deviceInfo": try await link.settings("info", side: side)
        case "connectionHeartbeat": try await link.connectionHeartbeat()
        case "connectionHeartbeatEnabled":
            guard let enabled = args["enabled"] as? Bool else { throw BridgeError.invalid("enabled is required") }
            try link.setConnectionHeartbeat(enabled: enabled)
        case "setting": try await link.settings(args["key"] as? String ?? "query", value: args["value"] as? Int ?? 0, side: side, auto: args["auto"] as? Bool ?? false)
        case "push":
            guard let b64 = args["base64"] as? String, let data = Data(base64Encoded: b64), !data.isEmpty, let sid = UInt8(exactly: args["serviceId"] as? Int ?? 0x90) else { throw BridgeError.invalid("Invalid payload") }
            if sid == 0x90 && PairedCommands.accepts(data) {
                guard side == nil else { throw BridgeError.invalid("App and data commands require both lenses") }
                try await paired.send(data)
                return ["written": data.count, "executed": true, "paired": true]
            }
            guard !paired.busy else { throw BridgeError.unavailable("A paired command still owns the loader") }
            try await link.send(data, sid: sid, side: side)
            return ["written": data.count, "executed": false, "note": "Bluetooth write only; verify loader execution and pixels separately"]
        case "appData":
            guard let id = args["appId"] as? Int, let seq = args["seq"] as? Int else { throw BridgeError.invalid("appId and seq required") }
            let blob = (args["text"] as? String).map { Data($0.utf8) } ?? Data(base64Encoded: args["base64"] as? String ?? "") ?? Data()
            try await paired.send(Wire.appData(id: id, seq: seq, blob: blob, clear: args["clear"] as? Bool ?? false))
        case "screenshotReset": fb.reset(); screenshot = nil; screenshotDescription = "Waiting for a new framebuffer"
        case "screenshot":
            guard fb.received > 0 else { throw BridgeError.unavailable("No framebuffer received; push the current fb_shot payload first") }
            let format = args["format"] as? String ?? "png", data = format == "a4" ? fb.bytes : screenshot?.pngData()
            guard let data else { throw BridgeError.unavailable("Screenshot not assembled") }
            return ["base64": data.base64EncodedString(), "complete": fb.complete, "received": fb.received, "side": "R", "generation": fb.generation]
        case "uploadFirmware":
            guard !flasher.active, let b64 = args["base64"] as? String, let data = Data(base64Encoded: b64), data.count <= 32 * 1024 * 1024 else { throw BridgeError.invalid("Invalid firmware upload") }
            let target = root.appendingPathComponent("firmware.bin"); try data.write(to: target, options: .atomic); firmwareFile = target
            return ["bytes": data.count]
        case "flash":
            guard let file = firmwareFile, let sha = args["sha256"] as? String else { throw BridgeError.invalid("Upload firmware and supply its CI SHA-256") }
            guard !voice.running, !["starting", "streaming", "synthesizing", "fetching", "converting", "retry"].contains(buzzer.state) else { throw BridgeError.unavailable("Stop voice/audio before flashing") }
            try flasher.start(file: file, sha: sha, dry: args["dryRun"] as? Bool ?? true, allowUnknown: args["allowUnknownGolden"] as? Bool ?? false)
        case "flashProbe": return ["leftReady": link.otaReady("L"), "rightReady": link.otaReady("R")]
        case "voiceStart":
            voice.liveOnGlasses = args["live"] as? Bool ?? true
            if let capture = args["captureSide"] as? String { voice.captureSide = capture }
            let session = try voice.start()
            do { try await link.settings("mic", value: 1) }
            catch { voice.stop(); throw error }
            return ["sessionId": session]
        case "voiceStop": voice.stop(); try await link.settings("mic", value: 0)
        case "voiceClear": try await voice.clearFace()
        case "voiceStatus": return voice.status()
        case "voiceConfig": try voice.setConfig(args["json"] as? String ?? "")
        case "voiceConfigStatus": return ["summary": voice.config.summary]
        case "voiceSessions": return ["sessions": voice.sessions(limit: args["limit"] as? Int ?? 100)]
        case "voiceSearch": return ["hits": try voice.search(args["query"] as? String ?? "", limit: args["limit"] as? Int ?? 30)]
        case "voiceExport":
            let url = try voice.export(args["sessionId"] as? String ?? voice.sessionID)
            guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 32 * 1024 * 1024 else { throw BridgeError.invalid("Use Files app to share recordings larger than 32 MB") }
            return ["base64": try Data(contentsOf: url).base64EncodedString(), "filename": "recording.wav"]
        case "buzzerSpeak": return ["requestId": try buzzer.speak(args["text"] as? String ?? "")]
        case "buzzerPlay": guard let url = URL(string: args["url"] as? String ?? "") else { throw BridgeError.invalid("Audio URL required") }; return ["requestId": try buzzer.play(url)]
        case "buzzerStop": buzzer.stop()
        default: throw BridgeError.invalid("Unknown bridge command: \(name)")
        }
        return ["accepted": true]
    }
}
