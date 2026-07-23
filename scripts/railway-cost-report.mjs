import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseRolloutEvidence } from './rollout-evidence.mjs'

export const RAILWAY_PRICING_VERIFIED_AT = '2026-07-23'
export const RAILWAY_PRICING_SOURCES = [
  'https://docs.railway.com/pricing',
  'https://docs.railway.com/storage-buckets/billing',
  'https://railway.com/pricing',
]
export const RAILWAY_RATES = Object.freeze({
  memoryGbSecond: 0.00000386,
  cpuVcpuSecond: 0.00000772,
  volumeGbSecond: 0.00000006,
  serviceEgressGb: 0.05,
  bucketGbMonth: 0.015,
  bucketOperations: 0,
  bucketEgressGb: 0,
  hobbyMinimum: 5,
  hobbyIncludedUsage: 5,
})

export function createRailwayCostReport(input = {}) {
  const measured = costForUsage(input.measured ?? input.usage ?? {})
  const componentsComplete = ['cpuSeconds', 'memoryGbSeconds', 'volumeGbSeconds', 'serviceEgressGb', 'bucketGbMonths']
    .every((field) => Number.isFinite(measured.usage[field]) && measured.usage[field] >= 0)
  const publicTrafficExcluded = input.measurement?.publicTrafficExcluded === true
  const eligibleNonTrafficTotal = componentsComplete && publicTrafficExcluded ? measured.totalUsage : null
  const projections = createMonthlyProjections(input.model ?? {})
  const recordedAt = requiredIso(input.recordedAt ?? new Date().toISOString(), 'recordedAt')
  return {
    artifactKind: 'ranking-railway-cost-report',
    schemaVersion: 1,
    recordedAt,
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.evidenceClass ? { evidenceClass: input.evidenceClass } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    pricing: {
      verifiedAt: RAILWAY_PRICING_VERIFIED_AT,
      sources: [...RAILWAY_PRICING_SOURCES],
      rates: RAILWAY_RATES,
      notes: {
        bucketOperations: 'free',
        bucketEgress: 'free',
        serviceUploads: 'service egress is billed',
        hobby: 'monthly bill is max($5 minimum/included usage, metered usage)',
      },
    },
    measured,
    measurement: {
      basis: 'production-metered-month',
      publicTrafficExcluded,
      componentsComplete,
      eligibleNonTrafficTotal,
      underFive: eligibleNonTrafficTotal === null ? false : eligibleNonTrafficTotal <= RAILWAY_RATES.hobbyIncludedUsage,
    },
    monthly: projections,
    marginals: {
      oneMatch: marginalFromEvidence(input.evidence, (run) => run.scenario === 'latest-append'
        && run.classification?.addedCount === 1
        && run.classification?.changedCount === 0
        && run.classification?.removedCount === 0),
      unchangedProbe: marginalFromEvidence(input.evidence, (run) => run.scenario === 'unchanged'
        && zeroBroadWork(run.work)),
    },
  }
}

export function parseRailwayCostReport(value) {
  if (!record(value) || value.artifactKind !== 'ranking-railway-cost-report' || value.schemaVersion !== 1) {
    throw new Error('Invalid Railway cost report identity')
  }
  assertExactKeys(value, [
    'artifactKind', 'schemaVersion', 'recordedAt', 'commit', 'deploymentId', 'runId',
    'evidenceClass', 'expiresAt', 'pricing', 'measured', 'measurement', 'monthly', 'marginals',
  ], 'Railway cost report')
  for (const field of ['commit', 'deploymentId', 'runId']) requireString(value[field], field)
  requiredIso(value.recordedAt, 'recordedAt')
  requiredIso(value.expiresAt, 'expiresAt')
  if (Date.parse(value.expiresAt) <= Date.parse(value.recordedAt)) throw new Error('Invalid Railway cost report evidence dates')
  if (!['live', 'production-like-fixture'].includes(value.evidenceClass)) throw new Error('Invalid Railway cost evidence class')
  if (!record(value.pricing) || !Array.isArray(value.pricing.sources)
    || !record(value.pricing.rates) || !record(value.pricing.notes)) throw new Error('Invalid Railway cost pricing')
  assertExactKeys(value.pricing, ['verifiedAt', 'sources', 'rates', 'notes'], 'Railway cost pricing')
  if (value.pricing.verifiedAt !== RAILWAY_PRICING_VERIFIED_AT
    || value.pricing.sources.length !== RAILWAY_PRICING_SOURCES.length
    || value.pricing.sources.some((source, index) => source !== RAILWAY_PRICING_SOURCES[index])) {
    throw new Error('Invalid Railway cost pricing authority')
  }
  assertExactKeys(value.pricing.rates, Object.keys(RAILWAY_RATES), 'Railway cost rates')
  for (const [field, rate] of Object.entries(RAILWAY_RATES)) {
    if (value.pricing.rates[field] !== rate) throw new Error(`Invalid Railway cost rate ${field}`)
  }
  parseRailwayCost(value.measured)
  parseMeasurementEligibility(value.measurement, value.measured)
  if (!Array.isArray(value.monthly) || !record(value.marginals)
    || !record(value.marginals.oneMatch) || !record(value.marginals.unchangedProbe)) {
    throw new Error('Invalid Railway cost report projections')
  }
  return value
}

