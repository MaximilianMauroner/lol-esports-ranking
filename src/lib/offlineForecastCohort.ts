import { isForecastLedger, type ForecastReceipt } from './tournamentForecast'

export type SyntheticSeriesOutcome = {
  matchId: string
  eventId: string
  teamIds: [string, string]
  bestOf: 1 | 3 | 5
  status: 'completed' | 'cancelled' | 'unresolved'
  startedAt: string
  completedAt: string | null
  observedAt: string
  gameWins: [number, number] | null
}

export type CohortExclusion = 'conflicting-outcomes' | 'invalid-outcome' | 'cancelled'
  | 'unresolved' | 'outcome-after-cutoff' | 'missing-receipt' | 'incompatible-model'
  | 'mismatched-series' | 'no-prestart-receipt'

export type OfflineCohortResult =
  | { status: 'unsupported'; reason: 'invalid-ledger' | 'invalid-policy' | 'synthetic-evidence-required' }
  | {
    status: 'replayed'
    sourceType: 'offline-receipt-replay'
    evaluationEligible: false
    evidenceReference: string
    policy: { version: 'latest-compatible-prestart-series-v1'; asOf: string; modelVersion: string; modelConfigHash: string }
    rows: Array<{
      matchId: string; eventId: string; bestOf: 1 | 3 | 5; receiptKey: string; snapshotId: string
      publishedAt: string; startedAt: string; completedAt: string
      homeTeamId: string; awayTeamId: string; homeWinProbability: number; homeWon: boolean
    }>
    exclusions: Array<{ matchId: string; reason: CohortExclusion }>
    duplicateOutcomeRows: number
    /** Offline receipt timestamps do not certify a forecast was published to viewers. */
    calibration: { status: 'unsupported'; reason: 'published-evaluation-receipts-unavailable' }
  }

/** One series row per match, never both binary sides or each forecast revision. */
export function replayOfflineSeriesCohort(input: {
  ledger: unknown
  outcomes: SyntheticSeriesOutcome[]
  evidence: { kind: 'synthetic-fixture'; reference: string }
  asOf: string
  modelVersion: string
  modelConfigHash: string
}): OfflineCohortResult {
  if (!isForecastLedger(input.ledger)) return { status: 'unsupported', reason: 'invalid-ledger' }
  if (!time(input.asOf) || !input.modelVersion?.trim() || !input.modelConfigHash?.trim()) {
    return { status: 'unsupported', reason: 'invalid-policy' }
  }
  if (input.evidence?.kind !== 'synthetic-fixture' || !input.evidence.reference?.trim()) {
    return { status: 'unsupported', reason: 'synthetic-evidence-required' }
  }
  const result: Extract<OfflineCohortResult, { status: 'replayed' }> = {
    status: 'replayed', sourceType: 'offline-receipt-replay', evaluationEligible: false,
    evidenceReference: input.evidence.reference.trim(),
    policy: { version: 'latest-compatible-prestart-series-v1', asOf: input.asOf,
      modelVersion: input.modelVersion, modelConfigHash: input.modelConfigHash },
    rows: [], exclusions: [], duplicateOutcomeRows: 0,
    calibration: { status: 'unsupported', reason: 'published-evaluation-receipts-unavailable' },
  }
  const outcomes = new Map<string, SyntheticSeriesOutcome>()
  const conflicts = new Set<string>()
  const seenOutcomes = new Set<string>()
  for (const outcome of input.outcomes) {
    const key = signature(outcome)
    if (seenOutcomes.has(key)) result.duplicateOutcomeRows += 1
    else seenOutcomes.add(key)
    const prior = outcomes.get(outcome.matchId)
    if (prior) {
      if (signature(prior) !== key) conflicts.add(outcome.matchId)
    } else outcomes.set(outcome.matchId, outcome)
  }
  const receipts = Object.values(input.ledger.receipts)
  for (const [matchId, outcome] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
    const exclude = (reason: CohortExclusion) => result.exclusions.push({ matchId, reason })
    if (conflicts.has(matchId)) { exclude('conflicting-outcomes'); continue }
    if (!matchId?.trim() || !outcome.eventId?.trim() || !Array.isArray(outcome.teamIds)
      || outcome.teamIds.length !== 2 || outcome.teamIds.some((id) => !id?.trim())
      || outcome.teamIds[0] === outcome.teamIds[1] || ![1, 3, 5].includes(outcome.bestOf)
      || !time(outcome.startedAt) || !time(outcome.observedAt)) { exclude('invalid-outcome'); continue }
    if (outcome.status === 'cancelled') { exclude('cancelled'); continue }
    if (outcome.status === 'unresolved') { exclude('unresolved'); continue }
    const needed = Math.floor(outcome.bestOf / 2) + 1
    if (outcome.status !== 'completed' || !time(outcome.completedAt)
      || Date.parse(outcome.completedAt) < Date.parse(outcome.startedAt)
      || Date.parse(outcome.observedAt) < Date.parse(outcome.completedAt)
      || !Array.isArray(outcome.gameWins) || outcome.gameWins.length !== 2
      || outcome.gameWins.some((wins) => !Number.isInteger(wins) || wins < 0)
      || !((outcome.gameWins[0] === needed && outcome.gameWins[1] < needed)
        || (outcome.gameWins[1] === needed && outcome.gameWins[0] < needed))) { exclude('invalid-outcome'); continue }
    if (Date.parse(outcome.observedAt) > Date.parse(input.asOf)) { exclude('outcome-after-cutoff'); continue }
    const forMatch = receipts.filter((receipt) => receipt.matchId === matchId)
    if (!forMatch.length) { exclude('missing-receipt'); continue }
    const compatible = forMatch.filter((receipt) => receipt.modelVersion === input.modelVersion
      && receipt.modelConfigHash === input.modelConfigHash)
    if (!compatible.length) { exclude('incompatible-model'); continue }
    const sameSeries = compatible.filter((receipt) => receipt.eventId === outcome.eventId && receipt.bestOf === outcome.bestOf
      && receipt.teams[0].sourceTeamId === outcome.teamIds[0] && receipt.teams[1].sourceTeamId === outcome.teamIds[1])
    if (!sameSeries.length) { exclude('mismatched-series'); continue }
    const eligible = sameSeries.filter((receipt) => Date.parse(receipt.publishedAt)
      < Math.min(Date.parse(outcome.startedAt), Date.parse(receipt.scheduledStartAt)))
      .sort(compareReceipts)
    const receipt = eligible[0]
    if (!receipt) { exclude('no-prestart-receipt'); continue }
    result.rows.push({ matchId, eventId: outcome.eventId, bestOf: outcome.bestOf, receiptKey: receipt.receiptKey,
      snapshotId: receipt.snapshotId, publishedAt: receipt.publishedAt,
      startedAt: outcome.startedAt, completedAt: outcome.completedAt,
      homeTeamId: outcome.teamIds[0], awayTeamId: outcome.teamIds[1],
      homeWinProbability: receipt.homeSeriesWinProbability, homeWon: outcome.gameWins[0] === needed })
  }
  return result
}

function time(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value))
}

function compareReceipts(a: ForecastReceipt, b: ForecastReceipt) {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    || b.forecastRevision.localeCompare(a.forecastRevision) || b.receiptKey.localeCompare(a.receiptKey)
}

function signature(outcome: SyntheticSeriesOutcome) {
  return JSON.stringify([outcome.matchId, outcome.eventId, outcome.teamIds, outcome.bestOf, outcome.status,
    outcome.startedAt, outcome.completedAt, outcome.observedAt, outcome.gameWins])
}
