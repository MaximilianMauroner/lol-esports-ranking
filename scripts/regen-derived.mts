import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createPublicArtifactWritePlan, PUBLIC_ARTIFACT_PATHS } from '../src/lib/publicArtifacts/writePlan'

// Regenerates every browser-loadable derived artifact from the existing full
// snapshot, without re-crunching raw CSVs. This intentionally shares the same
// public write plan and budget gates as data:crunch.
const data = JSON.parse(await readFile('data/derived/ranking-snapshot.full.json', 'utf8'))
const plan = createPublicArtifactWritePlan(data)

await rm(resolve('public/data', PUBLIC_ARTIFACT_PATHS.teamHistoryShardDir), { recursive: true, force: true })
await rm(resolve('public/data', PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir), { recursive: true, force: true })
await rm(resolve('public/data', PUBLIC_ARTIFACT_PATHS.teamHistory), { force: true })

for (const entry of plan.writes) {
  entry.validate(JSON.parse(entry.contents))
  const output = resolve('public/data', entry.relativePath)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, entry.contents)
}

await rm('public/data/snapshots', { recursive: true, force: true })
await rm('public/data/team-history', { recursive: true, force: true })
await rm('public/data/players.json', { force: true })
await rm('public/data/region-history.json', { force: true })
await rm('public/data/team-history.json', { force: true })

console.log('public artifacts:', plan.writes.length, 'files')
console.log('public scopes:', Object.keys(plan.snapshots).length, 'files under', PUBLIC_ARTIFACT_PATHS.scopeDir)
