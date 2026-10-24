import { canonicalTeamNameFor } from '../../rankings/evidence.ts'
import { estimatePublicMatchup, ratingScaleFromUnknown } from '../../rankings/read.ts'
import type { ModelInfo, RankingSummaryStanding } from '../../rankings/types.ts'
import { drawContext, drawProblem, SWISS_ROUND_SIZES, type PreviewTeam, type ResolvedScenario } from './swissScenario.ts'
import { uniformLegalSwissDraw } from './swissLegalDraw.ts'
import { WORLDS_2026_SWISS_RULES, applySwissWinner, swissBestOf } from './worlds2026Swiss.ts'
import type { SwissTeamStanding } from './worldsObservedRules.ts'
import type { TournamentSeries } from './tournamentFeed.ts'
import type { TournamentEvent } from './tournamentFeed.ts'
import { worldsRandom } from './worldsSimulation.ts'

export type SwissStatsOptions = { trials: number; seed: number }
export type SwissStatsProvenance = {
  snapshotId: string; publishedAt: string; ratingDataAsOf: string; dataMode: string; sources: string[]
  modelVersion: string; modelConfigHash: string
}
export type SwissStatsInput = {
  teams: PreviewTeam[]; scenario: ResolvedScenario; standings: RankingSummaryStanding[]; model: ModelInfo
  provenance: SwissStatsProvenance
}
export type SwissStatsResult = SwissStatsOptions & {
  drawModel: 'uniform-legal-v1'; provenance: SwissStatsProvenance
  fixedDraws: number; modelledDraws: number; fixedResults: number
  teams: Array<{ id: string; label: string; region: string; advanceCount: number; fixed: 'advanced' | 'eliminated' | null }>
  regions: Array<{ region: string; teamIds: string[]; anyAdvanceCount: number; qualifierCount: number }>
}

type SeriesWinChance = (a: string, b: string, bestOf: 1 | 3) => number

