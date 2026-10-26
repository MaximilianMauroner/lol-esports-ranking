#!/usr/bin/env python3
"""Import pinned research bytes. Evidence intake never adopts a model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile

SHA = re.compile(r'^[0-9a-f]{64}$')
DOCUMENTS = {'summary.json', 'relocation.json', 'reference-closure.json'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def safe_name(name):
    require(isinstance(name, str) and name and '\\' not in name and '\x00' not in name,
            f'Unsafe relative path {name!r}')
    require(not PurePosixPath(name).is_absolute() and all(p not in ('', '.', '..') for p in name.split('/')),
            f'Unsafe relative path {name!r}')
    return name


def confined(root, name):
    root = Path(root).absolute()
    require('..' not in root.parts, 'Noncanonical root')
    path = root / safe_name(name)
    for part in [*reversed(path.parents), path]:
        require(not part.is_symlink(), f'Symlink path {part}')
    return path


def regular(path):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, f'Noncanonical absolute path {path}')
    for part in [*reversed(path.parents), path]:
        require(not part.is_symlink(), f'Symlink path {part}')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode), f'Not a regular file {path}')
    return info


def signature(path):
    before = regular(path)
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    after = regular(path)
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), f'File changed during read {path}')
    return {'bytes': before.st_size, 'sha256': digest.hexdigest()}


def load(path):
    regular(path)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f'Duplicate JSON key {key}')
            result[key] = value
        return result
    return json.loads(Path(path).read_bytes(), object_pairs_hook=unique)


def pin(record):
    require(type(record['bytes']) is int and record['bytes'] >= 0 and
            isinstance(record['sha256'], str) and SHA.fullmatch(record['sha256']), 'Invalid byte pin')
    return {k: record[k] for k in ('bytes', 'sha256')}


def pinned(path, expected):
    require(isinstance(expected, str) and SHA.fullmatch(expected), 'Explicit SHA256 required')
    require(regular(path).st_nlink == 1, f'Pinned file alias {path}')
    require(signature(path)['sha256'] == expected, f'Trust anchor mismatch {path}')
    return load(path)


def tree(root):
    require(root.is_dir() and not root.is_symlink(), f'Missing or unsafe tree {root}')
    result = set()
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            require(not (Path(parent) / name).is_symlink(), f'Symlink directory {name}')
        for name in files:
            path = Path(parent) / name
            regular(path)
            result.add(path)
    return result


def validate(manifest):
    require(manifest['schema'] == 'gamba-independent-intake-v1', 'Unknown manifest format')
    require(manifest['activeModelChange'] is False and manifest['promotion'] == 'closed', 'Adoption forbidden')
    require(isinstance(manifest['files'], dict) and manifest['files'], 'Empty archive')
    require(set(manifest['documents']) == DOCUMENTS, 'Invalid bound documents')
    roots = manifest['sourceRoots']
    for prefix, root in roots.items():
        require(safe_name(prefix).startswith('archive/'), 'Invalid archive prefix')
        require(Path(root).is_absolute() and '..' not in Path(root).parts, 'Invalid original root')
    originals = set()
    for name, record in manifest['files'].items():
        require(safe_name(name).startswith('archive/'), 'File outside archive')
        pin(record)
        matches = [(prefix, root) for prefix, root in roots.items() if name.startswith(prefix + '/')]
        require(len(matches) == 1, f'No unique source root {name}')
        prefix, root = matches[0]
        require(str(Path(root) / name[len(prefix) + 1:]) == record['original'], f'Original path escape {name}')
        require(record['original'] not in originals, 'Duplicate original alias')
        originals.add(record['original'])
    for name, record in manifest['documents'].items():
        safe_name(name)
        pin(record)
    for edge in manifest['dependencies']:
        require(edge['from'] in manifest['files'] and edge['to'] in manifest['files'], 'Missing dependency')
        require(manifest['files'][edge['to']]['sha256'] == edge['sha256'], 'Conflicting dependency')
    siblings = set()
    for label, dep in manifest.get('bundleDependencies', {}).items():
        safe_name(label)
        name = safe_name(dep['siblingDirectory'])
        require('/' not in name and name not in siblings, 'Conflicting dependency directory')
        siblings.add(name)
        require(SHA.fullmatch(dep['manifestSha256']), 'Invalid dependency anchor')
    for edge in manifest.get('externalDependencies', []):
        require(edge['from'] in manifest['files'] and edge['bundle'] in manifest.get('bundleDependencies', {}),
                'Missing external dependency')
        safe_name(edge['to'])
        require(SHA.fullmatch(edge['sha256']), 'Invalid external pin')


def verify(root, expected_sha, ancestors=()):
    root = Path(root).absolute()
    require(root not in ancestors, 'Dependency cycle')
    manifest = pinned(confined(root, 'manifest.json'), expected_sha)
    validate(manifest)
    originals = {(r['device'], r['inode']) for r in manifest['files'].values()}
    identities = set()
    for name, record in {**manifest['files'], **manifest['documents'],
                         'manifest.json': signature(confined(root, 'manifest.json'))}.items():
        path = confined(root, name)
        info = regular(path)
        identity = info.st_dev, info.st_ino
        require(info.st_nlink == 1 and identity not in originals and identity not in identities, f'File alias {name}')
        identities.add(identity)
        require(signature(path) == pin(record), f'Byte mismatch {name}')
    require({str(p.relative_to(root)) for p in tree(confined(root, 'archive'))} == set(manifest['files']),
            'Archive file set mismatch')
    relocation = load(confined(root, 'relocation.json'))
    require(relocation['files'] == {r['original']: n for n, r in manifest['files'].items()}, 'Relocation mismatch')
    dependencies = {}
    for label, dep in manifest.get('bundleDependencies', {}).items():
        sibling = confined(root.parent, dep['siblingDirectory'])
        require(sibling != root, 'Self dependency')
        dependencies[label] = verify(sibling, dep['manifestSha256'], (*ancestors, root))
    for edge in manifest.get('externalDependencies', []):
        target = dependencies[edge['bundle']]['manifest']['files'].get(edge['to'])
        require(target is not None and target['sha256'] == edge['sha256'], 'Conflicting external dependency')
    return {'manifest': manifest, 'status': 'passed', 'files': len(manifest['files']),
            'bytes': sum(r['bytes'] for r in manifest['files'].values()), 'manifestSha256': expected_sha,
            'dependencyBundles': {label: {k: v[k] for k in ('files', 'bytes', 'manifestSha256')} for label, v in dependencies.items()},
            'originalPathsOpened': 0, 'modelAdopted': False, 'promotion': 'closed'}


def publish(root, name, data=None, source=None, expected=None):
    target = confined(root, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = expected or {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if target.exists():
        require(signature(target) == expected and regular(target).st_nlink == 1, f'Conflicting destination {name}')
        return False
    staging = confined(root, 'staging')
    staging.mkdir(exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='pending-', dir=staging)
    try:
        with os.fdopen(fd, 'wb') as stream:
            if source is None:
                stream.write(data)
            else:
                regular(source)
                with open(source, 'rb') as original:
                    shutil.copyfileobj(original, stream, 1024 * 1024)
            stream.flush()
            os.fsync(stream.fileno())
        require(signature(Path(temporary)) == expected, f'Copy changed {name}')
        os.chmod(temporary, 0o444)
        if source is not None:
            info = regular(source)
            os.utime(temporary, ns=(info.st_atime_ns, info.st_mtime_ns))
        try:
            os.link(temporary, target)
        except FileExistsError:
            require(signature(target) == expected, f'Conflicting destination {name}')
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)
    require(regular(target).st_nlink == 1, f'File alias {name}')
    return True


def recover_staging(root, manifest):
    staging = confined(root, 'staging')
    if not staging.exists():
        return
    targets = {**manifest['files'], **manifest['documents']}
    targets.update({name: signature(confined(root, name)) for name in ('inventory.json', 'manifest.json')
                    if confined(root, name).exists()})
    for pending in tree(staging):
        require(pending.parent == staging and pending.name.startswith('pending-'), 'Unknown staging file')
        info = regular(pending)
        if info.st_nlink > 1:
            aliases = [name for name in targets if confined(root, name).exists()
                       and (regular(confined(root, name)).st_dev, regular(confined(root, name)).st_ino) == (info.st_dev, info.st_ino)]
            require(info.st_nlink == 2 and len(aliases) == 1 and signature(pending) == pin(targets[aliases[0]]),
                    'Unrecognized staging alias')
        pending.unlink()


def references(files, dependencies):
    by_original = {r['original']: ('local', name, r['sha256']) for name, r in files.items()}
    for label, dependency in dependencies.items():
        for name, record in dependency['files'].items():
            prior = by_original.get(record['original'])
            require(prior is None or prior[2] == record['sha256'], 'Conflicting original dependency')
            by_original[record['original']] = (label, name, record['sha256'])
    local, external, unresolved = set(), set(), []
    inspected = 0
    for name, record in files.items():
        if not name.endswith('.json'):
            continue
        try:
            stack = [('', load(Path(record['original'])))]
        except (json.JSONDecodeError, UnicodeDecodeError):
            unresolved.append({'from': name, 'reason': 'opaque-non-json-bytes'})
            continue
        while stack:
            pointer, value = stack.pop()
            if isinstance(value, dict):
                path, digest = value.get('path'), value.get('sha256')
                if isinstance(path, str) and isinstance(digest, str) and SHA.fullmatch(digest):
                    inspected += 1
                    original = os.path.normpath(path if os.path.isabs(path) else str(Path(record['original']).parent / path))
                    target = by_original.get(original)
                    if target is None and not os.path.isabs(path):
                        matches = [v for o, v in by_original.items() if o.endswith('/' + path) and v[2] == digest]
                        if len(matches) == 1:
                            target = matches[0]
                    if target is not None and target[2] == digest:
                        label, destination, _ = target
                        (local if label == 'local' else external).add((name, destination, digest) if label == 'local'
                                                                      else (name, label, destination, digest))
                    else:
                        require(Path(name).name not in ('input-pins.json', 'script-pins.json'), f'Missing or conflicting input dependency {path}')
                        unresolved.append({'from': name, 'pointer': pointer, 'path': path, 'sha256': digest,
                                           'reason': 'historical-audit-pin-not-required-input'})
                stack.extend((pointer + '/' + str(k), v) for k, v in value.items())
            elif isinstance(value, list):
                stack.extend((pointer + '/' + str(i), v) for i, v in enumerate(value))
    return ([dict(zip(('from', 'to', 'sha256'), edge)) for edge in sorted(local)],
            [dict(zip(('from', 'bundle', 'to', 'sha256'), edge)) for edge in sorted(external)],
            {'pinnedRecordsInspected': inspected, 'unresolvedAuditPins': unresolved,
             'scope': 'Required input-pins and script-pins are closed. Broad old audit snapshots are not a claim to archive unrelated studies.'})


def freeze(root, spec_path, expected_sha):
    spec = pinned(spec_path, expected_sha)
    require(spec['schema'] == 'research-intake-spec-v1', 'Unknown intake spec')
    inventory = confined(root, 'inventory.json')
    if inventory.exists():
        manifest = load(inventory)
        require(manifest['specSha256'] == expected_sha, 'Inventory spec conflict')
        validate(manifest)
        recover_staging(root, manifest)
        check_originals(manifest)
        return manifest
    dependencies = {label: verify(confined(root.parent, dep['siblingDirectory']), dep['manifestSha256'])['manifest']
                    for label, dep in spec.get('bundleDependencies', {}).items()}
    files = {}
    for name, record in spec['files'].items():
        safe_name(name)
        original = Path(record['original'])
        info = regular(original)
        require(info.st_nlink == 1 and signature(original) == pin(record), f'Original byte or alias conflict {original}')
        files[name] = {**record, 'device': info.st_dev, 'inode': info.st_ino, 'mtimeNs': info.st_mtime_ns,
                       'mode': stat.S_IMODE(info.st_mode), 'role': 'closed-study-evidence'}
    local, external, closure = references(files, dependencies)
    status = spec['researchStatus']
    require(status['modelAdopted'] is False and status['promotion'] == 'closed', 'Adoption forbidden')
    documents = {'summary.json': status, 'relocation.json': {'files': {r['original']: n for n, r in files.items()},
                  'policy': 'Original paths are provenance only. Verification reads local bundles.'}, 'reference-closure.json': closure}
    pins = {name: {'bytes': len(encode(value)), 'sha256': hashlib.sha256(encode(value)).hexdigest()} for name, value in documents.items()}
    manifest = {'schema': 'gamba-independent-intake-v1', 'frozenAt': datetime.now(timezone.utc).isoformat(),
                'activeModelChange': False, 'promotion': 'closed', 'sourceRoots': spec['sourceRoots'], 'files': files,
                'documents': pins, 'dependencies': local, 'bundleDependencies': spec.get('bundleDependencies', {}),
                'externalDependencies': external, 'sourceRepositories': {}, 'specSha256': expected_sha}
    validate(manifest)
    recover_staging(root, manifest)
    for name, value in documents.items():
        publish(root, name, data=encode(value))
    publish(root, 'inventory.json', data=encode(manifest))
    return manifest


def check_originals(manifest):
    for record in manifest['files'].values():
        original = Path(record['original'])
        info = regular(original)
        require(info.st_nlink == 1 and signature(original) == pin(record), f'Original byte conflict {original}')
        require((info.st_dev, info.st_ino, info.st_mtime_ns, stat.S_IMODE(info.st_mode)) ==
                (record['device'], record['inode'], record['mtimeNs'], record['mode']), f'Original identity changed {original}')


def import_archive(root, inventory_path, expected_sha):
    manifest = pinned(inventory_path, expected_sha)
    validate(manifest)
    for dep in manifest.get('bundleDependencies', {}).values():
        verify(confined(root.parent, dep['siblingDirectory']), dep['manifestSha256'])
    check_originals(manifest)
    recover_staging(root, manifest)
    needed = sum(r['bytes'] for name, r in manifest['files'].items() if not confined(root, name).exists())
    require(shutil.disk_usage(root).free > needed + 1024 ** 3, 'Insufficient disk space')
    for name, record in {**manifest['files'], **manifest['documents']}.items():
        target = confined(root, name)
        if target.exists():
            require(signature(target) == pin(record) and regular(target).st_nlink == 1, f'Conflicting destination {name}')
    for name, record in manifest['documents'].items():
        require(signature(confined(root, name)) == pin(record), f'Missing frozen document {name}')
    copied = sum(publish(root, name, source=Path(record['original']), expected=pin(record)) for name, record in manifest['files'].items())
    check_originals(manifest)
    publish(root, 'manifest.json', data=Path(inventory_path).read_bytes(), expected=signature(inventory_path))
    result = verify(root, expected_sha)
    result.pop('manifest')
    return {**result, 'copiedFiles': copied, 'reusedFiles': len(manifest['files']) - copied,
            'verificationScope': 'originalPathsOpened applies only to verify. Import checks originals.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('freeze', 'import', 'verify'))
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--sha256', required=True, help='Explicit spec, inventory, or published manifest SHA256')
    parser.add_argument('--spec', type=Path)
    parser.add_argument('--inventory', type=Path)
    args = parser.parse_args()
    root = args.root.absolute()
    if args.command == 'freeze':
        require(args.spec is not None, 'freeze requires --spec')
        manifest = freeze(root, args.spec.absolute(), args.sha256)
        result = {'status': 'frozen', 'files': len(manifest['files']), 'manifestSha256': signature(confined(root, 'inventory.json'))['sha256']}
    elif args.command == 'import':
        require(args.inventory is not None, 'import requires --inventory')
        result = import_archive(root, args.inventory.absolute(), args.sha256)
    else:
        result = verify(root, args.sha256)
        result.pop('manifest')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
