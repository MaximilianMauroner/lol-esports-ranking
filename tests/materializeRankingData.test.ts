import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { validatePublicArtifactBundle } from '../scripts/materialize-ranking-data.ts'
import { PUBLIC_ARTIFACT_FIXTURE_DIR } from './fixtures/publicArtifactBundle.ts'

const run = promisify(execFile)

test('materializer recursively validates and atomically publishes the complete artifact graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-materialize-'))
  const source = join(root, 'source')
  const destination = join(root, 'public', 'data')
  await cp(PUBLIC_ARTIFACT_FIXTURE_DIR, source, { recursive: true })
  try {
    const validated = await validatePublicArtifactBundle(source)
    assert.ok(validated.relativePaths.some((path) => path.startsWith('matches/pages/')))
    assert.ok(validated.relativePaths.some((path) => path.startsWith('history/team-series/')))
    await executeMaterializer(source, destination)
    const publishedManifest = await readFile(join(destination, 'ranking-summary.json'), 'utf8')

    const pagePath = join(source, validated.relativePaths.find((path) => path.startsWith('matches/pages/')) ?? '')
    const page = JSON.parse(await readFile(pagePath, 'utf8'))
    page.artifactMeta.runId = 'mixed-generation'
    await writeFile(pagePath, `${JSON.stringify(page)}\n`)
    await assert.rejects(executeMaterializer(source, destination), /provenance mismatch/)
    assert.equal(await readFile(join(destination, 'ranking-summary.json'), 'utf8'), publishedManifest)

    await rm(pagePath)
    await assert.rejects(executeMaterializer(source, destination), /unavailable or invalid/)
    assert.equal(await readFile(join(destination, 'ranking-summary.json'), 'utf8'), publishedManifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('static deployment uses the validated-data preflight and supports local or external artifacts', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'ranking-static-empty-'))
  try {
    const vercel = JSON.parse(await readFile(join(process.cwd(), 'vercel.json'), 'utf8'))
    assert.equal(vercel.buildCommand, 'pnpm run build:static')
    await assert.rejects(run('pnpm', ['exec', 'tsx', 'scripts/static-data-preflight.ts'], {
      cwd: process.cwd(), env: { ...process.env, RANKING_STATIC_DATA_DIR: empty, VITE_RANKING_DATA_URL: '' },
    }), /no complete validated ranking data/)
    await run('pnpm', ['exec', 'tsx', 'scripts/static-data-preflight.ts'], {
      cwd: process.cwd(), env: { ...process.env, RANKING_STATIC_DATA_DIR: PUBLIC_ARTIFACT_FIXTURE_DIR, VITE_RANKING_DATA_URL: '' },
    })
    await run('pnpm', ['exec', 'tsx', 'scripts/static-data-preflight.ts'], {
      cwd: process.cwd(), env: { ...process.env, RANKING_STATIC_DATA_DIR: empty, VITE_RANKING_DATA_URL: 'https://cdn.example/x/ranking-summary.json' },
    })
    await assert.rejects(run('pnpm', ['exec', 'tsx', 'scripts/static-data-preflight.ts'], {
      cwd: process.cwd(), env: { ...process.env, RANKING_STATIC_DATA_DIR: empty, VITE_RANKING_DATA_URL: 'ftp://localhost/ranking-summary.json' },
    }), /must use HTTPS/)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

function executeMaterializer(source: string, destination: string) {
  return run('pnpm', ['exec', 'tsx', 'scripts/materialize-ranking-data.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, RANKING_GENERATED_DATA_DIR: source, RANKING_STATIC_DATA_DIR: destination },
  })
}
