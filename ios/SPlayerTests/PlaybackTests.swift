import AVFoundation
import Combine
import XCTest
@testable import SPlayer

final class PlaybackTests: XCTestCase {
    @MainActor func testRealVideoDecodesAndPlaylistAdvancesAutomatically() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let library = LibraryStore(root: temporary.appendingPathComponent("Videos"), metadata: temporary.appendingPathComponent("playlists.json"))
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "clip", withExtension: "mp4"))
        try FileManager.default.copyItem(at: fixture, to: library.root.appendingPathComponent("first.mp4"))
        try FileManager.default.copyItem(at: fixture, to: library.root.appendingPathComponent("second.mp4"))
        library.refresh()
        let playback = PlaybackController()
        defer { playback.stop() }
        let advanced = expectation(description: "Video decoded, played, and advanced to second item")
        let observation = playback.$index.dropFirst().first { $0 == 1 }.sink { _ in advanced.fulfill() }
        playback.play(["missing.mp4", "first.mp4", "second.mp4"], library: library)
        XCTAssertEqual(playback.paths, ["first.mp4", "second.mp4"])
        playback.previous()
        XCTAssertEqual(playback.index, 0)
        await fulfillment(of: [advanced], timeout: 20)
        XCTAssertNil(playback.error)
        XCTAssertEqual(playback.title, "second.mp4")
        playback.next()
        XCTAssertEqual(playback.index, 1)
        playback.previous()
        XCTAssertEqual(playback.title, "first.mp4")
        playback.stop()
        XCTAssertNil(playback.player.currentItem)
        withExtendedLifetime(observation) {}
    }
}
