import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createProviderFetchTelemetry, fetchWithRetry, snapshotProviderFetchTelemetry } from './provider-fetch-retry.mjs'

const args = parseArgs(process.argv.slice(2))
const start = args.start ?? `${args.year ?? new Date().getUTCFullYear()}-01-01`
const end = args.end ?? new Date().toISOString().slice(0, 10)
const output = resolve(args.output ?? 'data/leaguepedia-matches.json')
const pageSize = Number(args.limit ?? 500)
const userAgent = args.userAgent ?? 'lol-esports-power-index-local/0.1 (public data research)'
const cargoBaseUrl = args.baseUrl ?? args['base-url'] ?? 'https://lol.fandom.com/api.php'
const fetchTelemetry = createProviderFetchTelemetry()

const fields = [
  'OverviewPage',
  'Team1',
  'Team2',
  'WinTeam',
  'LossTeam',
  'DateTime_UTC',
  'Patch',
  'GameId',
  'Team1Kills',
  'Team2Kills',
  'Team1Gold',
  'Team2Gold',
]

const matches = []
let offset = 0

while (true) {
  const result = await cargoQuery({
    tables: 'ScoreboardGames',
    fields: fields.join(','),
    where: `DateTime_UTC >= "${start} 00:00:00" AND DateTime_UTC <= "${end} 23:59:59" AND Team1 IS NOT NULL AND Team2 IS NOT NULL AND WinTeam IS NOT NULL`,
    order_by: 'DateTime_UTC ASC',
    limit: String(pageSize),
    offset: String(offset),
  })

  if (result.error) {
    throw new Error(`${result.error.code}: ${result.error.info}`)
  }

  const rows = result.cargoquery ?? []
  matches.push(...rows.map((row) => normalizeGame(row.title)))
  if (rows.length < pageSize) break
  offset += rows.length
  await sleep(1200)
}

await mkdir(dirname(output), { recursive: true })
await writeFile(
  output,
  `${JSON.stringify({ source: 'Leaguepedia Cargo ScoreboardGames', fetchedAt: new Date().toISOString(), start, end, matches, fetchTelemetry: snapshotProviderFetchTelemetry(fetchTelemetry) }, null, 2)}\n`,
)

console.log(`Wrote ${matches.length} matches to ${output}`)

async function cargoQuery(params) {
  const url = new URL(cargoBaseUrl)
  url.searchParams.set('action', 'cargoquery')
  url.searchParams.set('format', 'json')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const response = await fetchWithRetry(url, { headers: { 'user-agent': userAgent } }, {
    maxAttempts: Number(args.retries ?? 6) + 1,
    baseDelayMs: Number(args.retryDelayMs ?? args.retryDelay ?? 1000),
    telemetry: fetchTelemetry,
    onFailure: writeFailureTelemetry,
    retryResponse: async (candidate) => {
      try {
        const body = await candidate.json()
        return isRateLimited(body) ? 'leaguepedia-body-ratelimited' : undefined
      } catch {
        return undefined
      }
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Leaguepedia Cargo`)
  }
  return response.json()
}

async function writeFailureTelemetry(telemetry) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify({
    source: 'Leaguepedia Cargo ScoreboardGames',
    fetchedAt: new Date().toISOString(),
    start,
    end,
    status: 'failed',
    fetchTelemetry: telemetry,
    matches: [],
  }, null, 2)}\n`)
}

function isRateLimited(result) {
  return result?.error?.code === 'ratelimited'
}

function normalizeGame(row) {
  return {
    id: row.GameId,
    date: String(row['DateTime UTC'] ?? '').slice(0, 10),
    datetimeUtc: row['DateTime UTC'],
    event: row.OverviewPage,
    patch: row.Patch,
    teamA: row.Team1,
    teamB: row.Team2,
    winner: row.WinTeam,
    loser: row.LossTeam,
    teamAKills: numberOrNull(row.Team1Kills),
    teamBKills: numberOrNull(row.Team2Kills),
    teamAGold: numberOrNull(row.Team1Gold),
    teamBGold: numberOrNull(row.Team2Gold),
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function parseArgs(rawArgs) {
  const parsed = {}
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rawArgs[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}
