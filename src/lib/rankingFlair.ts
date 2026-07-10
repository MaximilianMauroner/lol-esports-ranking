import type { PublicRecentMatch, PublicTeamStanding } from './publicArtifacts/schema'

export type RankingTierLabel = 'S' | 'A' | 'B' | 'C'

export type RankingTierBand = {
  label: RankingTierLabel
  floor: number
  ceiling: number
  dropFromLeader: number
}

export type RankingTierAssignment = {
  team: string
  code: string
  rank: number
  rating: number
  powerScore: number
  tier: RankingTierLabel
  band: RankingTierBand
}

export type RankingPodiumEntry = {
  place: 1 | 2 | 3
  team: string
  code: string
  region: PublicTeamStanding['region']
  league: string
  rank: number
  rating: number
  powerScore: number
  tier: RankingTierLabel
}

export type RankingMovementPick = {
  team: string
  code: string
  rank: number
  previousRank: number
  movement: number
  ratingDelta: number
}

export type RankingMovementPicks = {
  biggestRiser: RankingMovementPick | null
  biggestFaller: RankingMovementPick | null
}

export type RankingUpsetHeadline = {
  winner: string
  winnerCode: string
  opponent: string
  opponentCode?: string
  event: string
  date: string
  matchDelta: number
  ratingGap?: number
  rankGap?: number
  score: number
  headline: string
}

export type SpicyTakeConfidenceBand = 'high' | 'medium' | 'low'

export type SpicyTakeConfidence = {
  team: string
  code: string
  confidence: number
  uncertainty: number
  recentMatchCount: number
  score: number
  band: SpicyTakeConfidenceBand
  label: string
}

export type RankingFlair = {
  tiers: RankingTierAssignment[]
  podium: RankingPodiumEntry[]
  movement: RankingMovementPicks
  upsetHeadline: RankingUpsetHeadline | null
  spicyTakeConfidence: SpicyTakeConfidence[]
}

type RankingTierCandidate = Omit<RankingTierAssignment, 'band'>

const tierDropThresholds: Array<{ label: RankingTierLabel; dropFromLeader: number }> = [
  { label: 'S', dropFromLeader: 50 },
  { label: 'A', dropFromLeader: 225 },
  { label: 'B', dropFromLeader: 400 },
  { label: 'C', dropFromLeader: Number.POSITIVE_INFINITY },
]
const eliteTierPowerFloor = 2250
const minimumTierBoundaryGap = 35
const tierOrder: Record<RankingTierLabel, number> = {
  S: 0,
  A: 1,
  B: 2,
  C: 3,
}

export function powerScoreForStanding(standing: Pick<PublicTeamStanding, 'rating'>) {
  return Math.round(standing.rating)
}

export function deriveRankingFlair(
  standings: readonly PublicTeamStanding[],
  { tierUniverse = standings }: { tierUniverse?: readonly PublicTeamStanding[] } = {},
): RankingFlair {
  const canonicalTiers = deriveTierLabels(tierUniverse)
  const visibleTeams = new Set(standings.map(standingKey))
  return {
    tiers: canonicalTiers.filter((assignment) => visibleTeams.has(standingKey(assignment))),
    podium: deriveTopThreePodium(standings, canonicalTiers, leaderPowerScore(tierUniverse)),
    movement: deriveMovementPicks(standings),
    upsetHeadline: deriveUpsetHeadline(standings),
    spicyTakeConfidence: standingsByRank(standings).map((standing) => deriveSpicyTakeConfidence(standing)),
  }
}

export function deriveTierLabels(standings: readonly PublicTeamStanding[]): RankingTierAssignment[] {
  const leaderScore = leaderPowerScore(standings)
  if (leaderScore === undefined) return []

  const assignments: RankingTierCandidate[] = []
  for (const standing of standingsByRank(standings)) {
    const powerScore = powerScoreForStanding(standing)
    const rawTier = tierForPowerScore(powerScore, leaderScore)
    const previous = assignments.at(-1)
    const tier = previous && shouldKeepPreviousTier(previous, rawTier, powerScore)
      ? previous.tier
      : rawTier

    assignments.push({
      team: standing.team,
      code: standing.code,
      rank: standing.rank,
      rating: standing.rating,
      powerScore,
      tier,
    })
  }
  const bands = bandsForTierAssignments(assignments, leaderScore)

  return assignments.map((assignment) => ({
    ...assignment,
    band: bands.get(assignment.tier) ?? bandForTier(assignment.tier, leaderScore),
  }))
}

