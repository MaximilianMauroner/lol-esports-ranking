import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type ScoredSnapshot = {
  fetchedAt?: string
  start?: string
  end?: string
  matches?: Array<{ id?: string; date?: string; teamA?: string; teamB?: string; winner?: string }>
}

type FreshnessManifest = {
  files?: { leaguepediaJson?: string[] }
}

export type SemanticFreshnessAudit = {
  referencedCoverageEnd?: string
  latestManagedCoverageEnd?: string
  referencedRetrievalTime?: string
  latestManagedRetrievalTime?: string
  referencedDigests: string[]
  unreferencedEligibleFiles: string[]
}

export async function auditSemanticManifestFreshness(manifestPath: string): Promise<SemanticFreshnessAudit> {
  const absoluteManifestPath = resolve(manifestPath)
  const rawDir = dirname(absoluteManifestPath)
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8')) as FreshnessManifest
  const referencedPaths = new Set((manifest.files?.leaguepediaJson ?? []).map((path) => resolve(rawDir, path)))
  const managedDir = join(rawDir, 'leaguepedia')
  const managedPaths = (await readdir(managedDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^scoreboard-games-.*\.json$/i.test(entry.name))
    .map((entry) => join(managedDir, entry.name))
    .sort()
  const inventories = await Promise.all(managedPaths.map(readScoredInventory))
  const referenced = inventories.filter((entry) => referencedPaths.has(entry.path))
  const referencedDigests = new Set(referenced.map((entry) => entry.digest))
  const unreferencedEligible = inventories.filter((entry) => (
    !referencedPaths.has(entry.path)
    && entry.matchCount > 0
    && !referencedDigests.has(entry.digest)
  ))
  const referencedCoverageEnd = maximum(referenced.map((entry) => entry.coverageEnd))
  const latestManagedCoverageEnd = maximum(inventories.map((entry) => entry.coverageEnd))
  const referencedRetrievalTime = maximum(referenced.map((entry) => entry.fetchedAt))
  const latestManagedRetrievalTime = maximum(inventories.map((entry) => entry.fetchedAt))
  const drift = unreferencedEligible

  if (drift.length > 0) {
    const details = drift.map((entry) => {
      const freshness = referencedCoverageEnd && entry.coverageEnd && entry.coverageEnd <= referencedCoverageEnd
        ? 'different scored content'
        : `coverage through ${entry.coverageEnd ?? 'unknown'}`
      return `${basename(entry.path)} with ${freshness}, fetched ${entry.fetchedAt ?? 'unknown'}`
    }).join(', ')
    throw new Error(`Raw manifest omits eligible scored input: ${details}`)
  }

  return {
    referencedCoverageEnd,
    latestManagedCoverageEnd,
    referencedRetrievalTime,
    latestManagedRetrievalTime,
    referencedDigests: [...referencedDigests].sort(),
    unreferencedEligibleFiles: unreferencedEligible.map((entry) => basename(entry.path)),
  }
}

async function readScoredInventory(path: string) {
  const bytes = await readFile(path)
  const snapshot = JSON.parse(bytes.toString('utf8')) as ScoredSnapshot
  const matchDates = (snapshot.matches ?? []).map((match) => match.date).filter(isDate).sort()
  return {
    path: resolve(path),
    digest: createHash('sha256').update(bytes).digest('hex'),
    semanticDigest: createHash('sha256').update(JSON.stringify((snapshot.matches ?? []).map((match) => [
      match.id, match.date, match.teamA, match.teamB, match.winner,
    ]))).digest('hex'),
    fetchedAt: isTimestamp(snapshot.fetchedAt) ? snapshot.fetchedAt : undefined,
    coverageEnd: matchDates.at(-1) ?? (isDate(snapshot.end) ? snapshot.end : undefined),
    matchCount: snapshot.matches?.length ?? 0,
  }
}

function maximum(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)
}

function isDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
}

function isTimestamp(value: string | undefined): value is string {
  return Boolean(value && !Number.isNaN(Date.parse(value)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = process.argv[2] ?? 'data/raw/manifest.json'
  const audit = await auditSemanticManifestFreshness(manifestPath)
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`)
}
