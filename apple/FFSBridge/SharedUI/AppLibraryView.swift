import SwiftUI
import UniformTypeIdentifiers

struct AppLibraryView: View {
    @ObservedObject var library: AppLibrary
    @State private var importing = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(library.entries) { entry in
                HStack { Label(entry.name, systemImage: "app"); Spacer(); if entry.saved { Text("Saved session").foregroundStyle(.secondary) } }
            }
            if library.entries.isEmpty { Text("Add a native app package to make it available in the glasses’ app drawer.").foregroundStyle(.secondary) }
            Text(library.message).font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Add app…") { importing = true }
                Button("Sync library") { library.sync() }.disabled(library.busy)
            }
            Text("Apps load when opened on the glasses. Closing saves supported app state and frees working memory.").font(.caption).foregroundStyle(.secondary)
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
