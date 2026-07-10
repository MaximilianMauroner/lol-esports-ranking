import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parsePublicRankingManifest, parsePublicRankingShard, type PublicRankingShard, type PublicTeamStanding } from '../src/lib/publicArtifacts/schema.ts'

export type RiotGprEntry = {
  rank: number
  team: string
  code?: string
}

export type RiotGprComparisonRow = {
  team: string
  code?: string
  currentRank: number
  riotRank: number
  rankDelta: number
  absRankDelta: number
  flagged: boolean
  reasons: RiotGprComparisonReason[]
}

export type RiotGprComparisonReason = 'elite-rank-inversion' | 'top-band-rank-delta'

export type RiotGprBenchmarkReport = {
  artifactKind: 'riot-gpr-benchmark-comparison'
  generatedAt: string
  currentArtifact: {
    manifestPath: string
    shardPath: string
    defaultSnapshotKey: string
    modelVersion: string
    modelConfigHash: string
  }
  riotSnapshot: {
    path: string
    source?: string
    fetchedAt?: string
    year?: string
    milestone?: string
    entryCount: number
  }
  thresholds: RiotGprComparisonThresholds
  summary: {
    comparedTeams: number
    flaggedTeams: number
    missingFromCurrent: number
    missingFromRiot: number
    eliteFlaggedTeams: number
    missingEliteFromCurrent: number
    missingEliteFromRiot: number
    maxAbsRankDelta: number
    passed: boolean
  }
  rows: RiotGprComparisonRow[]
  missingFromCurrent: RiotGprEntry[]
  missingFromRiot: Array<Pick<PublicTeamStanding, 'team' | 'code' | 'rank'>>
}

export type RiotGprComparisonThresholds = {
  maxRankDelta: number
  maxLargeDeltas: number
  top: number
  eliteTop: number
  maxEliteRankDelta: number
  minMatched: number
}

type RiotSnapshotMeta = {
  source?: string
  fetchedAt?: string
  year?: string
  milestone?: string
}

type CliOptions = {
  riotGprPath?: string
  manifestPath: string
  publicDataDir: string
  outputPath: string
  thresholds: RiotGprComparisonThresholds
  required: boolean
}

const defaultPublicDataDir = 'public/data'
const benchmarkKeyAliases: Record<string, string[]> = {
  teamliquidalienware: ['teamliquid', 'tl'],
  tlaw: ['teamliquid', 'tl'],
  teamliquid: ['teamliquidalienware', 'tlaw', 'tl'],
  tl: ['teamliquidalienware', 'tlaw', 'teamliquid'],
  xianteamwe: ['teamwe', 'tw', 'we'],
  teamwe: ['xianteamwe', 'tw', 'we'],
  tw: ['xianteamwe', 'teamwe', 'we'],
  we: ['xianteamwe', 'teamwe', 'tw'],
}

if (isDirectExecution()) {
  await runCli(process.argv.slice(2))
}

