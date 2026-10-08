import type { EventTier, MatchRecord, MatchRosterSnapshot, Role } from '../../src/types'
import { createRatingReplayContext, replayRatingDates } from '../../src/lib/model'
import { transparentGprModelMetadata } from '../../src/lib/modelConfig'
import type { ConditionalPowerReplayBasis } from '../../src/lib/conditionalPowerReplay'
import type { ConditionalSeriesOutcome } from '../../src/lib/conditionalPowerPreview'
import type { PregamePlayerRatingEdge } from '../../src/lib/playerModel'
import type { TournamentSeries } from '../../src/lib/tournamentFeed'
import { encodeRatingCheckpointEnvelope } from '../../src/lib/ratingCheckpoint'
import { buildRatingCheckpointEventContract } from '../../src/lib/ratingCheckpointInventory'
import { digestCausalValue } from '../../src/lib/causalRecompute'
import { materializeRankingModel } from '../../src/lib/model'
import { createStaticRankingData } from '../../src/lib/snapshot'
import { createPublicArtifactWritePlan } from '../../src/lib/publicArtifacts/writePlan'
import { createConditionalPowerResultReceipt } from '../../src/lib/conditionalPowerResultReceiptBuilder'
import type { ForecastBasis } from '../../src/lib/tournamentForecast'

const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
function roster(team: string, date: string): MatchRosterSnapshot {
  return { sourceProvider: 'oracles-elixir', observedAt: date, completeness: 'complete-five-role',
    players: roles.map((role) => ({ id: `fixture-${team}-${role}`, name: `Fixture ${role}`, role })) }
}

function game(id: string, date: string, winner: string): MatchRecord {
  return {
    id, sourceProvider: 'seed', date, season: 2026, event: 'Controlled LCK fixture', phase: 'Regular season',
    region: 'LCK', league: 'LCK', teamA: 'Alpha', teamB: 'Beta', winner,
    teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL',
    tier: 'regional-regular', patch: '26.1', bestOf: 1, bestOfBasis: 'official',
    teamASide: 'blue', teamBSide: 'red', teamARoster: roster('Alpha', date), teamBRoster: roster('Beta', date),
    teamAKills: 18, teamBKills: 12, teamAGold: 65000, teamBGold: 58000,
    teamATowers: 9, teamBTowers: 3, teamADragons: 3, teamBDragons: 1, teamABarons: 1, teamBBarons: 0,
    gameLengthSeconds: 1800,
  }
}

/** Re-pins only deliberate, valid synthetic state changes made by a test. No artifact is written. */
export function pinControlledConditionalPowerBasis(basis: ConditionalPowerReplayBasis) {
  const identity = { importerVersion: 'controlled-fixture/importer', identityTaxonomyHash: 'controlled-fixture/taxonomy', rawLedgerPrefixHash: 'controlled-fixture/prefix' }
  const state = basis.state
  if (!state.processedThroughUtcDate || !state.previousMatch) throw new Error('A controlled fixture needs a complete replay boundary before pinning')
  const envelope = encodeRatingCheckpointEnvelope(state, identity, {
    processedThroughUtcDate: state.processedThroughUtcDate, processedThroughMatchId: state.previousMatch.id,
  }, buildRatingCheckpointEventContract(basis.context.authoritativeMatches, basis.context.eventWeightContext, basis.context.tournamentLifecycles))
  basis.preStateId = JSON.stringify({ ...identity, payloadDigest: envelope.metadata.payloadDigest, contextDigest: digestCausalValue(basis.context) })
}

