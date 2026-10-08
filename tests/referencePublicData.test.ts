import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const helperUrl = new URL('../scripts/reference-public-data.mjs', import.meta.url).href
const runnerPath = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

async function probe(publicDir?: string, ensure = true) {
  const env = { ...process.env }
  delete env.RANKING_TEST_PUBLIC_DIR
  if (publicDir) env.RANKING_TEST_PUBLIC_DIR = publicDir
  return exec(process.execPath, ['--input-type=module', '-e', `
    import { readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { ensureReferencePublicData, referencePublicDataDir, referencePublicDir } from ${JSON.stringify(helperUrl)}
    globalThis.fetch = () => { throw new Error('Unexpected reference download') }
    ${ensure ? 'await ensureReferencePublicData()' : ''}
    console.log(JSON.stringify({
      publicDir: referencePublicDir,
      dataDir: referencePublicDataDir,
      ${ensure ? `direct: JSON.parse(await readFile(join(referencePublicDataDir, 'ranking-summary.json'), 'utf8')),
      url: JSON.parse(await readFile(join(referencePublicDir, 'data/ranking-summary.json'), 'utf8')),` : ''}
    }))
  `], { cwd: repositoryRoot, env })
}

async function candidateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ranking-release-candidate-'))
  const publicDir = join(root, 'public')
  for (const path of [
    'ranking-summary.json',
    'entities/teams.json',
    'entities/players.json',
    'matches/index.json',
    'history/team-series/index.json',
    'history/region-series.json',
    'history/tournament-moves/index.json',
    'scopes/all.json',
  ]) {
    const target = join(publicDir, 'data', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ candidate: 'fresh-generated-output' }))
  }
  return { root, publicDir }
}

test('test readers select the generated candidate for both direct paths and data URLs', async () => {
  const { root, publicDir } = await candidateFixture()
  try {
    const selected = JSON.parse((await probe(publicDir)).stdout)
    assert.equal(selected.publicDir, publicDir)
    assert.equal(selected.dataDir, join(publicDir, 'data'))
    assert.deepEqual(selected.direct, { candidate: 'fresh-generated-output' })
    assert.deepEqual(selected.url, selected.direct)

    const frozen = JSON.parse((await probe(undefined, false)).stdout)
    assert.equal(frozen.publicDir, join(repositoryRoot, 'data/reference', '8adbc0a4239fd0dfba2094b3e70f60b513560de4', 'public'))
    assert.equal(frozen.dataDir, join(frozen.publicDir, 'data'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('candidate validation rejects a missing expected artifact without reference fallback', async () => {
  const { root, publicDir } = await candidateFixture()
  try {
    await rm(join(publicDir, 'data/history/region-series.json'))
    await assert.rejects(probe(publicDir), /Release candidate artifact is missing or invalid: .*history\/region-series\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('candidate validation rejects invalid JSON in generated shards', async () => {
  const { root, publicDir } = await candidateFixture()
  try {
    await writeFile(join(publicDir, 'data/scopes/all.json'), '{broken')
    await assert.rejects(probe(publicDir), /Release candidate artifact is missing or invalid: .*scopes\/all\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('test runner rejects a missing release candidate before launching test workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-missing-candidate-'))
  try {
    await assert.rejects(exec(process.execPath, [runnerPath], {
      cwd: repositoryRoot,
      env: { ...process.env, RANKING_TEST_PUBLIC_DIR: root },
    }), /ENOENT.*(?:scandir|ranking-summary)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
