import Foundation
import NaturalLanguage
import Translation

private struct Request: Decodable {
    let command: String
    let texts: [String]?
    let sourceLanguage: String?
    let targetLanguage: String?
}

private struct Reply: Encodable {
    let ok: Bool
    let status: String?
    let translations: [String]?
    let sourceLanguage: String?
    let message: String?
}

private enum HelperError: LocalizedError {
    case invalidRequest(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidRequest(let message), .unavailable(let message): return message
        }
    }
}

@available(macOS 26.0, *)
private func detectedLanguage(for texts: [String]) throws -> Locale.Language {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(texts.joined(separator: "\n"))
    guard let language = recognizer.dominantLanguage else {
        throw HelperError.unavailable("Apple Translation could not identify the source language")
    }
    return Locale.Language(identifier: language.rawValue)
}

@available(macOS 26.0, *)
private func languages(for request: Request) throws -> (Locale.Language, Locale.Language, String) {
    guard let targetCode = request.targetLanguage, !targetCode.isEmpty else {
        throw HelperError.invalidRequest("A target language is required")
    }
    let texts = request.texts ?? []
    let source: Locale.Language
    let sourceCode: String
    if let configured = request.sourceLanguage, !configured.isEmpty {
        source = Locale.Language(identifier: configured)
        sourceCode = configured
    } else {
        source = try detectedLanguage(for: texts)
        sourceCode = source.languageCode?.identifier ?? source.minimalIdentifier
    }
    return (source, Locale.Language(identifier: targetCode), sourceCode)
}

@available(macOS 26.0, *)
private func availabilityReply(for request: Request) async throws -> Reply {
    let (source, target, sourceCode) = try languages(for: request)
    // Use the dedicated Translation language models. High-fidelity strategy may
    // wait for Apple Intelligence provisioning, which is the wrong trade-off for
    // realtime subtitles and can leave progress sitting at zero.
    let availability = LanguageAvailability()
    let status = await availability.status(from: source, to: target)
    let name: String
    switch status {
    case .installed: name = "installed"
    case .supported: name = "download-required"
    case .unsupported: name = "unsupported"
    @unknown default: name = "unavailable"
    }
    return Reply(ok: status == .installed, status: name, translations: nil,
                 sourceLanguage: sourceCode, message: nil)
}

@available(macOS 26.0, *)
private func translate(_ request: Request) async throws -> Reply {
    let texts = request.texts ?? []
    if texts.isEmpty {
        return Reply(ok: true, status: "installed", translations: [],
                     sourceLanguage: request.sourceLanguage, message: nil)
    }
    let (source, target, sourceCode) = try languages(for: request)
    let availability = try await availabilityReply(for: request)
    guard availability.ok else {
        throw HelperError.unavailable("Apple Translation language models are not installed for this language pair")
    }
    let session = TranslationSession(installedSource: source, target: target)
    let batch = texts.enumerated().map {
        TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
    }
    let responses = try await session.translations(from: batch)
    var translated = Array(repeating: "", count: texts.count)
    for response in responses {
        guard let identifier = response.clientIdentifier, let index = Int(identifier),
              translated.indices.contains(index) else { continue }
        translated[index] = response.targetText
    }
    guard !translated.contains(where: { $0.isEmpty }) else {
        throw HelperError.unavailable("Apple Translation returned an incomplete batch")
    }
    return Reply(ok: true, status: "installed", translations: translated,
                 sourceLanguage: sourceCode, message: nil)
}

private func write(_ reply: Reply) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(reply) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

@main
private struct AppleTranslationHelper {
    static func main() async {
        do {
            guard #available(macOS 26.0, *) else {
                throw HelperError.unavailable("Apple Translation command-line sessions require macOS 26 or newer")
            }
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let request = try JSONDecoder().decode(Request.self, from: data)
            switch request.command {
            case "probe": write(try await availabilityReply(for: request))
            case "translate": write(try await translate(request))
            default: throw HelperError.invalidRequest("Unknown command")
            }
        } catch {
            write(Reply(ok: false, status: "unavailable", translations: nil,
                        sourceLanguage: nil, message: error.localizedDescription))
        }
    }
}