export async function runCli(rawArgs: string[]) {
  const options = parseCliOptions(rawArgs)
  if (!options.riotGprPath) {
    const message = 'No Riot GPR snapshot path provided. Pass --gpr data/raw/riot-gpr/riot-gpr-YYYY-current.json to run the local benchmark check.'
    if (options.required) throw new Error(message)
    console.log(`${message} Skipping optional benchmark.`)
    return
  }

  const manifestPath = resolve(options.manifestPath)
  const publicDataDir = resolve(options.publicDataDir)
  const manifest = parsePublicRankingManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  const shardEntry = manifest.snapshotIndex[manifest.defaultSnapshotKey]
  const shardPath = resolveDataUrl(publicDataDir, shardEntry.url)
  const shard = parsePublicRankingShard(JSON.parse(await readFile(shardPath, 'utf8')))
  const riotSnapshotPath = resolve(options.riotGprPath)
  const riotSnapshot = JSON.parse(await readFile(riotSnapshotPath, 'utf8')) as unknown
  const riotEntries = extractRiotGprEntries(riotSnapshot)
  const report = compareRiotGprBenchmark({
    currentShard: shard,
    currentArtifact: {
      manifestPath,
      shardPath,
      defaultSnapshotKey: manifest.defaultSnapshotKey,
      modelVersion: manifest.model.version,
      modelConfigHash: manifest.model.configHash,
    },
    riotEntries,
    riotSnapshot: {
      path: riotSnapshotPath,
      ...riotSnapshotMeta(riotSnapshot),
      entryCount: riotEntries.length,
    },
    thresholds: options.thresholds,
  })

  const outputPath = resolve(options.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)

  const flagged = report.rows.filter((row) => row.flagged)
  console.log(`Compared ${report.summary.comparedTeams} Riot GPR teams against ${manifest.defaultSnapshotKey}; wrote ${outputPath}`)
  if (!report.summary.passed) {
    const examples = flagged
      .slice(0, 8)
      .map((row) => `${row.team}: current ${row.currentRank}, Riot ${row.riotRank}, delta ${formatSigned(row.rankDelta)} (${row.reasons.join(', ')})`)
      .join('; ')
    throw new Error(`Riot GPR sanity benchmark thresholds exceeded: ${flagged.length} flagged team(s), ${report.summary.comparedTeams} matched. ${examples}`)
  }
}

export function compareRiotGprBenchmark(input: {
  currentShard: PublicRankingShard
  currentArtifact: RiotGprBenchmarkReport['currentArtifact']
  riotEntries: RiotGprEntry[]
  riotSnapshot: RiotGprBenchmarkReport['riotSnapshot']
  thresholds: RiotGprComparisonThresholds
}): RiotGprBenchmarkReport {
  const currentByKey = new Map<string, PublicTeamStanding>()
  const riotMatchedKeys = new Set<string>()

  for (const standing of input.currentShard.standings) {
    for (const key of standingKeys(standing)) {
      if (!currentByKey.has(key)) currentByKey.set(key, standing)
    }
  }

  const rows: RiotGprComparisonRow[] = []
  const missingCurrentCandidates: RiotGprEntry[] = []
  const missingComparisonLimit = Math.max(input.thresholds.top, input.thresholds.eliteTop)

  for (const riotEntry of input.riotEntries) {
    const current = findCurrentStanding(currentByKey, riotEntry)
    if (!current) {
      if (riotEntry.rank <= missingComparisonLimit) missingCurrentCandidates.push(riotEntry)
      continue
    }
    standingKeys(current).forEach((key) => riotMatchedKeys.add(key))
    const rankDelta = current.rank - riotEntry.rank
    const absRankDelta = Math.abs(rankDelta)
    const inComparedBand = current.rank <= input.thresholds.top || riotEntry.rank <= input.thresholds.top
    const inEliteBand = current.rank <= input.thresholds.eliteTop || riotEntry.rank <= input.thresholds.eliteTop
    const reasons: RiotGprComparisonReason[] = []
    if (inEliteBand && absRankDelta > input.thresholds.maxEliteRankDelta) reasons.push('elite-rank-inversion')
    if (inComparedBand && absRankDelta > input.thresholds.maxRankDelta) reasons.push('top-band-rank-delta')
    rows.push({
      team: current.team,
      code: current.code,
      currentRank: current.rank,
      riotRank: riotEntry.rank,
      rankDelta,
      absRankDelta,
      flagged: reasons.length > 0,
      reasons,
    })
  }

  const missingRiotCandidates = input.currentShard.standings
    .filter((standing) => standing.rank <= missingComparisonLimit)
    .filter((standing) => !standingKeys(standing).some((key) => riotMatchedKeys.has(key)))
    .map((standing) => ({ team: standing.team, code: standing.code, rank: standing.rank }))
  const missingFromCurrent = missingCurrentCandidates.filter((entry) => entry.rank <= input.thresholds.top)
  const missingFromRiot = missingRiotCandidates.filter((entry) => entry.rank <= input.thresholds.top)

  rows.sort((left, right) => {
    if (left.flagged !== right.flagged) return left.flagged ? -1 : 1
    return right.absRankDelta - left.absRankDelta || left.currentRank - right.currentRank
  })

  const flaggedTeams = rows.filter((row) => row.flagged).length
  const eliteFlaggedTeams = rows.filter((row) => row.reasons.includes('elite-rank-inversion')).length
  const missingEliteFromCurrent = missingCurrentCandidates.filter((entry) => entry.rank <= input.thresholds.eliteTop).length
  const missingEliteFromRiot = missingRiotCandidates.filter((entry) => entry.rank <= input.thresholds.eliteTop).length
  const comparedTeams = rows.length
  const passed = eliteFlaggedTeams === 0
    && missingEliteFromCurrent === 0
    && missingEliteFromRiot === 0
    && flaggedTeams <= input.thresholds.maxLargeDeltas
    && comparedTeams >= input.thresholds.minMatched

  return {
    artifactKind: 'riot-gpr-benchmark-comparison',
    generatedAt: new Date().toISOString(),
    currentArtifact: input.currentArtifact,
    riotSnapshot: input.riotSnapshot,
    thresholds: input.thresholds,
    summary: {
      comparedTeams,
      flaggedTeams,
      missingFromCurrent: missingFromCurrent.length,
      missingFromRiot: missingFromRiot.length,
      eliteFlaggedTeams,
      missingEliteFromCurrent,
      missingEliteFromRiot,
      maxAbsRankDelta: rows.reduce((max, row) => Math.max(max, row.absRankDelta), 0),
      passed,
    },
    rows,
    missingFromCurrent,
    missingFromRiot,
  }
}

