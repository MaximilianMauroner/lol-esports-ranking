import { randomUUID } from 'node:crypto'
import {
  acquireBucketMaintenance,
  bucketConfigFromEnv,
  createBucketClient,
  readBucketJson,
  recoverBucketMaintenance,
  releaseBucketMaintenance,
} from './railway-bucket.mjs'
import { createRailwayDurableObjectStore, executeRailwayDurableGc, planDurableGc } from './durable-ranking-state.mjs'

const args = new Set(process.argv.slice(2))
const config = bucketConfigFromEnv()
const client = createBucketClient(config)
if (!config.enabled || !client) throw new Error(`Bucket configuration is required: ${(config.missing ?? []).join(', ')}`)

const recoverIndex = process.argv.indexOf('--recover')
if (recoverIndex >= 0) {
  const owner = process.argv[recoverIndex + 1]
  const fencingToken = Number(process.argv[recoverIndex + 2])
  const result = await recoverBucketMaintenance({ owner, fencingToken }, {
    confirmedTerminated: args.has('--confirm-terminated'),
    config,
    client,
  })
  if (!result.released) throw new Error(`Maintenance recovery refused: ${result.reason}`)
  console.log(`Recovered maintenance authority ${owner}/${fencingToken}`)
  process.exit(0)
}

const owner = `${process.env.RAILWAY_DEPLOYMENT_ID ?? 'operator'}:${process.pid}:${randomUUID()}`
const acquired = await acquireBucketMaintenance({ owner, config, client })
if (!acquired.acquired || !acquired.maintenance) throw new Error(`Maintenance acquisition refused: ${acquired.reason}`)
const store = createRailwayDurableObjectStore({ config, client })
const dryRun = !args.has('--execute')
try {
  // Reachability is intentionally read only after the exclusive authority exists.
  const active = await readBucketJson('active-generation.json', { config, client })
  const plan = await planDurableGc({
    store,
    activePointer: active.value,
    activeEtag: active.etag,
    now: new Date().toISOString(),
    recentDays: positiveInteger(process.env.RANKING_DURABLE_RETENTION_DAYS) ?? 35,
    stagingGraceMs: positiveInteger(process.env.RANKING_DURABLE_STAGING_GRACE_MS) ?? 24 * 60 * 60_000,
  })
  const result = await executeRailwayDurableGc({
    store,
    plan,
    dryRun,
    maintenanceGuard: acquired.maintenance,
    bucketConfig: config,
    bucketClient: client,
    replan: async () => {
      const current = await readBucketJson('active-generation.json', { config, client })
      return planDurableGc({
        store,
        activePointer: current.value,
        activeEtag: current.etag,
        now: new Date().toISOString(),
        recentDays: positiveInteger(process.env.RANKING_DURABLE_RETENTION_DAYS) ?? 35,
        stagingGraceMs: positiveInteger(process.env.RANKING_DURABLE_STAGING_GRACE_MS) ?? 24 * 60 * 60_000,
      })
    },
  })
  console.log(JSON.stringify({ owner, fencingToken: acquired.maintenance.fencingToken, dryRun, ...result }))
} finally {
  const released = await releaseBucketMaintenance(acquired.maintenance, { config, client })
  if (!released.released) console.error(`Maintenance authority remains active: ${released.reason}`)
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
