import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const refreshScript: string = '../scripts/refresh-data-if-changed.mjs'
const { refreshDataIfChanged } = await import(refreshScript) as {
  refreshDataIfChanged: (args: string[], options: {
    env: Record<string, string>
    bucketConfig: Record<string, unknown>
    bucketClient: { send: () => Promise<never> }
    run: (command: string, args: string[]) => Promise<void>
    uploadRankingArtifacts: () => Promise<Record<string, unknown>>
  }) => Promise<{ changed: boolean; status?: string }>
}

for (const failure of ['different source', 'forced same source'] as const) {
  test(`refresh repairs a partial mutable publication after ${failure}`, async () => {
    const fixture = await mutablePublicationFixture()
    try {
      await fixture.refresh()
      assert.deepEqual(await fixture.artifacts(), { scope: 'A-1', summary: 'A-1' })

      fixture.source = failure === 'different source' ? 'B' : 'A'
      fixture.failPublication = true
      await assert.rejects(fixture.refresh(failure === 'forced same source' ? ['--force'] : []), /Partial mutable publication/)
      assert.deepEqual(await fixture.artifacts(), {
        scope: failure === 'different source' ? 'B-2' : 'A-2',
        summary: 'A-1',
      })

      fixture.source = 'A'
      fixture.failPublication = false
      const retry = await fixture.refresh()
      assert.deepEqual({
        changed: retry.changed,
        artifacts: await fixture.artifacts(),
        publications: fixture.publications,
      }, {
        changed: true,
        artifacts: { scope: 'A-3', summary: 'A-3' },
        publications: 3,
      }, 'A prior successful fingerprint cannot prove completeness after an intervening failed attempt')

      const unchanged = await fixture.refresh()
      assert.equal(unchanged.changed, false)
      assert.equal(fixture.publications, 3)
      assert.deepEqual(await fixture.artifacts(), { scope: 'A-3', summary: 'A-3' })
    } finally {
      await fixture.cleanup()
    }
  })
}

async function mutablePublicationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'refresh-mutable-publication-'))
  const rawDir = join(root, 'raw')
  const publicDataDir = join(root, 'public')
  const bucketDir = join(root, 'bucket')
  const statePath = join(rawDir, 'refresh-state.json')
  const args = [
    '--raw-dir', rawDir,
    '--manifest', join(rawDir, 'manifest.json'),
    '--state', statePath,
    '--staging-dir', join(root, 'staging'),
    '--output', join(root, 'full.json'),
    '--public-data-dir', publicDataDir,
    '--start', '2026-01-01',
    '--end', '2026-06-29',
  ]
  const fixture = {
    source: 'A',
    builds: 0,
    publications: 0,
    failPublication: false,
    statePath,
    async artifacts() {
      return {
        scope: await readFile(join(bucketDir, 'scope.json'), 'utf8'),
        summary: await readFile(join(bucketDir, 'ranking-summary.json'), 'utf8'),
      }
    },
    refresh(extraArgs: string[] = []) {
      return refreshDataIfChanged([...args, ...extraArgs], {
        env: { RANKING_BUCKET_RESTORE_RAW: 'false' },
        bucketConfig: { enabled: true, bucket: 'fixture', prefix: 'rankings' },
        bucketClient: { send: async () => { throw new Error('Unexpected bucket request') } },
        run: async (command, commandArgs) => {
          if (commandArgs.includes('scripts/download-local-data.mjs')) {
            const outDir = argument(commandArgs, '--out-dir')
            const sourcePath = join(outDir, 'leaguepedia.json')
            await writeFile(sourcePath, JSON.stringify({ matches: [{ id: fixture.source }] }))
            await writeFile(argument(commandArgs, '--manifest'), JSON.stringify({
              schemaVersion: 1,
              start: '2026-01-01',
              end: '2026-06-29',
              files: { leaguepediaJson: [sourcePath], oracleCsv: [] },
              sources: { leaguepedia: { status: 'downloaded', downloadedCount: 1 } },
              warnings: [],
            }))
            return
          }
          assert.equal(command, 'pnpm')
          assert.ok(commandArgs.includes('scripts/build-static-snapshot.ts'))
          fixture.builds += 1
          await mkdir(publicDataDir, { recursive: true })
          await writeFile(join(publicDataDir, 'scope.json'), `${fixture.source}-${fixture.builds}`)
          await writeFile(join(publicDataDir, 'ranking-summary.json'), JSON.stringify(`${fixture.source}-${fixture.builds}`))
        },
        uploadRankingArtifacts: async () => {
          fixture.publications += 1
          await mkdir(bucketDir, { recursive: true })
          await writeFile(join(bucketDir, 'scope.json'), await readFile(join(publicDataDir, 'scope.json')))
          if (fixture.failPublication) throw new Error('Partial mutable publication')
          await writeFile(join(bucketDir, 'ranking-summary.json'), JSON.parse(await readFile(join(publicDataDir, 'ranking-summary.json'), 'utf8')))
          return {
            enabled: true, bucket: 'fixture', prefix: 'rankings', uploaded: [], unchanged: [], skipped: [],
            artifactCount: 2, uploadedCount: 2, uploadedBytes: 6, unchangedCount: 0, unchangedBytes: 0,
          }
        },
      })
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
  return fixture
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1)
  return args[index + 1]
}
