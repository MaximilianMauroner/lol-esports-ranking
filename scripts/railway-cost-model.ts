export const railwayRates = {
  schemaVersion: 1,
  rateVersion: 'railway-2026-07-21',
  effectiveAt: '2026-07-21',
  currency: 'USD',
  storageGbBasis: 'decimal',
  cpuUsdPerVcpuMinute: 0.000463,
  ramUsdPerGbMinute: 0.000231,
  serviceEgressUsdPerGb: 0.05,
  volumeUsdPerGbMonth: 0.15,
  objectStorageUsdPerGbMonth: 0.015,
} as const

export type Workflow = 'full' | 'incremental-bucket' | 'incremental-volume'
export type Evidence = 'measured' | 'modeled'
export type AttemptOutcome = 'changed' | 'no-change' | 'failed' | 'unknown'
export type PhaseName = 'source' | 'crunch' | 'privatePersistence' | 'publicPublish' | 'startupTail'
export type UploadCategory = 'privateCache' | 'publicPayload' | 'rawAuthority' | 'metadata'
export type RetainedStorageCategory = 'bucketAuthoritative' | 'bucketPrivate' | 'volumePrivate'

export type PhaseUsage = {
  durationSeconds: number
  vcpuSeconds: number
  rssByteSeconds: number
  peakRssBytes: number
  serviceUploadBytes: Record<UploadCategory, number>
  bucketDownloadBytes: number
}

export type AttemptLedger = {
  workflow: Workflow
  evidence: Evidence
  outcome: AttemptOutcome
  phases: Partial<Record<PhaseName, PhaseUsage>>
  retainedBytes: Record<RetainedStorageCategory, number>
  provenance: string
}

export type CostBreakdown = {
  cpuUsd: number
  ramUsd: number
  serviceEgressUsd: number
  variableUsd: number
  objectStorageUsdPerMonth: number
  volumeUsdPerMonth: number
  storageUsdPerMonth: number
}

export type MonthlyProjection = CostBreakdown & {
  attemptsPerMonth: number
  outcomeProbability: number
  publishProbability: number
  projectedPublishes: number
  monthlyVariableUsd: number
  monthlyTotalUsd: number
  costPerAttemptUsd: number
  costPerPublishUsd: number | null
}

export type CostGateInput = {
  full: MonthlyProjection
  incremental: MonthlyProjection
  measuredPairs: number
  nodeMajor: number
  fullProductionCorpus: boolean
}

export type CostGateDecision = {
  decision: 'keep-incremental' | 'remove-incremental' | 'insufficient-evidence'
  eligibleForProductionDecision: boolean
  checks: {
    atLeastFivePairs: boolean
    node22: boolean
    fullProductionCorpus: boolean
    atLeastTwentyPercentCheaper: boolean
    savesAtLeastUsdPerChangedRun: boolean
    projectedMonthlyTotalLower: boolean
  }
  changedRunSavingsUsd: number
  changedRunSavingsFraction: number
  thresholds: { minimumSavingsFraction: number; minimumSavingsUsd: number }
}

const decimalGb = 1_000_000_000

export function calculateAttemptCost(ledger: AttemptLedger): CostBreakdown {
  const phases = Object.values(ledger.phases)
  const vcpuSeconds = phases.reduce((sum, phase) => sum + phase.vcpuSeconds, 0)
  const rssByteSeconds = phases.reduce((sum, phase) => sum + phase.rssByteSeconds, 0)
  const paidUploadBytes = phases.reduce((sum, phase) => sum + Object.values(phase.serviceUploadBytes).reduce((subtotal, bytes) => subtotal + bytes, 0), 0)
  const cpuUsd = vcpuSeconds / 60 * railwayRates.cpuUsdPerVcpuMinute
  const ramUsd = rssByteSeconds / decimalGb / 60 * railwayRates.ramUsdPerGbMinute
  const serviceEgressUsd = paidUploadBytes / decimalGb * railwayRates.serviceEgressUsdPerGb
  const objectBytes = ledger.retainedBytes.bucketAuthoritative + ledger.retainedBytes.bucketPrivate
  const objectStorageUsdPerMonth = objectBytes / decimalGb * railwayRates.objectStorageUsdPerGbMonth
  const volumeUsdPerMonth = ledger.retainedBytes.volumePrivate / decimalGb * railwayRates.volumeUsdPerGbMonth
  return {
    cpuUsd,
    ramUsd,
    serviceEgressUsd,
    variableUsd: cpuUsd + ramUsd + serviceEgressUsd,
    objectStorageUsdPerMonth,
    volumeUsdPerMonth,
    storageUsdPerMonth: objectStorageUsdPerMonth + volumeUsdPerMonth,
  }
}

export function projectMonthlyCost(
  cost: CostBreakdown,
  assumptions: { attemptsPerMonth: number; outcomeProbability: number; publishProbability: number; explicitBackupsUsdPerMonth?: number },
): MonthlyProjection {
  const projectedPublishes = assumptions.attemptsPerMonth * assumptions.publishProbability
  const monthlyVariableUsd = assumptions.attemptsPerMonth * assumptions.outcomeProbability * cost.variableUsd
  const monthlyTotalUsd = monthlyVariableUsd + cost.storageUsdPerMonth + (assumptions.explicitBackupsUsdPerMonth ?? 0)
  return {
    ...cost,
    attemptsPerMonth: assumptions.attemptsPerMonth,
    outcomeProbability: assumptions.outcomeProbability,
    publishProbability: assumptions.publishProbability,
    projectedPublishes,
    monthlyVariableUsd,
    monthlyTotalUsd,
    costPerAttemptUsd: assumptions.attemptsPerMonth > 0 ? monthlyVariableUsd / assumptions.attemptsPerMonth : 0,
    costPerPublishUsd: projectedPublishes > 0 ? monthlyTotalUsd / projectedPublishes : null,
  }
}

