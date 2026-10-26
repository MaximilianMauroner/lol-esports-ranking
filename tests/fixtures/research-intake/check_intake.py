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

    def test_required_pin_files_reject_malformed_json_and_records(self):
        invalid = [b'{invalid-json', b'[]', b'[{"path":"result.json","sha256":"bad"}]',
                   b'[{"sha256":"' + digest(self.original).encode() + b'"}]', b'{"scripts":[]}']
        for index, body in enumerate(invalid):
            with self.subTest(index=index):
                self.root = self.home / f'invalid-required-{index}'
                self.root.mkdir()
                name = 'script-pins.json' if index == 4 else 'input-pins.json'
                source = self.source / name
                source.write_bytes(body)
                self.spec_value['files'][f'archive/study/{name}'] = {'original': str(source),
                    'bytes': len(body), 'sha256': digest(source)}
                write(self.spec, self.spec_value)
                self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec), success=False)
                self.assertFalse((self.root / 'inventory.json').exists())
                self.spec_value['files'].pop(f'archive/study/{name}')

    def test_keyed_inputs_and_script_maps_have_real_dependency_edges(self):
        for index, (name, value) in enumerate([
            ('input-pins.json', {str(self.original): {'sha256': digest(self.original)}}),
            ('script-pins.json', {'scripts': {'result.json': digest(self.original)}}),
        ]):
            with self.subTest(name=name):
                self.root = self.home / f'keyed-required-{index}'
                self.root.mkdir()
                source = self.source / name
                write(source, value)
                self.spec_value['files'][f'archive/study/{name}'] = {'original': str(source),
                    'bytes': source.stat().st_size, 'sha256': digest(source)}
                write(self.spec, self.spec_value)
                self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec))
                inventory = json.loads((self.root / 'inventory.json').read_bytes())
                self.assertEqual(len(inventory['dependencies']), 1)
                self.anchor = digest(self.root / 'inventory.json')
                self.import_bundle()
                self.spec_value['files'].pop(f'archive/study/{name}')

    def test_script_map_keeps_nested_required_input_records(self):
        for index, present in enumerate([False, True]):
            with self.subTest(present=present):
                self.root = self.home / f'nested-script-input-{index}'
                self.root.mkdir()
                extra = self.source / 'extra.json'
                write(extra, {'retained': True})
                value = {'scripts': {'result.json': digest(self.original)},
                         'inputs': [{'path': str(extra), 'sha256': digest(extra)}]}
                source = self.source / 'script-pins.json'
                write(source, value)
                self.spec_value['files']['archive/study/script-pins.json'] = {'original': str(source),
                    'bytes': source.stat().st_size, 'sha256': digest(source)}
                if present:
                    self.spec_value['files']['archive/study/extra.json'] = {'original': str(extra),
                        'bytes': extra.stat().st_size, 'sha256': digest(extra)}
                write(self.spec, self.spec_value)
                self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec), success=present)
                if present:
                    inventory = json.loads((self.root / 'inventory.json').read_bytes())
                    self.assertEqual({edge['to'] for edge in inventory['dependencies']},
                                     {'archive/study/result.json', 'archive/study/extra.json'})
                    self.anchor = digest(self.root / 'inventory.json')
                    self.import_bundle()
                else:
                    self.assertFalse((self.root / 'inventory.json').exists())
                self.spec_value['files'].pop('archive/study/script-pins.json')
                self.spec_value['files'].pop('archive/study/extra.json', None)

    def test_repeat_freeze_cannot_shrink_the_pinned_selection(self):
        self.root = self.home / 'changed-inventory'
        self.root.mkdir()
        second = self.source / 'second.json'
        write(second, {'retained': True})
        self.spec_value['files']['archive/study/second.json'] = {'original': str(second),
            'bytes': second.stat().st_size, 'sha256': digest(second)}
        write(self.spec, self.spec_value)
        self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec))
        inventory_path = self.root / 'inventory.json'
        inventory = json.loads(inventory_path.read_bytes())
        inventory['files'].pop('archive/study/second.json')
        relocation_path = self.root / 'relocation.json'
        relocation = json.loads(relocation_path.read_bytes())
        relocation['files'].pop(str(second))
        relocation_path.chmod(0o644)
        write(relocation_path, relocation)
        inventory['documents']['relocation.json'] = {'bytes': relocation_path.stat().st_size,
            'sha256': digest(relocation_path)}
        inventory_path.chmod(0o644)
        write(inventory_path, inventory)
        before = inventory_path.read_bytes()
        self.run_cli('freeze', '--spec', str(self.spec), sha=digest(self.spec), success=False)
        self.assertEqual(inventory_path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
