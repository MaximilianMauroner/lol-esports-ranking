import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  IMPLEMENTATION_EVIDENCE_CONTRACTS,
  IMPLEMENTATION_EVIDENCE_REQUIREMENTS,
  generateImplementationEvidence,
} from '../scripts/rollout-implementation-evidence.mjs'

const exec = promisify(execFile)

const ARCHIVE_DISCOVERY_EXCLUSIONS = new Set([
  '.cache',
  '.git',
  '.rollout-evidence',
  '.vite',
  'coverage',
  'dist',
  'dist-ssr',
  'logs',
  'node_modules',
])

interface ImplementationRepositoryFixtureOptions {
  sourceRoot?: string
  nodeModulesRoot?: string
}

export async function createImplementationRepositoryFixture({
  sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url))),
  nodeModulesRoot = resolve(sourceRoot, 'node_modules'),
}: ImplementationRepositoryFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'implementation-evidence-'))
  const discoveredPaths = await discoverRepositorySourcePaths(sourceRoot)
  const paths = [...new Set([
    ...discoveredPaths,
    ...IMPLEMENTATION_EVIDENCE_REQUIREMENTS.flatMap(
      (id) => IMPLEMENTATION_EVIDENCE_CONTRACTS[id].sourcePaths,
    ),
  ])]
  for (const path of paths) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(sourceRoot, path), target)
  }
  await symlink(nodeModulesRoot, join(root, 'node_modules'), 'dir')
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
  return {
    root: resolve(root),
    commit: stdout.trim(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function discoverRepositorySourcePaths(sourceRoot: string) {
  try {
    const [{ stdout: tracked }, { stdout: deleted }] = await Promise.all([
      exec('git', ['ls-files'], { cwd: sourceRoot, maxBuffer: 10 * 1024 * 1024 }),
      exec('git', ['ls-files', '--deleted'], { cwd: sourceRoot, maxBuffer: 10 * 1024 * 1024 }),
    ])
    const deletedPaths = new Set(lines(deleted))
    return lines(tracked).filter((path) => !deletedPaths.has(path))
  } catch {
    return discoverArchiveSourcePaths(sourceRoot)
  }
}

async function discoverArchiveSourcePaths(sourceRoot: string) {
  const paths: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(sourceRoot, absolutePath)
      if (excludeArchiveEntry(relativePath, entry.isDirectory())) continue
      if (entry.isDirectory()) {
        await visit(absolutePath)
      } else if (entry.isFile()) {
        paths.push(relativePath)
      }
    }
  }
  await visit(sourceRoot)
  return paths
}

function excludeArchiveEntry(relativePath: string, isDirectory: boolean) {
  const normalized = relativePath.split(sep).join('/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (ARCHIVE_DISCOVERY_EXCLUSIONS.has(name)) return true
  if (name === '.env' || name.startsWith('.env.')) return true
  if (normalized === 'data/derived' || normalized.startsWith('data/derived/')) return true
  if (normalized.startsWith('data/raw/') && normalized !== 'data/raw/manifest.json') return true
  if (!isDirectory && normalized.startsWith('data/')
    && /\.(?:csv|jsonl|ndjson|parquet|sqlite|db)$/u.test(normalized)) return true
  if (!isDirectory && normalized.startsWith('public/data/')
    && (normalized.endsWith('.tmp') || /(?:^|\/)ranking-snapshot(?:\.full)?\.json$/u.test(normalized))) return true
  if (!isDirectory && (name.endsWith('.local') || name.endsWith('.log'))) return true
  if (normalized === 'lol-ranking-dev-current-branch.png') return true
  return false
}

function lines(value: string) {
  return value.trim().split('\n').filter(Boolean)
}

export function passingImplementationCommand() {
  return Promise.resolve({ exitCode: 0, passed: 1, failed: 0, cancelled: 0 })
}

export function generatePassingImplementationEvidence(repositoryRoot: string, subjectCommit: string) {
  return generateImplementationEvidence({
    repositoryRoot,
    subjectCommit,
    runCommand: passingImplementationCommand,
  })
}

export function generateNativeImplementationEvidence(repositoryRoot: string, subjectCommit: string) {
  return generateImplementationEvidence({ repositoryRoot, subjectCommit })
}
