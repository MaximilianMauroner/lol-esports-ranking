import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { parseProbeCoordinationEvidence } from './probe-refresh-coordination.mjs'
import { bucketConfigFromEnv, createBucketClient, readBucketJson } from './railway-bucket.mjs'
import { hasMeasuredProductionUsage, parseRailwayCostReport } from './railway-cost-report.mjs'
import {
  parseImplementationEvidence,
  resolveImplementationAuthority,
} from './rollout-implementation-evidence.mjs'
import { parseRolloutEvidence } from './rollout-evidence.mjs'
import {
  parseImmutableReference,
  parseRollbackRehearsalEvidence,
  parseRolloutGateDecision,
} from './rollout-gate.mjs'
import { parseRolloutShadowGateDecision } from './rollout-shadow-gate.mjs'

export const PLAN_COMPLETION_STATUSES = ['proved', 'contradicted', 'missing', 'live-pending', 'authorization-gated']

export const PLAN_COMPLETION_REQUIREMENTS = Object.freeze([
  requirement('provider-request-retry', 'ranking-rollout-implementation-test-evidence'),
  requirement('complete-immutable-receipts', 'ranking-rollout-implementation-test-evidence'),
  requirement('storage-delivery-contract', 'ranking-rollout-implementation-test-evidence'),
  requirement('retention-safety-contract', 'ranking-rollout-implementation-test-evidence'),
  requirement('authoritative-full-fallback', 'ranking-rollout-implementation-test-evidence'),
  requirement('atomic-generation-publication', 'ranking-rollout-implementation-test-evidence'),
  requirement('ranking-provenance-contract', 'ranking-rollout-implementation-test-evidence'),
  requirement('seven-day-live-shadow', 'ranking-rollout-shadow-gate-decision', { requiresLive: true }),
  requirement('deployment-bound-gate', 'ranking-five-minute-rollout-gate-decision', { requiresLive: true }),
  requirement('live-probe-coordination', 'ranking-rollout-probe-coordination-evidence', { requiresLive: true }),
  requirement('live-rollback-rehearsal', 'ranking-rollout-rollback-rehearsal', { requiresLive: true }),
  requirement('production-freshness-p95-15m', 'ranking-rollout-production-freshness-evidence', { requiresLive: true }),
  requirement('latest-game-performance-bounds', 'ranking-rollout-latest-game-performance-evidence', { requiresLive: true }),
  requirement('compressed-generation-storage-bounds', 'ranking-rollout-storage-measurement-evidence', { requiresLive: true }),
  requirement('railway-nontraffic-monthly-under-five', 'ranking-railway-cost-report', { requiresLive: true }),
  requirement('five-minute-cadence', 'ranking-five-minute-rollout-gate-decision', { requiresLive: true, authorizationRequired: true }),
  requirement('production-config-change', 'ranking-five-minute-rollout-gate-decision', { requiresLive: true, authorizationRequired: true }),
  requirement('incremental-cutover', 'ranking-five-minute-rollout-gate-decision', { requiresLive: true, authorizationRequired: true }),
  requirement('storage-delivery-production-cutover', 'ranking-five-minute-rollout-gate-decision', { requiresLive: true, authorizationRequired: true }),
  requirement('retention-delete-execution', 'ranking-five-minute-rollout-gate-decision', { requiresLive: true, authorizationRequired: true }),
])

