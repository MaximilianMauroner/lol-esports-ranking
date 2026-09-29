import assert from 'node:assert/strict'
import test from 'node:test'
import { replayWorlds2022Group, type ObservedGroupGame, type Worlds2022GroupEntrant } from '../src/lib/worlds2022ObservedGroups.ts'

// Fictional identities/results. These are not Riot observations.
const evidence = { kind: 'synthetic-fixture' as const, reference: 'tests/worlds2022ObservedGroups.test.ts' }
const entrants: Worlds2022GroupEntrant[] = [
  { id: 'alpha', region: 'LCK', pool: 'A' },
  { id: 'bravo', region: 'LPL', pool: 'B' },
  { id: 'charlie', region: 'LEC', pool: 'C' },
  { id: 'delta', region: 'LCS', pool: 'play-in' },
]
const ids = entrants.map(({ id }) => id)
const games: ObservedGroupGame[] = []
for (let a = 0; a < 4; a += 1) {
  for (let b = a + 1; b < 4; b += 1) {
    for (let leg = 1; leg <= 2; leg += 1) {
      games.push({ id: `${a}-${b}-${leg}`, teamAId: ids[a], teamBId: ids[b], winnerId: ids[a] })
    }
  }
}
const replay = (more: Partial<Parameters<typeof replayWorlds2022Group>[0]> = {}) => replayWorlds2022Group({
  season: 2022, groupId: 'A', entrants, entrantEvidence: evidence, gameEvidence: evidence, games, ...more,
})

test('complete observed group advances two without claiming a historical forecast', () => {
  const original = structuredClone(games)
  const result = replay()
  assert.equal(result.status, 'supported')
  if (result.status !== 'supported') return
  assert.deepEqual(result.standings, [
    { id: 'alpha', wins: 6, losses: 0 }, { id: 'bravo', wins: 4, losses: 2 },
    { id: 'charlie', wins: 2, losses: 4 }, { id: 'delta', wins: 0, losses: 6 },
  ])
  assert.deepEqual(result.knockoutQualifierIds, ['alpha', 'bravo'])
  assert.deepEqual(result.observationEvidence, { entrants: evidence, games: evidence })
  assert.deepEqual(result.forecast, { status: 'unsupported', reason: 'historical-model-inputs-unavailable' })
  assert.deepEqual(replay({ games: [...games].reverse() }), result)
  assert.deepEqual(games, original)
})

test('missing evidence, wrong season and incomplete group return unsupported', () => {
  assert.equal(replay({ season: 2026 }).status, 'unsupported')
  assert.match(JSON.stringify(replay({ entrantEvidence: undefined })), /entrant-evidence-missing/)
  assert.match(JSON.stringify(replay({ gameEvidence: undefined })), /game-evidence-missing/)
  assert.match(JSON.stringify(replay({ games: games.slice(0, -1) })), /incomplete-group/)
  assert.match(JSON.stringify(replay({ groupId: 'E' })), /invalid-entrants/)
})

test('entrant pools, regions and game identity must match the observed format', () => {
  const sameRegion = structuredClone(entrants)
  sameRegion[3].region = ' lck '
  assert.match(JSON.stringify(replay({ entrants: sameRegion })), /same region/)
  const samePool = structuredClone(entrants)
  samePool[3].pool = 'A'
  assert.match(JSON.stringify(replay({ entrants: samePool })), /one entrant from each/)
  const duplicateId = structuredClone(games)
  duplicateId[1].id = duplicateId[0].id
  assert.match(JSON.stringify(replay({ games: duplicateId })), /duplicate game ID/)
  const badWinner = structuredClone(games)
  badWinner[0].winnerId = 'ghost'
  assert.match(JSON.stringify(replay({ games: badWinner })), /Winner must be/)
  const repeatedPair = structuredClone(games)
  repeatedPair[2].teamAId = repeatedPair[0].teamAId
  repeatedPair[2].teamBId = repeatedPair[0].teamBId
  repeatedPair[2].winnerId = repeatedPair[0].winnerId
  assert.match(JSON.stringify(replay({ games: repeatedPair })), /more than two games/)
})

test('unresolved qualification tie is unsupported, including with all scheduled games', () => {
  const tied = structuredClone(games)
  tied.find((game) => game.id === '1-2-2')!.winnerId = 'charlie'
  assert.deepEqual(replay({ games: tied }), {
    status: 'unsupported',
    reason: 'tiebreaker-rules-unavailable',
    detail: 'A tie crosses the knockout qualification line; the cited primer does not specify its resolution',
  })
})