export function hasMeasuredProductionUsage(value) {
  try {
    const report = parseRailwayCostReport(value)
    return report.evidenceClass === 'live'
      && ['cpuSeconds', 'memoryGbSeconds', 'volumeGbSeconds', 'serviceEgressGb', 'bucketGbMonths']
      .every((field) => Number.isFinite(report.measured.usage[field]) && report.measured.usage[field] >= 0)
      && report.measurement.basis === 'production-metered-month'
      && report.measurement.publicTrafficExcluded === true
      && report.measurement.componentsComplete === true
      && Number.isFinite(report.measurement.eligibleNonTrafficTotal)
      && report.measurement.eligibleNonTrafficTotal >= 0
      && report.measurement.eligibleNonTrafficTotal <= RAILWAY_RATES.hobbyIncludedUsage
      && report.measurement.underFive === true
  } catch {
    return false
  }
}

function parseMeasurementEligibility(value, measured) {
  if (!record(value)) throw new Error('Invalid Railway measured eligibility')
  assertExactKeys(value, [
    'basis', 'publicTrafficExcluded', 'componentsComplete', 'eligibleNonTrafficTotal', 'underFive',
  ], 'Railway measured eligibility')
  if (value.basis !== 'production-metered-month'
    || typeof value.publicTrafficExcluded !== 'boolean'
    || typeof value.componentsComplete !== 'boolean'
    || typeof value.underFive !== 'boolean') throw new Error('Invalid Railway measured eligibility fields')
  numberOrNull(value.eligibleNonTrafficTotal, 'measurement.eligibleNonTrafficTotal')
  const complete = ['cpuSeconds', 'memoryGbSeconds', 'volumeGbSeconds', 'serviceEgressGb', 'bucketGbMonths']
    .every((field) => Number.isFinite(measured.usage[field]) && measured.usage[field] >= 0)
  const total = complete && value.publicTrafficExcluded ? measured.totalUsage : null
  if (value.componentsComplete !== complete
    || value.eligibleNonTrafficTotal !== total
    || value.underFive !== (total !== null && total <= RAILWAY_RATES.hobbyIncludedUsage)) {
    throw new Error('Railway measured eligibility does not match native calculation')
  }
}

