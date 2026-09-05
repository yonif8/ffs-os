import SwiftUI
import UniformTypeIdentifiers

@main
struct FFSBridgeApp: App {
    @StateObject private var model = BridgeModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            BridgeView(model: model)
                .preferredColorScheme(.dark)
                .tint(Color(red: 0.61, green: 0.93, blue: 0.48))
                .onChange(of: phase) { _, next in model.setForeground(next == .active) }
                .onChange(of: model.developer.enabled) { _, _ in model.setForeground(phase == .active) }
                .onChange(of: model.flasher.active) { _, _ in model.setForeground(phase == .active) }
        }
    }
}

struct BridgeView: View {
    @ObservedObject var model: BridgeModel
    @State private var showFirmwarePicker = false
    @State private var showFlashConfirmation = false
    @State private var brightness = 35.0
    @State private var speech = "Hello from FFS"
    @State private var audioURL = ""
    @State private var query = ""
    @State private var hits: [[String: Any]] = []
    @State private var showPairingKey = false
    @State private var configText = ""
    @State private var showConfig = false
    @State private var shareURL: URL?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("FFS").font(.system(size: 38, weight: .bold, design: .rounded))
                            Text("GLASSES BRIDGE").font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Label(model.link.pairReady ? "PAIR READY" : "OFFLINE", systemImage: model.link.pairReady ? "checkmark.circle.fill" : "circle")
                            .font(.caption.bold()).foregroundStyle(model.link.pairReady ? Color.green : Color.secondary)
                    }.padding(.vertical, 10)
                    ForEach(["L", "R"], id: \.self) { side in
                        let lens = model.link.lenses[side]!
                        HStack {
                            Text(side).font(.headline.monospaced()).frame(width: 22)
                            Circle().fill(lens.ready ? Color.green : Color.gray).frame(width: 7, height: 7)
                            VStack(alignment: .leading) {
                                Text(lens.name).font(.subheadline)
                                Text(lens.state).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing) {
                                Text(lens.battery.map { "\($0)%" } ?? "—").font(.subheadline.monospacedDigit())
                                if let rssi = lens.rssi { Text("\(rssi) dBm").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                    HStack {
                        Button("Connect", systemImage: "link") { model.perform { try model.link.connect() } }
                        Spacer()
                        Button("Disconnect") { model.perform { try model.link.disconnect() } }.foregroundStyle(.secondary)
                    }.disabled(model.flasher.active)
                    Text(model.link.bluetooth).font(.caption).foregroundStyle(.secondary)
                }
                Section("Glasses") {
                    HStack {
                        Label(model.link.micLive ? "Microphone streaming" : "Microphone quiet", systemImage: model.link.micLive ? "mic.fill" : "mic.slash")
                            .foregroundStyle(model.link.micLive ? Color.orange : Color.secondary)
                        Spacer()
                        Button("Close mic") { model.perform { try await model.link.settings("mic", value: 0) } }.disabled(!model.link.pairReady || model.flasher.active)
                    }.font(.subheadline)
                    ForEach(["L", "R"], id: \.self) { side in
                        LabeledContent("\(side) firmware", value: model.link.lenses[side]?.version ?? "—").font(.caption)
                    }
                    HStack {
                        Button("Refresh info") { model.perform { try await model.link.settings("info") } }
                        Spacer()
                        Button("Wake display") { model.perform { try await model.link.settings("wake", value: 1) } }
                    }.disabled(!model.link.pairReady || model.flasher.active)
                    DisclosureGroup("Display controls") {
                        if model.link.lenses["R"]?.settingsSnapshot["silentMode"] == 1 {
                            Text("Display sleep mode is on. Wake display clears it and starts the dashboard.")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        HStack { Text("Brightness"); Slider(value: $brightness, in: 0...100, step: 1); Text("\(Int(brightness))").monospacedDigit() }
                        Button("Apply brightness") { model.perform { try await model.link.settings("brightness", value: Int(brightness)) } }
                        HStack {
                            Button("Wear detection on") { model.perform { try await model.link.settings("wear", value: 1) } }
                            Spacer()
                            Button("Off") { model.perform { try await model.link.settings("wear", value: 0) } }
                        }
                        ForEach(["L", "R"], id: \.self) { side in
                            if let text = model.link.lenses[side]?.diagnostics["loader"] { Text("\(side): \(text)").font(.caption.monospaced()).textSelection(.enabled) }
                        }
                    }.disabled(!model.link.pairReady || model.flasher.active)
                }
                Section("Mac connection") {
                    Toggle("Developer connection", isOn: Binding(get: { model.developer.enabled }, set: { _ in model.toggleDeveloper() }))
                    Text(model.developer.status).font(.caption).foregroundStyle(.secondary)
                    if model.developer.enabled {
                        Text("Keep this app open during development and firmware transfers. Your Mac uses the same Wi-Fi network.").font(.caption).foregroundStyle(.secondary)
                        DisclosureGroup("Pair this Mac", isExpanded: $showPairingKey) {
                            Text("The Mac can import the pairing key over USB using the included tool, or you can copy it below.").font(.caption)
                            Text(model.developer.pairingKey).font(.caption.monospaced()).textSelection(.enabled)
                            Button("Copy pairing key") { UIPasteboard.general.string = model.developer.pairingKey }
                        }
                    }
                }
                Section("Firmware") {
                    Button(model.firmwareFile == nil ? "Choose firmware file…" : "Choose another firmware file…", systemImage: "doc.badge.arrow.up") { showFirmwarePicker = true }.disabled(model.flasher.active)
                    TextField("CI SHA-256 (64 hex digits)", text: $model.firmwareSHA).font(.caption.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(model.flasher.active)
                    Toggle("Allow SHA-pinned custom build", isOn: $model.allowUnknownFirmware).font(.subheadline).disabled(model.flasher.active)
                    HStack {
                        Button("Validate — no writes") { runFlash(dry: true) }
                        Spacer()
                        Button("Flash glasses") { showFlashConfirmation = true }.foregroundStyle(.orange)
                    }.disabled(model.firmwareFile == nil || model.firmwareSHA.count != 64 || !model.link.pairReady || model.flasher.active || model.voice.running)
                    if model.flasher.active { ProgressView(value: model.flasher.progress) }
                    Text(model.flasher.message).font(.caption).foregroundStyle(model.flasher.success == false ? Color.orange : Color.secondary)
                }
                Section("Voice") {
                    Text(model.voice.statusMessage).font(.subheadline)
                    HStack {
                        Button(model.voice.running ? "Stop capture" : "Start capture") {
                            model.perform {
                                if model.voice.running { model.voice.stop(); try await model.link.settings("mic", value: 0) }
                                else { _ = try model.voice.start(); try await model.link.settings("mic", value: 1) }
                            }
                        }.disabled(!model.link.pairReady || model.flasher.active)
                        Spacer(); Text("\(model.voice.pendingCount) pending").font(.caption).foregroundStyle(.secondary)
                    }
                    DisclosureGroup("Transcription and recordings") {
                        Toggle("Live text on glasses", isOn: Binding(get: { model.voice.liveOnGlasses }, set: { model.voice.liveOnGlasses = $0 }))
                        Text(model.voice.config.summary).font(.caption).foregroundStyle(.secondary)
                        Button("Configure provider…") { showConfig = true }
                        HStack {
                            TextField("Search transcripts", text: $query)
                            Button("Search") { model.perform { hits = try model.voice.search(query) } }
                        }
                        ForEach(hits.indices, id: \.self) { i in
                            VStack(alignment: .leading) {
                                Text(hits[i]["snippet"] as? String ?? "").font(.subheadline)
                                Text(hits[i]["provider"] as? String ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        ForEach(model.voice.sessions(limit: 10).compactMap { $0["id"] as? String }, id: \.self) { id in
                            HStack {
                                Text(id).font(.caption.monospaced()).lineLimit(1)
                                Spacer()
                                Button("Export WAV") { model.perform { shareURL = try model.voice.export(id) } }
                            }
                        }
                        if let shareURL { ShareLink("Share recording", item: shareURL) }
                    }
                }
                Section {
                    DisclosureGroup("Buzzer audio") {
                        TextField("Text to speak", text: $speech)
                        HStack {
                            Button("Speak") { model.perform { _ = try model.buzzer.speak(speech) } }
                            Spacer(); Button("Stop") { model.buzzer.stop() }
                        }
                        TextField("Audio URL", text: $audioURL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Play URL") { model.perform { guard let url = URL(string: audioURL) else { return }; _ = try model.buzzer.play(url) } }
                        Text("\(model.buzzer.state) \(model.buzzer.detail)").font(.caption).foregroundStyle(.secondary)
                    }.disabled(model.flasher.active)
                }
                if let image = model.screenshot {
                    Section("Last framebuffer") {
                        Image(uiImage: image).resizable().interpolation(.none).aspectRatio(contentMode: .fit).listRowBackground(Color.black)
                        Text(model.screenshotDescription).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Activity") {
                    if model.activity.isEmpty { Text("Bridge events will appear here.").foregroundStyle(.secondary) }
                    ForEach(model.activity.suffix(30).reversed()) { entry in
                        HStack(alignment: .top) {
                            Text(entry.time, style: .time).font(.caption2.monospaced()).foregroundStyle(.secondary)
                            Text(entry.message).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .fileImporter(isPresented: $showFirmwarePicker, allowedContentTypes: [.data]) { result in model.perform { try model.importFirmware(result.get()) } }
            .confirmationDialog("Flash the selected firmware to both lenses?", isPresented: $showFlashConfirmation, titleVisibility: .visible) {
                Button("Flash verified firmware", role: .destructive) { runFlash(dry: false) }
            } message: { Text("Complete a successful dry-run first. Keep the app open and both lenses powered and nearby until reconnection is verified.") }
            .alert("FFS Bridge", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) { Button("OK") { model.errorMessage = nil } } message: { Text(model.errorMessage ?? "") }
            .sheet(isPresented: $showConfig) {
                NavigationStack {
                    Form {
                        Text("Paste the same provider JSON schema used by the Android bridge. Credentials stay in private app storage. Leave empty to disable transcription.").font(.caption)
                        TextEditor(text: $configText).font(.caption.monospaced()).frame(minHeight: 260).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Save configuration") { model.perform { try model.voice.setConfig(configText); configText = ""; showConfig = false } }
                    }.navigationTitle("Speech provider").toolbar { Button("Cancel") { configText = ""; showConfig = false } }
                }
            }
        }
    }
    private func runFlash(dry: Bool) {
        model.perform {
            guard let file = model.firmwareFile else { return }
            guard !model.voice.running else { throw BridgeError.unavailable("Stop recording before flashing") }
            model.buzzer.stop()
            try model.flasher.start(file: file, sha: model.firmwareSHA.trimmingCharacters(in: .whitespacesAndNewlines), dry: dry, allowUnknown: model.allowUnknownFirmware)
        }
    }
}
