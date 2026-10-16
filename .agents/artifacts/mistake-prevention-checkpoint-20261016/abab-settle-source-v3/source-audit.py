import hashlib
import json
from pathlib import Path

new = Path(__file__).resolve().parent
old = new.parent / 'r3-abab-attempts-fix-v2'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
package = json.loads((old / 'source-package.json').read_text())
for name in ['abab-driver.mjs', 'locked-abab.sh', 'compare-abab.mjs']:
    assert sha(old / name) == package['sources'][name], name
for name in ['compare-abab.mjs', 'dependency-state-pins.json', 'input-manifest.json', 'input-sha256.txt']:
    assert (old / name).read_bytes() == (new / name).read_bytes(), name
before = (old / 'abab-driver.mjs').read_text()
after = (new / 'abab-driver.mjs').read_text()
start = after.index('const pause = ')
end = after.index('\nasync function barrier()', start)
old_pause = 'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))'
assert after[:start] + old_pause + after[end:] == before
assert (new / 'locked-abab.sh').read_text() == (old / 'locked-abab.sh').read_text().replace(str(old), str(new))
provenance = json.loads((new / 'source-input-inventory.json').read_text())
assert provenance['historical141PinsUnchanged'] == json.loads((old / 'input-manifest.json').read_text())
for entry in provenance['sourceAndReviewProvenance']:
    assert sha(Path(entry['path'])) == entry['sha256'], entry['path']
assert len((old / 'inventory-sha256.txt').read_text().splitlines()) == 750
assert sha(old / 'inventory-sha256.txt') == '5c883638154d354e74af44511c7f4a85e2c23f46211489e1090d0bb39f150b4e'
assert "emit('driver', 'postcondition-met', { action })\n  await pause(3000)\n  await barrier()" in after
print(json.dumps({'verdict': 'PASS', 'sourceDelta': ['pause body', 'launcher revision path'], 'comparatorByteIdentical': True, 'fiveInstrumentSourceKeysUnchanged': True, 'historicalInputPins': 141, 'historicalInventoryPins': 750, 'provenanceHashes': len(provenance['sourceAndReviewProvenance']), 'actualRuntimeReadOrRun': False}))