export function costForUsage(usage = {}) {
  const cpuSeconds = known(usage.cpuSeconds)
  const memoryGbSeconds = known(usage.memoryGbSeconds)
  const serviceEgressGb = known(usage.serviceEgressGb ?? usage.serviceUploadGb)
  const rawBucketGbMonths = known(usage.bucketGbMonths ?? usage.bucketStorageGbMonths)
  const bucketGbMonths = rawBucketGbMonths === null
    ? null
    : rawBucketGbMonths === 0 ? 0 : Math.ceil(rawBucketGbMonths)
  const volumeGbSeconds = usage.volumeGbSeconds === undefined || usage.volumeGbSeconds === null ? null : known(usage.volumeGbSeconds)
  const components = {
    cpu: multiplyKnown(cpuSeconds, RAILWAY_RATES.cpuVcpuSecond),
    memory: multiplyKnown(memoryGbSeconds, RAILWAY_RATES.memoryGbSecond),
    volume: volumeGbSeconds === null ? null : multiplyKnown(volumeGbSeconds, RAILWAY_RATES.volumeGbSecond),
    serviceEgress: multiplyKnown(serviceEgressGb, RAILWAY_RATES.serviceEgressGb),
    bucketStorage: multiplyKnown(bucketGbMonths, RAILWAY_RATES.bucketGbMonth),
    bucketOperations: 0,
    bucketEgress: 0,
  }
  const resourceCost = sumIfKnown([components.cpu, components.memory], components.volume)
  const usageCost = sumIfKnown([components.serviceEgress, components.bucketStorage, components.bucketOperations, components.bucketEgress])
  const totalUsage = resourceCost === null || usageCost === null ? null : resourceCost + usageCost
  return {
    usage: { cpuSeconds, memoryGbSeconds, volumeGbSeconds, serviceEgressGb, bucketGbMonths },
    components,
    resourceCost,
    usageCost,
    totalUsage,
    hobbyBilled: totalUsage === null ? null : Math.max(RAILWAY_RATES.hobbyMinimum, totalUsage),
    warning: totalUsage === null ? 'unknown' : totalUsage > 5 ? 'over-hobby-included-usage' : totalUsage >= 4 ? 'approaching-hobby-included-usage' : null,
  }
}

export function createMonthlyProjections(model = {}) {
  const current = model.current ?? {}
  const growth = model.annualGrowth ?? {}
  return [2026, 2027, 2028].map((year) => {
    const offset = year - 2026
    const corpusGb = grow(current.corpusGb, growth.corpus, offset)
    const runsPerMonth = grow(current.runsPerMonth, growth.runs, offset)
    const storageGb = grow(current.storageGb ?? current.bucketStorageGb, growth.storage, offset)
    const perRun = current.perRun ?? {}
    const corpusScale = ratioKnown(corpusGb, known(current.corpusGb))
    const usage = {
      cpuSeconds: productKnown(productKnown(perRun.cpuSeconds, corpusScale), runsPerMonth),
      memoryGbSeconds: productKnown(productKnown(perRun.memoryGbSeconds, corpusScale), runsPerMonth),
      serviceEgressGb: productKnown(productKnown(perRun.serviceEgressGb, corpusScale), runsPerMonth),
      bucketGbMonths: storageGb,
      ...(perRun.volumeGbSeconds === undefined ? {} : {
        volumeGbSeconds: productKnown(productKnown(perRun.volumeGbSeconds, corpusScale), runsPerMonth),
      }),
    }
    return {
      year,
      period: offset === 0 ? 'current' : String(year),
      assumptions: {
        corpusGb,
        runsPerMonth,
        storageGb,
        annualGrowth: {
          corpus: known(growth.corpus),
          runs: known(growth.runs),
          storage: known(growth.storage),
        },
      },
      ...costForUsage(usage),
    }
  })
}

function marginalFromEvidence(evidence, predicate) {
  const runs = Array.isArray(evidence)
    ? evidence.map(validatedEvidence).filter((run) => run && qualifyingEvidence(run) && predicate(run))
    : []
  if (runs.length === 0) return { status: 'unknown', cost: null, reason: 'measured-subset-missing' }
  const usage = averageUsage(runs)
  const cost = costForUsage(usage)
  const complete = cost.usage.cpuSeconds !== null
    && cost.usage.memoryGbSeconds !== null
    && cost.usage.serviceEgressGb !== null
    && cost.usage.bucketGbMonths !== null
  return complete
    ? { status: 'measured', sampleCount: runs.length, runIds: runs.map((run) => run.runId), cost: cost.totalUsage, usage: cost.usage, components: cost.components }
    : {
        status: 'partial',
        cost: null,
        reason: cost.usage.bucketGbMonths === null
          ? 'bucket-storage-attribution-missing'
          : 'measured-subset-incomplete',
        sampleCount: runs.length,
        runIds: runs.map((run) => run.runId),
        usage: cost.usage,
      }
}

function validatedEvidence(value) {
  try {
    return parseRolloutEvidence(value)
  } catch {
    return null
  }
}

