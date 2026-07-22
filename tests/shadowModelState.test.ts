import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  cleanupStagedShadowModelState,
  readStagedShadowModelState,
  stageShadowModelState,
} from '../scripts/shadow-model-state.ts'
import type { PersistedSnapshotModelState } from '../src/lib/incremental/snapshotInputs.ts'

const compatibilityHash = 'compatibility-test'

function fixture(): PersistedSnapshotModelState {
  return {
    schemaVersion: 1,
    compatibilityHash,
    rankingCatalogs: new Map(),
    playerCatalogs: new Map(),
    rankingResults: new Map(),
    playerResults: new Map(),
  }
}

test('shadow model state uses private permissions and validates before decode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-shadow-state-'))
  const staged = stageShadowModelState(root, fixture())
  try {
    assert.equal((await stat(staged.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(staged.path)).mode & 0o777, 0o600)
    assert.deepEqual(readStagedShadowModelState(staged, compatibilityHash), fixture())
  } finally {
    cleanupStagedShadowModelState(staged)
  }
  await assert.rejects(stat(staged.directory), { code: 'ENOENT' })
})

test('corrupt and truncated shadow model state fail closed and always clean up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-shadow-corrupt-'))
  for (const corruption of ['corrupt', 'truncated'] as const) {
    const staged = stageShadowModelState(root, fixture())
    try {
      const contents = await readFile(staged.path)
      if (corruption === 'corrupt') contents[0] = contents[0] === 0x7b ? 0x5b : 0x7b
      await writeFile(staged.path, corruption === 'truncated' ? contents.subarray(0, Math.max(1, contents.length - 4)) : contents)
      await chmod(staged.path, 0o600)
      assert.throws(
        () => readStagedShadowModelState(staged, compatibilityHash),
        corruption === 'truncated' ? /byte length mismatch/ : /digest mismatch/,
      )
    } finally {
      cleanupStagedShadowModelState(staged)
    }
    await assert.rejects(stat(staged.directory), { code: 'ENOENT' })
  }
})
