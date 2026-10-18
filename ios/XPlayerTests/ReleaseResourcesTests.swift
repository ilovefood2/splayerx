// SPDX-License-Identifier: MIT
import XCTest
@testable import XPlayer

final class ReleaseResourcesTests: XCTestCase {
    func testPrivacyLicenseAndSupportShipWithTheApplication() throws {
        XCTAssertTrue(try AppInformation.document("PrivacyPolicy").contains("does not upload"))
        XCTAssertTrue(try AppInformation.document("Support").contains("MP4, M4V, and MOV"))
        XCTAssertTrue(try AppInformation.document("License", extension: "txt").contains("MIT License"))
        XCTAssertTrue(try AppInformation.document("ThirdPartyNotices").contains("no bundled third-party SDK"))
        let url = try XCTUnwrap(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let data = try Data(contentsOf: url)
        let manifest = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((manifest["NSPrivacyCollectedDataTypes"] as? [Any])?.count, 0)
        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.ilovefood2.xplayer")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String, "xplayer")
    }
}
