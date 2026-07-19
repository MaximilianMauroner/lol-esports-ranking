import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createPublicArtifactWritePlan, PUBLIC_ARTIFACT_PATHS } from '../src/lib/publicArtifacts/writePlan'

// Regenerates every browser-loadable derived artifact from the existing full
// snapshot, without re-crunching raw CSVs. This intentionally shares the same
// public write plan and budget gates as data:crunch.
const data = JSON.parse(await readFile('data/derived/ranking-snapshot.full.json', 'utf8'))
const plan = createPublicArtifactWritePlan(data)

const generatedDataDir = resolve(process.env.RANKING_PUBLIC_DATA_DIR ?? '.generated/ranking-data')
await rm(resolve(generatedDataDir, PUBLIC_ARTIFACT_PATHS.teamHistoryShardDir), { recursive: true, force: true })
await rm(resolve(generatedDataDir, PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir), { recursive: true, force: true })
await rm(resolve(generatedDataDir, PUBLIC_ARTIFACT_PATHS.matchHistoryShardDir), { recursive: true, force: true })
await rm(resolve(generatedDataDir, PUBLIC_ARTIFACT_PATHS.teamHistory), { force: true })

for (const entry of plan.writes) {
  entry.validate(JSON.parse(entry.contents))
  const output = resolve(generatedDataDir, entry.relativePath)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, entry.contents)
}

await rm(resolve(generatedDataDir, 'snapshots'), { recursive: true, force: true })
await rm(resolve(generatedDataDir, 'team-history'), { recursive: true, force: true })
await rm(resolve(generatedDataDir, 'players.json'), { force: true })
await rm(resolve(generatedDataDir, 'region-history.json'), { force: true })
await rm(resolve(generatedDataDir, 'team-history.json'), { force: true })

console.log('public artifacts:', plan.writes.length, 'files')
console.log('public scopes:', Object.keys(plan.snapshots).length, 'files under', PUBLIC_ARTIFACT_PATHS.scopeDir)
