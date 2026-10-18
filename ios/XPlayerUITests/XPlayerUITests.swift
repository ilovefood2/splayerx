// SPDX-License-Identifier: MIT
import XCTest

final class XPlayerUITests: XCTestCase {
    @MainActor private func selectTab(_ name: String, in app: XCUIApplication) {
        // iPad exposes floating tabs as cells instead of a TabBar.
        let tab = app.descendants(matching: .any).matching(identifier: name).firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 5))
        tab.tap()
    }

    @MainActor func testPrivacyAndLicenseAreReadableInApp() throws {
        let app = XCUIApplication()
        app.launch()
        selectTab("About", in: app)
        app.buttons["Privacy Policy"].tap()
        XCTAssertTrue(app.navigationBars["Privacy Policy"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Your video library"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Open Source License"].tap()
        XCTAssertTrue(app.navigationBars["MIT License"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["MIT License"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Help & Supported Formats"].tap()
        XCTAssertTrue(app.staticTexts["Import videos and folders"].waitForExistence(timeout: 5))
    }

    @MainActor func testFoldersAndPlaylistsSurviveRelaunch() throws {
        let app = XCUIApplication()
        app.launch()
        let suffix = String(UUID().uuidString.prefix(6))
        let folder = "Trips \(suffix)"
        let playlist = "Favorites \(suffix)"
        app.buttons["Library actions"].tap()
        app.buttons["New Folder"].tap()
        let name = app.textFields["nameField"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText(folder)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts[folder].waitForExistence(timeout: 5))
        app.staticTexts[folder].tap()
        XCTAssertTrue(app.navigationBars[folder].waitForExistence(timeout: 5))
        app.buttons["Library actions"].tap()
        app.buttons["New Folder"].tap()
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("Day One")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Day One"].waitForExistence(timeout: 5))
        selectTab("Playlists", in: app)
        app.buttons["Create playlist"].tap()
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText(playlist)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts[playlist].waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts[folder].waitForExistence(timeout: 5))
        app.staticTexts[folder].tap()
        XCTAssertTrue(app.staticTexts["Day One"].waitForExistence(timeout: 5))
        selectTab("Playlists", in: app)
        XCTAssertTrue(app.staticTexts[playlist].waitForExistence(timeout: 5))
        app.staticTexts[playlist].tap()
        XCTAssertTrue(app.buttons["Add Videos"].waitForExistence(timeout: 5))
    }
}
