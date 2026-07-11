const TERMINAL_STATES = new Set(['complete', 'completed'])
const RETRY_DELAYS_MS = [15, 30, 60, 120].map((minutes) => minutes * 60_000)
const LONG_RETRY_MS = 6 * 60 * 60_000

export function emptyTriggerState(mode = 'legacy') {
  return {
    schemaVersion: 1,
    generation: 0,
    mode,
    checkedAt: null,
    observationWatermark: null,
    acknowledged: {},
    pending: {},
    metrics: {
      probeCount: 0,
      probeFailureCount: 0,
      completedDetectedCount: 0,
      providerFetchCount: 0,
    },
  }
}

export function parseTriggerState(value, { mode = 'legacy' } = {}) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return emptyTriggerState(mode)
  return {
    ...emptyTriggerState(mode),
    ...value,
    mode: validMode(value.mode) ? value.mode : mode,
    generation: nonNegativeInteger(value.generation),
    acknowledged: objectRecord(value.acknowledged),
    pending: objectRecord(value.pending),
    metrics: {
      ...emptyTriggerState(mode).metrics,
      ...objectRecord(value.metrics),
    },
  }
}

export function completionEvidence(event) {
  const matchId = stringValue(event?.matchId)
  const teams = Array.isArray(event?.teams) ? event.teams.filter((team) => stringValue(team?.id) || stringValue(team?.name)) : []
  const hasFinalScore = teams.length === 2 && teams.every((team) => Number.isFinite(team?.gameWins))
  const winner = teams.find((team) => String(team?.outcome ?? '').toLowerCase() === 'win')
    ?? scoreWinner(teams)
  const terminal = TERMINAL_STATES.has(String(event?.state ?? '').toLowerCase())
  const reasons = [
    ...(!matchId ? ['missing-match-id'] : []),
    ...(!terminal ? ['non-terminal-state'] : []),
    ...(teams.length !== 2 ? ['unresolved-teams'] : []),
    ...(!winner && !hasFinalScore ? ['missing-final-result'] : []),
  ]
  return {
    complete: reasons.length === 0,
    matchId,
    reasons,
    ...(winner ? { winner: stringValue(winner.id) || stringValue(winner.name) } : {}),
  }
}

export function applyScheduleProbe(stateValue, probe) {
  const state = parseTriggerState(stateValue, { mode: probe.mode })
  const checkedAt = isoDate(probe.checkedAt)
  const pending = { ...state.pending }
  let detected = 0

  for (const event of probe.events ?? []) {
    const evidence = completionEvidence(event)
    if (!evidence.complete || state.acknowledged[evidence.matchId] || pending[evidence.matchId]) continue
    pending[evidence.matchId] = {
      completedAt: isoDate(event.startTime ?? checkedAt),
      detectedAt: checkedAt,
      attempts: 0,
      nextAttemptAt: checkedAt,
      lastReason: 'new-completed-match',
      reconciliation: { status: 'unresolved', candidates: [] },
    }
    detected += 1
  }

  return {
    ...state,
    generation: state.generation + 1,
    checkedAt,
    observationWatermark: probe.coverageComplete
      ? isoDate(probe.coverageEnd ?? checkedAt)
      : state.observationWatermark,
    pending,
    metrics: {
      ...state.metrics,
      probeCount: nonNegativeInteger(state.metrics.probeCount) + 1,
      completedDetectedCount: nonNegativeInteger(state.metrics.completedDetectedCount) + detected,
    },
    lastProbe: {
      status: probe.coverageComplete ? 'complete' : 'incomplete',
      coverageStart: probe.coverageStart ?? null,
      coverageEnd: probe.coverageEnd ?? null,
      eventCount: probe.events?.length ?? 0,
      detected,
    },
  }
}

export function applyProbeFailure(stateValue, { checkedAt, reason }) {
  const state = parseTriggerState(stateValue)
  return {
    ...state,
    generation: state.generation + 1,
    checkedAt: isoDate(checkedAt),
    metrics: {
      ...state.metrics,
      probeFailureCount: nonNegativeInteger(state.metrics.probeFailureCount) + 1,
    },
    lastProbe: { status: 'error', reason: String(reason) },
  }
}

export function duePendingMatchIds(stateValue, now = new Date()) {
  const state = parseTriggerState(stateValue)
  const nowMs = dateMs(now)
  return Object.entries(state.pending)
    .filter(([, pending]) => dateMs(pending?.nextAttemptAt) <= nowMs)
    .map(([matchId]) => matchId)
    .sort()
}

export function recordPendingAttempt(stateValue, matchIds, { attemptedAt = new Date(), reason = 'scored-source-not-yet-visible' } = {}) {
  const state = parseTriggerState(stateValue)
  const attemptedAtMs = dateMs(attemptedAt)
  const pending = { ...state.pending }
  for (const matchId of matchIds) {
    const current = pending[matchId]
    if (!current) continue
    const attempts = nonNegativeInteger(current.attempts) + 1
    pending[matchId] = {
      ...current,
      attempts,
      lastAttemptAt: new Date(attemptedAtMs).toISOString(),
      nextAttemptAt: new Date(attemptedAtMs + retryDelayMs(attempts)).toISOString(),
      lastReason: reason,
    }
  }
  return {
    ...state,
    generation: state.generation + 1,
    pending,
    metrics: {
      ...state.metrics,
      providerFetchCount: nonNegativeInteger(state.metrics.providerFetchCount) + Number(matchIds.length > 0),
    },
  }
}

export function acknowledgeMatches(stateValue, reconciliations, acknowledgedAt = new Date()) {
  const state = parseTriggerState(stateValue)
  const pending = { ...state.pending }
  const acknowledged = { ...state.acknowledged }
  for (const reconciliation of reconciliations) {
    if (reconciliation?.status !== 'exact' || !pending[reconciliation.matchId]) continue
    acknowledged[reconciliation.matchId] = {
      acknowledgedAt: isoDate(acknowledgedAt),
      canonicalSeriesId: reconciliation.canonicalSeriesId,
      scoredGameIds: reconciliation.scoredGameIds ?? [],
    }
    delete pending[reconciliation.matchId]
  }
  return { ...state, generation: state.generation + 1, pending, acknowledged }
}

export function shouldFetchScoredProviders(stateValue, { now = new Date(), correctionAuditDue = false, manual = false } = {}) {
  const state = parseTriggerState(stateValue)
  if (manual) return true
  if (state.mode !== 'gated') return false
  return correctionAuditDue || duePendingMatchIds(state, now).length > 0
}

export function retryDelayMs(attempts) {
  return RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? LONG_RETRY_MS
}

function scoreWinner(teams) {
  if (teams.length !== 2 || !teams.every((team) => Number.isFinite(team?.gameWins))) return undefined
  if (teams[0].gameWins === teams[1].gameWins) return undefined
  return teams[0].gameWins > teams[1].gameWins ? teams[0] : teams[1]
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validMode(value) {
  return value === 'legacy' || value === 'shadow' || value === 'gated'
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function isoDate(value) {
  return new Date(value).toISOString()
}

function dateMs(value) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}
