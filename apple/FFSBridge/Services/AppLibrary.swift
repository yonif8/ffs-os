import Foundation
import Combine

@MainActor
final class AppLibrary: ObservableObject {
    struct Entry: Identifiable { let id: Int; let name: String; let icon: Int; let saved: Bool; let listed: Bool }
    @Published private(set) var entries: [Entry] = []
    @Published private(set) var message = "App library ready"
    @Published private(set) var busy = false
    private let directory: URL
    private var packages: [Int: AppPackage] = [:]
    private var hiddenIDs = Set<Int>()
    private var recentLoadRequests: [UInt32] = []
    private var queue: Task<Void, Never>?
    private var settingsAcknowledged: Data?
    private var connectionGeneration: UInt64 = 0
    var send: ((Data) async throws -> Void)?
    var setting: ((String, Int) async throws -> Void)?
    var available: (() -> Bool)?
    init(root: URL) {
        directory = root.appendingPathComponent("AppLibrary", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "ffsa" {
            if let d = try? Data(contentsOf: url), let p = try? AppPackage(frame: d) { packages[p.id] = p }
        }
        for url in Bundle.main.urls(forResourcesWithExtension: "ffsa", subdirectory: nil) ?? [] {
            if let d = try? Data(contentsOf: url), let p = try? AppPackage(frame: d), packages[p.id] == nil {
                try? d.write(to: directory.appendingPathComponent("\(p.id).ffsa"), options: .atomic); packages[p.id] = p
            }
        }
        if let data = try? Data(contentsOf: directory.appendingPathComponent("hidden-apps.json")),
           let ids = try? JSONDecoder().decode([Int].self, from: data) {
            hiddenIDs = Set(ids.filter { (1...65534).contains($0) })
        }
        refresh()
    }
    private func stateURL(_ p: AppPackage) -> URL { directory.appendingPathComponent("\(p.id)-\(p.crc).state") }
    private func saved(_ p: AppPackage) -> Data { let d = (try? Data(contentsOf: stateURL(p))) ?? Data(); return d.count <= 48 ? d : Data() }
    private func refresh() { entries = packages.values.sorted { $0.id < $1.id }.map { Entry(id: $0.id, name: $0.name, icon: $0.image.u16(32), saved: !saved($0).isEmpty, listed: !hiddenIDs.contains($0.id)) } }
    func add(_ frame: Data) throws {
        let p = try AppPackage(frame: frame)
        guard packages[p.id] != nil || packages.count < 12 else { throw BridgeError.invalid("Library supports up to 12 apps") }
        try frame.write(to: directory.appendingPathComponent("\(p.id).ffsa"), options: .atomic)
        packages[p.id] = p
        if hiddenIDs.contains(p.id) { var next = hiddenIDs; next.remove(p.id); try persistHidden(next) }
        refresh()
    }
    private func persistHidden(_ next: Set<Int>) throws {
        try JSONEncoder().encode(next.sorted()).write(to: directory.appendingPathComponent("hidden-apps.json"), options: .atomic)
        hiddenIDs = next
    }
    /// Changes only the glasses catalog. The companion keeps the package and checkpoint.
    func setListed(id: Int, listed: Bool) throws {
        guard packages[id] != nil else { throw BridgeError.invalid("Unknown app") }
        var next = hiddenIDs
        if listed { next.remove(id) } else { next.insert(id) }
        if next != hiddenIDs { try persistHidden(next) }
        refresh(); message = "Catalog change saved; syncing with glasses"
        sync()
    }
    private func enqueue(_ work: @escaping () async throws -> Void) {
        let previous = queue
        queue = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            self.busy = true; defer { self.busy = false }
            do { guard self.available?() == true else { throw BridgeError.unavailable("Connect both glasses to use the library") }; try await work() }
            catch { self.message = error.localizedDescription }
        }
    }
    private func transmit(_ frame: Data) async throws {
        guard let send else { throw BridgeError.unavailable("App library transport unavailable") }
        try await send(frame)
    }

    func sync() {
        enqueue { [weak self] in
            guard let self else { return }
            // Remove first to make room, including removals staged while disconnected.
            let apps = self.packages.values.sorted(by: { $0.id < $1.id })
            for p in apps where self.hiddenIDs.contains(p.id) {
                try await self.transmit(p.frame(op: 3))
            }
            for p in apps where !self.hiddenIDs.contains(p.id) {
                try await self.transmit(p.frame(op: 5))
            }
            self.message = "\(apps.filter { !self.hiddenIDs.contains($0.id) }.count) apps available on glasses"
        }
    }
    func syncSettings(_ values: [String: Int]) {
        let frame = AppPackage.settingsFrame(brightness: values["brightness"], wear: values["wearDetection"], headup: values["headUp"])
        enqueue { [weak self] in
            guard let self, self.settingsAcknowledged != frame else { return }
            let generation = self.connectionGeneration
            do {
                try await self.transmit(frame)
                if generation == self.connectionGeneration { self.settingsAcknowledged = frame }
            } catch {
                self.settingsAcknowledged = nil
                throw error
            }
        }
    }
    func disconnected() {
        recentLoadRequests.removeAll(); settingsAcknowledged = nil; connectionGeneration &+= 1
    }
    func receive(_ d: Data) {
        guard d.count >= 8, d[0] == 1, d[1] == 0, d[3] & 1 != 0, d.count == 8+d.u16(6) else { return }
        let p = Data(d.dropFirst(8))
        switch d[2] {
        case 0x20:
            guard p.count == 4, let app = packages[p.u16(0)], !hiddenIDs.contains(app.id) else { return }
            let token = p.u16(2), request = p.u32(0)
            guard !recentLoadRequests.contains(request) else { return }
            recentLoadRequests.append(request)
            if recentLoadRequests.count > 32 { recentLoadRequests.removeFirst() }
            enqueue { [weak self] in
                guard let self, !self.hiddenIDs.contains(app.id) else { return }; self.message = "Opening \(app.name)"
                // Refresh possibly older persistent metadata, then restore content only
                // for the app the wearer actually selected. Empty state clears stale RAM.
                try await self.transmit(app.frame(op: 5))
                try await self.transmit(app.frame(op: 6, state: self.saved(app)))
                guard !self.hiddenIDs.contains(app.id) else { return }
                try await self.transmit(app.frame(op: 8, token: token)); self.message = "\(app.name) is open"
            }
        case 0x21:
            guard p.count >= 6, p.count <= 54, let app = packages[p.u16(0)], app.crc == p.u32(2) else { return }
            do { try Data(p.dropFirst(6)).write(to: stateURL(app), options: .atomic); refresh(); message = "Saved \(app.name)" }
            catch { message = "Could not save \(app.name): \(error.localizedDescription)" }
        case 0x22:
            guard p.count == 2, p[0] <= 2 else { return }
            let key = ["brightness", "wear", "headup"][Int(p[0])], value = Int(p[1])
            enqueue { [weak self] in try await self?.setting?(key, value) }
        default: break
        }
    }
    func status() -> [String: Any] {
        ["apps": entries.map { ["id": $0.id, "name": $0.name, "icon": $0.icon, "saved": $0.saved, "listed": $0.listed] as [String: Any] }, "message": message, "busy": busy]
    }
}
