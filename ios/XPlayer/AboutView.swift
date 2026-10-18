// SPDX-License-Identifier: MIT
import SwiftUI

enum AppInformation {
    static let privacyURL = URL(string: "https://ilovefood2.github.io/xplayer/privacy.html")!
    static let supportURL = URL(string: "https://ilovefood2.github.io/xplayer/support.html")!
    static let issuesURL = URL(string: "https://github.com/ilovefood2/xplayer/issues")!
    static let emailURL = URL(string: "mailto:a@ikel.ca?subject=xplayer%20support")!

    static func document(_ name: String, extension suffix: String = "md") throws -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: suffix) else {
            throw LibraryError(message: "This document is unavailable. Please use the website link below.")
        }
        return try String(contentsOf: url, encoding: .utf8)
    }
}

struct AboutView: View {
    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("xplayer", systemImage: "play.rectangle.fill").font(.largeTitle.bold()).foregroundStyle(.mint)
                    Text("Your videos. Your folders. Your playlists.").foregroundStyle(.secondary)
                    Text("Version \(version)").font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
            }
            Section("Help") {
                NavigationLink("Help & Supported Formats") { AppDocumentView(title: "Help", resource: "Support", website: AppInformation.supportURL) }
                Link("Support Website", destination: AppInformation.supportURL)
                Link("Email Support", destination: AppInformation.emailURL)
                Link("Report a Problem", destination: AppInformation.issuesURL)
            }
            Section {
                NavigationLink("Privacy Policy") { AppDocumentView(title: "Privacy Policy", resource: "PrivacyPolicy", website: AppInformation.privacyURL) }
                NavigationLink("Open Source License") { AppDocumentView(title: "MIT License", resource: "License", suffix: "txt") }
                NavigationLink("Third-Party Notices") { AppDocumentView(title: "Notices", resource: "ThirdPartyNotices") }
            } header: {
                Text("Privacy & Licenses")
            } footer: {
                Text("xplayer does not upload your videos or playlists. No account, ads, or tracking. © 2026 xplayer contributors.")
            }
        }.navigationTitle("About")
    }
}

struct AppDocumentView: View {
    let title: String
    let resource: String
    var suffix = "md"
    var website: URL?

    private var paragraphs: [String] {
        let text: String
        do { text = try AppInformation.document(resource, extension: suffix) }
        catch { text = error.localizedDescription }
        return text.components(separatedBy: "\n\n").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    if paragraph.hasPrefix("#") {
                        Text(paragraph.drop(while: { $0 == "#" || $0 == " " }))
                            .font(.headline).accessibilityAddTraits(.isHeader)
                    } else {
                        Text(paragraph.replacingOccurrences(of: "\n", with: " "))
                            .font(.body).textSelection(.enabled)
                    }
                }
                if let website { Link("Read on the Website", destination: website).padding(.top, 4) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}
