import type { Role } from '../rankings/types.ts'
import type { PlayerMetricKey, StyleMetric, TeamMetricKey } from './metrics.ts'

export const STYLE_VERSION = 'style-profiles-v1'
export const DEFINITION_VERSION = 'observed-style-means-v1'
export const MIN_GAMES = 20
export const ROLES = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const satisfies readonly Role[]
export const STYLE_SCOPES = ['all', 'season:2025', 'season:2026'] as const
export type StyleScope = typeof STYLE_SCOPES[number]
export const SAMPLE_RULES = {
  source: 'complete-paired-oracles-elixir',
  aggregation: 'unweighted-per-game-mean',
  scopeBasis: 'game-date-calendar-year',
  minEntityGames: 20,
  minMetricGames: 20,
  minCohort: 2,
  minGameSeconds: 600,
  maxGameSeconds: 5400,
  ratingEffect: 'none',
} as const
export type ObservedMean = { mean: number; games: number }
export type PlayerStyleRow = {
  id: string
  name: string
  role: Role
  teamId: string
  team: string
  league: string | null
  games: number
  observed: Partial<Record<PlayerMetricKey, ObservedMean>>
}
export const DURATION_BINS = [
  { key: 'under25', label: 'Under 25 min' },
  { key: '25to35', label: '25 to under 35 min' },
  { key: '35plus', label: '35 min or more' },
] as const
export type DurationBin = typeof DURATION_BINS[number]['key']
export type TeamStyleRow = {
  id: string
  name: string
  league: string | null
  games: number
  observed: Partial<Record<TeamMetricKey, ObservedMean>>
  durationWins: Partial<Record<DurationBin, [wins: number, games: number]>>
}
export type StyleEntity = PlayerStyleRow | TeamStyleRow
export type ScopeProfiles = {
  through: string | null
  countedGames: number
  excludedGames: number
  excludedByReason: Record<'other-provider' | 'incomplete-pair' | 'missing-team-id', number>
  players: PlayerStyleRow[]
  teams: TeamStyleRow[]
}
export type StyleProfileArtifact = {
  version: typeof STYLE_VERSION
  definitionVersion: typeof DEFINITION_VERSION
  sourceSha256: string
  through: string | null
  sampleRules: typeof SAMPLE_RULES
  scopes: Record<StyleScope, ScopeProfiles>
}
export type StyleMeasure = {
  metric: StyleMetric
  value: number | null
  games: number
  cohortSize: number
} & ({ status: 'ok'; percentile: number } | {
  status: 'missing' | 'few-games' | 'few-metric-games' | 'small-cohort'
  percentile: null
})
export type StylePeer = { key: string; name: string; value: number }
export type StyleCohorts = Map<string, StylePeer[]>
export function playerKey(player: Pick<PlayerStyleRow, 'id' | 'role'>) {
  return `${player.id}|${player.role}`
}