export function conditionalPowerFixture(bestOf: 1 | 3 | 5 = 5, outcome: ConditionalSeriesOutcome = { winner: 'home', loserWins: 0 }, tier: EventTier = 'worlds-playoffs') {
  const history = Array.from({ length: 6 }, (_, index) => game(`prior-${index}`, `2026-09-${String(10 + index).padStart(2, '0')}`, index % 2 ? 'Beta' : 'Alpha'))
  const context = createRatingReplayContext(history, {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LPL', league: 'LPL' },
  })
  const state = replayRatingDates({ context, replayMatches: history })
  // Exercise the public soft cap repaired by #37, rather than only initial ratings.
  state.ratings.set('Alpha', 1950)
  state.ratings.set('Beta', 1725)
  state.rosterPriorOffsets.set('Alpha', 12)
  state.rosterPriorOffsets.set('Beta', -3)
  state.momentums.set('Alpha', 8)
  state.momentums.set('Beta', -4)
  const basis: ConditionalPowerReplayBasis = {
    modelVersion: transparentGprModelMetadata.version, modelConfigHash: transparentGprModelMetadata.configHash,
    preStateId: '', ratingScale: structuredClone(transparentGprModelMetadata.ratingScale),
    context, state, sourceTeamIds: ['fixture-alpha', 'fixture-beta'], teamNames: ['Alpha', 'Beta'],
    event: { id: 'worlds:2026:controlled', name: 'Controlled Worlds fixture', league: 'Worlds', phase: 'Quarterfinals', tier, region: 'LCK' },
  }
  pinControlledConditionalPowerBasis(basis)
  const series: TournamentSeries = {
    id: 'controlled-series', eventId: basis.event.id, startTime: '2026-09-16T12:00:00.000Z', stage: 'Quarterfinals',
    status: 'upcoming', sourceState: 'unstarted', bestOf, vodUrls: [],
    teams: [{ id: 'fixture-alpha', name: 'Alpha', code: 'ALP', gameWins: null, outcome: null },
      { id: 'fixture-beta', name: 'Beta', code: 'BET', gameWins: null, outcome: null }],
  }
  const wins = (bestOf + 1) / 2
  const winner = outcome.winner === 'home' ? 'Alpha' : 'Beta'
  const loser = outcome.winner === 'home' ? 'Beta' : 'Alpha'
  const games: MatchRecord[] = Array.from({ length: wins + outcome.loserWins }, (_, index) => ({
    ...game(`hypothetical-${index}`, '2026-09-16', index < outcome.loserWins ? loser : winner),
    officialMatchId: series.id, officialEventId: series.eventId, gameNumber: index + 1,
    datetimeUtc: `2026-09-16T${String(12 + index).padStart(2, '0')}:00:00.000Z`,
    bestOf, event: basis.event.name, league: basis.event.league, phase: basis.event.phase, tier,
  }))
  // Explicit controlled prior assumptions, not inferred unavailable player data.
  const edge: PregamePlayerRatingEdge = {
    teamAAdjustment: 12, teamBAdjustment: -3, teamACoverage: 1, teamBCoverage: 1,
    teamAEvidenceBasis: 'pregame-confirmed', teamBEvidenceBasis: 'pregame-confirmed',
    teamAFreshnessWeight: 1, teamBFreshnessWeight: 1,
  }
  const playerEdges = new Map(games.map((game) => [game.id, structuredClone(edge)]))
  return { series, outcome, now: Date.parse('2026-09-16T11:00:00.000Z'), basis, games, playerEdges }
}

/** Public fixture artifacts come from the same exact state as the producer component receipt. */
export function conditionalPowerReceiptFixture(bestOf: 1 | 3 | 5 = 5, options: { rawRatings?: readonly [number, number] } = {}) {
  const input = conditionalPowerFixture(bestOf)
  if (options.rawRatings) {
    input.basis.state.ratings.set(input.basis.teamNames[0], options.rawRatings[0])
    input.basis.state.ratings.set(input.basis.teamNames[1], options.rawRatings[1])
    pinControlledConditionalPowerBasis(input.basis)
  }
  const generatedAt = new Date(input.now).toISOString()
  const ranking = materializeRankingModel({ context: structuredClone(input.basis.context), state: structuredClone(input.basis.state) })
  const data = createStaticRankingData({
    matches: input.basis.context.authoritativeMatches, teams: input.basis.context.teams, rosters: {},
    generatedAt: '2026-09-16T10:00:00.000Z', source: 'Controlled offline Power-component fixture', dataMode: 'seeded-sample',
    precomputedGlobalRanking: ranking, materializeSnapshotKeys: new Set(['All__All__All']), materializeTournamentIds: new Set(),
  })
  const plan = createPublicArtifactWritePlan(data)
  const artifactMeta = plan.manifest.artifactMeta
  if (!artifactMeta) throw new Error('The controlled public generation identity is missing')
  const snapshot = plan.snapshots[plan.manifest.defaultSnapshotKey]
  if (!snapshot) throw new Error('The controlled default snapshot is missing')
  const forecastBasis: ForecastBasis = {
    snapshotId: `${artifactMeta.runId}/${plan.manifest.defaultSnapshotKey}`,
    ratingDataAsOf: plan.manifest.coverage.latestMatchDate!, ratingPublishedAt: plan.manifest.generatedAt,
    dataMode: plan.manifest.dataMode, model: plan.manifest.model, snapshot,
    identityMap: {
      version: 1, source: 'lolesports-persisted-site-api', revision: 'controlled-component-identities',
      mappings: input.basis.teamNames.map((team, index) => {
        const sourceTeamId = input.basis.sourceTeamIds[index]
        const row = snapshot.standings.find((entry) => entry.team === team)
        if (!sourceTeamId || !row) throw new Error('The controlled identity mapping is incomplete')
        return { sourceTeamId, teamId: row.teamId }
      }),
    },
  }
  const result = createConditionalPowerResultReceipt({ series: input.series, forecastBasis, replayBasis: input.basis, generatedAt })
  if (result.status !== 'ready') throw new Error(result.detail)
  return { ...input, generatedAt, forecastBasis, plan, receipt: result.receipt }
}
