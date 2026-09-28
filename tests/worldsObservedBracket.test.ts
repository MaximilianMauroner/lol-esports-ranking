import assert from 'node:assert/strict'
import test from 'node:test'
import { replayWorlds2025Knockout } from '../src/lib/worldsObservedBracket.ts'
import { WORLDS_2025_SWISS_RULES, type ObservedSwissMatch, type SwissReplayResult } from '../src/lib/worldsObservedRules.ts'

// Entirely synthetic standings and draw; no entrant or result is asserted as official.
const swiss: SwissReplayResult = {
  status: 'supported',
  rulesId: WORLDS_2025_SWISS_RULES.id,
  source: WORLDS_2025_SWISS_RULES.source,
  completedRounds: 5,
  standings: [
    ...['A', 'C'].map((id) => ({ id, wins: 3, losses: 0, status: 'advanced' as const, opponents: [] })),
    ...['B', 'D', 'E'].map((id) => ({ id, wins: 3, losses: 1, status: 'advanced' as const, opponents: [] })),
    ...['F', 'G', 'H'].map((id) => ({ id, wins: 3, losses: 2, status: 'advanced' as const, opponents: [] })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `X${index}`, wins: index % 3, losses: 3, status: 'eliminated' as const, opponents: [] })),
  ],
  forecast: { status: 'unsupported', reason: 'draw-procedure-or-model-unavailable' },
}
const slots = ['A', 'F', 'B', 'G', 'C', 'H', 'D', 'E']
const quarterfinals = observed('q', [['A', 'F', 'A'], ['B', 'G', 'B'], ['C', 'H', 'C'], ['D', 'E', 'D']])
const semifinals = observed('s', [['A', 'B', 'A'], ['C', 'D', 'D']])
const final = observed('f', [['A', 'D', 'D']])

const replay = (more: Partial<Parameters<typeof replayWorlds2025Knockout>[0]> = {}) => replayWorlds2025Knockout({
  swiss, drawEvidence: 'synthetic fixture draw', slots, rounds: {}, ...more,
})

test('observed bracket keeps quarterfinal slots and reports forecasts unsupported', () => {
  const result = replay()
  assert.equal(result.status, 'supported')
  if (result.status !== 'supported') return
  assert.deepEqual(result.slots, slots)
  assert.equal(result.completedRounds, 0)
  assert.equal(result.championId, null)
  assert.ok(result.teams.every((team) => team.reached === 'quarterfinal' && team.eliminatedAt === null))
  assert.equal(result.forecast.status, 'unsupported')
})

test('fixed links carry observed winners through semis and final without re-seeding', () => {
  const original = structuredClone({ slots, quarterfinals, semifinals, final })
  const rounds = { quarterfinals, semifinals, final }
  const result = replay({ rounds })
  assert.equal(result.status, 'supported')
  if (result.status !== 'supported') return
  assert.equal(result.completedRounds, 3)
  assert.equal(result.championId, 'D')
  assert.deepEqual(result.teams.filter((team) => team.eliminatedAt === 'quarterfinal').map((team) => team.id), ['E', 'F', 'G', 'H'])
  assert.deepEqual(result.teams.filter((team) => team.eliminatedAt === 'semifinal').map((team) => team.id), ['B', 'C'])
  assert.equal(result.teams.find((team) => team.id === 'A')?.eliminatedAt, 'final')
  assert.deepEqual(replay({ rounds: { quarterfinals: [...quarterfinals].reverse(), semifinals: [...semifinals].reverse(), final } }), result)
  assert.deepEqual({ slots, quarterfinals, semifinals, final }, original)
})

test('draw evidence, Swiss completion, exact qualifiers and opposite halves are required', () => {
  assert.match(JSON.stringify(replay({ drawEvidence: '' })), /draw-evidence-missing/)
  assert.match(JSON.stringify(replay({ swiss: { status: 'unsupported', reason: 'rules-unavailable', detail: '2026' } })), /swiss-unavailable/)
  if (swiss.status === 'supported') {
    const corrupt = structuredClone(swiss)
    corrupt.standings[8].status = 'active'
    assert.match(JSON.stringify(replay({ swiss: corrupt })), /terminal team states/)
  }
  assert.match(JSON.stringify(replay({ slots: ['A', 'F', 'A', 'G', 'C', 'H', 'D', 'E'] })), /distinct slot IDs/)
  assert.match(JSON.stringify(replay({ slots: ['A', 'B', 'C', 'F', 'D', 'G', 'E', 'H'] })), /opposite bracket halves|3-2 opponent/)
  assert.match(JSON.stringify(replay({ slots: ['A', 'F', 'C', 'H', 'B', 'G', 'D', 'E'] })), /opposite bracket halves/)
})

test('partial rounds and invalid results fail instead of advancing a bracket', () => {
  assert.match(JSON.stringify(replay({ rounds: { semifinals } })), /earlier rounds/)
  assert.match(JSON.stringify(replay({ rounds: { quarterfinals: quarterfinals.slice(0, 3) } })), /needs 4 completed matches/)
  assert.match(JSON.stringify(replay({ rounds: { quarterfinals, final } })), /earlier rounds/)
  const reseeded = observed('s', [['A', 'D', 'A'], ['B', 'C', 'B']])
  assert.match(JSON.stringify(replay({ rounds: { quarterfinals, semifinals: reseeded } })), /fixed semifinals bracket links/)
  const wrongWinner = structuredClone(quarterfinals)
  wrongWinner[0].winnerId = 'X0'
  assert.match(JSON.stringify(replay({ rounds: { quarterfinals: wrongWinner } })), /Winner is not a bracket participant/)
  const duplicate = structuredClone(quarterfinals)
  duplicate[1].id = duplicate[0].id
  assert.match(JSON.stringify(replay({ rounds: { quarterfinals: duplicate } })), /Duplicate or blank match ID/)
})

function observed(prefix: string, matches: Array<[string, string, string]>): ObservedSwissMatch[] {
  return matches.map(([teamAId, teamBId, winnerId], index) => ({ id: `${prefix}${index}`, teamAId, teamBId, winnerId }))
}
