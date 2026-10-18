import AVKit
import SwiftUI

@MainActor
final class PlaybackController: ObservableObject {
    let player = AVPlayer()
    @Published var isPresented = false
    @Published private(set) var paths: [String] = []
    @Published private(set) var index = 0
    @Published var error: String?
    private var root: URL?
    private var endObserver: NSObjectProtocol?
    private var failureObserver: NSKeyValueObservation?
    var title: String { paths.indices.contains(index) ? (paths[index] as NSString).lastPathComponent : "SPlayer" }

    func play(_ paths: [String], startingAt path: String? = nil, library: LibraryStore) {
        self.paths = paths.filter(library.exists)
        guard !self.paths.isEmpty else { library.notice = "No playable files were found. Import videos into the library first."; return }
        root = library.root
        index = path.flatMap { self.paths.firstIndex(of: $0) } ?? 0
        isPresented = true
        loadCurrent()
    }

    func next() {
        guard index + 1 < paths.count else { return }
        index += 1
        loadCurrent()
    }

    func previous() {
        guard index > 0 else { return }
        index -= 1
        loadCurrent()
    }

    private func loadCurrent() {
        removeObservers()
        player.pause()
        error = nil
        guard let root, paths.indices.contains(index) else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            let item = AVPlayerItem(url: try LibraryFiles.url(paths[index], root: root))
            failureObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                guard item.status == .failed else { return }
                let detail = item.error?.localizedDescription ?? "This video codec is not supported by iOS."
                Task { @MainActor [weak self] in
                    guard self?.player.currentItem === item else { return }
                    self?.error = "Unable to play this video. \(detail) Try an H.264 or HEVC video in MP4, M4V, or MOV format."
                }
            }
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard self?.player.currentItem === item else { return }
                    self?.next()
                }
            }
            player.replaceCurrentItem(with: item)
            player.play()
        } catch { self.error = error.localizedDescription }
    }

    private func removeObservers() {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        failureObserver = nil
    }

    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        removeObservers()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

struct NativeVideoPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = false
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}

struct PlayerScreen: View {
    @ObservedObject var playback: PlaybackController
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                NativeVideoPlayer(player: playback.player)
                if let error = playback.error {
                    Text(error).font(.callout).foregroundStyle(.orange).padding().accessibilityIdentifier("playbackError")
                }
                HStack {
                    Button { playback.previous() } label: { Label("Previous", systemImage: "backward.end.fill") }
                        .disabled(playback.index == 0)
                    Spacer()
                    Text("\(playback.index + 1) / \(playback.paths.count)").monospacedDigit().foregroundStyle(.secondary)
                    Spacer()
                    Button { playback.next() } label: { Label("Next", systemImage: "forward.end.fill") }
                        .disabled(playback.index + 1 >= playback.paths.count)
                }.labelStyle(.iconOnly).font(.title2).padding(24)
            }
            .background(.black)
            .navigationTitle(playback.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { playback.isPresented = false } }
            }
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false; playback.stop() }
    }
}
