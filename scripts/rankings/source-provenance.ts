import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function rankingSourceProvenance(root: string, gitRoot = root) {
  const paths = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: gitRoot, encoding: 'utf8' })
    .split('\0').filter(path => /^(src|scripts|tools)\/.*\.(ts|tsx|mjs|js|json)$/.test(path)
      || /^(package\.json|tsconfig.*\.json)$/.test(path))
  const sourceDigests = await Promise.all([...new Set(paths)].sort().map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })))
  return { sourceDigests, sourceHash: createHash('sha256').update(JSON.stringify(sourceDigests)).digest('hex') }
}
