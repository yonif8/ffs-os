import Foundation
import Combine

@MainActor
final class CatalogSyncGate {
    private(set) var synchronized = false
    private(set) var running = false
    private var generation: UInt64 = 0

    var needsAutomaticSync: Bool { !synchronized && !running }

    func invalidate() {
        generation &+= 1
        synchronized = false
        running = false
    }
    func begin() -> UInt64 {
        generation &+= 1
        synchronized = false
        running = true
        return generation
    }
    func finish(_ succeeded: Bool, generation expectedGeneration: UInt64) {
        guard generation == expectedGeneration else { return }
        running = false
        synchronized = succeeded
    }
    func disconnected() {
        invalidate()
    }
}

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
    private var queue: Task<Bool, Never>?
    private var settingsAcknowledged: Data?
    private var connectionGeneration: UInt64 = 0
    let catalogSync = CatalogSyncGate()
    /// The first catalog-reset after a cold boot triggers a FlashDB metadata wipe that can take far
    /// longer than the 8 s default paired-command timeout; give it a generous budget so the bridge
    /// does not abandon a write the firmware is still completing.
    private static let catalogResetTimeout: Duration = .seconds(30)
    var send: ((Data, Duration?) async throws -> Void)?
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
        let alreadyListed = packages[p.id] != nil && !hiddenIDs.contains(p.id)
        let listedCount = packages.keys.filter { !hiddenIDs.contains($0) }.count
        guard alreadyListed || listedCount < 12 else { throw BridgeError.invalid("Remove an app from the glasses before adding another") }
        try frame.write(to: directory.appendingPathComponent("\(p.id).ffsa"), options: .atomic)
        packages[p.id] = p
        if hiddenIDs.contains(p.id) { var next = hiddenIDs; next.remove(p.id); try persistHidden(next) }
        refresh(); catalogSync.invalidate()
    }
    private func persistHidden(_ next: Set<Int>) throws {
        try JSONEncoder().encode(next.sorted()).write(to: directory.appendingPathComponent("hidden-apps.json"), options: .atomic)
        hiddenIDs = next
    }
    /// Changes only the glasses catalog. The companion keeps the package and checkpoint.
    @discardableResult func setListed(id: Int, listed: Bool) throws -> Task<Bool, Never> {
        guard packages[id] != nil else { throw BridgeError.invalid("Unknown app") }
        if listed && hiddenIDs.contains(id) {
            guard packages.keys.filter({ !hiddenIDs.contains($0) }).count < 12 else {
                throw BridgeError.invalid("Glasses catalog supports up to 12 apps")
            }
        }
        var next = hiddenIDs
        if listed { next.remove(id) } else { next.insert(id) }
        if next != hiddenIDs { try persistHidden(next) }
        refresh(); message = "Catalog change saved; syncing with glasses"
        return sync()
    }
    @discardableResult private func enqueue(_ work: @escaping () async throws -> Void,
                                            completion: ((Bool) -> Void)? = nil) -> Task<Bool, Never> {
        let previous = queue
        let next = Task { [weak self] in
            _ = await previous?.value
            guard let self else { return false }
            self.busy = true; defer { self.busy = false }
            do {
                guard self.available?() == true else { throw BridgeError.unavailable("Connect both glasses to use the library") }
                try await work()
                completion?(true)
                return true
            } catch {
                self.message = error.localizedDescription
                completion?(false)
                return false
            }
        }
        queue = next
        return next
    }
    private func transmit(_ frame: Data, timeout: Duration? = nil) async throws {
        guard let send else { throw BridgeError.unavailable("App library transport unavailable") }
        try await send(frame, timeout)
    }

    @discardableResult func sync() -> Task<Bool, Never> {
        let generation = catalogSync.begin()
        return enqueue({ [weak self] in
            guard let self else { throw BridgeError.unavailable("App library closed") }
            let apps = self.packages.values.sorted(by: { $0.id < $1.id })
            // Reset first so both lenses rebuild the same complete snapshot even if
            // either one contains entries this companion has never seen. The cold-boot
            // reset write is slow, so this frame alone gets the longer timeout.
            try await self.transmit(AppPackage.catalogResetFrame(), timeout: Self.catalogResetTimeout)
            for p in apps where !self.hiddenIDs.contains(p.id) {
                try await self.transmit(p.frame(op: 5))
            }
            self.message = "\(apps.filter { !self.hiddenIDs.contains($0.id) }.count) apps available on glasses"
        }, completion: { [weak self] succeeded in
            self?.catalogSync.finish(succeeded, generation: generation)
        })
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
        catalogSync.disconnected(); recentLoadRequests.removeAll(); settingsAcknowledged = nil; connectionGeneration &+= 1
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