export async function auditPlanCompletion({
  acceptance,
  evidence = [],
  expectedCommit,
  expectedDeploymentId,
  subjectCommit = expectedCommit,
  implementationAuthorityDir,
  repositoryRoot = process.cwd(),
  resolveReference,
  now = new Date(),
} = {}) {
  if (!acceptance || acceptance.artifactKind !== 'ranking-rollout-acceptance-contract' || acceptance.schemaVersion !== 1) {
    throw new Error('Invalid plan acceptance contract identity')
  }
  const bucketResolved = typeof resolveReference === 'function'
    ? (await Promise.all((Array.isArray(evidence) ? evidence : []).map((reference) => resolveCompletionAttachment(reference, resolveReference))))
      .filter(Boolean)
    : []
  const repositoryResolved = implementationAuthorityDir
    ? (await resolveImplementationAuthority({
      authorityDir: implementationAuthorityDir,
      subjectCommit,
      repositoryRoot,
    })).map((value) => ({ authority: 'repository', value }))
    : []
  const resolved = [...bucketResolved, ...repositoryResolved]
  const requirements = PLAN_COMPLETION_REQUIREMENTS.map((contract) => {
    const candidates = resolved.filter((entry) => attachmentApplies(entry.value, contract)
      && nativeEvidenceValid(entry.value, {
        expectedCommit,
        expectedDeploymentId,
        subjectCommit,
        repositoryAuthority: entry.authority === 'repository',
        requiresLive: contract.requiresLive,
        now,
      }))
    const contradiction = candidates.find((entry) => entry.value.result === 'contradicted' || entry.value.proved === false)
    const proof = candidates.find((entry) => nativeProofPassed(entry.value))
    const status = contract.authorizationRequired
      ? 'authorization-gated'
      : contradiction
        ? 'contradicted'
        : proof
          ? 'proved'
          : contract.requiresLive
            ? 'live-pending'
            : 'missing'
    return {
      id: contract.id,
      required: true,
      status,
      evidenceKind: proof?.value.artifactKind ?? contradiction?.value.artifactKind ?? null,
      evidenceId: proof?.value.runId ?? contradiction?.value.runId ?? null,
    }
  })
  const incomplete = requirements.filter((entry) => entry.status !== 'proved')
  return {
    artifactKind: 'ranking-rollout-plan-completion-audit',
    schemaVersion: 1,
    complete: incomplete.length === 0,
    exitCode: incomplete.length === 0 ? 0 : 1,
    counts: Object.fromEntries(PLAN_COMPLETION_STATUSES.map((status) => [
      status,
      requirements.filter((entry) => entry.status === status).length,
    ])),
    incompleteIds: incomplete.map((entry) => entry.id),
    requirements,
  }
}

async function resolveCompletionAttachment(raw, resolveReference) {
  try {
    const reference = parseImmutableReference(raw)
    if (!reference.key.startsWith('ops/')) return null
    const result = await resolveReference(reference.key)
    const found = result?.found === undefined ? result !== undefined : result.found
    const value = result?.found === undefined ? result : result.value
    if (!found || !record(value)) return null
    const digest = createHash('sha256').update(canonicalJsonFor(value)).digest('hex')
    return digest === reference.sha256 ? { authority: 'bucket', ...reference, value } : null
  } catch {
    return null
  }
}

function attachmentApplies(value, contract) {
  if (value.artifactKind !== contract.evidenceKind) return false
  if (value.artifactKind === 'ranking-rollout-implementation-test-evidence') {
    return value.requirementId === contract.id
  }
  return true
}

function nativeEvidenceValid(value, {
  expectedCommit,
  expectedDeploymentId,
  subjectCommit,
  repositoryAuthority,
  requiresLive,
  now,
}) {
  try {
    if (value.artifactKind === 'ranking-rollout-implementation-test-evidence') {
      const parsed = parseImplementationEvidence(value)
      return repositoryAuthority === true
        && typeof subjectCommit === 'string'
        && parsed.subjectCommit === subjectCommit
        && parsed.producerSourceCommit === subjectCommit
    }
    if (typeof expectedCommit !== 'string' || typeof expectedDeploymentId !== 'string') return false
    if (value.commit !== expectedCommit || value.deploymentId !== expectedDeploymentId
      || typeof value.runId !== 'string' || typeof value.recordedAt !== 'string'
      || typeof value.expiresAt !== 'string' || Date.parse(value.expiresAt) <= new Date(now).getTime()
      || Date.parse(value.expiresAt) <= Date.parse(value.recordedAt)
      || !['live', 'production-like-fixture'].includes(value.evidenceClass)
      || (requiresLive && value.evidenceClass !== 'live')) return false
    switch (value.artifactKind) {
      case 'ranking-rollout-run-evidence':
        return parseRolloutEvidence(value).deployment.deploymentId === expectedDeploymentId
      case 'ranking-rollout-shadow-gate-decision':
        return parseRolloutShadowGateDecision(value).allowed
      case 'ranking-five-minute-rollout-gate-decision':
        return parseRolloutGateDecision(value).allowed
      case 'ranking-rollout-probe-coordination-evidence':
        parseProbeCoordinationEvidence(value)
        return true
      case 'ranking-rollout-rollback-rehearsal':
        parseRollbackRehearsalEvidence(value)
        return value.restoredGenerationId === value.expectedGenerationId
      case 'ranking-railway-cost-report':
        parseRailwayCostReport(value)
        return hasMeasuredProductionUsage(value)
      default:
        return false
    }
  } catch {
    return false
  }
}

