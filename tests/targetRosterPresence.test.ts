import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ExactPregameProbabilityState } from '../src/domains/rankings/forecast.ts'
import { playerRatingPredictionWeight } from '../src/domains/rankings/internal/policy/modelConfig.ts'
import { buildPlayerLineupEdges, type PregamePlayerRatingEdge } from '../src/domains/rankings/internal/players/playerModel.ts'
import { createRatingReplayContext, prepareRatingUtcDateBoundary, replayRatingDates } from '../src/domains/rankings/internal/replay/model.ts'
import { sideAdjustmentsFromSamples } from '../src/domains/rankings/internal/replay/sideAdjustments.ts'
import type { MatchRecord, MatchRosterSnapshot, PregamePrediction, Role, Side, TeamProfile } from '../src/domains/rankings/types.ts'
import { emitPregamePredictionsForDate } from '../src/lib/ratingSeriesEngine.ts'

const targetDate = '2026-01-10'
const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}
const history = [
  game({ id: 'h1', date: '2026-01-02', winner: 'Alpha', kills: { alpha: 6, beta: 1 } }),
  game({ id: 'h2', date: '2026-01-04', winner: 'Alpha', kills: { alpha: 5, beta: 2 } }),
  game({ id: 'h3', date: '2026-01-06', winner: 'Beta', kills: { alpha: 1, beta: 7 } }),
]
const target = game({ id: 'target', date: targetDate, winner: 'Alpha', kills: { alpha: 4, beta: 2 } })
const future = game({ id: 'future', date: '2026-01-20', winner: 'Beta', kills: { alpha: 0, beta: 9 } })

function forecast(dateMatches: MatchRecord[], edgesFrom: (state: ReturnType<typeof replayRatingDates>) => Map<string, PregamePlayerRatingEdge>) {
  const context = createRatingReplayContext(history, teams)
  const state = replayRatingDates({ context, replayMatches: history })
  prepareRatingUtcDateBoundary({ dateMatches, teams, state })
  const pregamePlayerRatingEdges = edgesFrom(state)
  const exact: ExactPregameProbabilityState[] = []
  emitPregamePredictionsForDate({ matches: dateMatches, teams, state, pregamePlayerRatingEdges,
    onExactState: value => exact.push(value) })
  const prediction = state.predictions.at(-1)!
  assert.equal(prediction.id, dateMatches.at(-1)!.id)
  return { exact: exact.at(-1)!, hash: createHash('sha256').update(JSON.stringify(exact.at(-1))).digest('hex'), prediction, forecast: predictorOutput(prediction), state }
}

const targetGameDiagnosticFields = new Set(['actualWinner', 'segments', 'source', 'teamASide', 'teamBSide'])
function predictorOutput(prediction: PregamePrediction) {
  return Object.fromEntries(Object.entries(prediction).filter(([key]) => !targetGameDiagnosticFields.has(key)))
}

function sourceBuilt(corpus: MatchRecord[]) {
  return forecast(corpus.filter(match => match.date === targetDate), () => buildPlayerLineupEdges(corpus, { teams }).forecast)
}

test('source-built forecasts ignore target roster, side, identities, stats, winner and future games', () => {
  const withRosters = sourceBuilt([...history, target])
  const pricedAdjustment = withRosters.prediction.teamAPlayerRatingAdjustment
  assert.ok(pricedAdjustment !== undefined)
  assert.notEqual(withRosters.state.rosterPriorOffsets.get('Alpha'), pricedAdjustment * playerRatingPredictionWeight,
    'stored offset differs from the freshly priced prior edge, so the roster branch is observable')
  assert.ok((sideAdjustmentsFromSamples(withRosters.state.sideAdjustmentSamples).get(target.patch) ?? 0) > 0)
  const variants: Array<[string, MatchRecord[]]> = [
    ['no target rosters', [...history, { ...target, teamARoster: undefined, teamBRoster: undefined }]],
    ['one target roster', [...history, { ...target, teamBRoster: undefined }]],
    ['no target sides', [...history, { ...target, teamASide: undefined, teamBSide: undefined }]],
    ['swapped target sides', [...history, { ...target, teamASide: 'red', teamBSide: 'blue' }]],
    ['changed identities and stats', [...history, { ...target, winner: 'Beta',
      teamARoster: roster('alpha', 'blue', false, 0, { Mid: 'alpha-sub', Bot: 'alpha-sub-bot' }),
      teamBRoster: roster('beta', 'red', true, 12, { Top: 'beta-sub' }) }]],
    ['future games', [...history, target, future]],
    ['future games without target rosters', [...history, { ...target, teamARoster: undefined, teamBRoster: undefined }, future]],
  ]
  for (const [label, corpus] of variants) {
    const actual = sourceBuilt(corpus)
    assert.deepEqual(actual.exact, withRosters.exact, `${label}: exact pregame state`)
    assert.equal(actual.hash, withRosters.hash, `${label}: exact pregame state hash`)
    assert.deepEqual(actual.forecast, withRosters.forecast, `${label}: forecast probabilities and features`)
  }
})

