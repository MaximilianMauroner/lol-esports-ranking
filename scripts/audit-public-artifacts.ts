import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareSemanticArtifact } from './public-artifact-storage.mjs'

export async function auditPublicArtifacts(root: string) {
  const artifacts: Array<{ path: string; family: string; year: string; logicalBytes: number; storedBytes: number; nodeCount: number; largestNodeBytes: number }> = []
  async function visit(directory: string, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) { await visit(join(directory, entry.name), `${path}/`); continue }
      if (!entry.name.endsWith('.json')) continue
      const bytes = await readFile(join(directory, entry.name))
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      const prepared = prepareSemanticArtifact(value)
      const nodes = [...(prepared.children ?? []), prepared]
      const match = /(?:^|[-/])(\d{4})(?:[-/.]|$)/.exec(path)
      artifacts.push({ path, family: path.split('/')[0], year: match?.[1] ?? 'shared', logicalBytes: bytes.byteLength,
        storedBytes: nodes.reduce((sum, node) => sum + node.compressedBytes, 0), nodeCount: nodes.length,
        largestNodeBytes: Math.max(...nodes.map((node) => node.bytes)) })
    }
  }
  await visit(resolve(root))
  const byFamily: Record<string, number> = {}, byYear: Record<string, number> = {}
  for (const artifact of artifacts) {
    byFamily[artifact.family] = (byFamily[artifact.family] ?? 0) + artifact.logicalBytes
    byYear[artifact.year] = (byYear[artifact.year] ?? 0) + artifact.logicalBytes
  }
  return { kind: 'local-public-artifact-size-audit', officialProductionEvidence: false, artifactCount: artifacts.length,
    logicalBytes: artifacts.reduce((sum, entry) => sum + entry.logicalBytes, 0), byFamily, byYear,
    storedBytesBeforeDeduplication: artifacts.reduce((sum, entry) => sum + entry.storedBytes, 0),
    nodeCountBeforeDeduplication: artifacts.reduce((sum, entry) => sum + entry.nodeCount, 0),
    largest: artifacts.toSorted((a, b) => b.largestNodeBytes - a.largestNodeBytes).slice(0, 10),
    peakProcessRssBytes: process.resourceUsage().maxRSS * 1024 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await auditPublicArtifacts(process.argv[2] ?? 'public/data'), null, 2)}\n`)
}
