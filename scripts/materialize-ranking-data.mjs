import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const sourceDir = resolve(process.env.RANKING_GENERATED_DATA_DIR ?? '.generated/ranking-data')
const destinationDir = resolve(process.env.RANKING_STATIC_DATA_DIR ?? 'public/data')
const manifest = await readJson(resolve(sourceDir, 'ranking-summary.json'))
if (manifest?.artifactKind !== 'public-ranking-manifest' || !manifest?.artifactMeta?.runId) {
  throw new Error('Generated ranking manifest is missing valid public artifact provenance')
}
const references = new Set(['ranking-summary.json'])
collectDataReferences(manifest, references)
for (const relativePath of [...references].sort()) {
  const path = safeResolve(sourceDir, relativePath)
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a file')
    if (relativePath.endsWith('.json')) await readJson(path)
  } catch (error) {
    throw new Error(`Referenced ranking artifact is unavailable or invalid: ${relativePath}`, { cause: error })
  }
}
await rm(destinationDir, { recursive: true, force: true })
await mkdir(dirname(destinationDir), { recursive: true })
await cp(sourceDir, destinationDir, { recursive: true, force: false, errorOnExist: false })
console.log(`Materialized ${references.size} validated ranking artifacts from ${sourceDir} to ${destinationDir}`)

function collectDataReferences(value, output) {
  if (Array.isArray(value)) {
    for (const entry of value) collectDataReferences(entry, output)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const entry of Object.values(value)) {
    if (typeof entry === 'string' && entry.startsWith('/data/')) {
      output.add(decodeURIComponent(entry.slice('/data/'.length).split('?', 1)[0]))
    } else collectDataReferences(entry, output)
  }
}

function safeResolve(root, relativePath) {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid ranking artifact path: ${relativePath}`)
  }
  const path = resolve(root, relativePath)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Ranking artifact escapes source directory: ${relativePath}`)
  return path
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
