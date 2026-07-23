import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  aggregateRolloutEvidence,
  hasRolloutFailure,
  hasZeroBroadWork,
  parseRolloutEvidence,
  percentile,
  ROLLOUT_CHANGED_SCENARIOS,
  ROLLOUT_EVIDENCE_SCENARIOS,
  ROLLOUT_SHADOW_SCENARIOS,
} from './rollout-evidence.mjs'

export const ROLLOUT_SHADOW_GATE_DECISION_KIND = 'ranking-rollout-shadow-gate-decision'
export const ROLLOUT_SHADOW_GATE_CRITERIA = [
  'exactCommit',
  'unexpired',
  'consecutiveUtcComparisonDates',
  'changedRuns',
  'unchangedRuns',
  'noFailures',
  'unchangedZeroBroadWork',
  'deterministicScenarioCoverage',
]

export function evaluateRolloutShadowGate({
  evidence,
  commit,
  deploymentId,
  runId,
  evidenceClass,
  expiresAt,
  now = new Date(),
} = {}) {
  if (typeof commit !== 'string' || commit.length === 0) throw new Error('Shadow gate requires an exact commit')
  const nowMs = new Date(now).getTime()
  const all = (evidence ?? []).map(parseRolloutEvidence)
  const sameCommit = all.filter((run) => run.commit === commit)
  const exact = sameCommit.filter((run) => new Date(run.expiresAt).getTime() > nowMs)
  const live = exact.filter((run) => run.evidenceClass === 'live')
  const aggregate = aggregateRolloutEvidence(exact)
  const byDate = new Map()
  for (const run of live) {
    const date = String(run.execution.finishedAt ?? run.execution.startedAt ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const current = byDate.get(date) ?? []
    current.push(run)
    byDate.set(date, current)
  }
  const dates = [...byDate.keys()].sort()
  let consecutiveDates = []
  for (const date of dates) {
    const runs = byDate.get(date)
    const validDate = runs.length > 0
      && runs.every((run) => !hasRolloutFailure(run))
      && runs.some((run) => run.scenario === 'unchanged' && hasZeroBroadWork(run))
      && runs.some((run) => ROLLOUT_CHANGED_SCENARIOS.includes(run.scenario))
    const follows = consecutiveDates.length === 0 || utcDayDifference(consecutiveDates.at(-1), date) === 1
    consecutiveDates = validDate && follows ? [...consecutiveDates, date] : validDate ? [date] : []
  }
  const cleanSuffixDates = consecutiveDates.slice(-7)
  const relevantLive = live.filter((run) => cleanSuffixDates.includes(executionDate(run)))
  const changed = relevantLive.filter((run) => ROLLOUT_CHANGED_SCENARIOS.includes(run.scenario))
  const unchanged = relevantLive.filter((run) => run.scenario === 'unchanged')
  const unchangedDurations = unchanged.map((run) => run.timings.totalMs)
  const scenarioCoverage = ROLLOUT_SHADOW_SCENARIOS.every((scenario) => aggregate.scenarioCoverage.includes(scenario))
  const criteria = {
    exactCommit: sameCommit.length === all.length,
    unexpired: exact.length === sameCommit.length,
    consecutiveUtcComparisonDates: consecutiveDates.length >= 7,
    changedRuns: changed.length >= 7,
    unchangedRuns: unchanged.length >= 7,
    noFailures: relevantLive.every((run) => !hasRolloutFailure(run)),
    unchangedZeroBroadWork: unchanged.length >= 7 && unchanged.every(hasZeroBroadWork),
    deterministicScenarioCoverage: scenarioCoverage,
  }
  const evaluatedAt = new Date(now).toISOString()
  return {
    artifactKind: ROLLOUT_SHADOW_GATE_DECISION_KIND,
    schemaVersion: 1,
    commit,
    ...(deploymentId ? { deploymentId } : {}),
    ...(runId ? { runId } : {}),
    ...(evidenceClass ? { evidenceClass } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    evaluatedAt,
    recordedAt: evaluatedAt,
    allowed: Object.values(criteria).every(Boolean),
    criteria,
    consecutiveDates: cleanSuffixDates,
    counts: { changed: changed.length, unchanged: unchanged.length, live: relevantLive.length },
    scenarioCoverage: aggregate.scenarioCoverage,
    liveScenarioCoverage: aggregate.liveScenarioCoverage,
    unchangedP50Ms: percentile(unchangedDurations, 0.50),
    unchangedP95Ms: percentile(unchangedDurations, 0.95),
  }
}

export function parseRolloutShadowGateDecision(value) {
  assertExactKeys(value, [
    'artifactKind', 'schemaVersion', 'commit', 'deploymentId', 'runId', 'evidenceClass',
    'expiresAt', 'evaluatedAt', 'recordedAt', 'allowed', 'criteria', 'consecutiveDates',
    'counts', 'scenarioCoverage', 'liveScenarioCoverage', 'unchangedP50Ms', 'unchangedP95Ms',
  ], 'rollout shadow gate decision')
  if (value.artifactKind !== ROLLOUT_SHADOW_GATE_DECISION_KIND || value.schemaVersion !== 1) {
    throw new Error('Invalid rollout shadow gate decision identity')
  }
  for (const field of ['commit', 'deploymentId', 'runId']) requireString(value[field], field)
  if (!['live', 'production-like-fixture'].includes(value.evidenceClass)) throw new Error('Invalid shadow gate evidence class')
  const evaluatedAt = requiredIso(value.evaluatedAt, 'evaluatedAt')
  if (value.recordedAt !== evaluatedAt) throw new Error('Shadow gate recordedAt must equal evaluatedAt')
  const expiresAt = requiredIso(value.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(evaluatedAt)) throw new Error('Shadow gate decision is not valid after evaluation')
  parseBooleanCriteria(value.criteria, ROLLOUT_SHADOW_GATE_CRITERIA, 'shadow gate criteria')
  if (typeof value.allowed !== 'boolean' || value.allowed !== Object.values(value.criteria).every(Boolean)) {
    throw new Error('Shadow gate allowed must equal the criteria conjunction')
  }
  assertExactKeys(value.counts, ['changed', 'unchanged', 'live'], 'shadow gate counts')
  for (const field of ['changed', 'unchanged', 'live']) requireNonNegativeInteger(value.counts[field], `counts.${field}`)
  if (value.counts.live < value.counts.changed + value.counts.unchanged) throw new Error('Invalid shadow gate live count')
  if (value.criteria.changedRuns !== (value.counts.changed >= 7)
    || value.criteria.unchangedRuns !== (value.counts.unchanged >= 7)) {
    throw new Error('Shadow gate run criteria do not match counts')
  }
  if (!Array.isArray(value.consecutiveDates)
    || value.consecutiveDates.some((date) => typeof date !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
    throw new Error('Invalid shadow gate consecutive dates')
  }
  if (value.criteria.consecutiveUtcComparisonDates !== (value.consecutiveDates.length >= 7)) {
    throw new Error('Shadow gate consecutive-date criterion does not match summary')
  }
  for (let index = 1; index < value.consecutiveDates.length; index += 1) {
    if (utcDayDifference(value.consecutiveDates[index - 1], value.consecutiveDates[index]) !== 1) {
      throw new Error('Shadow gate dates are not consecutive')
    }
  }
  for (const field of ['scenarioCoverage', 'liveScenarioCoverage']) {
    if (!Array.isArray(value[field])
      || value[field].some((scenario) => !ROLLOUT_EVIDENCE_SCENARIOS.includes(scenario))
      || value[field].some((scenario, index) => index > 0 && value[field][index - 1] >= scenario)) {
      throw new Error(`Invalid shadow gate ${field}`)
    }
  }
  if (value.liveScenarioCoverage.some((scenario) => !value.scenarioCoverage.includes(scenario))) {
    throw new Error('Shadow gate live coverage must be a subset of scenario coverage')
  }
  const coverage = ROLLOUT_SHADOW_SCENARIOS.every((scenario) => value.scenarioCoverage.includes(scenario))
  if (value.criteria.deterministicScenarioCoverage !== coverage) throw new Error('Shadow gate coverage criterion does not match summary')
  for (const field of ['unchangedP50Ms', 'unchangedP95Ms']) requireNumberOrNull(value[field], field)
  if ((value.counts.unchanged === 0) !== (value.unchangedP50Ms === null && value.unchangedP95Ms === null)
    || (value.counts.unchanged > 0 && (value.unchangedP50Ms === null || value.unchangedP95Ms === null))) {
    throw new Error('Shadow gate latency summary does not match unchanged count')
  }
  if (value.unchangedP50Ms !== null && value.unchangedP95Ms !== null && value.unchangedP50Ms > value.unchangedP95Ms) {
    throw new Error('Invalid shadow gate latency summary')
  }
  return value
}

function utcDayDifference(left, right) {
  return (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000
}

function parseBooleanCriteria(value, keys, label) {
  assertExactKeys(value, keys, label)
  for (const key of keys) if (typeof value[key] !== 'boolean') throw new Error(`Invalid ${label}.${key}`)
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label} fields`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid shadow gate ${label}`)
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`Invalid shadow gate ${label}`)
  return value
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid shadow gate ${label}`)
}

function requireNumberOrNull(value, label) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid shadow gate ${label}`)
}

function executionDate(run) {
  return String(run.execution.finishedAt ?? run.execution.startedAt ?? '').slice(0, 10)
}

async function main([path, commit]) {
  if (!path || !commit) throw new Error('Usage: rollout-shadow-gate <evidence.json> <commit>')
  const input = JSON.parse(await readFile(path, 'utf8'))
  const decision = evaluateRolloutShadowGate({ evidence: Array.isArray(input) ? input : input.runs, commit })
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
  if (!decision.allowed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
