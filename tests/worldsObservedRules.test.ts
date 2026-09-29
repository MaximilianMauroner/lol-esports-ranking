import assert from 'node:assert/strict'
import test from 'node:test'
import { replayWorldsSwiss, type ObservedSwissMatch, type SwissEntrant } from '../src/lib/worldsObservedRules.ts'

const regions = ['LCK', 'LPL', 'LEC', 'LTA', 'LCP']
const fixtureEvidence = { kind: 'synthetic-fixture' as const, reference: 'tests/worldsObservedRules.test.ts' }
const entrants: SwissEntrant[] = [
  ...regions.map((region, index) => ({ id: `one${index}`, region, tier: 1 as const })),
  ...regions.map((region, index) => ({ id: `two${index}`, region, tier: 2 as const })),
  { id: 'third0', region: 'LCK', tier: 2 },
  ...regions.slice(1).map((region, index) => ({ id: `third${index + 1}`, region, tier: 3 as const })),
  { id: 'playin', region: 'LCK', tier: 3 },
]

const firstRound: ObservedSwissMatch[] = [
  ...Array.from({ length: 4 }, (_, index) => ({
    id: `r1a${index}`, teamAId: `one${index}`, teamBId: `third${(index + 1) % 4 + 1}`, winnerId: `one${index}`,
  })),
  { id: 'r1a4', teamAId: 'one4', teamBId: 'playin', winnerId: 'one4' },
  { id: 'r1b0', teamAId: 'two0', teamBId: 'two1', winnerId: 'two0' },
  { id: 'r1b1', teamAId: 'two2', teamBId: 'two3', winnerId: 'two2' },
  { id: 'r1b2', teamAId: 'two4', teamBId: 'third0', winnerId: 'two4' },
]
const secondRound = [
  ...pairGroup(['one0', 'one1', 'one2', 'one3', 'one4', 'two0', 'two2', 'two4'], 'r2w'),
  ...pairGroup(['third2', 'third3', 'third4', 'third1', 'playin', 'two1', 'two3', 'third0'], 'r2l'),
]
secondRound[0].winnerId = 'one1'

const replay = (rounds: ObservedSwissMatch[][], more: Partial<Parameters<typeof replayWorldsSwiss>[0]> = {}) =>
  replayWorldsSwiss({ season: 2025, entrantEvidence: fixtureEvidence, matchEvidence: fixtureEvidence, entrants, rounds, ...more })

test('2025 observed Swiss round 1 replays without forecasting an unobserved draw', () => {
  const original = structuredClone(firstRound)
  const result = replay([firstRound])
  assert.equal(result.status, 'supported')
  if (result.status !== 'supported') return
  assert.equal(result.completedRounds, 1)
  assert.equal(result.standings.filter((team) => team.wins === 1).length, 8)
  assert.equal(result.standings.filter((team) => team.losses === 1).length, 8)
  assert.equal(result.standings.filter((team) => team.status === 'active').length, 16)
  assert.deepEqual(result.observationEvidence, { entrants: fixtureEvidence, matches: fixtureEvidence })
  assert.deepEqual(result.forecast, { status: 'unsupported', reason: 'draw-procedure-or-model-unavailable' })
  assert.deepEqual(firstRound, original)
  assert.deepEqual(replay([[...firstRound].reverse()]), result)
})

test('missing entrant evidence and uncertified seasons return explicit unsupported states', () => {
  assert.deepEqual(replay([], { entrantEvidence: undefined }), {
    status: 'unsupported', reason: 'entrant-evidence-missing', detail: 'Entrant identities and draw tiers need an evidence reference',
  })
  assert.deepEqual(replay([firstRound], { matchEvidence: undefined }), {
    status: 'unsupported', reason: 'match-evidence-missing', detail: 'Observed matches and winners need an evidence reference',
  })
  const noMatches = replay([], { matchEvidence: undefined })
  assert.equal(noMatches.status, 'supported')
  if (noMatches.status === 'supported') assert.equal(noMatches.observationEvidence.matches, null)
  assert.match(JSON.stringify(replay([], { season: 2026 })), /rules-unavailable/)
})