export function deriveTopThreePodium(
  standings: readonly PublicTeamStanding[],
  tierAssignments: readonly RankingTierAssignment[] = deriveTierLabels(standings),
  canonicalLeaderScore = leaderPowerScore(standings),
): RankingPodiumEntry[] {
  const leaderScore = canonicalLeaderScore ?? leaderPowerScore(standings)
  if (leaderScore === undefined) return []

  const tierByTeam = new Map(tierAssignments.map((assignment) => [standingKey(assignment), assignment.tier]))
  return standingsByRank(standings)
    .slice(0, 3)
    .map((standing, index) => {
      const powerScore = powerScoreForStanding(standing)
      const tier = tierByTeam.get(standingKey(standing))
      return {
        place: (index + 1) as 1 | 2 | 3,
        team: standing.team,
        code: standing.code,
        region: standing.region,
        league: standing.league,
        rank: standing.rank,
        rating: standing.rating,
        powerScore,
        tier: tier ?? tierForPowerScore(powerScore, leaderScore),
      }
    })
}

function standingKey(standing: Pick<PublicTeamStanding, 'team' | 'code'>) {
  return `${standing.team}\u0000${standing.code}`
}

export function deriveMovementPicks(standings: readonly PublicTeamStanding[]): RankingMovementPicks {
  const ranked = standingsByRank(standings)
  const biggestRiser = ranked
    .filter((standing) => standing.movement > 0 && standing.delta > 0)
    .sort(compareRisers)[0]
  const biggestFaller = ranked
    .filter((standing) => standing.movement < 0 && standing.delta < 0)
    .sort(compareFallers)[0]

  return {
    biggestRiser: biggestRiser ? movementPick(biggestRiser) : null,
    biggestFaller: biggestFaller ? movementPick(biggestFaller) : null,
  }
}

export function deriveUpsetHeadline(standings: readonly PublicTeamStanding[]): RankingUpsetHeadline | null {
  const standingLookup = teamLookup(standings)
  const candidates = standings.flatMap((standing) =>
    standing.recentMatches
      .filter((match) => match.result === 'W' && match.delta > 0)
      .map((match) => upsetCandidate(standing, match, standingLookup)),
  )

  return candidates.sort(compareUpsets)[0] ?? null
}

export function deriveSpicyTakeConfidence(standing: PublicTeamStanding): SpicyTakeConfidence {
  const recentMatchCount = standing.recentMatches.length
  const eligibleBonus = standing.eligibility.eligible ? 10 : -15
  const score = clampScore(
    standing.confidence - standing.uncertainty * 0.35 + Math.min(recentMatchCount, 5) * 3 + eligibleBonus,
  )
  const band = spicyBandForScore(score)

  return {
    team: standing.team,
    code: standing.code,
    confidence: standing.confidence,
    uncertainty: standing.uncertainty,
    recentMatchCount,
    score,
    band,
    label: spicyBandLabel(band),
  }
}

export function tierForPowerScore(powerScore: number, leaderScore: number): RankingTierLabel {
  const dropFromLeader = Math.max(0, leaderScore - powerScore)
  if (dropFromLeader <= tierDropThresholds[0].dropFromLeader || powerScore >= eliteTierPowerFloor) return 'S'
  return tierDropThresholds.find((tier) => dropFromLeader <= tier.dropFromLeader)?.label ?? 'C'
}

export function firstPageForTier(
  standings: readonly Pick<PublicTeamStanding, 'team' | 'code'>[],
  assignments: readonly RankingTierAssignment[],
  tier: RankingTierLabel,
  pageSize: number,
) {
  const tiers = new Map(assignments.map((assignment) => [standingKey(assignment), assignment.tier]))
  const index = standings.findIndex((standing) => tiers.get(standingKey(standing)) === tier)
  return index < 0 ? undefined : Math.floor(index / Math.max(1, pageSize)) + 1
}

function shouldKeepPreviousTier(
  previous: RankingTierCandidate | undefined,
  rawTier: RankingTierLabel,
  powerScore: number,
) {
  if (!previous) return false
  if (tierOrder[rawTier] <= tierOrder[previous.tier]) return false
  return Math.max(0, previous.powerScore - powerScore) < minimumTierBoundaryGap
}

function leaderPowerScore(standings: readonly PublicTeamStanding[]) {
  const scores = standings.map(powerScoreForStanding).filter(Number.isFinite)
  return scores.length > 0 ? Math.max(...scores) : undefined
}

