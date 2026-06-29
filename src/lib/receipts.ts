import type {
  CompactPlayer,
  PublicRankingManifest,
  PublicRankingShard,
  PublicRecentMatch,
  PublicTeamStanding,
  SnapshotFilter,
  SnapshotSourceBreakdown,
} from './publicArtifacts/schema'
import { deriveSpicyTakeConfidence, deriveTierLabels, type RankingTierLabel, type SpicyTakeConfidence } from './rankingFlair'
import type { DataCoverage, DataSourceInfo, ModelInfo } from './snapshot'
import type { RatingComponents, Region, Role } from '../types'

export type TeamReceiptPlayer = {
  id: string
  name: string
  role: Role
  team: string
  teamCode?: string
  rank: number
  rating: number
  delta: number
  games: number
  sourceProvider?: string
  latestObservedAt?: string
  latestObservedEvent?: string
  individualResidualConfidence?: number
}

export type TeamReceiptHashPayload = {
  team: string
  code: string
  region: Region
  league: string
  rank: number
  rating: number
  delta: number
  movement: number
  tier: RankingTierLabel
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  filter?: SnapshotFilter
}

export type TeamReceipt = {
  artifactKind: 'team-receipt'
  generatedAt: string
  team: {
    name: string
    code: string
    region: Region
    league: string
    tier: RankingTierLabel
    rank: number
    record: {
      wins: number
      losses: number
    }
    eligibility: PublicTeamStanding['eligibility']
  }
  rating: {
    current: number
    previous: number
    delta: number
    base: number
    leagueScore: number
    leagueAdjustment: number
    components: RatingComponents
    update?: PublicTeamStanding['ratingUpdate']
    strongestFactor: PublicTeamStanding['strongestFactor']
    factors: PublicTeamStanding['factors']
  }
  movement: {
    rank: number
    previousRank: number
    rankDelta: number
    ratingDelta: number
  }
  players: TeamReceiptPlayer[]
  recent: {
    events: string[]
    matches: PublicRecentMatch[]
  }
  confidence: SpicyTakeConfidence
  source: {
    label: string
    dataMode?: PublicRankingManifest['dataMode']
    coverage?: DataCoverage
    sources: DataSourceInfo[]
    sourceBreakdown: SnapshotSourceBreakdown[]
  }
  model: {
    name?: string
    version: string
    configHash: string
    parameters?: unknown
  }
  config: {
    schemaVersion?: PublicRankingManifest['schemaVersion']
    filter?: SnapshotFilter
    matchCount?: number
    modelConfigHash: string
  }
  staleness: {
    generatedAt: string
    asOf: string
    ageDays: number | null
    staleAfterDays: number
    isStale: boolean
  }
  share: {
    hash: string
    payload: TeamReceiptHashPayload
  }
}

export type BuildTeamReceiptInput = {
  standing: PublicTeamStanding
  standings?: readonly PublicTeamStanding[]
  players?: readonly CompactPlayer[]
  manifest?: Pick<PublicRankingManifest, 'schemaVersion' | 'generatedAt' | 'source' | 'sources' | 'model' | 'coverage' | 'dataMode' | 'defaultFilter'>
  shard?: Pick<PublicRankingShard, 'filter' | 'modelVersion' | 'modelConfigHash' | 'matchCount' | 'sourceBreakdown'>
  generatedAt?: string
  asOf?: string
  staleAfterDays?: number
}

const defaultStaleAfterDays = 7
const unknownModelVersion = 'unknown-model'
const unknownConfigHash = 'unknown-config'
const roleOrder: Record<Role, number> = {
  Top: 0,
  Jungle: 1,
  Mid: 2,
  Bot: 3,
  Support: 4,
}

