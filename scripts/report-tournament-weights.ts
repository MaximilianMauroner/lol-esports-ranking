import { readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { eventTierConfig, kespaCupEventWeightMultiplier, preseasonEventWeightMultiplier } from '../src/data/rankingConfig.ts'
import { deservedStandingModelParameters } from '../src/lib/deservedStanding.ts'
import { transparentGprModelMetadata } from '../src/lib/modelConfig.ts'

type PublicMatch = {
  date: string
  event: string
  phase: string
  league: string
  weighting?: { tier: keyof typeof eventTierConfig; multiplier: number }
}

type MatchPage = {
  artifactKind: 'match-history-page'
  schemaVersion: number
  modelVersion: string
  modelConfigHash: string
  artifactMeta: { runId: string; generatedAt: string }
  page: number
  gameCount: number
  seriesCount: number
  matches: PublicMatch[]
}

type MatchCatalog = Omit<MatchPage, 'artifactKind' | 'page' | 'matches'> & {
  artifactKind: 'match-history-catalog'
  pages: Array<{ page: number; url: string; gameCount: number; seriesCount: number }>
}

type MatchIndex = Omit<MatchPage, 'artifactKind' | 'page' | 'matches' | 'gameCount' | 'seriesCount'> & {
  artifactKind: 'match-history-index'
  defaultScopeKey: string
  scopeIndex: Record<string, { url: string; gameCount: number; seriesCount: number; pageCount: number }>
}

const publicDataDir = resolve(valueAfter('--public-data-dir') ?? '.generated/ranking-data')
const outputPath = valueAfter('--output')
const index = await readJson<MatchIndex>(resolve(publicDataDir, 'matches', 'index.json'))
if (index.artifactKind !== 'match-history-index') throw new Error('Invalid match-history index artifact kind')
const scope = index.scopeIndex[index.defaultScopeKey]
if (!scope) throw new Error(`Default match-history scope ${index.defaultScopeKey} is missing`)
const catalogPath = artifactPathForUrl(publicDataDir, scope.url)
const catalog = await readJson<MatchCatalog>(catalogPath)
if (catalog.artifactKind !== 'match-history-catalog') throw new Error('Invalid match-history catalog artifact kind')
assertSameGeneration(index, catalog, 'catalog')
if (catalog.pages.length !== scope.pageCount) throw new Error('Match-history catalog page count does not match its index declaration')
const pageNumbers = catalog.pages.map((entry) => entry.page)
if (new Set(pageNumbers).size !== pageNumbers.length || pageNumbers.some((page, index) => page !== index + 1)) {
  throw new Error('Match-history catalog page numbers are incomplete or duplicated')
}
const declaredPaths = catalog.pages.map((entry) => artifactPathForUrl(publicDataDir, entry.url))
if (new Set(declaredPaths).size !== declaredPaths.length) throw new Error('Match-history catalog contains duplicate page URLs')
const pagesDir = resolve(publicDataDir, 'matches', 'pages')
const presentAllPages = (await readdir(pagesDir)).filter((name) => /^all-\d+\.json$/.test(name)).map((name) => resolve(pagesDir, name)).sort()
const declaredAllPages = declaredPaths.toSorted()
if (!sameStrings(presentAllPages, declaredAllPages)) {
  const missing = declaredAllPages.filter((path) => !presentAllPages.includes(path)).map((path) => relative(publicDataDir, path))
  const extras = presentAllPages.filter((path) => !declaredAllPages.includes(path)).map((path) => relative(publicDataDir, path))
  throw new Error(`Match-history pages differ from catalog (missing: ${missing.join(', ') || 'none'}; extras: ${extras.join(', ') || 'none'})`)
}
const pages = await Promise.all(catalog.pages.map(async (entry) => {
  const page = await readJson<MatchPage>(artifactPathForUrl(publicDataDir, entry.url))
  if (page.artifactKind !== 'match-history-page' || page.page !== entry.page) throw new Error(`Invalid match-history page ${entry.page}`)
  assertSameGeneration(index, page, `page ${entry.page}`)
  if (page.gameCount !== entry.gameCount || page.matches.length !== entry.gameCount || page.seriesCount !== entry.seriesCount) {
    throw new Error(`Match-history page ${entry.page} count mismatch`)
  }
  return page
}))
const provenance = pages[0]
if (!provenance) throw new Error('Missing match-page provenance')
if (index.modelConfigHash !== transparentGprModelMetadata.configHash) {
  throw new Error(`Tournament inventory requires freshly generated artifacts for ${transparentGprModelMetadata.configHash}; found ${index.modelConfigHash}`)
}
const matches = pages.flatMap((page) => page.matches)
if (matches.length !== catalog.gameCount || matches.length !== scope.gameCount
  || pages.reduce((sum, page) => sum + page.seriesCount, 0) !== catalog.seriesCount
  || catalog.seriesCount !== scope.seriesCount) {
  throw new Error('Match-history aggregate counts do not match catalog/index declarations')
}
const worldsEnds = new Map<number, string>()
for (const match of matches) {
  const tier = tierFor(match)
  if (tier !== 'worlds-main' && tier !== 'worlds-playoffs') continue
  const year = Number(match.date.slice(0, 4))
  const previous = worldsEnds.get(year)
  if (!previous || match.date > previous) worldsEnds.set(year, match.date)
}
const grouped = new Map<string, {
  event: string
  phase: string
  league: string
  tier: ReturnType<typeof tierFor>
  multiplier: number
  start: string
  end: string
  games: number
}>()
for (const match of matches) {
  const tier = tierFor(match)
  const multiplier = match.weighting!.multiplier
  const key = [match.event, match.phase, match.league, tier, multiplier].join('\u0000')
  const row = grouped.get(key) ?? {
    event: match.event,
    phase: match.phase,
    league: match.league,
    tier,
    multiplier,
    start: match.date,
    end: match.date,
    games: 0,
  }
  row.start = row.start < match.date ? row.start : match.date
  row.end = row.end > match.date ? row.end : match.date
  row.games += 1
  grouped.set(key, row)
}
const rows = [...grouped.values()].sort((left, right) => left.event.localeCompare(right.event) || left.phase.localeCompare(right.phase)).map((row) => {
  const config = eventTierConfig[row.tier]
  return {
    ...row,
    teamK: config.kFactor * row.multiplier,
    leagueK: config.leagueKFactor * row.multiplier,
    displayWeight: config.weight * row.multiplier,
    deservedStandingEventWeight: deservedStandingModelParameters.eventWeights[row.tier] * row.multiplier,
  }
})
const report = `${JSON.stringify({
  schemaVersion: 1,
  source: {
    publicDataDir,
    index: relative(publicDataDir, resolve(publicDataDir, 'matches', 'index.json')).replaceAll(sep, '/'),
    catalog: relative(publicDataDir, catalogPath).replaceAll(sep, '/'),
    pages: declaredPaths.length,
    games: matches.length,
    schemaVersion: index.schemaVersion,
  },
  model: {
    version: provenance.modelVersion,
    configHash: provenance.modelConfigHash,
    runId: provenance.artifactMeta.runId,
    generatedAt: provenance.artifactMeta.generatedAt,
  },
  policies: {
    preseasonMultiplier: preseasonEventWeightMultiplier,
    kespaCupMultiplier: kespaCupEventWeightMultiplier,
  },
  tierWeights: eventTierConfig,
  deservedStandingEventWeights: deservedStandingModelParameters.eventWeights,
  deservedStandingFormatMultipliers: deservedStandingModelParameters.formatMultipliers,
  worldsEndDates: Object.fromEntries(worldsEnds),
  rows,
}, null, 2)}\n`
if (outputPath) {
  await writeFile(resolve(outputPath), report)
} else {
  process.stdout.write(report)
}

function tierFor(match: PublicMatch) {
  if (!match.weighting || !(match.weighting.tier in eventTierConfig)
    || typeof match.weighting.multiplier !== 'number' || !Number.isFinite(match.weighting.multiplier)
    || match.weighting.multiplier <= 0) {
    throw new Error(`Match ${match.event}/${match.date} is missing generation-bound applied weighting provenance`)
  }
  return match.weighting.tier
}

function valueAfter(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function artifactPathForUrl(root: string, url: string) {
  const pathname = url.split('?')[0] ?? ''
  if (!pathname.startsWith('/data/')) throw new Error(`Invalid public artifact URL: ${url}`)
  const path = resolve(root, pathname.slice('/data/'.length))
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Public artifact URL escapes its root: ${url}`)
  return path
}

function assertSameGeneration(reference: MatchIndex, candidate: MatchCatalog | MatchPage, label: string) {
  if (candidate.schemaVersion !== reference.schemaVersion
    || candidate.modelVersion !== reference.modelVersion
    || candidate.modelConfigHash !== reference.modelConfigHash
    || candidate.artifactMeta.runId !== reference.artifactMeta.runId
    || candidate.artifactMeta.generatedAt !== reference.artifactMeta.generatedAt) {
    throw new Error(`Match-history ${label} generation/model/schema provenance mismatch`)
  }
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
