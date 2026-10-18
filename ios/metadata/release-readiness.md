# Release preparation record

Prepared on 2026-10-18 for xplayer, bundle ID `com.ilovefood2.xplayer`.

## Implemented in this project

- Standalone native app, project, version, scripts, and MIT licensing boundary.
- Source/artwork provenance and notices; no upstream desktop code or original icon in the app.
- Offline privacy, help, and license screens under About.
- Privacy manifest: no tracking, no collected app data; file metadata reasons
  C617.1 (app container) and 3B52.1 (user-selected files).
- Only supported video types advertised to Files; remote URLs rejected.
- Import completion UI waits for the system picker to dismiss; cancellation
  does not report a successful import. Backgrounding pauses playback.
- Accurate format limitations, local-storage/delete behavior, and support guidance.
- Source-controlled store description, keywords, review notes, export settings,
  and static public policy/support pages generated from bundled documents.
- Build/archive scripts and local source/bundle/URL checks.

## Account-holder and external gates

These are not claims of completed Apple approval:

1. Paid Apple Developer membership is not active, as confirmed by the account
   holder on 2026-10-18. App Store distribution signing and submission remain blocked.
2. Create the App Store Connect app record and verify store-name availability.
   Similar XPlayer/X Player names already appear in public Canadian listings.
   The requested display name remains xplayer; trademark clearance is unresolved.
3. The account holder approved a@ikel.ca as the public support email on
   2026-10-18. The seller name will be determined by the enrolled Apple account.
4. Public policy/support URLs have been deployed and verified byte-for-byte
   against the current bundled-document website output. Recheck before upload.
5. Complete age-rating, pricing/availability, content-rights, and export-compliance
   forms using the actual app behavior. No custom/non-exempt encryption is used.
6. Supply actual review contact details in App Store Connect. Six screenshots
   are prepared under screenshots/en-US for 6.9-inch iPhone and 13-inch iPad;
   they use synthetic sample videos, not the user's private media.
7. Export with App Store distribution signing and run Apple's archive validation.
8. Obtain Apple review. Local checks do not guarantee acceptance or legal clearance.

The source/license audit supports an independent implementation; the scope and
limits are in PROVENANCE.md. Existing upstream GPL licenses are not changed.
If adding upstream code, third-party SDKs, codecs, cloud sync, analytics, ads,
accounts, or paid features, review licenses and privacy declarations again.

## Verification of 4.11.134

- iPhone 16 Pro Max simulator, iOS 26.5: 13 tests passed.
- iPad Pro 13-inch simulator, iPadOS 26.5: 13 tests passed.
- Physical iPhone 16 Pro Max, iOS 27.0.1: 11 core/resource tests passed.
- A fresh signed archive was built from the standalone repository. Bundle
  identity, version, documents, privacy manifest, and signing verification passed.
- xplayer 4.11.134 was installed and launched on the physical iPhone.
- App Store export was attempted; Apple rejected provisioning because the
  current team has no permission to create iOS App Store profiles and the
  account has no App Store Connect provider. No App Store submission occurred.
- Migration from the former development bundle could not proceed because
  that bundle was absent from the device when checked; the account holder
  confirmed manually uninstalling it. The migration stopped before copying
  or overwriting data. This is separate from the passing import
  and playlist tests; no claim of successful old-library recovery is made.

The local checks are reproducible with scripts/verify-release.py, the Xcode
test scheme, and scripts/build.sh. They do not replace Apple's server-side
validation or review, and do not certify trademark or legal clearance.

## Primary references checked

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/app-store/submitting/
- https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
- https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons
- https://www.gnu.org/licenses/gpl-faq.en.html#ReleaseUnderGPLAndNF
- https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation
