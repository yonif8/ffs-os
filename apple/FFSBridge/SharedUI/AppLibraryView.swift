import SwiftUI
import UniformTypeIdentifiers

struct AppLibraryView: View {
    @ObservedObject var library: AppLibrary
    @State private var importing = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(library.entries) { entry in
                HStack {
                    Label(entry.name, systemImage: entry.icon == 0 ? "timer" : entry.icon == 3 ? "sparkles" : entry.icon == 4 ? "book" : "app")
                    Spacer()
                    if entry.saved { Text("Saved session").foregroundStyle(.secondary) }
                    Button(entry.listed ? "Remove from glasses" : "Add to glasses") {
                        do { try library.setListed(id: entry.id, listed: !entry.listed) }
                        catch { self.error = error.localizedDescription }
                    }.disabled(library.busy)
                }
            }
            if library.entries.isEmpty { Text("Add a native app package to make it available in the glasses’ app drawer.").foregroundStyle(.secondary) }
            Text(library.message).font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Add app…") { importing = true }
                Button("Sync catalog") { library.sync() }.disabled(library.busy)
            }
            Text("Names and icons update over Bluetooth. Removing an entry keeps its app and saved session on this companion. Apps load only when opened on the glasses.").font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data]) { result in
            do {
                let url = try result.get(), scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                try library.add(Data(contentsOf: url)); library.sync()
            } catch { self.error = error.localizedDescription }
        }
    }
}
