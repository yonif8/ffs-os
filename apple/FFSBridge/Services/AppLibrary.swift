import Foundation
import Combine

@MainActor
final class AppLibrary: ObservableObject {
    struct Entry: Identifiable { let id: Int; let name: String; let saved: Bool }
    @Published private(set) var entries: [Entry] = []
    @Published private(set) var message = "App library ready"
    @Published private(set) var busy = false
    private let directory: URL
    private var packages: [Int: AppPackage] = [:]
    private var recentLoadRequests: [UInt32] = []
    private var queue: Task<Void, Never>?
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
        refresh()
    }
    private func stateURL(_ p: AppPackage) -> URL { directory.appendingPathComponent("\(p.id)-\(p.crc).state") }
    private func saved(_ p: AppPackage) -> Data { let d = (try? Data(contentsOf: stateURL(p))) ?? Data(); return d.count <= 48 ? d : Data() }
    private func refresh() { entries = packages.values.sorted { $0.id < $1.id }.map { Entry(id: $0.id, name: $0.name, saved: !saved($0).isEmpty) } }
    func add(_ frame: Data) throws {
        let p = try AppPackage(frame: frame)
        guard packages[p.id] != nil || packages.count < 12 else { throw BridgeError.invalid("Library supports up to 12 apps") }
        try frame.write(to: directory.appendingPathComponent("\(p.id).ffsa"), options: .atomic)
        packages[p.id] = p; refresh()
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
            for p in self.packages.values.sorted(by: { $0.id < $1.id }) {
                try await self.transmit(p.frame(op: 5))
                let state = self.saved(p)
                if !state.isEmpty { try await self.transmit(p.frame(op: 6, state: state)) }
            }
            self.message = "\(self.packages.count) apps available on glasses"
        }
    }
    func syncSettings(_ values: [String: Int]) {
        enqueue { [weak self] in
            try await self?.transmit(AppPackage.settingsFrame(brightness: values["brightness"], wear: values["wearDetection"], headup: values["headUp"]))
        }
    }
    func disconnected() { recentLoadRequests.removeAll() }
    func receive(_ d: Data) {
        guard d.count >= 8, d[0] == 1, d[1] == 0, d[3] & 1 != 0, d.count == 8+d.u16(6) else { return }
        let p = Data(d.dropFirst(8))
        switch d[2] {
        case 0x20:
            guard p.count == 4, let app = packages[p.u16(0)] else { return }
            let token = p.u16(2), request = p.u32(0)
            guard !recentLoadRequests.contains(request) else { return }
            recentLoadRequests.append(request)
            if recentLoadRequests.count > 32 { recentLoadRequests.removeFirst() }
            enqueue { [weak self] in
                guard let self else { return }; self.message = "Opening \(app.name)"
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
        ["apps": entries.map { ["id": $0.id, "name": $0.name, "saved": $0.saved] as [String: Any] }, "message": message, "busy": busy]
    }
}
