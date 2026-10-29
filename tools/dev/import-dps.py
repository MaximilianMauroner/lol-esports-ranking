#!/usr/bin/env python3
"""Verify imported DPS paths and behavior against the pinned tracked source."""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path

REVISION = 'd3fd42ee44be3b4ae599ea9aa981b2e239a621d2'
ROOT = Path(__file__).resolve().parents[2]


def destination(path):
    special = {
        'src/app/api/auth/login/route.ts': 'scripts/dps/auth/login.ts',
        'src/app/api/auth/logout/route.ts': 'scripts/dps/auth/login.ts',
        'tests/observations/records.ts': 'tools/dps/validation/records.ts',
        'tests/engine-harness/harness.ts': 'tools/dps/validation/harness.ts',
        'src/ingestion/completed-items.ts': 'src/domains/dps/observed-items.ts',
        'src/ingestion/types.ts': 'src/domains/dps/observation-types.ts',
        'src/app/page.tsx': 'src/views/dps/DpsLab.tsx',
        'src/app/login/page.tsx': 'src/views/dps/LoginPage.tsx',
        'src/app/globals.css': 'src/styles/dps.css',
        '.env.example': 'scripts/dps/env.example',
        'README.md': 'scripts/dps/README.md',
    }
    if path in special:
        return special[path]
    for old, new in [
        ('src/domain/', 'src/domains/dps/'),
        ('src/components/lab/', 'src/components/dps/'),
        ('src/workers/', 'src/browser/dps/'),
        ('src/data/fixtures.ts', 'src/domains/dps/fixtures.ts'),
        ('src/data/', 'scripts/dps/data/'),
        ('src/auth/session.ts', 'scripts/dps/auth/session.ts'),
        ('src/app/api/', 'scripts/dps/api/'),
        ('src/db/', 'scripts/dps/db/'),
        ('src/storage/', 'scripts/dps/storage/'),
        ('src/ingestion/', 'scripts/dps/ingestion/'),
        ('scripts/rulesets/', 'tools/dps/rulesets/'),
        ('scripts/check-plan.ts', 'tools/dps/check-plan.ts'),
        ('scripts/plan-', 'tools/dps/plan-'),
        ('scripts/benchmark-optimizer.ts', 'tools/dps/benchmark-optimizer.ts'),
        ('scripts/validate-mechanics.ts', 'tools/dps/validate-mechanics.ts'),
        ('scripts/', 'scripts/dps/'),
        ('migrations/', 'scripts/dps/migrations/'),
        ('tests/', 'tests/dps/'),
    ]:
        if path.startswith(old):
            return new + path[len(old):]
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', help='Read the pinned tree from a local source repository')
    args = parser.parse_args()
    receipt = ROOT / 'tools/dev/dps-import.json'
    if not args.source:
        recorded = json.loads(receipt.read_text())
        if recorded['revision'] != REVISION:
            raise SystemExit('Pinned source revision changed')
        for row in recorded['files']:
            if destination(row['source']) != row['target'] or not re.fullmatch('[0-9a-f]{64}', row['sourceSha256']):
                raise SystemExit(f'Invalid import receipt {row}')
            if not (ROOT / row['target']).is_file():
                raise SystemExit(f'Missing imported capability {row["target"]}')
        print(f'{len(recorded["files"])} tracked source files accounted for')
        return
    archive = subprocess.check_output(['git', 'archive', REVISION], cwd=args.source)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        sources = {entry.name: tar.extractfile(entry).read() for entry in tar if entry.isfile()}
    mapped = {path: destination(path) for path in sources if destination(path)}

    manifest = [
        {'source': path, 'target': target, 'sourceSha256': hashlib.sha256(sources[path]).hexdigest()}
        for path, target in mapped.items()
    ]
    recorded = json.loads(receipt.read_text())
    if recorded['files'] != manifest or recorded['revision'] != REVISION:
        raise SystemExit('Source mapping or pinned source hashes changed')
    for row in manifest:
        if not (ROOT / row['target']).is_file():
            raise SystemExit(f'Missing imported capability {row["target"]}')
    adapted = {
        'src/domains/dps/engine/kernel/event-queue.ts',
        'src/domains/dps/engine/kernel/session.ts',
        'src/domains/dps/engine/kernel/timer-port.ts',
        'src/domains/dps/rulesets/cdragon-directory-roster.ts',
        'src/domains/dps/observed-items.ts',
        'src/domains/dps/contracts/ports.ts',
    }
    def body(text):
        text = re.sub(r'^import\s[\s\S]*?;\n', '', text, flags=re.M)
        return re.sub(r'(["\'])(\.[./A-Za-z0-9_-]+)\1', lambda match: match[1] + match[2].removesuffix('.ts').removesuffix('/index') + match[1], text).strip()
    preserved = 0
    for row in manifest:
        if row['target'].startswith('src/domains/dps/') and row['target'] not in adapted:
            if body(sources[row['source']].decode()) != body((ROOT / row['target']).read_text()):
                raise SystemExit(f'Imported domain behavior changed: {row["target"]}')
            preserved += 1
    print(f'{preserved} imported domain bodies match pinned source; {len(adapted)} declared runtime or lint adaptations require tests and review')
    print(f'{len(manifest)} tracked source files accounted for from {REVISION}')


if __name__ == '__main__':
    main()