function bandsForTierAssignments(assignments: readonly RankingTierCandidate[], leaderScore: number) {
  const bands = new Map<RankingTierLabel, RankingTierBand>()
  for (const label of ['S', 'A', 'B', 'C'] as const) {
    const scores = assignments
      .filter((assignment) => assignment.tier === label)
      .map((assignment) => assignment.powerScore)
    if (scores.length === 0) continue
    const floor = Math.min(...scores)
    bands.set(label, {
      label,
      floor,
      ceiling: Math.max(...scores),
      dropFromLeader: Math.max(0, leaderScore - floor),
    })
  }
  return bands
}

function bandForTier(label: RankingTierLabel, leaderScore: number): RankingTierBand {
  const thresholdIndex = tierDropThresholds.findIndex((threshold) => threshold.label === label)
  const threshold = tierDropThresholds[thresholdIndex]
  const previousThreshold = tierDropThresholds[thresholdIndex - 1]
  const sTierFloor = Math.min(leaderScore - tierDropThresholds[0].dropFromLeader, eliteTierPowerFloor)
  const previousDrop = previousThreshold?.dropFromLeader
  const floor = label === 'S'
    ? sTierFloor
    : Number.isFinite(threshold.dropFromLeader)
      ? leaderScore - threshold.dropFromLeader
      : Number.NEGATIVE_INFINITY
  const ceiling = label === 'S'
    ? leaderScore
    : previousDrop === undefined
      ? leaderScore
      : previousThreshold?.label === 'S'
        ? sTierFloor - 1
        : leaderScore - previousDrop - 1

  return {
    label,
    floor,
    ceiling,
    dropFromLeader: threshold.dropFromLeader,
  }
}

function standingsByRank(standings: readonly PublicTeamStanding[]) {
  return [...standings].sort((a, b) => a.rank - b.rank || b.rating - a.rating || a.team.localeCompare(b.team))
}

function movementPick(standing: PublicTeamStanding): RankingMovementPick {
  return {
    team: standing.team,
    code: standing.code,
    rank: standing.rank,
    previousRank: standing.previousRank,
    movement: standing.movement,
    ratingDelta: standing.delta,
  }
}

function compareRisers(a: PublicTeamStanding, b: PublicTeamStanding) {
  return b.movement - a.movement || b.delta - a.delta || a.rank - b.rank || a.team.localeCompare(b.team)
}

function compareFallers(a: PublicTeamStanding, b: PublicTeamStanding) {
  return a.movement - b.movement || a.delta - b.delta || a.rank - b.rank || a.team.localeCompare(b.team)
}

function teamLookup(standings: readonly PublicTeamStanding[]) {
  const entries = new Map<string, PublicTeamStanding>()
  for (const standing of standings) {
    entries.set(standing.team.toLocaleLowerCase('en'), standing)
    entries.set(standing.code.toLocaleLowerCase('en'), standing)
  }
  return entries
}

function upsetCandidate(
  standing: PublicTeamStanding,
  match: PublicRecentMatch,
  standingLookup: ReadonlyMap<string, PublicTeamStanding>,
): RankingUpsetHeadline {
  const opponent = standingLookup.get(match.opponent.toLocaleLowerCase('en'))
  const ratingGap = opponent ? opponent.rating - standing.rating : undefined
  const rankGap = opponent ? standing.rank - opponent.rank : undefined
  const score = match.delta + Math.max(0, ratingGap ?? 0) / 20 + Math.max(0, rankGap ?? 0) * 2

  return {
    winner: standing.team,
    winnerCode: standing.code,
    opponent: match.opponent,
    opponentCode: opponent?.code,
    event: match.event,
    date: match.date,
    matchDelta: match.delta,
    ratingGap,
    rankGap,
    score: roundOne(score),
    headline: `${standing.code} upset ${opponent?.code ?? match.opponent} for ${signed(match.delta)} rating`,
  }
}

function compareUpsets(a: RankingUpsetHeadline, b: RankingUpsetHeadline) {
  return b.score - a.score || b.matchDelta - a.matchDelta || b.date.localeCompare(a.date) || a.winner.localeCompare(b.winner)
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function spicyBandForScore(score: number): SpicyTakeConfidenceBand {
  if (score >= 70) return 'high'
  if (score >= 45) return 'medium'
  return 'low'
}

function spicyBandLabel(band: SpicyTakeConfidenceBand) {
  if (band === 'high') return 'Evidence ready'
  if (band === 'medium') return 'Spicy but defensible'
  return 'Chaos warning'
}

function roundOne(value: number) {
  return Math.round(value * 10) / 10
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value)
}
