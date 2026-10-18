#!/usr/bin/env python3
"""Render the same privacy/support text shipped in the app as a static site."""
import html
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
DOCS.mkdir(exist_ok=True)

def linked(text):
    escaped = html.escape(text)
    def anchor(match):
        value = match.group(0)
        url = value.rstrip('.,;')
        return f'<a href="{url}">{url}</a>' + value[len(url):]
    return re.sub(r'https://[^\s<]+', anchor, escaped)

def render(text):
    blocks = []
    for paragraph in text.strip().split('\n\n'):
        paragraph = paragraph.replace('\n', ' ')
        if paragraph.startswith('## '):
            blocks.append('<h2>' + html.escape(paragraph[3:]) + '</h2>')
        elif paragraph.startswith('# '):
            blocks.append('<h1>' + html.escape(paragraph[2:]) + '</h1>')
        else:
            blocks.append('<p>' + linked(paragraph) + '</p>')
    return '\n'.join(blocks)

STYLE = '''
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#071323;color:#edf5ff;line-height:1.65}
body{max-width:760px;margin:auto;padding:28px 24px 64px}nav{display:flex;gap:24px;flex-wrap:wrap;padding:16px 0 28px;border-bottom:1px solid #254054}
a{color:#75edce;overflow-wrap:anywhere}nav a{text-decoration:none}h1{font-size:2.4rem;line-height:1.15;margin:42px 0 28px}h2{font-size:1.25rem;margin-top:32px;color:#ccf9ec}
p{margin:18px 0}footer{border-top:1px solid #254054;margin-top:48px;padding-top:20px;color:#abc0ce;font-size:.9rem}.icon{width:120px;height:120px;border-radius:27px;margin-top:40px}pre{white-space:pre-wrap;font:inherit}strong{color:#75edce}
'''

def write_page(filename, title, body):
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} · xplayer</title><meta name="description" content="xplayer offline video player: privacy, support, and license information.">
<link rel="icon" href="icon.png"><style>{STYLE}</style></head><body>
<nav aria-label="Main navigation"><a href="index.html">xplayer</a><a href="privacy.html">Privacy</a><a href="support.html">Support</a><a href="license.html">License</a></nav>
<main>{body}</main><footer>© 2026 xplayer contributors · <a href="mailto:a@ikel.ca">a@ikel.ca</a> · <a href="https://github.com/ilovefood2/xplayer">Source code</a> · <a href="https://github.com/ilovefood2/xplayer/issues">Issues</a></footer>
</body></html>'''
    (DOCS / filename).write_text(page)

write_page('index.html', 'Offline videos, organized', '''<img class="icon" src="icon.png" alt="xplayer app icon">
<h1>Your videos.<br>Your folders.<br>Your playlists.</h1>
<p>xplayer is a native offline video library for iPhone and iPad running iOS 17 or later.</p>
<p>Import your own videos or folder trees from Files, organize them into folders, and create playlists that play in sequence.</p>
<p><strong>No account. No ads. No tracking SDKs.</strong> Your videos and playlists are stored locally and are not uploaded to the developer.</p>
<p>Supports MP4, M4V, and MOV with the codecs available on your device. MKV, AVI, and protected/DRM content are not supported.</p>
<p><a href="support.html">Read the user guide</a> or <a href="privacy.html">read the privacy policy</a>.</p>''')
for name, filename in [('PrivacyPolicy', 'privacy.html'), ('Support', 'support.html')]:
    text = (ROOT / 'XPlayer/Resources' / (name + '.md')).read_text()
    write_page(filename, name.replace('PrivacyPolicy', 'Privacy Policy'), render(text))
write_page('license.html', 'License', '<h1>License</h1><pre>' + html.escape((ROOT / 'LICENSE').read_text()) + '</pre>' + render((ROOT / 'THIRD_PARTY_NOTICES.md').read_text()))
shutil.copyfile(ROOT / 'XPlayer/Assets.xcassets/AppIcon.appiconset/AppIcon.png', DOCS / 'icon.png')
(DOCS / '.nojekyll').touch()
assert 'href="https://github.com/ilovefood2/xplayer/issues"' in (DOCS / 'privacy.html').read_text()
assert '<script' not in ''.join(p.read_text() for p in DOCS.glob('*.html'))
print('Generated static privacy, support, license, and home pages in docs/.')
