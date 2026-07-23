import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { bucketConfigFromEnv, createBucketClient, readBucketJson } from './railway-bucket.mjs'
import { evaluateRolloutGate, parseImmutableReference } from './rollout-gate.mjs'

export async function readRolloutGateReceipt(value, {
  config = bucketConfigFromEnv(), client = createBucketClient(config), readJson = readBucketJson,
} = {}) {
  if (!value) return undefined
  let reference
  try {
    reference = parseImmutableReference(typeof value === 'object' ? value : JSON.parse(String(value)))
  } catch {
    throw new Error('Rollout gate input must be a bucket authority reference; inline/local receipts are forbidden')
  }
  if (!reference.key.startsWith('ops/rollout-gates/')) throw new Error('Rollout gate input must be a bucket authority reference; inline/local receipts are forbidden')
  const stored = await readJson(reference.key, { config, client })
  if (!stored.found) throw new Error('Rollout gate authority is missing')
  const digest = createHash('sha256').update(canonicalJsonFor(stored.value)).digest('hex')
  if (digest !== reference.sha256) throw new Error('Rollout gate authority digest mismatch')
  return {
    ...reference,
    commit: stored.value.commit,
    deploymentId: stored.value.deploymentId,
    runId: stored.value.runId,
    recordedAt: stored.value.issuedAt,
    expiresAt: stored.value.expiresAt,
    evidenceClass: stored.value.evidenceClass,
    value: stored.value,
  }
}

export async function validateRolloutGate({ intervalMinutes, mode, commit, deploymentId, receipt, now } = {}) {
  const config = bucketConfigFromEnv()
  const client = createBucketClient(config)
  return evaluateRolloutGate({
    intervalMinutes,
    mode,
    commit,
    deploymentId,
    receiptAuthority: await readRolloutGateReceipt(receipt, { config, client }),
    resolveReference: (key) => readBucketJson(key, { config, client }),
    now,
  })
}

async function main(args) {
  const [receiptPath, commit, deploymentId, interval = '5', mode = 'gated'] = args
  const decision = await validateRolloutGate({ receipt: receiptPath, commit, deploymentId, intervalMinutes: Number(interval), mode })
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
  if (!decision.allowed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
