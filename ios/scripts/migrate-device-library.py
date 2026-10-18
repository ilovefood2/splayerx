#!/usr/bin/env python3
"""One-time, verified copy into an empty xplayer container. Never deletes source data."""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True, help='Paired iPhone UDID')
parser.add_argument('--copy', action='store_true', help='Perform the copy after checking the destination is empty')
args = parser.parse_args()
SOURCE = 'org.splayer.ios'
DESTINATION = 'com.ilovefood2.xplayer'
DIRECTORIES = ['Documents', 'Library/Application Support']

def device(*arguments):
    result = subprocess.run(['xcrun', 'devicectl', 'device', *arguments, '--device', args.device], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout

def information(*arguments):
    return json.loads(device('info', *arguments, '--json-output', '-'))['result']

def files(bundle, directory):
    return information('files', '--domain-type', 'appDataContainer', '--domain-identifier', bundle,
                       '--subdirectory', directory, '--recurse')['files']

def hashes(directory):
    result = {}
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('Symbolic links are not migrated.')
        if path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            result[str(path.relative_to(directory))] = digest.hexdigest()
    return result

processes = information('processes')['runningProcesses']
for process in processes:
    executable = process.get('executable', '')
    if executable.endswith(('/SPlayer.app/SPlayer', '/XPlayer.app/XPlayer')):
        raise RuntimeError('Close SPlayer and xplayer before migration to keep the copy consistent.')

source_count = 0
for directory in DIRECTORIES:
    current = files(DESTINATION, directory)
    if any(not item['resources'].get('isDirectory') for item in current):
        raise RuntimeError(f'Destination {directory} contains files. Refusing to overwrite an existing library.')
    for item in files(SOURCE, directory):
        if item['resources'].get('isSymbolicLink'):
            raise RuntimeError('Source contains symbolic links. Migration stopped.')
        source_count += not item['resources'].get('isDirectory')

if not args.copy:
    print(f'Ready to copy {source_count} files into the empty xplayer library. Run again with --copy.')
else:
    backup = ROOT / 'build/device-migration' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True, mode=0o700)
    receipts = {}
    for directory in DIRECTORIES:
        name = directory.replace('/', '-')
        original = backup / 'original' / name
        verified = backup / 'verified' / name
        original.parent.mkdir(exist_ok=True)
        verified.parent.mkdir(exist_ok=True)
        device('copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', SOURCE,
               '--source', directory, '--destination', str(original))
        expected = hashes(original)
        if expected:
            device('copy', 'to', '--domain-type', 'appDataContainer', '--domain-identifier', DESTINATION,
                   '--source', str(original), '--destination', directory)
        device('copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', DESTINATION,
               '--source', directory, '--destination', str(verified))
        actual = hashes(verified)
        if expected != actual:
            raise RuntimeError(f'Copy verification failed for {directory}; the original app and local backup are preserved at {backup}.')
        receipts[directory] = {'files': len(expected), 'sha256': expected}
    (backup / 'receipt.json').write_text(json.dumps(receipts, indent=2))
    print(f'Verified {source_count} files. Original app data was preserved. Private backup: {backup}')
