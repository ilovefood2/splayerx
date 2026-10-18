import SwiftUI

struct PlaylistsScreen: View {
    @EnvironmentObject private var library: LibraryStore
    @State private var nameRequest: NameRequest?
    @State private var deleting: Playlist?
    var body: some View {
        List {
            if library.playlists.isEmpty {
                ContentUnavailableView {
                    Label("Your next watch, lined up", systemImage: "text.badge.plus")
                } description: { Text("Build playlists from any folder. Arrange your videos once, then play them in order.") }
                actions: { Button("New Playlist", action: create).buttonStyle(.borderedProminent) }
                    .listRowBackground(Color.clear)
            }
            ForEach(library.playlists) { playlist in
                NavigationLink { PlaylistScreen(id: playlist.id) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "text.line.first.and.arrowtriangle.forward").font(.title2).foregroundStyle(.mint).frame(width: 42)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(playlist.name).font(.headline)
                            Text("\(playlist.paths.count) videos").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 8)
                    }
                }
                .contextMenu {
                    Button("Rename", systemImage: "pencil") {
                        nameRequest = NameRequest(title: "Rename Playlist", value: playlist.name) { try library.updatePlaylist(playlist.id, name: $0) }
                    }
                    Button("Delete Playlist", systemImage: "trash", role: .destructive) { deleting = playlist }
                }
            }
        }
        .navigationTitle("Playlists")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(action: create) { Image(systemName: "plus.circle.fill").font(.title3) }.accessibilityLabel("Create playlist") } }
        .sheet(item: $nameRequest) { NameSheet(request: $0) }
        .confirmationDialog("Delete playlist?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete Playlist", role: .destructive) { if let deleting { library.perform { try library.deletePlaylist(deleting.id) } }; deleting = nil }
        } message: { Text("Your video files will stay in the library.") }
    }
    private func create() { nameRequest = NameRequest(title: "New Playlist") { _ = try library.createPlaylist($0) } }
}

struct PlaylistScreen: View {
    let id: UUID
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var playback: PlaybackController
    @State private var adding = false
    @State private var nameRequest: NameRequest?
    private var playlist: Playlist? { library.playlists.first { $0.id == id } }
    var body: some View {
        List {
            if let playlist {
                Section {
                    Button { playback.play(playlist.paths, library: library) } label: { Label("Play All", systemImage: "play.fill").font(.headline) }
                        .disabled(!playlist.paths.contains(where: library.exists))
                    Button { adding = true } label: { Label("Add Videos", systemImage: "plus") }
                }
                if playlist.paths.isEmpty {
                    ContentUnavailableView("No videos yet", systemImage: "text.badge.plus", description: Text("Add videos from your library. Playlists can combine videos from different folders."))
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(Array(playlist.paths.enumerated()), id: \.offset) { offset, path in
                            Button { playback.play(playlist.paths, startingAt: path, library: library) } label: {
                                HStack(spacing: 14) {
                                    Text("\(offset + 1)").monospacedDigit().foregroundStyle(.secondary).frame(width: 24)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text((path as NSString).lastPathComponent).lineLimit(2)
                                        Text(library.exists(path) ? ((path as NSString).deletingLastPathComponent.isEmpty ? "Library" : (path as NSString).deletingLastPathComponent) : "File missing — remove or import again")
                                            .font(.caption).foregroundStyle(library.exists(path) ? Color.secondary : Color.orange)
                                    }
                                    Spacer()
                                    Image(systemName: library.exists(path) ? "play.circle" : "exclamationmark.triangle").foregroundStyle(.secondary)
                                }.padding(.vertical, 5)
                            }.tint(.primary).disabled(!library.exists(path))
                        }
                        .onMove { source, destination in
                            var paths = playlist.paths
                            paths.move(fromOffsets: source, toOffset: destination)
                            library.perform { try library.updatePlaylist(id, paths: paths) }
                        }
                        .onDelete { offsets in
                            var paths = playlist.paths
                            paths.remove(atOffsets: offsets)
                            library.perform { try library.updatePlaylist(id, paths: paths) }
                        }
                    } footer: { Text("Playback advances automatically. Tap Edit to reorder or remove videos. Removing an entry keeps its file in the library.") }
                }
            }
        }
        .navigationTitle(playlist?.name ?? "Playlist")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { EditButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Rename", systemImage: "pencil") {
                    if let playlist { nameRequest = NameRequest(title: "Rename Playlist", value: playlist.name) { try library.updatePlaylist(id, name: $0) } }
                }
            }
        }
        .sheet(isPresented: $adding) { VideoSelectionSheet(playlistID: id) }
        .sheet(item: $nameRequest) { NameSheet(request: $0) }
    }
}

struct VideoSelectionSheet: View {
    let playlistID: UUID
    @EnvironmentObject private var library: LibraryStore
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []
    @State private var query = ""
    @State private var error: String?
    private var existing: [String] { library.playlists.first { $0.id == playlistID }?.paths ?? [] }
    private var available: [VideoEntry] { library.videos().filter { !existing.contains($0.path) && (query.isEmpty || $0.path.localizedCaseInsensitiveContains(query)) } }
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                if available.isEmpty { ContentUnavailableView("No videos to add", systemImage: "film", description: Text("Import videos in Library first, or try another search.")) }
                ForEach(available) { entry in
                    Button {
                        if selected.contains(entry.path) { selected.remove(entry.path) } else { selected.insert(entry.path) }
                    } label: {
                        HStack {
                            Label(entry.path, systemImage: "play.rectangle")
                            Spacer()
                            Image(systemName: selected.contains(entry.path) ? "checkmark.circle.fill" : "circle")
                        }
                    }.accessibilityAddTraits(selected.contains(entry.path) ? [.isSelected] : [])
                }
            }
            .searchable(text: $query, prompt: "Search all folders")
            .navigationTitle("Add Videos").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add (\(selected.count))") {
                        do { try library.add(library.videos().map(\.path).filter { selected.contains($0) }, to: playlistID); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }.disabled(selected.isEmpty)
                }
            }
        }
    }
}

struct AddToPlaylistSheet: View {
    let paths: [String]
    @EnvironmentObject private var library: LibraryStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                if let error { Text(error).foregroundStyle(.red) }
                Section("Choose a playlist") {
                    ForEach(library.playlists) { playlist in
                        Button(playlist.name) {
                            do { try library.add(paths, to: playlist.id); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                }
                Section("Or create a playlist") {
                    TextField("Playlist name", text: $name)
                    Button("Create and Add \(paths.count) Videos") {
                        do { try library.createPlaylist(name, paths: paths); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || paths.isEmpty)
                }
            }
            .navigationTitle("Add to Playlist").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
