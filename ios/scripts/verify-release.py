#!/usr/bin/env python3
"""Local release checks; does not claim trademark clearance or Apple approval."""
import argparse
import json
import plistlib
import struct
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--app', type=Path)
parser.add_argument('--check-urls', action='store_true')
args = parser.parse_args()
errors = []

def check(condition, message):
    if not condition:
        errors.append(message)

package = json.loads((ROOT / 'package.json').read_text())
source = ROOT / 'XPlayer'
info = plistlib.loads((source / 'Info.plist').read_bytes())
privacy = plistlib.loads((source / 'PrivacyInfo.xcprivacy').read_bytes())
check(package['license'] == 'MIT', 'Standalone package license is not MIT.')
check(info.get('CFBundleDisplayName') == 'xplayer', 'Display name must be xplayer.')
check(info.get('ITSAppUsesNonExemptEncryption') is False, 'Review the export-compliance declaration.')
check(not info.get('NSAppTransportSecurity', {}).get('NSAllowsArbitraryLoads'), 'Unrestricted network transport is enabled.')
check(privacy.get('NSPrivacyTracking') is False, 'Unexpected tracking declaration.')
check(privacy.get('NSPrivacyCollectedDataTypes') == [], 'Review data collection before release.')
reasons = {item['NSPrivacyAccessedAPIType']: set(item['NSPrivacyAccessedAPITypeReasons']) for item in privacy['NSPrivacyAccessedAPITypes']}
check(reasons.get('NSPrivacyAccessedAPICategoryFileTimestamp') == {'C617.1', '3B52.1'}, 'File metadata reason declarations do not match the audited use.')
check((ROOT / 'LICENSE').read_bytes() == (source / 'Resources/License.txt').read_bytes(), 'Bundled MIT license differs from the source license.')
check((ROOT / 'THIRD_PARTY_NOTICES.md').read_bytes() == (source / 'Resources/ThirdPartyNotices.md').read_bytes(), 'Bundled third-party notices differ.')
for name in ['PrivacyPolicy.md', 'Support.md', 'License.txt', 'ThirdPartyNotices.md']:
    text = (source / 'Resources' / name).read_text()
    check(len(text) > 100, f'Missing or incomplete document: {name}')
    check(not any(marker in text for marker in ['TODO', 'example.com', '<your', 'TBD']), f'Placeholder in public document: {name}')
for name, limit in [('name', 30), ('subtitle', 30), ('keywords', 100), ('description', 4000)]:
    text = (ROOT / 'metadata/en-US' / (name + '.txt')).read_text().strip()
    check(0 < len(text) <= limit, f'Store metadata {name} exceeds {limit} characters.')
project = (ROOT / 'project.yml').read_text()
check(f'MARKETING_VERSION: "{package["version"]}"' in project, 'Project and package versions differ.')
check('PRODUCT_BUNDLE_IDENTIFIER: com.ilovefood2.xplayer' in project, 'Unexpected bundle identifier.')
check('SPlayer' not in project and '../' not in project, 'Project references legacy or external build sources.')
icon = (source / 'Assets.xcassets/AppIcon.appiconset/AppIcon.png').read_bytes()
check(icon[:8] == b'\x89PNG\r\n\x1a\n', 'App icon must be PNG.')
width, height, depth, color = struct.unpack('>IIBB', icon[16:26])
check((width, height, color) == (1024, 1024, 2), 'App icon must be an opaque RGB 1024-square PNG.')
check(not list(ROOT.glob('*.p12')) and not list(ROOT.glob('*.mobileprovision')), 'Signing secrets are present at the project root.')

if args.app:
    built = plistlib.loads((args.app / 'Info.plist').read_bytes())
    check(built.get('CFBundleIdentifier') == 'com.ilovefood2.xplayer', 'Built bundle identifier differs.')
    check(built.get('CFBundleDisplayName') == 'xplayer', 'Built display name differs.')
    check(built.get('CFBundleShortVersionString') == package['version'], 'Built application version differs.')
    for name in ['PrivacyInfo.xcprivacy', 'PrivacyPolicy.md', 'Support.md', 'License.txt', 'ThirdPartyNotices.md']:
        check((args.app / name).is_file(), f'Required resource absent from app: {name}')
    check(not list(args.app.rglob('*.mp4')), 'Test video must not ship in the production app.')
    check(not (args.app / 'Frameworks').exists(), 'Bundled frameworks need a fresh dependency/license audit.')

if args.check_urls:
    metadata = json.loads((ROOT / 'metadata/app-privacy.json').read_text())
    for field in ['privacyPolicyURL', 'supportURL']:
        try:
            request = urllib.request.Request(metadata[field], headers={'User-Agent': 'xplayer-release-check'})
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read().decode()
                local = ROOT / 'docs' / ('privacy.html' if field == 'privacyPolicyURL' else 'support.html')
                check(response.status == 200 and body.strip() == local.read_text().strip(), f'Public page does not match the bundled policy/support version: {metadata[field]}')
        except Exception as error:
            errors.append(f'Public page unreachable: {metadata[field]}: {error}')

if errors:
    print('\n'.join('FAIL: ' + error for error in errors), file=sys.stderr)
    sys.exit(1)
print('PASS: local source' + (' and app bundle' if args.app else '') + (' and public URLs' if args.check_urls else '') + ' checks. Apple review, name clearance, and account setup are separate.')
