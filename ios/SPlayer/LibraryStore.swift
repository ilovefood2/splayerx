import Foundation
import Combine

struct VideoEntry: Identifiable, Hashable {
    var id: String { path }
    let path: String
    let isFolder: Bool
    var name: String { (path as NSString).lastPathComponent }
    var parent: String {
        let value = (path as NSString).deletingLastPathComponent
        return value == "." ? "" : value
    }
}

struct Playlist: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var paths: [String] = []
}

struct LibraryError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum LibraryFiles {
    static let extensions: Set<String> = ["mp4", "m4v", "mov"]

    static func validName(_ raw: String) throws -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..", !name.hasPrefix("."),
              !name.contains("/"), !name.contains(":"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              name.utf8.count <= 200 else {
            throw LibraryError(message: "Use a name of 1–200 bytes without slashes, colons, or a leading dot.")
        }
        return name
    }

    static func url(_ path: String, root: URL) throws -> URL {
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        guard path.isEmpty || (!path.hasPrefix("/") && path.split(separator: "/").allSatisfy {
            $0 != ".." && $0 != "." && !$0.hasPrefix(".")
        }) else { throw LibraryError(message: "Invalid library path.") }
        // Resolving a non-existent leaf does not reliably resolve its symlink parents.
        var componentURL = base
        for component in path.split(separator: "/") {
            componentURL.appendPathComponent(String(component))
            let attributes = try? FileManager.default.attributesOfItem(atPath: componentURL.path)
            guard attributes?[.type] as? FileAttributeType != .typeSymbolicLink else {
                throw LibraryError(message: "Symbolic links are not supported in the video library.")
            }
        }
        let result = base.appendingPathComponent(path).standardizedFileURL
        let resolved = result.resolvingSymlinksInPath()
        guard resolved.path == base.path || resolved.path.hasPrefix(base.path + "/"),
              resolved.path == result.path else {
            throw LibraryError(message: "Links outside the video library are not supported.")
        }
        return result
    }

    static func scan(root: URL) throws -> [VideoEntry] {
        var scanError: Error?
        guard let items = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey],
            options: [.skipsHiddenFiles], errorHandler: { _, error in scanError = error; return false }
        ) else { throw LibraryError(message: "The video library could not be read.") }
        var entries: [VideoEntry] = []
        for case let item as URL in items {
            let values = try item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey])
            if values.isSymbolicLink == true { items.skipDescendants(); continue }
            if values.isDirectory == true || (values.isRegularFile == true && extensions.contains(item.pathExtension.lowercased())) {
                let path = String(item.path.dropFirst(root.path.count + 1))
                entries.append(VideoEntry(path: path, isFolder: values.isDirectory == true))
            }
        }
        if let scanError { throw scanError }
        return entries.sorted {
            if $0.isFolder != $1.isFolder { return $0.isFolder }
            return $0.path.localizedStandardCompare($1.path) == .orderedAscending
        }
    }

    static func uniqueDestination(_ source: URL, in folder: URL) -> URL {
        let fm = FileManager.default
        var target = folder.appendingPathComponent(source.lastPathComponent)
        let isFolder = (try? source.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        let stem = isFolder ? source.lastPathComponent : source.deletingPathExtension().lastPathComponent
        let suffix = isFolder || source.pathExtension.isEmpty ? "" : "." + source.pathExtension
        var number = 2
        while fm.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(stem) (\(number))\(suffix)")
            number += 1
        }
        return target
    }

    // Copies each selection atomically; a failed selection never leaves a partial video.
    static func importVideos(_ sources: [URL], into folder: URL) -> String {
        let fm = FileManager.default
        var imported = 0
        var skipped = 0
        var failures: [String] = []
        for source in sources {
            let access = source.startAccessingSecurityScopedResource()
            defer { if access { source.stopAccessingSecurityScopedResource() } }
            let staging = folder.appendingPathComponent(".import-" + UUID().uuidString)
            do {
                let sourcePath = source.resolvingSymlinksInPath().path
                let folderPath = folder.resolvingSymlinksInPath().path
                guard sourcePath != folderPath, !folderPath.hasPrefix(sourcePath + "/") else {
                    throw LibraryError(message: "Choose a folder outside the destination folder.")
                }
                var coordinationError: NSError?
                var copyError: Error?
                var count = 0
                var ignored = 0
                NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { readable in
                    do { try copyVideos(readable, to: staging, count: &count, skipped: &ignored) }
                    catch { copyError = error }
                }
                if let coordinationError { throw coordinationError }
                if let copyError { throw copyError }
                if fm.fileExists(atPath: staging.path) {
                    try fm.moveItem(at: staging, to: uniqueDestination(source, in: folder))
                }
                imported += count
                skipped += ignored
            } catch {
                try? fm.removeItem(at: staging)
                failures.append("\(source.lastPathComponent): \(error.localizedDescription)")
            }
        }
        var summary = "Imported \(imported) video\(imported == 1 ? "" : "s")."
        if skipped > 0 { summary += " Skipped \(skipped) unsupported files or links. Supported containers: MP4, M4V, MOV." }
        if !failures.isEmpty { summary += "\n" + failures.joined(separator: "\n") }
        return summary
    }

    private static func copyVideos(_ source: URL, to target: URL, count: inout Int, skipped: inout Int) throws {
        let fm = FileManager.default
        let values = try source.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey])
        guard values.isSymbolicLink != true else { skipped += 1; return }
        if values.isDirectory == true {
            try fm.createDirectory(at: target, withIntermediateDirectories: true)
            for child in try fm.contentsOfDirectory(at: source, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                try copyVideos(child, to: target.appendingPathComponent(child.lastPathComponent), count: &count, skipped: &skipped)
            }
        } else if values.isRegularFile == true && extensions.contains(source.pathExtension.lowercased()) {
            try fm.copyItem(at: source, to: target)
            count += 1
        } else { skipped += 1 }
    }
}

@MainActor
final class LibraryStore: ObservableObject {
    @Published private(set) var entries: [VideoEntry] = []
    @Published private(set) var playlists: [Playlist] = []
    @Published private(set) var isImporting = false
    @Published var notice: String?
    let root: URL
    private let metadata: URL
    private var metadataReadable = true

    init(root: URL? = nil, metadata: URL? = nil) {
        let fm = FileManager.default
        self.root = root ?? fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Videos")
        self.metadata = metadata ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("playlists.json")
        do {
            try fm.createDirectory(at: self.root, withIntermediateDirectories: true)
            try fm.createDirectory(at: self.metadata.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: self.metadata.path) {
                do { playlists = try JSONDecoder().decode([Playlist].self, from: Data(contentsOf: self.metadata)) }
                catch { metadataReadable = false; throw LibraryError(message: "Saved playlists could not be read. The original file has been preserved. \(error.localizedDescription)") }
            }
        } catch { notice = error.localizedDescription }
        refresh()
    }

    func refresh() {
        do { entries = try LibraryFiles.scan(root: root) }
        catch { notice = error.localizedDescription }
    }

    func children(of folder: String) -> [VideoEntry] { entries.filter { $0.parent == folder } }
    func videos(in folder: String = "") -> [VideoEntry] {
        entries.filter { !$0.isFolder && (folder.isEmpty || $0.path.hasPrefix(folder + "/")) }
    }
    func exists(_ path: String) -> Bool { entries.contains { $0.path == path && !$0.isFolder } }
    func fileURL(_ path: String) throws -> URL { try LibraryFiles.url(path, root: root) }

    private func save(_ value: [Playlist]) throws {
        guard metadataReadable else { throw LibraryError(message: "Playlist changes are disabled because the saved library could not be read. Restore playlists.json before editing.") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: metadata, options: .atomic)
        playlists = value
    }

    @discardableResult func createPlaylist(_ name: String, paths: [String] = []) throws -> UUID {
        let name = try LibraryFiles.validName(name)
        var uniquePaths: [String] = []
        for path in paths where exists(path) && !uniquePaths.contains(path) { uniquePaths.append(path) }
        let playlist = Playlist(name: name, paths: uniquePaths)
        try save(playlists + [playlist])
        return playlist.id
    }

    func updatePlaylist(_ id: UUID, name: String? = nil, paths: [String]? = nil) throws {
        guard let index = playlists.firstIndex(where: { $0.id == id }) else { return }
        var updated = playlists
        if let name { updated[index].name = try LibraryFiles.validName(name) }
        if let paths { updated[index].paths = paths }
        try save(updated)
    }

    func add(_ paths: [String], to id: UUID) throws {
        guard let playlist = playlists.first(where: { $0.id == id }) else { return }
        var updated = playlist.paths
        for path in paths where exists(path) && !updated.contains(path) { updated.append(path) }
        try updatePlaylist(id, paths: updated)
    }

    func deletePlaylist(_ id: UUID) throws { try save(playlists.filter { $0.id != id }) }

    func createFolder(_ name: String, in parent: String) throws {
        let url = try fileURL(parent).appendingPathComponent(LibraryFiles.validName(name))
        guard !FileManager.default.fileExists(atPath: url.path) else { throw LibraryError(message: "A file or folder with that name already exists.") }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        refresh()
    }

    func relocate(_ entry: VideoEntry, to folder: String, name: String? = nil) throws {
        let newName = try LibraryFiles.validName(name ?? entry.name)
        let newPath = folder.isEmpty ? newName : folder + "/" + newName
        guard newPath != entry.path else { return }
        guard !entry.isFolder || !(folder == entry.path || folder.hasPrefix(entry.path + "/")) else {
            throw LibraryError(message: "A folder cannot be moved inside itself.")
        }
        let source = try fileURL(entry.path)
        let target = try fileURL(newPath)
        guard !FileManager.default.fileExists(atPath: target.path) else { throw LibraryError(message: "A file or folder with that name already exists.") }
        var updated = playlists
        for index in updated.indices {
            updated[index].paths = updated[index].paths.map { path in
                if path == entry.path { return newPath }
                if entry.isFolder && path.hasPrefix(entry.path + "/") { return newPath + path.dropFirst(entry.path.count) }
                return path
            }
        }
        try FileManager.default.moveItem(at: source, to: target)
        do { try save(updated) }
        catch {
            try FileManager.default.moveItem(at: target, to: source)
            throw error
        }
        refresh()
    }

    func delete(_ entry: VideoEntry) throws {
        let source = try fileURL(entry.path)
        let staged = root.appendingPathComponent(".deleted-" + UUID().uuidString)
        var updated = playlists
        for index in updated.indices {
            updated[index].paths.removeAll { $0 == entry.path || (entry.isFolder && $0.hasPrefix(entry.path + "/")) }
        }
        try FileManager.default.moveItem(at: source, to: staged)
        do { try save(updated) }
        catch {
            try FileManager.default.moveItem(at: staged, to: source)
            throw error
        }
        defer { refresh() }
        try FileManager.default.removeItem(at: staged)
    }

    func importVideos(_ urls: [URL], into folder: String = "") async {
        guard !isImporting else { return }
        do {
            let target = try fileURL(folder)
            isImporting = true
            defer { isImporting = false }
            notice = await Task.detached(priority: .userInitiated) {
                LibraryFiles.importVideos(urls, into: target)
            }.value
            refresh()
        } catch { notice = error.localizedDescription }
    }

    func perform(_ work: () throws -> Void) {
        do { try work() } catch { notice = error.localizedDescription }
    }
}
