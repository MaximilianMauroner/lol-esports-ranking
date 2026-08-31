import { readFile } from 'node:fs/promises'

const [oldPath, nextPath] = process.argv.slice(2)
const oldData = JSON.parse(await readFile(oldPath, 'utf8'))
const nextData = JSON.parse(await readFile(nextPath, 'utf8'))
const oldById = new Map(oldData.rows.map((row) => [row.id, row]))
const paired = nextData.rows.flatMap((next) => {
  const old = oldById.get(next.id)
  return old ? [{ old, next }] : []
})
if (paired.length !== oldData.rows.length || paired.length !== nextData.rows.length) {
  throw new Error(`Prediction identities differ: old=${oldData.rows.length}, next=${nextData.rows.length}, paired=${paired.length}`)
}

const clusters = [...Map.groupBy(paired, (pair) => pair.next.seriesId).values()]
const random = mulberry32(0x51a7e)
const bootstrap = (select, iterations = 10000) => {
  const eligibleClusters = clusters.map((cluster) => cluster.filter(select)).filter((cluster) => cluster.length > 0)
  const samples = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let brierDelta = 0
    let logLossDelta = 0
    let count = 0
    for (let index = 0; index < eligibleClusters.length; index += 1) {
      const cluster = eligibleClusters[Math.floor(random() * eligibleClusters.length)]
      for (const pair of cluster) {
        brierDelta += brier(pair.next) - brier(pair.old)
        logLossDelta += logLoss(pair.next) - logLoss(pair.old)
        count += 1
      }
    }
    samples.push({ brier: brierDelta / count, logLoss: logLossDelta / count })
  }
  return {
    brier: interval(samples.map((sample) => sample.brier)),
    logLoss: interval(samples.map((sample) => sample.logLoss)),
  }
}

const global = summarize(paired)
const crossRegionPairs = paired.filter((pair) => pair.next.segments.includes('cross-region'))
const crossRegion = summarize(crossRegionPairs)
const globalBootstrap = bootstrap(() => true)
const crossRegionBootstrap = bootstrap((pair) => pair.next.segments.includes('cross-region'))
const rosterSlices = Object.fromEntries([
  ['rosterChange', 'roster-change'],
  ['partialLineup', 'partial-lineup'],
  ['unknownLineup', 'unknown-lineup'],
].map(([label, segment]) => {
  const rows = paired.filter((pair) => pair.next.segments.includes(segment))
  return [label, {
    ...summarize(rows),
    ...(rows.length > 0 ? { confidence95: bootstrap((pair) => pair.next.segments.includes(segment)) } : {}),
  }]
}))
const leagues = [...new Set(paired.flatMap((pair) => [pair.next.leagueA, pair.next.leagueB]))]
  .filter((league) => league !== 'Unknown')
  .map((league) => {
    const rows = paired.filter((pair) => pair.next.leagueA === league || pair.next.leagueB === league)
    return { league, ...summarize(rows), ...calibration(rows) }
  })
  .filter((entry) => entry.count >= 50)
  .sort((left, right) => left.league.localeCompare(right.league))

const result = {
  oldModel: { version: oldData.modelVersion, configHash: oldData.modelConfigHash },
  nextModel: { version: nextData.modelVersion, configHash: nextData.modelConfigHash },
  pairedPredictions: paired.length,
  seriesClusters: clusters.length,
  global: { ...global, confidence95: globalBootstrap },
  crossRegion: { ...crossRegion, confidence95: crossRegionBootstrap },
  rosterSlices,
  leagues,
}
const failures = []
if (globalBootstrap.brier.high > 0.0005) failures.push('global Brier upper bound exceeds 0.0005')
if (globalBootstrap.logLoss.high > 0.001) failures.push('global log-loss upper bound exceeds 0.001')
if (crossRegion.brierDelta > 0) failures.push('cross-region Brier point estimate did not improve')
if (crossRegionBootstrap.brier.high > 0.0005) failures.push('cross-region Brier upper bound exceeds 0.0005')
for (const league of leagues) if (league.brierDelta > 0.001) failures.push(`${league.league} Brier worsened by more than 0.001`)
if (rosterSlices.rosterChange.count >= 50 && rosterSlices.rosterChange.brierDelta > 0.001) failures.push('roster-change Brier worsened by more than 0.001')
if (rosterSlices.partialLineup.count >= 50 && rosterSlices.partialLineup.brierDelta > 0) failures.push('partial-lineup Brier did not improve')
console.log(JSON.stringify({ ...result, passed: failures.length === 0, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1

function summarize(rows) {
  const oldBrier = mean(rows.map((pair) => brier(pair.old)))
  const nextBrier = mean(rows.map((pair) => brier(pair.next)))
  const oldLogLoss = mean(rows.map((pair) => logLoss(pair.old)))
  const nextLogLoss = mean(rows.map((pair) => logLoss(pair.next)))
  return {
    count: rows.length,
    oldBrier,
    nextBrier,
    brierDelta: nextBrier - oldBrier,
    oldLogLoss,
    nextLogLoss,
    logLossDelta: nextLogLoss - oldLogLoss,
  }
}

function calibration(rows) {
  const probabilities = rows.map((pair) => pair.next.probability)
  const outcomes = rows.map((pair) => pair.next.actual)
  const meanProbability = mean(probabilities)
  const meanOutcome = mean(outcomes)
  const covariance = mean(probabilities.map((value, index) => (value - meanProbability) * (outcomes[index] - meanOutcome)))
  const variance = mean(probabilities.map((value) => (value - meanProbability) ** 2))
  const buckets = Map.groupBy(rows, (pair) => Math.min(9, Math.floor(pair.next.probability * 10)))
  const ece = [...buckets.values()].reduce((total, bucket) => (
    total + bucket.length / rows.length * Math.abs(mean(bucket.map((pair) => pair.next.probability)) - mean(bucket.map((pair) => pair.next.actual)))
  ), 0)
  return { calibrationSlope: variance === 0 ? null : covariance / variance, expectedCalibrationError: ece }
}

function brier(row) { return (row.probability - row.actual) ** 2 }
function logLoss(row) {
  const probability = Math.min(1 - 1e-12, Math.max(1e-12, row.probability))
  return -(row.actual * Math.log(probability) + (1 - row.actual) * Math.log(1 - probability))
}
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length }
function interval(values) {
  values.sort((left, right) => left - right)
  return { low: values[Math.floor(values.length * 0.025)], high: values[Math.floor(values.length * 0.975)] }
}
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}
