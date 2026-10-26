import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOL = Path(sys.argv.pop(1))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + '\n')


class IntakeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='research-intake-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.source = self.home / 'source'
        self.root = self.home / 'bundle'
        self.source.mkdir()
        self.root.mkdir()
        self.original = self.source / 'result.json'
        write(self.original, {'verdict': 'rejected', 'generatedAt': '2026-01-01T00:00:00Z'})
        self.spec = self.home / 'spec.json'
        self.spec_value = {'schema': 'research-intake-spec-v1', 'sourceRoots': {'archive/study': str(self.source)},
                           'files': {'archive/study/result.json': {'original': str(self.original),
                                     'bytes': self.original.stat().st_size, 'sha256': digest(self.original)}},
                           'researchStatus': {'modelAdopted': False, 'promotion': 'closed', 'verdict': 'rejected'}}
        write(self.spec, self.spec_value)
        self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec))
        self.anchor = digest(self.root / 'inventory.json')

    def run_cli(self, command, *args, sha=None, success=True):
        argv = [sys.executable, '-B', str(TOOL), command, '--root', str(self.root), '--sha256', sha or self.anchor, *args]
        result = subprocess.run(argv, text=True, capture_output=True)
        print(json.dumps({'argv': argv, 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}))
        self.assertEqual(result.returncode, 0 if success else 1, result.stdout + result.stderr)
        return json.loads(result.stdout if success else result.stderr)

    def import_bundle(self):
        return self.run_cli('import', '--inventory', str(self.root / 'inventory.json'))

    def test_actual_import_source_denied_verify_and_zero_copy_resume(self):
        self.assertEqual(self.import_bundle()['copiedFiles'], 1)
        target = self.root / 'archive/study/result.json'
        before = (target.read_bytes(), target.stat())
        hidden = self.home / 'hidden'
        self.source.rename(hidden)
        self.assertEqual(self.run_cli('verify')['originalPathsOpened'], 0)
        hidden.rename(self.source)
        self.assertEqual(self.import_bundle()['copiedFiles'], 0)
        self.assertEqual(target.read_bytes(), before[0])
        self.assertEqual((target.stat().st_ino, target.stat().st_mtime_ns), (before[1].st_ino, before[1].st_mtime_ns))

    def test_partial_copy_and_link_publish_crash_resume(self):
        staging = self.root / 'staging'
        (staging / 'pending-partial').write_bytes(b'incomplete')
        self.import_bundle()
        target = self.root / 'archive/study/result.json'
        before = target.stat()
        os.link(target, staging / 'pending-crash')
        self.assertEqual(self.import_bundle()['copiedFiles'], 0)
        self.assertEqual((target.stat().st_ino, target.stat().st_mtime_ns, target.stat().st_nlink),
                         (before.st_ino, before.st_mtime_ns, 1))
        self.assertEqual(list(staging.iterdir()), [])

    def test_freeze_publication_crash_resume_preserves_inventory(self):
        inventory = self.root / 'inventory.json'
        before = inventory.read_bytes(), inventory.stat().st_ino, inventory.stat().st_mtime_ns
        staging = self.root / 'staging'
        os.link(inventory, staging / 'pending-inventory-crash')
        os.link(self.root / 'summary.json', staging / 'pending-document-crash')
        self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec))
        self.assertEqual((inventory.read_bytes(), inventory.stat().st_ino, inventory.stat().st_mtime_ns), before)
        self.import_bundle()
        self.run_cli('verify')

    def test_conflicting_copy_never_overwrites(self):
        target = self.root / 'archive/study/result.json'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'conflict')
        self.run_cli('import', '--inventory', str(self.root / 'inventory.json'), success=False)
        self.assertEqual(target.read_bytes(), b'conflict')

    def test_corrupt_missing_extra_symlink_and_hardlink_rejected(self):
        self.import_bundle()
        target = self.root / 'archive/study/result.json'
        data = target.read_bytes()
        target.chmod(0o644)
        target.write_bytes(b'wrong')
        self.run_cli('verify', success=False)
        target.unlink()
        self.run_cli('verify', success=False)
        target.symlink_to(self.original)
        self.run_cli('verify', success=False)
        target.unlink()
        os.link(self.original, target)
        self.run_cli('verify', success=False)
        target.unlink()
        target.write_bytes(data)
        extra = target.parent / 'extra'
        extra.write_bytes(b'extra')
        self.run_cli('verify', success=False)
        extra.unlink()
        self.run_cli('verify')

    def test_manifest_anchor_traversal_and_duplicate_keys_rejected(self):
        self.import_bundle()
        self.run_cli('verify', sha='0' * 64, success=False)
        path = self.root / 'manifest.json'
        manifest = json.loads(path.read_bytes())
        path.chmod(0o644)
        manifest['files']['archive/../escape'] = manifest['files'].pop('archive/study/result.json')
        write(path, manifest)
        self.run_cli('verify', sha=digest(path), success=False)
        path.write_text('{"schema":"one","schema":"two"}')
        self.run_cli('verify', sha=digest(path), success=False)

    def test_nonregular_and_symlink_parent_rejected(self):
        target = self.root / 'archive/study/result.json'
        target.parent.mkdir(parents=True)
        target.mkdir()
        self.run_cli('import', '--inventory', str(self.root / 'inventory.json'), success=False)
        target.rmdir()
        target.parent.rmdir()
        target.parent.symlink_to(self.source, target_is_directory=True)
        self.run_cli('import', '--inventory', str(self.root / 'inventory.json'), success=False)

    def test_pinned_dependency_and_missing_conflicting_or_changed_anchor(self):
        self.import_bundle()
        dependency = self.root
        self.root = self.home / 'second'
        self.root.mkdir()
        self.spec_value['bundleDependencies'] = {'previous': {'siblingDirectory': dependency.name, 'manifestSha256': self.anchor}}
        input_pin = self.source / 'input-pins.json'
        write(input_pin, [{'path': str(self.original), 'sha256': digest(self.original)}])
        self.spec_value['sourceRoots'] = {'archive/second': str(self.source)}
        self.spec_value['files'] = {'archive/second/input-pins.json': {'original': str(input_pin),
                                  'bytes': input_pin.stat().st_size, 'sha256': digest(input_pin)}}
        write(self.spec, self.spec_value)
        self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec))
        self.anchor = digest(self.root / 'inventory.json')
        self.import_bundle()
        self.assertEqual(len(json.loads((self.root / 'manifest.json').read_bytes())['externalDependencies']), 1)
        dependency.rename(self.home / 'hidden')
        self.run_cli('verify', success=False)
        (self.home / 'hidden').rename(dependency)
        manifest_path = self.root / 'manifest.json'
        manifest_path.chmod(0o644)
        manifest = json.loads(manifest_path.read_bytes())
        manifest['externalDependencies'][0]['sha256'] = '0' * 64
        write(manifest_path, manifest)
        self.run_cli('verify', sha=digest(manifest_path), success=False)
        manifest['externalDependencies'][0]['sha256'] = digest(self.original)
        manifest['bundleDependencies']['previous']['manifestSha256'] = '0' * 64
        write(manifest_path, manifest)
        self.run_cli('verify', sha=digest(manifest_path), success=False)

    def test_missing_required_input_cannot_freeze(self):
        self.root = self.home / 'missing-input'
        self.root.mkdir()
        input_pin = self.source / 'input-pins.json'
        write(input_pin, [{'path': '/not-an-input', 'sha256': '0' * 64}])
        self.spec_value['files']['archive/study/input-pins.json'] = {'original': str(input_pin),
                         'bytes': input_pin.stat().st_size, 'sha256': digest(input_pin)}
        write(self.spec, self.spec_value)
        self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec), success=False)
        self.assertFalse((self.root / 'manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