export function decideIncrementalCostGate(input: CostGateInput): CostGateDecision {
  const minimumSavingsFraction = 0.2
  const minimumSavingsUsd = 0.0015
  const boundaryTolerance = 1e-12
  const changedRunSavingsUsd = input.full.variableUsd - input.incremental.variableUsd
  const changedRunSavingsFraction = input.full.variableUsd > 0 ? changedRunSavingsUsd / input.full.variableUsd : 0
  const checks = {
    atLeastFivePairs: input.measuredPairs >= 5,
    node22: input.nodeMajor === 22,
    fullProductionCorpus: input.fullProductionCorpus,
    atLeastTwentyPercentCheaper: changedRunSavingsFraction + boundaryTolerance >= minimumSavingsFraction,
    savesAtLeastUsdPerChangedRun: changedRunSavingsUsd + boundaryTolerance >= minimumSavingsUsd,
    projectedMonthlyTotalLower: input.incremental.monthlyTotalUsd < input.full.monthlyTotalUsd,
  }
  const eligibleForProductionDecision = checks.atLeastFivePairs && checks.node22 && checks.fullProductionCorpus
  const passesDollarGate = checks.atLeastTwentyPercentCheaper
    && checks.savesAtLeastUsdPerChangedRun
    && checks.projectedMonthlyTotalLower
  return {
    decision: !eligibleForProductionDecision ? 'insufficient-evidence' : passesDollarGate ? 'keep-incremental' : 'remove-incremental',
    eligibleForProductionDecision,
    checks,
    changedRunSavingsUsd,
    changedRunSavingsFraction,
    thresholds: { minimumSavingsFraction, minimumSavingsUsd },
  }
}

export function classifyAttemptOutcome(input: { published: boolean; explicitNoChange: boolean; failed: boolean }): AttemptOutcome {
  if (input.failed) return 'failed'
  if (input.published) return 'changed'
  if (input.explicitNoChange) return 'no-change'
  return 'unknown'
}

export function medianCostLedger(ledgers: AttemptLedger[]): AttemptLedger {
  if (ledgers.length === 0) throw new Error('At least one ledger is required')
  const template = ledgers[0]!
  const phaseNames: PhaseName[] = ['source', 'crunch', 'privatePersistence', 'publicPublish', 'startupTail']
  const phases: Partial<Record<PhaseName, PhaseUsage>> = {}
  for (const phaseName of phaseNames) {
    const values = ledgers.map((ledger) => ledger.phases[phaseName]).filter((phase): phase is PhaseUsage => phase !== undefined)
    if (values.length === 0) continue
    phases[phaseName] = {
      durationSeconds: median(values.map((value) => value.durationSeconds)),
      vcpuSeconds: median(values.map((value) => value.vcpuSeconds)),
      rssByteSeconds: median(values.map((value) => value.rssByteSeconds)),
      peakRssBytes: median(values.map((value) => value.peakRssBytes)),
      serviceUploadBytes: {
        privateCache: median(values.map((value) => value.serviceUploadBytes.privateCache)),
        publicPayload: median(values.map((value) => value.serviceUploadBytes.publicPayload)),
        rawAuthority: median(values.map((value) => value.serviceUploadBytes.rawAuthority)),
        metadata: median(values.map((value) => value.serviceUploadBytes.metadata)),
      },
      bucketDownloadBytes: median(values.map((value) => value.bucketDownloadBytes)),
    }
  }
  return {
    ...template,
    phases,
    retainedBytes: {
      bucketAuthoritative: median(ledgers.map((ledger) => ledger.retainedBytes.bucketAuthoritative)),
      bucketPrivate: median(ledgers.map((ledger) => ledger.retainedBytes.bucketPrivate)),
      volumePrivate: median(ledgers.map((ledger) => ledger.retainedBytes.volumePrivate)),
    },
  }
}

export function modelVolumeLedgerFromBucket(ledger: AttemptLedger): AttemptLedger {
  if (ledger.workflow !== 'incremental-bucket' || ledger.evidence !== 'measured') {
    throw new Error('Volume modeling requires a measured incremental-bucket ledger')
  }
  const phases: AttemptLedger['phases'] = {}
  for (const [name, phase] of Object.entries(ledger.phases) as Array<[PhaseName, PhaseUsage | undefined]>) {
    if (!phase) continue
    phases[name] = {
      ...phase,
      serviceUploadBytes: { ...phase.serviceUploadBytes, privateCache: 0 },
    }
  }
  return {
    ...ledger,
    workflow: 'incremental-volume',
    evidence: 'modeled',
    provenance: `${ledger.provenance}; modeled by zeroing private cache uploads and moving retained private bytes to a Railway volume`,
    phases,
    retainedBytes: {
      bucketAuthoritative: ledger.retainedBytes.bucketAuthoritative,
      bucketPrivate: 0,
      volumePrivate: ledger.retainedBytes.volumePrivate + ledger.retainedBytes.bucketPrivate,
    },
  }
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2
}