function nativeProofPassed(value) {
  if (value.result === 'proved') return true
  if ('allowed' in value) return value.allowed === true
  if (value.artifactKind === 'ranking-rollout-probe-coordination-evidence') return value.status === 'completed'
  if (value.artifactKind === 'ranking-rollout-rollback-rehearsal') return value.completed === true
  if (value.artifactKind === 'ranking-railway-cost-report') return hasMeasuredProductionUsage(value)
  return false
}

function requirement(id, evidenceKind, options = {}) {
  return Object.freeze({ id, evidenceKind, requiresLive: false, authorizationRequired: false, ...options })
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function main(args) {
  const {
    acceptancePath,
    evidencePath,
    commit,
    deploymentId,
    subjectCommit,
    implementationAuthorityDir,
    repositoryRoot,
  } = parseCliArgs(args)
  const acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'))
  const evidence = evidencePath ? JSON.parse(await readFile(evidencePath, 'utf8')) : []
  const references = Array.isArray(evidence) ? evidence : evidence.evidence ?? []
  const config = references.length > 0 ? bucketConfigFromEnv() : undefined
  const client = config ? createBucketClient(config) : undefined
  const audit = await auditPlanCompletion({
    acceptance,
    evidence: references,
    expectedCommit: commit ?? subjectCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA,
    expectedDeploymentId: deploymentId ?? process.env.RAILWAY_DEPLOYMENT_ID,
    subjectCommit: subjectCommit ?? commit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA,
    implementationAuthorityDir,
    repositoryRoot,
    ...(config ? { resolveReference: (key) => readBucketJson(key, { config, client }) } : {}),
  })
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`)
  process.exitCode = audit.exitCode
}

function parseCliArgs(args) {
  const acceptancePath = args[0]
  if (!acceptancePath) {
    throw new Error('Usage: audit-plan-completion <acceptance.json> [--evidence-refs <path>] [--commit <commit>] [--deployment <id>] [--subject-commit <commit> --implementation-authority <absolute-path>] [--repository-root <absolute-path>]')
  }
  const optionArgs = args[1] === '--' ? [acceptancePath, ...args.slice(2)] : args
  if (optionArgs.slice(1).every((value) => !value.startsWith('--'))) {
    const [evidencePath, commit, deploymentId] = optionArgs.slice(1)
    return { acceptancePath, evidencePath, commit, deploymentId, repositoryRoot: process.cwd() }
  }
  const values = new Map()
  for (let index = 1; index < optionArgs.length; index += 2) {
    const flag = optionArgs[index]
    const value = optionArgs[index + 1]
    if (!['--evidence-refs', '--commit', '--deployment', '--subject-commit', '--implementation-authority', '--repository-root'].includes(flag)
      || !value) throw new Error(`Invalid completion audit argument ${flag ?? ''}`.trim())
    values.set(flag, value)
  }
  return {
    acceptancePath,
    evidencePath: values.get('--evidence-refs'),
    commit: values.get('--commit'),
    deploymentId: values.get('--deployment'),
    subjectCommit: values.get('--subject-commit'),
    implementationAuthorityDir: values.get('--implementation-authority'),
    repositoryRoot: values.get('--repository-root') ?? process.cwd(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