test('Swiss rejects incomplete, duplicate, incorrect-tier, same-region and contradictory results', () => {
  assert.equal(replay([firstRound.slice(0, 7)]).status, 'unsupported')
  const twice = structuredClone(firstRound)
  twice[1].teamAId = twice[0].teamAId
  assert.match(JSON.stringify(replay([twice])), /appears twice/)
  const wrongTier = structuredClone(firstRound)
  wrongTier[0].teamBId = 'two1'
  assert.match(JSON.stringify(replay([wrongTier])), /tier 1/)
  const sameRegion = structuredClone(firstRound)
  sameRegion[0].teamBId = 'playin'
  assert.match(JSON.stringify(replay([sameRegion])), /same-region/)
  const mixedCaseEntrants = structuredClone(entrants)
  mixedCaseEntrants.find((team) => team.id === 'playin')!.region = ' lck '
  assert.match(JSON.stringify(replay([sameRegion], { entrants: mixedCaseEntrants })), /same-region/)
  const unknownWinner = structuredClone(firstRound)
  unknownWinner[0].winnerId = 'ghost'
  assert.match(JSON.stringify(replay([unknownWinner])), /Winner is not a participant/)
  assert.match(JSON.stringify(replay([], { entrants: entrants.slice(1) })), /16 identified entrants/)
  const unknownRegion = structuredClone(entrants)
  unknownRegion[0].region = 'unknown'
  assert.match(JSON.stringify(replay([], { entrants: unknownRegion })), /Unknown 2025 region/)
})

test('later Swiss rounds require equal records and never replay an opponent', () => {
  const valid = replay([firstRound, secondRound])
  assert.equal(valid.status, 'supported')
  const unequal = structuredClone(secondRound)
  const swapped = unequal[0].teamBId
  unequal[0].teamBId = unequal[4].teamBId
  unequal[4].teamBId = swapped
  unequal[0].winnerId = unequal[0].teamAId
  unequal[4].winnerId = unequal[4].teamAId
  assert.match(JSON.stringify(replay([firstRound, unequal])), /equal records/)

  const standings = valid.status === 'supported' ? valid.standings : []
  const remaining = standings.filter((team) => !['one0', 'third2'].includes(team.id))
  const round3 = [
    { id: 'r3rematch', teamAId: 'one0', teamBId: 'third2', winnerId: 'one0' },
    ...pairGroup(remaining.map((team) => team.id), 'r3'),
  ]
  assert.match(JSON.stringify(replay([firstRound, secondRound, round3])), /Swiss rematch/)
  assert.match(JSON.stringify(replay([firstRound, ...Array.from({ length: 5 }, () => firstRound)])), /at most five rounds/)
})

test('five observed rounds finish with exactly eight advancers and no active team', () => {
  const third = observedRound('r3', [
    ['third0', 'third1', 'third1'], ['third3', 'two1', 'third3'],
    ['one0', 'one3', 'one0'], ['playin', 'third2', 'third2'],
    ['third4', 'two0', 'two0'], ['two3', 'two4', 'two4'],
    ['one1', 'one2', 'one2'], ['one4', 'two2', 'one4'],
  ])
  const fourth = observedRound('r4', [
    ['one3', 'playin', 'one3'], ['third1', 'third3', 'third3'],
    ['third4', 'two3', 'third4'], ['one0', 'two0', 'two0'],
    ['one1', 'two2', 'one1'], ['third2', 'two4', 'third2'],
  ])
  const fifth = observedRound('r5', [
    ['one0', 'third3', 'one0'], ['one3', 'two2', 'two2'], ['third4', 'two4', 'two4'],
  ])
  const result = replay([firstRound, secondRound, third, fourth, fifth])
  assert.equal(result.status, 'supported')
  if (result.status !== 'supported') return
  assert.equal(result.standings.filter((team) => team.status === 'advanced').length, 8)
  assert.equal(result.standings.filter((team) => team.status === 'eliminated').length, 8)
  assert.equal(result.standings.filter((team) => team.status === 'active').length, 0)
  assert.deepEqual(result.standings.filter((team) => team.status === 'advanced').map((team) => team.id),
    ['one0', 'one1', 'one2', 'one4', 'third2', 'two0', 'two2', 'two4'])
  assert.deepEqual(result.standings.filter((team) => team.wins === 3).map((team) => team.losses).sort(),
    [0, 0, 1, 1, 1, 2, 2, 2])
})

function pairGroup(ids: string[], prefix: string): ObservedSwissMatch[] {
  return Array.from({ length: ids.length / 2 }, (_, index) => ({
    id: `${prefix}${index}`, teamAId: ids[index * 2], teamBId: ids[index * 2 + 1], winnerId: ids[index * 2],
  }))
}

function observedRound(prefix: string, matches: Array<[string, string, string]>): ObservedSwissMatch[] {
  return matches.map(([teamAId, teamBId, winnerId], index) => ({ id: `${prefix}${index}`, teamAId, teamBId, winnerId }))
}
