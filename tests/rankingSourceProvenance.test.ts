import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rankingSourceProvenance } from '../scripts/rankings/source-provenance.ts'

test('resume and export identity cover executed JavaScript and root configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-source-'))
  try {
    execFileSync('git', ['init', '--quiet', root])
    await mkdir(join(root, 'scripts'))
    const inputs = ['scripts/local-data-manifest.js', 'package.json', 'tsconfig.node.json']
    for (const path of inputs) await writeFile(join(root, path), '{}')
    const baseline = await rankingSourceProvenance(root)
    assert.deepEqual(baseline.sourceDigests.map(row => row.path), [...inputs].sort())
    for (const path of inputs) {
      await writeFile(join(root, path), '{"changed":true}')
      assert.notEqual((await rankingSourceProvenance(root)).sourceHash, baseline.sourceHash, path)
      await writeFile(join(root, path), '{}')
    }
    assert.deepEqual(await rankingSourceProvenance(root), baseline)
  } finally { await rm(root, { recursive: true, force: true }) }
})
