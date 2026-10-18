import SwiftUI
import UniformTypeIdentifiers

struct NameRequest: Identifiable {
    let id = UUID()
    let title: String
    var value: String = ""
    let save: (String) throws -> Void
}

struct NameSheet: View {
    let request: NameRequest
    @State private var value: String
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    init(request: NameRequest) { self.request = request; _value = State(initialValue: request.value) }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $value).focused($focused).accessibilityIdentifier("nameField")
                    .submitLabel(.done).onSubmit(save)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(request.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            .onAppear { focused = true }
        }.presentationDetents([.medium])
    }
    private func save() {
        do { try request.save(value); dismiss() } catch { self.error = error.localizedDescription }
    }
}

struct ImportPicker: UIViewControllerRepresentable {
    let folder: Bool
    let completion: ([URL]) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: folder ? [.folder] : [.movie, .video], asCopy: false)
        picker.allowsMultipleSelection = true
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let completion: ([URL]) -> Void
        init(completion: @escaping ([URL]) -> Void) { self.completion = completion }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { completion(urls) }
    }
}

enum ImportSelection: String, Identifiable {
    case videos, folder
    var id: String { rawValue }
}

struct FolderScreen: View {
    let folder: String
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var playback: PlaybackController
    @State private var query = ""
    @State private var nameRequest: NameRequest?
    @State private var importSelection: ImportSelection?
    @State private var moving: VideoEntry?
    @State private var deleting: VideoEntry?
    @State private var adding: VideoEntry?
    private var title: String { folder.isEmpty ? "Library" : (folder as NSString).lastPathComponent }
    private var visible: [VideoEntry] {
        if query.isEmpty { return library.children(of: folder) }
        return library.entries.filter {
            (folder.isEmpty || $0.path.hasPrefix(folder + "/")) && $0.name.localizedCaseInsensitiveContains(query)
        }
    }
    var body: some View {
        List {
            if folder.isEmpty && query.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("YOUR VIDEO LIBRARY", systemImage: "play.rectangle.fill")
                            .font(.caption.weight(.semibold)).foregroundStyle(.mint)
                        Text("Everything in its place.").font(.title2.bold())
                        Text("\(library.videos().count) videos · \(library.entries.filter(\.isFolder).count) folders")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.vertical, 10)
                }
            }
            if visible.isEmpty {
                ContentUnavailableView {
                    Label(query.isEmpty ? "Add your videos" : "No matches", systemImage: "folder.badge.plus")
                } description: {
                    Text(query.isEmpty ? "Import videos or an entire folder from Files. Subfolders stay organized. MP4, M4V, and MOV are supported." : "Try another name.")
                } actions: {
                    if query.isEmpty {
                        Button("Import Videos") { importSelection = .videos }.buttonStyle(.borderedProminent)
                        Button("Import Folder") { importSelection = .folder }
                    }
                }.listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(visible) { entry in
                        Group {
                            if entry.isFolder {
                                NavigationLink { FolderScreen(folder: entry.path) } label: { entryRow(entry) }
                            } else {
                                Button { playback.play(visible.filter { !$0.isFolder }.map(\.path), startingAt: entry.path, library: library) } label: { entryRow(entry) }.tint(.primary)
                            }
                        }
                        .contextMenu {
                            Button { play(entry) } label: { Label(entry.isFolder ? "Play Folder" : "Play", systemImage: "play.fill") }
                            Button { adding = entry } label: { Label("Add to Playlist", systemImage: "text.badge.plus") }
                            Button { moving = entry } label: { Label("Move to Folder", systemImage: "folder") }
                            if entry.isFolder {
                                Button("Rename Folder", systemImage: "pencil") {
                                    nameRequest = NameRequest(title: "Rename Folder", value: entry.name) { try library.relocate(entry, to: entry.parent, name: $0) }
                                }
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = entry }
                        }
                    }
                } header: { Text(query.isEmpty ? "Folders & videos" : "Search results") }
            }
            if folder.isEmpty && query.isEmpty {
                Section {
                    Label("Add files with Files or Finder", systemImage: "externaldrive")
                    Text("You can also copy folders into On My iPhone → SPlayer → Videos. Long-press a video or folder to organize it or add it to a playlist.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(title)
        .searchable(text: $query, prompt: "Search videos and folders")
        .refreshable { library.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Import Videos", systemImage: "square.and.arrow.down") { importSelection = .videos }
                    Button("Import Folder", systemImage: "folder.badge.plus") { importSelection = .folder }
                    Button("New Folder", systemImage: "folder.fill.badge.plus") {
                        nameRequest = NameRequest(title: "New Folder") { try library.createFolder($0, in: folder) }
                    }
                    Button("Play All", systemImage: "play.fill") { playback.play(library.videos(in: folder).map(\.path), library: library) }
                        .disabled(library.videos(in: folder).isEmpty)
                } label: { Image(systemName: "plus.circle.fill").font(.title3) }.accessibilityLabel("Library actions")
            }
        }
        .sheet(item: $nameRequest) { NameSheet(request: $0) }
        .sheet(item: $importSelection) { selection in
            ImportPicker(folder: selection == .folder) { urls in
                importSelection = nil
                Task { await library.importVideos(urls, into: folder) }
            }.ignoresSafeArea()
        }
        .sheet(item: $moving) { MoveSheet(entry: $0) }
        .sheet(item: $adding) { entry in
            AddToPlaylistSheet(paths: entry.isFolder ? library.videos(in: entry.path).map(\.path) : [entry.path])
        }
        .confirmationDialog("Delete \(deleting?.name ?? "")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete from Library", role: .destructive) {
                if let deleting { library.perform { try library.delete(deleting) } }
                deleting = nil
            }
        } message: { Text("This deletes the local copy and removes it from playlists. All videos inside a deleted folder are included. Your original imported files are unchanged.") }
    }

    private func play(_ entry: VideoEntry) {
        playback.play(entry.isFolder ? library.videos(in: entry.path).map(\.path) : [entry.path], library: library)
    }

    private func entryRow(_ entry: VideoEntry) -> some View {
        HStack(spacing: 14) {
            Image(systemName: entry.isFolder ? "folder.fill" : "play.rectangle.fill")
                .font(.title2).foregroundStyle(entry.isFolder ? Color.mint : Color.secondary)
                .frame(width: 42, height: 46)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.name).lineLimit(2).font(.body.weight(.medium))
                Text(entry.isFolder ? "\(library.videos(in: entry.path).count) videos" : (query.isEmpty ? entry.name.components(separatedBy: ".").last!.uppercased() : entry.parent))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 3)
    }
}

struct MoveSheet: View {
    let entry: VideoEntry
    @EnvironmentObject private var library: LibraryStore
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                destination("", name: "Library")
                ForEach(library.entries.filter { $0.isFolder && $0.path != entry.path && !$0.path.hasPrefix(entry.path + "/") }) {
                    destination($0.path, name: $0.path)
                }
            }
            .navigationTitle("Move to Folder").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
    private func destination(_ path: String, name: String) -> some View {
        Button {
            do { try library.relocate(entry, to: path); dismiss() } catch { self.error = error.localizedDescription }
        } label: { Label(name, systemImage: "folder") }.disabled(path == entry.parent)
    }
}
