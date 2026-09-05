import SwiftUI
import AppKit
import UniformTypeIdentifiers

@main struct FFSDevBridgeApp: App {
    @StateObject private var model = BridgeModel()
    var body: some Scene {
        WindowGroup("FFS Dev Bridge") {
            MacBridgeView(model: model).frame(minWidth: 900, minHeight: 680)
                .preferredColorScheme(.dark).tint(.green)
                .task {
                    do {
                        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config/ffs")
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        let file = directory.appendingPathComponent("mac.json")
                        let data = try JSONSerialization.data(withJSONObject: ["host":"127.0.0.1", "port":Int(model.developer.port), "key":model.developer.pairingKey])
                        try data.write(to: file, options: .atomic)
                        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
                        try model.developer.start()
                    } catch { model.errorMessage = error.localizedDescription }
                }
        }.defaultSize(width: 1040, height: 780)
    }
}

struct MacBridgeView: View {
    @ObservedObject var model: BridgeModel
    @State private var command = "status"
    @State private var arguments = "{}"
    @State private var response = "Run a command to inspect its response."
    @State private var importFirmware = false
    @State private var flashConfirm = false
    @State private var speech = "Hello from the Mac"
    @State private var config = ""
    @State private var query = ""
    @State private var hits = ""
    var body: some View {
        HSplitView {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        VStack(alignment: .leading) {
                            Text("FFS").font(.system(size: 40, weight: .bold, design: .rounded))
                            Text("DIRECT MAC BRIDGE").font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Label(model.link.pairReady ? "Pair ready" : "Offline", systemImage: model.link.pairReady ? "checkmark.circle.fill" : "circle").foregroundStyle(model.link.pairReady ? .green : .secondary)
                    }
                    Text("Mac Bluetooth → G2 glasses · no phone required").foregroundStyle(.secondary)
                    ForEach(["L", "R"], id: \.self) { side in
                        let lens = model.link.lenses[side]!
                        GroupBox {
                            HStack {
                                Text(side).font(.title2.bold()).foregroundStyle(lens.ready ? .green : .secondary)
                                VStack(alignment: .leading) {
                                    Text(lens.name); Text(lens.state).font(.caption).foregroundStyle(.secondary)
                                    Text(lens.version).font(.caption.monospaced())
                                }
                                Spacer()
                                Text(lens.battery.map { "\($0)%" } ?? "—")
                                if let rssi = lens.rssi { Text("\(rssi) dBm").font(.caption) }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                        }
                    }
                    HStack {
                        Button("Connect glasses") { model.perform { try model.link.connect() } }.buttonStyle(.borderedProminent)
                        Button("Disconnect") { model.perform { try model.link.disconnect() } }
                        Button("Read info") { run("deviceInfo") }
                        Button("Wake") { run("setting", ["key":"wake","value":1]) }
                    }.disabled(model.flasher.active)
                    Text(model.link.bluetooth).font(.caption).foregroundStyle(.secondary)
                    GroupBox("Developer control") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.developer.status).font(.caption)
                            Text("Authenticated commands on localhost:8766. The window may stay in the background.").font(.caption).foregroundStyle(.secondary)
                            Text("python3 tools/mac.py status").font(.caption.monospaced()).textSelection(.enabled)
                            HStack {
                                TextField("Command", text: $command)
                                Button("Run") { execute() }.keyboardShortcut(.return, modifiers: [.command])
                            }
                            TextEditor(text: $arguments).font(.system(.caption, design: .monospaced)).frame(height: 75)
                            ScrollView { Text(response).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 150)
                        }.padding(6)
                    }
                    DisclosureGroup("Firmware flashing") {
                        VStack(alignment: .leading, spacing: 10) {
                            Button("Choose CI firmware…") { importFirmware = true }
                            Text(model.firmwareFile?.lastPathComponent ?? "No image selected").font(.caption)
                            TextField("CI SHA-256", text: $model.firmwareSHA)
                            Toggle("Allow image outside recorded golden vectors (integrity checks still required)", isOn: $model.allowUnknownFirmware)
                            HStack {
                                Button("Dry-run") { flash(true) }
                                Button("Flash both lenses…") { flashConfirm = true }
                            }.disabled(model.firmwareFile == nil || model.flasher.active)
                            ProgressView(value: model.flasher.progress)
                            Text(model.flasher.message).font(.caption)
                        }.padding(.top, 8)
                    }
                    DisclosureGroup("Voice recording and transcription") {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(model.link.micLive ? "Glasses microphone streaming" : "Microphone quiet", systemImage: "mic")
                            Text(model.voice.statusMessage).font(.caption)
                            HStack {
                                Button("Start capture") { run("voiceStart", ["live":true]) }
                                Button("Stop capture") { run("voiceStop") }
                                Button("Open recordings") { NSWorkspace.shared.open(model.root.appendingPathComponent("voice/sessions")) }
                            }
                            TextEditor(text: $config).font(.caption.monospaced()).frame(height: 70)
                            Button("Save STT provider JSON") { model.perform { try model.voice.setConfig(config); config = "" } }
                            Text(model.voice.config.summary).font(.caption)
                            HStack {
                                TextField("Search transcripts", text: $query)
                                Button("Search") { model.perform { let results = try model.voice.search(query); hits = results.compactMap { $0["snippet"] as? String }.joined(separator: "\n") } }
                            }
                            Text(hits).textSelection(.enabled)
                        }.padding(.top,8)
                    }
                    DisclosureGroup("Buzzer audio") {
                        HStack {
                            TextField("Speech", text: $speech)
                            Button("Speak") { run("buzzerSpeak", ["text":speech]) }
                            Button("Stop") { run("buzzerStop") }
                        }
                        Text(model.buzzer.detail).font(.caption)
                    }
                }.padding(22)
            }.frame(minWidth: 500)
            VStack(alignment: .leading, spacing: 12) {
                Text("GLASSES FRAMEBUFFER").font(.caption.monospaced()).foregroundStyle(.secondary)
                if let image = model.screenshot {
                    Image(nsImage: image).resizable().interpolation(.none).aspectRatio(contentMode: .fit).background(.black)
                } else {
                    Rectangle().fill(.black).aspectRatio(2, contentMode: .fit).overlay(Text("Push the current screenshot payload\nto receive the right-lens framebuffer.").multilineTextAlignment(.center).font(.caption).foregroundStyle(.secondary))
                }
                Text(model.screenshotDescription).font(.caption).foregroundStyle(.secondary)
                Divider()
                Text("ACTIVITY").font(.caption.monospaced()).foregroundStyle(.secondary)
                List(model.activity.reversed()) { entry in
                    VStack(alignment: .leading) {
                        Text(entry.time, style: .time).font(.caption2).foregroundStyle(.secondary)
                        Text(entry.message).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }.listStyle(.plain)
            }.padding(18).frame(minWidth: 320)
        }
        .fileImporter(isPresented: $importFirmware, allowedContentTypes: [.data]) { result in model.perform { try model.importFirmware(result.get()) } }
        .confirmationDialog("Flash verified firmware to both lenses?", isPresented: $flashConfirm) { Button("Flash") { flash(false) } }
        .alert("FFS Dev Bridge", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) { Button("OK") { model.errorMessage = nil } } message: { Text(model.errorMessage ?? "") }
    }
    private func run(_ name: String, _ args: [String:Any] = [:]) {
        model.perform { let value = try await model.command(name,args); response = String(data: try JSONSerialization.data(withJSONObject:value, options:[.prettyPrinted,.sortedKeys]), encoding:.utf8) ?? "" }
    }
    private func execute() {
        model.perform {
            guard let args = try JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String:Any] else { throw BridgeError.invalid("Arguments must be a JSON object") }
            let value = try await model.command(command,args)
            response = String(data: try JSONSerialization.data(withJSONObject:value, options:[.prettyPrinted,.sortedKeys]), encoding:.utf8) ?? ""
        }
    }
    private func flash(_ dry: Bool) {
        run("flash",["sha256":model.firmwareSHA.trimmingCharacters(in:.whitespacesAndNewlines),"dryRun":dry,"allowUnknownGolden":model.allowUnknownFirmware])
    }
}
