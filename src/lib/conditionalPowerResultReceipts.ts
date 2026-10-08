import type { PublishedRatingScale } from '../types'
import { conditionalOutcomeProblem, legalConditionalScores, unavailablePowerPreview, type ConditionalSeriesOutcome } from './conditionalPowerPreview'
import { ratingScaleFromUnknown } from './ratingCalculations'
import { tournamentEventStateVersion, type ForecastBasis, type ForecastReady } from './tournamentForecast'
import type { TournamentSeries } from './tournamentFeed'

export const stableResultPolicy = 'snapshot-stable-only-v1'
export const stableResultAssumptions = [
  'Only the stable-team series-result update is applied. This is a component, not the full future Power delta.',
  'Snapshot lineups, player priors and roster continuity are held fixed; future lineup confirmation is unavailable.',
  'League scores, momentum, uncertainty, records and historical evidence are held fixed. The production standing projection is recomputed.',
  'The scheduled UTC date selects event weighting. Future time decay, patch changes, placements and other series are excluded.',
  'Future game statistics and execution updates are unavailable and are not invented. Tournament simulations keep frozen strength.',
]

type ComponentTeam = { sourceTeamId: string; team: string; before: number; after: number; delta: number }
export type ConditionalPowerResultReceipt = {
  version: 1
  policy: typeof stableResultPolicy
  matchId: string
  eventId: string
  eventStateVersion: string
  bestOf: 1 | 3 | 5
  snapshotId: string
  ratingDataAsOf: string
  ratingPublishedAt: string
  generatedAt: string
  identityRevision: string
  modelVersion: string
  modelConfigHash: string
  ratingScale: PublishedRatingScale
  preStateId: string
  event: { id: string; name: string; league: string; phase: string; tier: string; region: string }
  eventK: number
  eventWeight: number
  outputs: Array<{ outcome: ConditionalSeriesOutcome; teams: ComponentTeam[] }>
}
export type ConditionalPowerResultLedger = { version: 1; receipts: ConditionalPowerResultReceipt[] }

export function isConditionalPowerResultLedger(value: unknown): value is ConditionalPowerResultLedger {
  return record(value) && value.version === 1 && Array.isArray(value.receipts)
    && value.receipts.every(isReceipt)
    && new Set(value.receipts.map((entry) => JSON.stringify([entry.matchId, entry.snapshotId, entry.eventStateVersion]))).size === value.receipts.length
}

function isReceipt(value: unknown): value is ConditionalPowerResultReceipt {
  if (!record(value) || value.version !== 1 || value.policy !== stableResultPolicy
    || !['matchId', 'eventId', 'eventStateVersion', 'snapshotId', 'ratingDataAsOf', 'ratingPublishedAt', 'generatedAt',
      'identityRevision', 'modelVersion', 'modelConfigHash', 'preStateId'].every((key) => text(value[key]))
    || (value.bestOf !== 1 && value.bestOf !== 3 && value.bestOf !== 5)
    || !ratingScaleFromUnknown(value.ratingScale) || !record(value.event)
    || value.event.id !== value.eventId || !positive(value.eventK) || !positive(value.eventWeight)
    || !Array.isArray(value.outputs)) return false
  const event = value.event
  if (!['id', 'name', 'league', 'phase', 'tier', 'region'].every((key) => text(event[key]))) return false
  const scores = legalConditionalScores(value.bestOf)
  if (value.outputs.length !== 2 * scores.length) return false
  const keys = new Set<string>()
  for (const output of value.outputs) {
    if (!record(output) || !record(output.outcome) || (output.outcome.winner !== 'home' && output.outcome.winner !== 'away')
      || typeof output.outcome.loserWins !== 'number' || !scores.includes(output.outcome.loserWins)
      || !Array.isArray(output.teams) || output.teams.length !== 2 || !output.teams.every(isComponentTeam)) return false
    const [home, away] = output.teams
    if (!home || !away || home.sourceTeamId === away.sourceTeamId) return false
    const key = JSON.stringify([output.outcome.winner, output.outcome.loserWins])
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

function isComponentTeam(value: unknown): value is ComponentTeam {
  return record(value) && text(value.sourceTeamId) && text(value.team)
    && [value.before, value.after, value.delta].every((entry) => typeof entry === 'number' && Number.isFinite(entry) && Number.isInteger(entry))
    && typeof value.before === 'number' && typeof value.after === 'number' && value.delta === value.after - value.before
}

export function conditionalResultFromReceipt(input: {
  series: TournamentSeries; outcome: ConditionalSeriesOutcome; now: number
  forecast: ForecastReady; basis: ForecastBasis; ledger: ConditionalPowerResultLedger | null
}) {
  const { series, outcome, now, forecast, basis, ledger } = input
  const problem = conditionalOutcomeProblem(series, outcome, now)
  if (problem) return problem
  if (!ledger) return unavailablePowerPreview('missing-result-receipt', 'No exact producer result-component receipt is available for this snapshot and event.')
  const candidates = ledger.receipts.filter((receipt) => receipt.matchId === series.id && receipt.snapshotId === forecast.snapshotId)
  if (candidates.length !== 1) return unavailablePowerPreview('missing-result-receipt', 'A unique producer receipt matching the current snapshot is required.')
  const receipt = candidates[0]!
  const scale = ratingScaleFromUnknown(receipt.ratingScale)
  const basisScale = ratingScaleFromUnknown(basis.model.ratingScale)
  const start = Date.parse(series.startTime ?? '')
  if (receipt.eventId !== series.eventId || receipt.eventStateVersion !== tournamentEventStateVersion(series)
    || receipt.bestOf !== series.bestOf || receipt.modelVersion !== forecast.modelVersion || receipt.modelConfigHash !== forecast.modelConfigHash
    || receipt.identityRevision !== forecast.identityRevision || receipt.ratingDataAsOf !== forecast.ratingDataAsOf
    || receipt.ratingPublishedAt !== forecast.ratingPublishedAt || JSON.stringify(scale) !== JSON.stringify(basisScale)
    || !Number.isFinite(Date.parse(receipt.generatedAt)) || Date.parse(receipt.generatedAt) < Date.parse(receipt.ratingPublishedAt)
    || Date.parse(receipt.generatedAt) > now || Date.parse(receipt.generatedAt) >= start || Date.parse(receipt.ratingDataAsOf) > Date.parse(receipt.generatedAt)) {
    return unavailablePowerPreview('stale-result-receipt', 'The result component does not match the current source, model, scale, identity or snapshot basis.')
  }
  const selected = receipt.outputs.find((entry) => entry.outcome.winner === outcome.winner && entry.outcome.loserWins === outcome.loserWins)
  if (!selected || !scale || selected.teams.some((team, index) => team.sourceTeamId !== forecast.teams[index]?.sourceTeamId
    || team.before !== forecast.teams[index]?.rating || team.before < scale.publishedMinimum || team.before > scale.publishedMaximum
    || team.after < scale.publishedMinimum || team.after > scale.publishedMaximum)) {
    return unavailablePowerPreview('stale-result-receipt', 'Participant identities and public endpoints must match the current forecast.')
  }
  return { status: 'partial' as const, scope: 'stable-team-result' as const, fullDelta: 'unavailable' as const,
    teams: structuredClone(selected.teams), provenance: structuredClone(receipt), assumptions: [...stableResultAssumptions] }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
