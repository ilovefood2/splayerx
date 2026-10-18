import SwiftUI

@main
struct SPlayerApp: App {
    @StateObject private var library = LibraryStore()
    @StateObject private var playback = PlaybackController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            TabView {
                NavigationStack { FolderScreen(folder: "") }
                    .tabItem { Label("Library", systemImage: "folder.fill") }
                NavigationStack { PlaylistsScreen() }
                    .tabItem { Label("Playlists", systemImage: "text.line.first.and.arrowtriangle.forward") }
            }
            .tint(.mint)
            .preferredColorScheme(.dark)
            .environmentObject(library)
            .environmentObject(playback)
            .fullScreenCover(isPresented: $playback.isPresented) { PlayerScreen(playback: playback).preferredColorScheme(.dark).tint(.mint) }
            .alert("SPlayer", isPresented: Binding(get: { library.notice != nil }, set: { if !$0 { library.notice = nil } })) {
                Button("OK", role: .cancel) { library.notice = nil }
            } message: { Text(library.notice ?? "") }
            .overlay {
                if library.isImporting {
                    ZStack {
                        Color.black.opacity(0.5).ignoresSafeArea()
                        VStack(spacing: 16) {
                            ProgressView()
                            Text("Importing videos…").font(.headline)
                            Text("Keep SPlayer open until the copy finishes.").font(.caption).foregroundStyle(.secondary)
                        }.padding(28).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                    }
                }
            }
            .onOpenURL { url in Task { await library.importVideos([url]) } }
            .onChange(of: scenePhase) { _, phase in if phase == .active && !library.isImporting { library.refresh() } }
        }
    }
}