export function runSwissStats(input: SwissStatsInput, options: SwissStatsOptions, onProgress?: (completed: number, total: number) => void): SwissStatsResult {
  const { model, provenance } = input
  if (!model.version?.trim() || !model.configHash?.trim() || !model.name?.trim()
    || model.version !== provenance.modelVersion || model.configHash !== provenance.modelConfigHash
    || !ratingScaleFromUnknown(model.ratingScale) || !model.parameters || typeof model.parameters !== 'object' || Array.isArray(model.parameters)) {
    throw new Error('A valid published rating model and config are required.')
  }
  const parameters = model.parameters as Record<string, unknown>
  for (const name of ['winProbabilityEloScale', 'winProbabilityUncertaintyScale']) {
    const value = parameters[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid rating model parameter ${name}.`)
  }
  const floor = parameters.winProbabilityUncertaintyFloor
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) throw new Error('Invalid rating model parameter winProbabilityUncertaintyFloor.')
  const byName = new Map<string, RankingSummaryStanding[]>()
  for (const standing of input.standings) {
    const name = canonicalTeamNameFor(standing.team)
    byName.set(name, [...byName.get(name) ?? [], standing])
  }
  const rated = new Map<string, RankingSummaryStanding>()
  const names = new Set<string>()
  const teams = input.teams.map((team) => {
    if (team.label === 'Play-In winner') throw new Error('Choose a named Play-In winner from the schedule before you preview stats.')
    const name = canonicalTeamNameFor(team.label)
    const matches = byName.get(name) ?? []
    if (matches.length !== 1 || names.has(name)) throw new Error(`A unique published Power rating is required for ${team.label}.`)
    names.add(name)
    const standing = matches[0]
    if (standing.rating === null || !Number.isFinite(standing.rating) || standing.uncertainty === null
      || !Number.isFinite(standing.uncertainty) || standing.uncertainty < 0) throw new Error(`A finite rating and uncertainty are required for ${team.label}.`)
    const region = team.region ?? standing.region
    if (!region?.trim()) throw new Error(`A region is required for ${team.label}.`)
    rated.set(team.id, standing)
    return { ...team, region }
  })
  const winChance: SeriesWinChance = (a, b, bestOf) =>
    estimatePublicMatchup(rated.get(a)!, rated.get(b)!, model, { bestOf, sideAssumption: 'neutral' }).homeSeriesWinProbability
  return simulateSwissStats(teams, input.scenario, winChance, options, provenance, onProgress)
}

export function simulateSwissStats(teams: readonly PreviewTeam[], scenario: ResolvedScenario, winChance: SeriesWinChance,
  options: SwissStatsOptions, provenance: SwissStatsProvenance, onProgress?: (completed: number, total: number) => void): SwissStatsResult {
  const { trials, seed } = options
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 100_000 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('Use 1 to 100000 trials and an unsigned 32-bit seed.')
  }
  const initial = validateScenario(teams, scenario)
  const random = worldsRandom(seed)
  const cache = new Map<string, [string, string][][]>()
  const result: SwissStatsResult = {
    trials, seed, drawModel: 'uniform-legal-v1', provenance: { ...provenance },
    fixedDraws: scenario.rounds.length, modelledDraws: SWISS_ROUND_SIZES.length - scenario.rounds.length,
    fixedResults: scenario.rounds.reduce((sum, round) => sum + round.matches.filter((match) => match.winnerId).length, 0),
    teams: teams.map((team) => {
      const status = initial.find((row) => row.id === team.id)!.status
      return { id: team.id, label: team.label, region: team.region!, advanceCount: 0, fixed: status === 'active' ? null : status }
    }),
    regions: [...new Set(teams.map((team) => team.region!))].map((region) => ({ region,
      teamIds: teams.filter((team) => team.region === region).map((team) => team.id), anyAdvanceCount: 0, qualifierCount: 0 })),
  }
  const probabilities = new Map<string, number>()
  const play = (standings: SwissTeamStanding[], pair: [string, string], bestOf: 1 | 3) => {
    const key = JSON.stringify([pair, bestOf])
    let chance = probabilities.get(key)
    if (chance === undefined) {
      chance = winChance(pair[0], pair[1], bestOf)
      if (!Number.isFinite(chance) || chance < 0 || chance > 1) throw new Error('The series win probability must be finite and in [0, 1].')
      probabilities.set(key, chance)
    }
    applySwissWinner(standings, pair, random() < chance ? pair[0] : pair[1])
  }
  onProgress?.(0, trials)
  for (let trial = 0; trial < trials; trial++) {
    const standings = initial.map((row) => ({ ...row, opponents: [...row.opponents] }))
    for (const match of scenario.rounds.at(-1)?.matches ?? []) if (!match.winnerId) play(standings, match.teamIds, match.bestOf)
    for (let round = scenario.rounds.length + 1; round <= SWISS_ROUND_SIZES.length; round++) {
      const context = drawContext(round, teams, standings)
      const pairs = uniformLegalSwissDraw(context, random, cache)
      for (const pair of pairs) play(standings, pair, swissBestOf(context.standings.get(pair[0])!))
    }
    const advanced = new Set(standings.filter((row) => row.status === 'advanced').map((row) => row.id))
    if (advanced.size !== 8) throw new Error('Every Swiss trial must advance exactly eight teams.')
    for (const team of result.teams) if (advanced.has(team.id)) team.advanceCount++
    for (const region of result.regions) {
      const count = region.teamIds.filter((id) => advanced.has(id)).length
      region.qualifierCount += count
      if (count) region.anyAdvanceCount++
    }
    if ((trial + 1) % 50 === 0 || trial + 1 === trials) onProgress?.(trial + 1, trials)
  }
  return result
}

function validateScenario(teams: readonly PreviewTeam[], scenario: ResolvedScenario) {
  if (teams.length !== 16 || new Set(teams.map((team) => team.id)).size !== 16
    || teams.some((team) => !team.id.trim() || !team.label.trim() || !team.region?.trim()) || scenario.rounds.length > 5) {
    throw new Error('Sixteen unique named Swiss teams with known regions are required.')
  }
  if (teams.some((team) => team.seed) && (new Set(teams.map((team) => team.seed)).size !== 16
    || teams.some((team) => !WORLDS_2026_SWISS_RULES.pools.flat().some((seed) => seed === team.seed)))) throw new Error('The Swiss seed pools are invalid.')
  if (!scenario.rounds.length && teams.some((team) => !team.seed)) throw new Error('Round 1 requires known seed pools or a fixed observed draw.')
  const standings: SwissTeamStanding[] = teams.map(({ id }) => ({ id, wins: 0, losses: 0, status: 'active', opponents: [] }))
  for (const [index, round] of scenario.rounds.entries()) {
    const context = drawContext(index + 1, teams, standings)
    if (round.round !== index + 1 || drawProblem(round.matches.map((match) => match.teamIds), context)
      || round.matches.length !== SWISS_ROUND_SIZES[index]) throw new Error('The Swiss scenario contains an invalid draw.')
    for (const match of round.matches) {
      const before = match.teamIds.map((id) => context.standings.get(id)!)
      if (match.bestOf !== swissBestOf(before[0]) || before.some((row, slot) => row.wins !== match.records[slot][0] || row.losses !== match.records[slot][1])
        || (match.winnerId !== null && !match.teamIds.includes(match.winnerId))) throw new Error('The Swiss scenario contains an invalid result.')
      if (match.winnerId) applySwissWinner(standings, match.teamIds, match.winnerId)
      else if (index !== scenario.rounds.length - 1) throw new Error('Resolve the current round before drawing another round.')
    }
  }
  const rows = new Map(scenario.standings.map((row) => [row.id, row]))
  if (rows.size !== 16 || scenario.standings.length !== 16 || standings.some((row) => {
    const other = rows.get(row.id)
    return !other || row.wins !== other.wins || row.losses !== other.losses || row.status !== other.status
      || JSON.stringify(row.opponents) !== JSON.stringify(other.opponents)
  })) throw new Error('The scenario standings do not match its fixed results.')
  const next = scenario.rounds.at(-1)?.matches.some((match) => !match.winnerId) ? 'results' : standings.some((row) => row.status === 'active') ? 'draw' : 'complete'
  if (scenario.next.kind !== next || (scenario.next.kind !== 'complete' && scenario.next.round !== scenario.rounds.length + (next === 'draw' ? 1 : 0))) throw new Error('The scenario next round is invalid.')
  return standings
}

export function swissStatsConditioning(event: TournamentEvent, teams: readonly PreviewTeam[], scenario: ResolvedScenario) {
  let conditioned = 0
  for (const series of event.series) {
    const round = Number(/^Round ([1-5])$/.exec(series.stage ?? '')?.[1])
    if (!round) continue
    const names = series.teams.map((team) => canonicalTeamNameFor(team.name ?? team.id ?? ''))
    const drawnRound = scenario.rounds.find((entry) => entry.round === round)
    const match = drawnRound?.matches.find((match) =>
      match.teamIds.length === names.length && match.teamIds.every((id) => names.includes(canonicalTeamNameFor(teams.find((team) => team.id === id)!.label))))
    if (series.status === 'completed') {
      if (drawnRound?.liveDraw && match && !validCompletedResult(series, match.bestOf)) return { blocked: 'A completed Swiss series has an incomplete or conflicting result. Stats need a valid final score or an unambiguous winner.', conditioned }
      continue
    }
    if (series.status !== 'live' && !series.teams.some((team) => (team.gameWins ?? 0) > 0)) continue
    if (!match?.winnerId || match.result !== 'preview') return { blocked: 'A Swiss series is live or has a partial score. Pre-match estimates cannot use that score. Pick its winner in this scenario to condition the preview, or wait for its final result.', conditioned }
    conditioned++
  }
  return { blocked: null, conditioned }
}

function validCompletedResult(series: TournamentSeries, bestOf: 1 | 3): boolean {
  if (series.teams.length !== 2 || (series.bestOf !== null && series.bestOf !== bestOf)) return false
  const target = (bestOf + 1) / 2
  const outcomes = series.teams.map((team) => team.outcome?.toLowerCase())
  const scores = series.teams.map((team) => team.gameWins)
  if (scores.some((score) => score !== null && (!Number.isInteger(score) || score < 0))) return false
  let winner: number | null = null
  if (outcomes.filter((outcome) => outcome === 'win').length === 1) winner = outcomes.indexOf('win')
  else if (scores[0] === target && scores[1] !== null && scores[1] < target) winner = 0
  else if (scores[1] === target && scores[0] !== null && scores[0] < target) winner = 1
  return winner !== null
    && outcomes.every((outcome, index) => !outcome || outcome === (index === winner ? 'win' : 'loss'))
    && scores.every((score, index) => score === null || (index === winner ? score === target : score < target))
}
