import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createStaticRankingData } from '../../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../../src/lib/publicArtifacts/writePlan.ts'
import { rosters, sampleMatches, teams } from './rankingFixtures.ts'

export const PUBLIC_ARTIFACT_FIXTURE_RUN = {
  generatedAt: '2026-07-19T12:00:00.000Z',
  runId: 'fixture_public_artifacts_v1',
}

export const PUBLIC_ARTIFACT_FIXTURE_DIR = createFixtureBundle()

function createFixtureBundle() {
  const root = mkdtempSync(join(tmpdir(), 'lol-public-artifacts-'))
  process.once('exit', () => rmSync(root, { recursive: true, force: true }))
  const snapshot = createStaticRankingData({
    matches: sampleMatches.map((match) => ({ ...match, sourceProvider: 'oracles-elixir' })),
    teams,
    rosters,
    source: 'deterministic public artifact test fixture',
    runMetadata: PUBLIC_ARTIFACT_FIXTURE_RUN,
  })
  const plan = createPublicArtifactWritePlan(snapshot, { runMetadata: PUBLIC_ARTIFACT_FIXTURE_RUN })
  for (const write of plan.writes) {
    const path = join(root, write.relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, write.contents)
  }
  return root
}
