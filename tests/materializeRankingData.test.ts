import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { materializePublicArtifactBundle, validatePublicArtifactBundle } from '../scripts/materialize-ranking-data.ts'
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
    const published = await readTree(destination)
    const pageRelativePath = validated.relativePaths.find((path) => path.startsWith('matches/pages/')) ?? ''
    assert.ok(pageRelativePath)
    for (const mutation of provenanceMutations(pageRelativePath)) {
      await rm(source, { recursive: true, force: true })
      await cp(PUBLIC_ARTIFACT_FIXTURE_DIR, source, { recursive: true })
      const path = join(source, mutation.relativePath)
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      mutation.apply(value)
      await writeFile(path, `${JSON.stringify(value)}\n`)
      await assert.rejects(
        materializePublicArtifactBundle(source, destination),
        (error) => errorChainIncludes(error, 'provenance mismatch'),
        mutation.label,
      )
      assert.deepEqual(await readTree(destination), published, `${mutation.label} changed the atomic target`)
    }

    await rm(join(source, pageRelativePath))
    await assert.rejects(materializePublicArtifactBundle(source, destination), /unavailable or invalid/)
    assert.deepEqual(await readTree(destination), published)
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
      cwd: process.cwd(), env: { ...process.env, RANKING_STATIC_DATA_DIR: PUBLIC_ARTIFACT_FIXTURE_DIR, VITE_RANKING_DATA_URL: '', RANKING_RELEASE_DATA_ALLOW_FIXTURE: 'true' },
    })
    const external = await run('pnpm', ['exec', 'tsx', 'scripts/static-data-preflight.ts'], {
      cwd: process.cwd(), env: { ...process.env, RANKING_STATIC_DATA_DIR: empty, VITE_RANKING_DATA_URL: 'https://cdn.example/x/' },
    })
    assert.match(external.stdout, /https:\/\/cdn\.example\/x\/ranking-summary\.json/)
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

function provenanceMutations(pageRelativePath: string) {
  const fields = ['runId', 'generatedAt', 'modelVersion', 'modelConfigHash'] as const
  const mutations: Array<{ label: string; relativePath: string; apply(value: Record<string, unknown>): void }> = []
  for (const field of fields) {
    mutations.push({
      label: `manifest artifactMeta ${field}`,
      relativePath: 'ranking-summary.json',
      apply: (value) => { record(value.artifactMeta)[field] = `wrong-${field}` },
    })
    mutations.push({
      label: `artifact top-level ${field}`,
      relativePath: pageRelativePath,
      apply: (value) => { value[field] = `wrong-${field}` },
    })
    mutations.push({
      label: `artifact artifactMeta ${field}`,
      relativePath: pageRelativePath,
      apply: (value) => { record(value.artifactMeta)[field] = `wrong-${field}` },
    })
  }
  mutations.push({
    label: 'manifest generatedAt',
    relativePath: 'ranking-summary.json',
    apply: (value) => { value.generatedAt = '2020-01-01T00:00:00.000Z' },
  }, {
    label: 'manifest model version',
    relativePath: 'ranking-summary.json',
    apply: (value) => { record(value.model).version = 'wrong-model' },
  }, {
    label: 'manifest model config hash',
    relativePath: 'ranking-summary.json',
    apply: (value) => { record(value.model).configHash = 'wrong-config' },
  })
  return mutations
}

async function readTree(root: string, relativePath = ''): Promise<Record<string, string>> {
  const entries = await readdir(join(root, relativePath), { withFileTypes: true })
  const output: Record<string, string> = {}
  for (const entry of entries) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(output, await readTree(root, child))
    else if (entry.isFile()) output[child] = (await readFile(join(root, child))).toString('base64')
  }
  return output
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function errorChainIncludes(error: unknown, expected: string): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes(expected) || errorChainIncludes(error.cause, expected)
}