export function extractRiotGprEntries(value: unknown): RiotGprEntry[] {
  const explicitArray = firstArrayAtKnownKey(value)
  const sourceRows = explicitArray ?? collectCandidateObjects(value)
  const byKey = new Map<string, RiotGprEntry>()

  for (const sourceRow of sourceRows) {
    const entry = riotEntryFromObject(sourceRow)
    if (!entry) continue
    const key = entry.code ? normalizeKey(entry.code) : normalizeKey(entry.team)
    const existing = byKey.get(key)
    if (!existing || entry.rank < existing.rank) byKey.set(key, entry)
  }

  return [...byKey.values()].sort((left, right) => left.rank - right.rank)
}

function parseCliOptions(rawArgs: string[]): CliOptions {
  const args = parseArgs(rawArgs)
  const maxRankDelta = readInteger(args, 'max-rank-delta', 24)
  const maxLargeDeltas = readInteger(args, 'max-large-deltas', 2)
  const top = readInteger(args, 'top', 25)
  const eliteTop = readInteger(args, 'elite-top', 2)
  const maxEliteRankDelta = readInteger(args, 'max-elite-rank-delta', 20)
  const minMatched = readInteger(args, 'min-matched', 20)
  return {
    riotGprPath: stringArg(args.gpr) ?? stringArg(args['riot-gpr']) ?? process.env.RIOT_GPR_SNAPSHOT,
    manifestPath: stringArg(args.summary) ?? `${defaultPublicDataDir}/ranking-summary.json`,
    publicDataDir: stringArg(args['public-data-dir']) ?? defaultPublicDataDir,
    outputPath: stringArg(args.output) ?? 'data/derived/riot-gpr-benchmark-report.json',
    thresholds: { maxRankDelta, maxLargeDeltas, top, eliteTop, maxEliteRankDelta, minMatched },
    required: booleanArg(args.required),
  }
}

