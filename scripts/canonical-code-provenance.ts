import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex, stableHash } from '../src/lib/incremental/hash.ts'

const DEFAULT_SCRIPT_PATHS = [
  'scripts/build-static-snapshot.ts',
  'scripts/canonical-code-provenance.ts',
  'scripts/incremental-provider-state.ts',
]

export async function canonicalCodeProvenanceHash({
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  scriptPaths = DEFAULT_SCRIPT_PATHS,
}: {
  repositoryRoot?: string
  scriptPaths?: string[]
} = {}): Promise<string> {
  const sourcePaths = await typeScriptFiles(resolve(repositoryRoot, 'src'))
  const paths = [...sourcePaths, ...scriptPaths.map((path) => resolve(repositoryRoot, path))]
    .map((path) => resolve(path))
    .toSorted((left, right) => portableRelative(repositoryRoot, left).localeCompare(portableRelative(repositoryRoot, right)))
  const entries = await Promise.all(paths.map(async (path) => ({
    path: portableRelative(repositoryRoot, path),
    contentHash: sha256Hex(await readFile(path, 'utf8')),
  })))
  return stableHash(entries)
}

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return typeScriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  }))
  return files.flat()
}

function portableRelative(root: string, path: string) {
  return relative(root, path).split(sep).join('/')
}
