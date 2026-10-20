import {
  createRatingReplayContext, replayRatingDates, type SeriesPassCapture,
} from '../src/domains/rankings/build.ts'
import { createRatingRunState, type RatingRunState } from '../src/domains/rankings/internal/replay/ratingRunState.ts'
import type { MatchRecord, MatchRosterSnapshot, TeamProfile } from '../src/domains/rankings/types.ts'
import { processRatingSeriesForDate } from '../src/lib/ratingSeriesEngine.ts'

export const profiles: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'A', league: 'LCK', region: 'LCK' },
  Beta: { name: 'Beta', code: 'B', league: 'LCK', region: 'LCK' },
  Gamma: { name: 'Gamma', code: 'G', league: 'LEC', region: 'LEC' },
  Zulu: { name: 'Zulu', code: 'Z', league: 'LPL', region: 'LPL' },
}
export function roster(prefix: string, completeness: MatchRosterSnapshot['completeness'] = 'complete-five-role'): MatchRosterSnapshot {
  return {
    sourceProvider: 'oracles-elixir', teamId: prefix, observedAt: '2026-01-01', completeness,
    players: (['Support', 'Mid', 'Top', 'Bot', 'Jungle'] as const).slice(0, completeness === 'partial' ? 3 : 5)
      .map((role) => ({ id: `${prefix}-${role}`, name: `${prefix}-${role}`, role })),
  }
}
export function game(id: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id, sourceGameId: id, sourceMatchId: id, sourceProvider: 'oracles-elixir', dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01', datetimeUtc: '2026-01-01T12:00:00Z', season: 2026,
    event: 'LCK 2026 Spring', phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1,
    tier: 'regional-regular', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamASide: 'blue', teamBSide: 'red',
    teamAKills: 20, teamBKills: 12, teamAGold: 65000, teamBGold: 59000,
    teamARoster: roster('Alpha'), teamBRoster: roster('Beta'), ...overrides,
  }
}
export function observe(matches: readonly MatchRecord[], prepare?: (state: RatingRunState) => void,
  teams: Record<string, TeamProfile> = profiles) {
  const context = createRatingReplayContext(structuredClone(matches), structuredClone(teams))
  const state = createRatingRunState(context.authoritativeMatches, context.teams, context.eventWeightContext, context.tournamentLifecycles)
  prepare?.(state)
  const captures: SeriesPassCapture[] = []
  replayRatingDates({ context, state, replayMatches: [...context.authoritativeMatches].reverse(), onSeriesPassDate: (capture) => {
    if (state.processedThroughUtcDate !== capture.frame.utcDate) throw new Error('Capture precedes the complete date marker')
    if (JSON.stringify(state.processedThroughUtcDateMatchIds) !== JSON.stringify(capture.frame.authoritativeMatchIds)) {
      throw new Error('Capture membership differs from the completed date')
    }
    captures.push(capture)
  } })
  return { captures, context, state }
}

export function variedGames(): MatchRecord[] {
  return [
    game('opening', { date: '2025-12-31', datetimeUtc: '2025-12-31T12:00:00Z' }),
    game('domestic'),
    game('changed-roster', { datetimeUtc: '2026-01-01T16:00:00Z', teamB: 'Gamma',
      teamARoster: roster('changed'), teamBRoster: roster('Gamma'), patch: '' }),
    ...[1, 2].map((gameNumber) => game(`international-${gameNumber}`, {
      sourceMatchId: 'international', gameNumber, bestOf: 3, date: '2026-01-02', datetimeUtc: `2026-01-02T1${gameNumber}:00:00Z`,
      event: 'MSI 2026', league: 'MSI', region: 'International', tier: 'msi-bracket', teamA: gameNumber === 1 ? 'Alpha' : 'Zulu',
      teamB: gameNumber === 1 ? 'Zulu' : 'Alpha', winner: 'Alpha', teamARoster: roster(gameNumber === 1 ? 'changed' : 'Zulu'),
      teamBRoster: roster(gameNumber === 1 ? 'Zulu' : 'changed'), teamATowers: 8, teamBTowers: 2, teamADragons: 3, teamBBarons: 1,
    })),
    ...[1, 2].map((gameNumber) => game(`draw-${gameNumber}`, {
      sourceMatchId: 'draw', gameNumber, bestOf: 2, date: '2026-01-03', datetimeUtc: `2026-01-03T1${gameNumber}:00:00Z`,
      event: 'MSI 2026', league: 'MSI', region: 'International', tier: 'msi-play-in', teamB: 'Gamma',
      winner: gameNumber === 1 ? 'Alpha' : 'Gamma', teamARoster: roster('changed', 'partial'), teamBRoster: undefined,
      teamASide: undefined, teamBSide: undefined,
    })),
    game('incomplete', { bestOf: 5, date: '2026-01-04', datetimeUtc: undefined, teamARoster: undefined, teamBRoster: undefined }),
    game('no-fingerprint', { date: '2026-01-05', datetimeUtc: '2026-01-05T12:00:00Z',
      teamARoster: { ...roster('empty'), players: [] } }),
    ...Array.from({ length: 6 }, (_, index) => game(`unknown-${index + 1}`, {
      sourceMatchId: 'unknown', gameNumber: index + 1, bestOf: 5, date: '2026-01-06', datetimeUtc: undefined,
      winner: index % 2 ? 'Beta' : 'Alpha', teamARoster: undefined, teamBRoster: undefined,
    })),
  ]
}

export function sparseDate() {
  const match = game('sparse', {
    bestOf: 3, patch: '', winner: 'Beta', teamARoster: undefined, teamBRoster: undefined,
    teamAKills: -0, teamBKills: 0, teamAGold: 0, teamBGold: 0,
  })
  const state = createRatingRunState([], {})
  state.executionRatings.set('Beta', 1816)
  const capture = processRatingSeriesForDate({
    matches: [match], teams: structuredClone(profiles), state, sideAdjustments: new Map(),
    lastDate: match.date, pregamePlayerRatingEdges: new Map(), capture: true,
  })
  if (!capture) throw new Error('The synthetic series pass did not emit a capture')
  return capture
}
