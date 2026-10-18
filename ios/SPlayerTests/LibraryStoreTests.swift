import XCTest
@testable import SPlayer

final class LibraryStoreTests: XCTestCase {
    private var temporary: URL!
    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: temporary) }

    @MainActor private func store() -> LibraryStore {
        LibraryStore(root: temporary.appendingPathComponent("Videos"), metadata: temporary.appendingPathComponent("playlists.json"))
    }
    private func video(_ path: String, root: URL) throws {
        let target = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("test video bytes".utf8).write(to: target)
    }

    @MainActor func testFolderImportPreservesHierarchyAndNeverOverwrites() throws {
        let library = store()
        let source = temporary.appendingPathComponent("Trip")
        try video("Day 1/01.mp4", root: source)
        try video("Day 2/02.MOV", root: source)
        try video("notes.txt", root: source)
        let result = LibraryFiles.importVideos([source], into: library.root)
        XCTAssertTrue(result.contains("Imported 2 videos"))
        XCTAssertTrue(result.contains("Skipped 1"))
        _ = LibraryFiles.importVideos([source], into: library.root)
        library.refresh()
        XCTAssertEqual(library.videos().map(\.path), ["Trip/Day 1/01.mp4", "Trip/Day 2/02.MOV", "Trip (2)/Day 1/01.mp4", "Trip (2)/Day 2/02.MOV"].sorted { $0.localizedStandardCompare($1) == .orderedAscending })
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.appendingPathComponent("notes.txt").path))
    }

    @MainActor func testPlaylistOrderPersistsAndDuplicateAddsAreIgnored() throws {
        let library = store()
        try video("one.mp4", root: library.root)
        try video("two.mov", root: library.root)
        library.refresh()
        let id = try library.createPlaylist("Watch later", paths: ["one.mp4", "two.mov", "one.mp4"])
        try library.add(["two.mov", "missing.mp4"], to: id)
        try library.updatePlaylist(id, paths: ["two.mov", "one.mp4"])
        XCTAssertEqual(store().playlists.first?.paths, ["two.mov", "one.mp4"])
        try library.updatePlaylist(id, name: "Favorites", paths: ["one.mp4"])
        XCTAssertEqual(store().playlists.first?.name, "Favorites")
        try library.deletePlaylist(id)
        XCTAssertTrue(store().playlists.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.root.appendingPathComponent("one.mp4").path))
    }

    @MainActor func testFolderMoveAndDeleteUpdateOnlyMatchingPlaylistReferences() throws {
        let library = store()
        try video("Trip/Day 1/clip.mp4", root: library.root)
        try video("Trip2/other.mp4", root: library.root)
        library.refresh()
        try library.createPlaylist("Travel", paths: library.videos().map(\.path))
        try library.createFolder("Archive", in: "")
        try library.relocate(VideoEntry(path: "Trip", isFolder: true), to: "Archive", name: "Holiday")
        XCTAssertEqual(library.playlists[0].paths, ["Archive/Holiday/Day 1/clip.mp4", "Trip2/other.mp4"])
        XCTAssertThrowsError(try library.relocate(VideoEntry(path: "Archive", isFolder: true), to: "Archive/Holiday"))
        try library.delete(VideoEntry(path: "Archive", isFolder: true))
        XCTAssertEqual(store().playlists[0].paths, ["Trip2/other.mp4"])
        XCTAssertTrue(library.exists("Trip2/other.mp4"))
    }

    @MainActor func testFailedMetadataWriteRollsBackFileMoveAndDelete() throws {
        let library = store()
        try video("one.mp4", root: library.root)
        library.refresh()
        try FileManager.default.createDirectory(at: temporary.appendingPathComponent("playlists.json"), withIntermediateDirectories: false)
        try library.createFolder("Destination", in: "")
        let entry = VideoEntry(path: "one.mp4", isFolder: false)
        XCTAssertThrowsError(try library.relocate(entry, to: "Destination"))
        XCTAssertThrowsError(try library.delete(entry))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.root.appendingPathComponent("one.mp4").path))
    }

    @MainActor func testCorruptMetadataIsPreserved() throws {
        let original = Data("broken metadata".utf8)
        let metadata = temporary.appendingPathComponent("playlists.json")
        try original.write(to: metadata)
        let library = store()
        XCTAssertNotNil(library.notice)
        XCTAssertThrowsError(try library.createPlaylist("New"))
        XCTAssertEqual(try Data(contentsOf: metadata), original)
    }

    @MainActor func testTraversalAndSymlinksAreRejected() throws {
        let library = store()
        XCTAssertThrowsError(try library.fileURL("../secret.mp4"))
        XCTAssertThrowsError(try library.fileURL("/tmp/secret.mp4"))
        XCTAssertThrowsError(try library.createFolder("../bad", in: ""))
        try FileManager.default.createSymbolicLink(at: library.root.appendingPathComponent("escape"), withDestinationURL: temporary)
        XCTAssertThrowsError(try library.fileURL("escape/secret.mp4"))
        library.refresh()
        XCTAssertTrue(library.entries.isEmpty)
    }

    @MainActor func testCannotImportAncestorIntoItself() throws {
        let library = store()
        let result = LibraryFiles.importVideos([temporary], into: library.root)
        XCTAssertTrue(result.contains("outside the destination"))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: library.root.path).isEmpty)
    }
}