function parseArgs(rawArgs: string[]) {
  const parsed: Record<string, string | boolean> = {}
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

function readInteger(args: Record<string, string | boolean>, key: string, fallback: number) {
  const value = stringArg(args[key])
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${key} must be a non-negative integer`)
  return parsed
}

function stringArg(value: string | boolean | undefined) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function booleanArg(value: string | boolean | undefined) {
  if (value === true) return true
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes'].includes(value.toLowerCase())
}

function resolveDataUrl(publicDataDir: string, url: string) {
  const pathname = url.split('?')[0]
  if (!pathname.startsWith('/data/')) throw new Error(`Expected local /data URL, got ${url}`)
  return resolve(publicDataDir, pathname.slice('/data/'.length))
}

function firstArrayAtKnownKey(value: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['standings', 'rankings', 'teams', 'gpr']) {
    const child = value[key]
    if (Array.isArray(child) && child.every(isRecord)) return child
  }
  return undefined
}

function collectCandidateObjects(value: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = []
  const seen = new Set<unknown>()

  function visit(node: unknown) {
    if (node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (isRecord(node)) {
      if (riotEntryFromObject(node)) candidates.push(node)
      Object.values(node).forEach(visit)
    }
  }

  visit(value)
  return candidates
}

function riotEntryFromObject(value: Record<string, unknown>): RiotGprEntry | undefined {
  const gprRecord = isRecord(value.currentTeamGPR) ? value.currentTeamGPR : undefined
  const rank = numberField(value, ['rank', 'ranking', 'position', 'ordinal', 'place'])
    ?? (gprRecord ? numberField(gprRecord, ['rank', 'ranking', 'position', 'ordinal', 'place']) : undefined)
  if (!rank || rank < 1) return undefined

  const teamRecord = isRecord(value.team) ? value.team : undefined
  const team = stringField(value, ['teamName', 'team_name', 'name', 'displayName', 'display_name'])
    ?? (teamRecord ? stringField(teamRecord, ['name', 'displayName', 'display_name', 'slug']) : undefined)
  if (!team) return undefined

  const code = stringField(value, ['code', 'acronym', 'tricode', 'abbreviation'])
    ?? (teamRecord ? stringField(teamRecord, ['code', 'acronym', 'tricode', 'abbreviation']) : undefined)

  return {
    rank,
    team,
    ...(code ? { code } : {}),
  }
}

function numberField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
    if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) return Math.trunc(Number(raw))
  }
  return undefined
}

function stringField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return undefined
}

function findCurrentStanding(byKey: Map<string, PublicTeamStanding>, riotEntry: RiotGprEntry) {
  for (const key of riotEntryKeys(riotEntry)) {
    const standing = byKey.get(key)
    if (standing) return standing
  }
  return undefined
}

function standingKeys(standing: Pick<PublicTeamStanding, 'team' | 'code'>) {
  return benchmarkKeys([standing.team, standing.code])
}

function riotEntryKeys(entry: RiotGprEntry) {
  return benchmarkKeys([entry.team, entry.code])
}

function benchmarkKeys(values: Array<string | undefined>) {
  const keys = new Set<string>()
  for (const value of values) {
    if (!value) continue
    const normalized = normalizeKey(value)
    if (!normalized) continue
    keys.add(normalized)
    for (const alias of benchmarkAliasesFor(normalized)) keys.add(alias)
  }
  return [...keys]
}

function benchmarkAliasesFor(key: string) {
  return benchmarkKeyAliases[key] ?? []
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
}

function riotSnapshotMeta(value: unknown): RiotSnapshotMeta {
  if (!isRecord(value)) return {}
  return {
    ...optionalStringProperty(value, 'source'),
    ...optionalStringProperty(value, 'fetchedAt'),
    ...optionalStringProperty(value, 'year'),
    ...optionalStringProperty(value, 'milestone'),
  }
}

function optionalStringProperty(value: Record<string, unknown>, key: keyof RiotSnapshotMeta): Partial<RiotSnapshotMeta> {
  const property = value[key]
  return typeof property === 'string' ? { [key]: property } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function formatSigned(value: number) {
  return value > 0 ? `+${value}` : `${value}`
}

function isDirectExecution() {
  return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false
}