test('a later game forecast cannot use a side selected after an earlier game result', () => {
  const first = { ...target, id: 'series-1', sourceMatchId: 'target-series', gameNumber: 1, bestOf: 3 }
  const second = { ...target, id: 'series-2', sourceMatchId: 'target-series', gameNumber: 2, bestOf: 3,
    datetimeUtc: `${targetDate}T12:00:00Z`, gameCompletedAtUtc: `${targetDate}T13:00:00Z` }
  const base = sourceBuilt([...history, first, second])
  for (const teamASide of ['red', undefined] as const) {
    const changed = sourceBuilt([...history, { ...first, winner: 'Beta' },
      { ...second, teamASide, teamBSide: teamASide === undefined ? undefined : 'blue' }])
    assert.deepEqual(changed.exact, base.exact)
    assert.equal(changed.hash, base.hash)
    assert.deepEqual(changed.forecast, base.forecast)
  }
})

test('the prior edge prices the offset, a gated zero included, and only a missing edge falls back to the stored offset', () => {
  const stored = 12
  const priced = 30
  const run = (adjustment: number | undefined, rostered: boolean, storedOffset: number | null = stored) => {
    const match = rostered ? target : { ...target, teamARoster: undefined, teamBRoster: undefined }
    return forecast([match], (state) => {
      if (storedOffset === null) state.rosterPriorOffsets.delete('Alpha')
      else state.rosterPriorOffsets.set('Alpha', storedOffset)
      state.rosterPriorOffsets.set('Beta', 0)
      return adjustment === undefined ? new Map() : new Map([[target.id, edge(adjustment)]])
    }).exact.home.rating
  }
  const zero = run(0, true)
  for (const rostered of [true, false]) {
    assert.equal(run(0, rostered), zero, `gated zero edge prices zero, rostered=${rostered}`)
    assert.ok(Math.abs(run(priced, rostered) - zero - priced * playerRatingPredictionWeight) < 1e-9, `priced edge, rostered=${rostered}`)
    assert.ok(Math.abs(run(undefined, rostered) - zero - stored) < 1e-9, `missing edge keeps stored offset, rostered=${rostered}`)
    assert.equal(run(undefined, rostered, null), zero, `missing edge and no stored offset prices zero, rostered=${rostered}`)
  }
})

function edge(teamAAdjustment: number): PregamePlayerRatingEdge {
  return { teamAAdjustment, teamBAdjustment: 0, teamACoverage: 1, teamBCoverage: 1, teamAEvidenceBasis: 'prior-observed',
    teamBEvidenceBasis: 'prior-observed', teamAFreshnessWeight: 1, teamBFreshnessWeight: 1 }
}

function game({ id, date, winner, kills }: { id: string; date: string; winner: string; kills: { alpha: number; beta: number } }): MatchRecord {
  return {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, dataCompleteness: 'scoreboard-game-stats',
    date, datetimeUtc: `${date}T10:00:00Z`, gameCompletedAtUtc: `${date}T11:00:00Z`, season: 2026,
    event: 'LCK 2026 Cup', phase: 'Groups', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1, tier: 'regional-regular',
    teamA: 'Alpha', teamB: 'Beta', teamASide: 'blue', teamBSide: 'red', winner,
    teamAKills: kills.alpha * 5, teamBKills: kills.beta * 5, teamAGold: 60000, teamBGold: 58000,
    teamARoster: roster('alpha', 'blue', winner === 'Alpha', kills.alpha, {}, date),
    teamBRoster: roster('beta', 'red', winner === 'Beta', kills.beta, {}, date),
  }
}

function roster(prefix: string, side: Side, won: boolean, kills: number, ids: Partial<Record<Role, string>> = {}, observedAt = targetDate): MatchRosterSnapshot {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return {
    sourceProvider: 'oracles-elixir', teamId: prefix, observedAt, completeness: 'complete-five-role',
    players: roles.map(role => ({ id: ids[role] ?? `${prefix}-${role}`, name: `${prefix} ${role}`, role,
      stats: { side, won, kills, deaths: won ? 1 : 5, assists: won ? 9 : 3, damageShare: 0.2, earnedGoldShare: 0.2, vspm: 1 } })),
  }
}
