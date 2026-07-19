import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

test('static materialization validates every manifest reference before copying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-materialize-'))
  const source = join(root, 'source')
  const destination = join(root, 'public', 'data')
  await mkdir(join(source, 'scopes'), { recursive: true })
  const manifest = {
    artifactKind: 'public-ranking-manifest',
    artifactMeta: { runId: 'fixture-run' },
    defaultSnapshotKey: 'All__All__All',
    snapshotIndex: { All__All__All: { url: '/data/scopes/all.json?v=fixture-run' } },
  }
  await writeFile(join(source, 'ranking-summary.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(join(source, 'scopes', 'all.json'), '{"artifactKind":"public-snapshot-shard"}\n')
  try {
    await run(process.execPath, ['scripts/materialize-ranking-data.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, RANKING_GENERATED_DATA_DIR: source, RANKING_STATIC_DATA_DIR: destination },
    })
    assert.deepEqual(JSON.parse(await readFile(join(destination, 'ranking-summary.json'), 'utf8')), manifest)
    await rm(join(source, 'scopes', 'all.json'))
    await assert.rejects(run(process.execPath, ['scripts/materialize-ranking-data.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, RANKING_GENERATED_DATA_DIR: source, RANKING_STATIC_DATA_DIR: destination },
    }), /Referenced ranking artifact/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