function qualifyingEvidence(run) {
  return run && run.artifactKind === 'ranking-rollout-run-evidence'
    && run.evidenceClass === 'live'
    && run.execution?.result === 'completed'
    && run.error === null
}

function averageUsage(runs) {
  return {
    cpuSeconds: averageKnown(runs.map((run) => run.resources?.cpuSeconds)),
    memoryGbSeconds: averageKnown(runs.map((run) => run.resources?.memoryGbSeconds)),
    serviceEgressGb: averageKnown(runs.map((run) => Number.isFinite(run.work?.bytesWritten)
      ? run.work.bytesWritten / (1024 ** 3)
      : null)),
    bucketGbMonths: null,
  }
}

function averageKnown(values) {
  const knownValues = values.map(known).filter((value) => value !== null)
  return knownValues.length === values.length && values.length > 0
    ? knownValues.reduce((sum, value) => sum + value, 0) / knownValues.length
    : null
}

function zeroBroadWork(work = {}) {
  return ['broadFetches', 'fullBuilds', 'incrementalBuilds', 'uploads', 'bytesWritten', 'objectsWritten']
    .every((field) => work[field] === 0)
}

function parseRailwayCost(value) {
  if (!record(value)) throw new Error('Invalid measured Railway cost')
  assertExactKeys(value, ['usage', 'components', 'resourceCost', 'usageCost', 'totalUsage', 'hobbyBilled', 'warning'], 'measured Railway cost')
  if (!record(value.usage) || !record(value.components)) throw new Error('Invalid measured Railway cost fields')
  assertExactKeys(value.usage, ['cpuSeconds', 'memoryGbSeconds', 'volumeGbSeconds', 'serviceEgressGb', 'bucketGbMonths'], 'measured Railway usage')
  assertExactKeys(value.components, ['cpu', 'memory', 'volume', 'serviceEgress', 'bucketStorage', 'bucketOperations', 'bucketEgress'], 'measured Railway cost components')
  for (const field of ['cpuSeconds', 'memoryGbSeconds', 'volumeGbSeconds', 'serviceEgressGb', 'bucketGbMonths']) numberOrNull(value.usage[field], `measured.usage.${field}`)
  for (const field of ['cpu', 'memory', 'volume', 'serviceEgress', 'bucketStorage', 'bucketOperations', 'bucketEgress']) numberOrNull(value.components[field], `measured.components.${field}`)
  for (const field of ['resourceCost', 'usageCost', 'totalUsage', 'hobbyBilled']) numberOrNull(value[field], `measured.${field}`)
  if (value.warning !== null && typeof value.warning !== 'string') throw new Error('Invalid measured Railway cost warning')
  const expected = costForUsage(value.usage)
  if (['resourceCost', 'usageCost', 'totalUsage', 'hobbyBilled', 'warning'].some((field) => value[field] !== expected[field])
    || Object.keys(expected.components).some((field) => value.components[field] !== expected.components[field])) {
    throw new Error('Measured Railway cost does not match native calculation')
  }
  return value
}

function numberOrNull(value, label) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid ${label}`)
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid Railway cost report ${label}`)
  }
  return value
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid Railway cost report ${label}`)
}

function assertExactKeys(value, keys, label) {
  if (!record(value)) throw new Error(`Invalid ${label}`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label} fields`)
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function grow(value, rate, years) {
  const base = known(value)
  const annual = known(rate)
  return base === null || annual === null ? null : base * ((1 + annual) ** years)
}

function known(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function multiplyKnown(value, rate) {
  return value === null ? null : value * rate
}

function productKnown(left, right) {
  const a = known(left)
  const b = known(right)
  return a === null || b === null ? null : a * b
}

function ratioKnown(value, baseline) {
  return value === null || baseline === null || baseline === 0 ? null : value / baseline
}

function sumIfKnown(required, optional = 0) {
  if (required.some((value) => value === null)) return null
  return required.reduce((sum, value) => sum + value, 0) + (optional ?? 0)
}

async function main([inputPath]) {
  const input = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : {}
  process.stdout.write(`${JSON.stringify(createRailwayCostReport(input), null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