export function buildTeamReceipt(input: BuildTeamReceiptInput): TeamReceipt {
  const generatedAt = input.generatedAt ?? input.manifest?.generatedAt ?? 'unknown'
  const model = modelForReceipt(input.manifest?.model, input.shard)
  const filter = input.shard?.filter ?? input.manifest?.defaultFilter
  const tier = tierForReceipt(input.standing, input.standings)
  const sharePayload = sharePayloadFor(input.standing, {
    generatedAt,
    modelVersion: model.version,
    modelConfigHash: model.configHash,
    filter,
    tier,
  })

  return {
    artifactKind: 'team-receipt',
    generatedAt,
    team: {
      name: input.standing.team,
      code: input.standing.code,
      region: input.standing.region,
      league: input.standing.league,
      tier,
      rank: input.standing.rank,
      record: {
        wins: input.standing.wins,
        losses: input.standing.losses,
      },
      eligibility: input.standing.eligibility,
    },
    rating: {
      current: input.standing.rating,
      previous: input.standing.previousRating,
      delta: input.standing.delta,
      base: input.standing.baseRating,
      leagueScore: input.standing.leagueScore,
      leagueAdjustment: input.standing.leagueAdjustment,
      components: input.standing.ratingComponents,
      update: input.standing.ratingUpdate,
      strongestFactor: input.standing.strongestFactor,
      factors: input.standing.factors,
    },
    movement: {
      rank: input.standing.rank,
      previousRank: input.standing.previousRank,
      rankDelta: input.standing.movement,
      ratingDelta: input.standing.delta,
    },
    players: playersForReceipt(input.standing, input.players ?? []),
    recent: {
      events: [...input.standing.recentEvents],
      matches: input.standing.recentMatches.map((match) => ({ ...match })),
    },
    confidence: deriveSpicyTakeConfidence(input.standing),
    source: {
      label: input.manifest?.source ?? 'public-ranking-shard',
      dataMode: input.manifest?.dataMode,
      coverage: input.manifest?.coverage,
      sources: input.manifest?.sources ?? [],
      sourceBreakdown: input.shard?.sourceBreakdown ?? [],
    },
    model,
    config: {
      schemaVersion: input.manifest?.schemaVersion,
      filter,
      matchCount: input.shard?.matchCount,
      modelConfigHash: model.configHash,
    },
    staleness: stalenessFor(generatedAt, input.asOf ?? generatedAt, input.staleAfterDays ?? defaultStaleAfterDays),
    share: {
      hash: hashReceiptPayload(sharePayload),
      payload: sharePayload,
    },
  }
}

export function hashReceiptPayload(payload: TeamReceiptHashPayload) {
  return `gpr-${fnv1a32(stableStringify(payload))}`
}

function tierForReceipt(standing: PublicTeamStanding, standings?: readonly PublicTeamStanding[]) {
  const tierAssignment = deriveTierLabels(standings ?? [standing]).find((assignment) => assignment.team === standing.team && assignment.code === standing.code)
  return tierAssignment?.tier ?? 'S'
}

function modelForReceipt(
  manifestModel?: ModelInfo,
  shard?: Pick<PublicRankingShard, 'modelVersion' | 'modelConfigHash'>,
): TeamReceipt['model'] {
  return {
    name: manifestModel?.name,
    version: manifestModel?.version ?? shard?.modelVersion ?? unknownModelVersion,
    configHash: manifestModel?.configHash ?? shard?.modelConfigHash ?? unknownConfigHash,
    parameters: manifestModel?.parameters,
  }
}

function sharePayloadFor(
  standing: PublicTeamStanding,
  context: {
    generatedAt: string
    modelVersion: string
    modelConfigHash: string
    filter?: SnapshotFilter
    tier: RankingTierLabel
  },
): TeamReceiptHashPayload {
  return {
    team: standing.team,
    code: standing.code,
    region: standing.region,
    league: standing.league,
    rank: standing.rank,
    rating: standing.rating,
    delta: standing.delta,
    movement: standing.movement,
    tier: context.tier,
    generatedAt: context.generatedAt,
    modelVersion: context.modelVersion,
    modelConfigHash: context.modelConfigHash,
    filter: context.filter,
  }
}

function playersForReceipt(standing: PublicTeamStanding, players: readonly CompactPlayer[]): TeamReceiptPlayer[] {
  return players
    .filter((player) => player.team === standing.team || player.teamCode === standing.code)
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.rank - b.rank || b.rating - a.rating || a.name.localeCompare(b.name))
    .map((player) => ({
      id: player.id,
      name: player.name,
      role: player.role,
      team: player.team,
      teamCode: player.teamCode,
      rank: player.rank,
      rating: player.rating,
      delta: player.delta,
      games: player.games,
      sourceProvider: player.sourceProvider,
      latestObservedAt: player.latestObservedAt,
      latestObservedEvent: player.latestObservedEvent,
      individualResidualConfidence: player.individualResidual?.confidence,
    }))
}

function stalenessFor(generatedAt: string, asOf: string, staleAfterDays: number): TeamReceipt['staleness'] {
  const ageDays = daysBetween(generatedAt, asOf)
  return {
    generatedAt,
    asOf,
    ageDays,
    staleAfterDays,
    isStale: ageDays === null ? false : ageDays > staleAfterDays,
  }
}

function daysBetween(start: string, end: string) {
  const startTime = Date.parse(start)
  const endTime = Date.parse(end)
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
  return Math.max(0, Math.round((endTime - startTime) / 86_400_000))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
