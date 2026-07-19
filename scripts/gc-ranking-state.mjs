import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  acquireBucketMaintenance,
  bucketConfigFromEnv,
  createBucketClient,
  readBucketJson,
  recoverBucketMaintenance,
  releaseBucketMaintenance,
} from './railway-bucket.mjs'
import { createRailwayDurableObjectStore, executeRailwayDurableGc, planDurableGc } from './durable-ranking-state.mjs'

export async function runRankingStateGc({
  args = process.argv.slice(2),
  env = process.env,
  config = bucketConfigFromEnv(env),
  client = createBucketClient(config),
  owner = `${env.RAILWAY_DEPLOYMENT_ID ?? 'operator'}:${process.pid}:${randomUUID()}`,
  output = (message) => process.stdout.write(message),
  planGc = planDurableGc,
  now = () => new Date(),
} = {}) {
  if (!config.enabled || !client) throw new Error(`Bucket configuration is required: ${(config.missing ?? []).join(', ')}`)
  const flags = new Set(args)
  const recoverIndex = args.indexOf('--recover')
  if (recoverIndex >= 0) {
    const recoveryOwner = args[recoverIndex + 1]
    const fencingToken = Number(args[recoverIndex + 2])
    const result = await recoverBucketMaintenance({ owner: recoveryOwner, fencingToken }, {
      confirmedTerminated: flags.has('--confirm-terminated'), config, client,
    })
    if (!result.released) throw new Error(`Maintenance recovery refused: ${result.reason}`)
    output(`Recovered maintenance authority ${recoveryOwner}/${fencingToken}\n`)
    return result
  }

  const acquired = await acquireBucketMaintenance({ owner, now: now(), config, client })
  if (!acquired.acquired || !acquired.maintenance) throw new Error(`Maintenance acquisition refused: ${acquired.reason}`)
  output(`Maintenance acquired owner=${owner} fencingToken=${acquired.maintenance.fencingToken}\nRecovery after confirming this process terminated: pnpm data:gc -- --recover ${owner} ${acquired.maintenance.fencingToken} --confirm-terminated\n`)
  const store = createRailwayDurableObjectStore({ config, client })
  const planningOptions = async () => {
    const active = await readBucketJson('active-generation.json', { config, client })
    return {
      store,
      activePointer: active.value,
      activeEtag: active.etag,
      now: now().toISOString(),
      recentDays: positiveInteger(env.RANKING_DURABLE_RETENTION_DAYS) ?? 35,
      stagingGraceMs: positiveInteger(env.RANKING_DURABLE_STAGING_GRACE_MS) ?? 24 * 60 * 60_000,
    }
  }
  try {
    const plan = await planGc(await planningOptions())
    if (!plan.safe) throw new Error(`Maintenance planning failed closed: ${plan.reason}`)
    const dryRun = !flags.has('--execute')
    const result = await executeRailwayDurableGc({
      store,
      plan,
      dryRun,
      maintenanceGuard: acquired.maintenance,
      bucketConfig: config,
      bucketClient: client,
      replan: async () => planGc(await planningOptions()),
    })
    output(`${JSON.stringify({ owner, fencingToken: acquired.maintenance.fencingToken, dryRun, ...result })}\n`)
    return result
  } finally {
    const released = await releaseBucketMaintenance(acquired.maintenance, { config, client })
    if (!released.released) output(`Maintenance authority remains active: ${released.reason}\n`)
  }
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await runRankingStateGc()
