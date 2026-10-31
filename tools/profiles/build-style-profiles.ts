import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { MatchRecord } from '../../src/domains/rankings/types'
import { buildStyleProfiles } from '../../src/domains/style/build'
import { parseStyleProfileArtifact } from '../../src/domains/style/profile'

const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } }, strict: true })
if (!values.input || !values.output) throw new Error('Usage: build-style-profiles --input <prepared-corpus.json> --output <artifact.json>')
const output = resolve(values.output)
if (output === resolve(values.input) || output.includes('/public/data/')) throw new Error('Choose an explicit output outside public/data and the input file')
const bytes = await readFile(resolve(values.input))
const input: unknown = JSON.parse(bytes.toString('utf8'))
if (!input || typeof input !== 'object' || !('matches' in input) || !Array.isArray(input.matches)) throw new Error('Expected a prepared corpus with {matches}')
for (const match of input.matches) {
  if (!match || typeof match !== 'object' || typeof match.id !== 'string' || !match.id.trim()
    || typeof match.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)
    || !Number.isSafeInteger(match.season) || !match.teamA || !match.teamB) throw new Error('Invalid prepared MatchRecord')
  for (const side of ['A', 'B']) {
    const roster = match[`team${side}Roster`]
    if (roster !== undefined && (!roster || !Array.isArray(roster.players)
      || roster.players.some((player: unknown) => !player || typeof player !== 'object'))) throw new Error(`Invalid roster in ${match.id}`)
  }
}
const artifact = parseStyleProfileArtifact(buildStyleProfiles(input.matches as MatchRecord[], createHash('sha256').update(bytes).digest('hex')))
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(artifact)}\n`, { flag: 'w' })
console.log(JSON.stringify({ output, sourceSha256: artifact.sourceSha256, scopes: Object.fromEntries(Object.entries(artifact.scopes)
  .map(([scope, table]) => [scope, { countedGames: table.countedGames, excludedGames: table.excludedGames, players: table.players.length, teams: table.teams.length }])) }))
