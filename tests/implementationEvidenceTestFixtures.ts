import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  IMPLEMENTATION_EVIDENCE_CONTRACTS,
  IMPLEMENTATION_EVIDENCE_REQUIREMENTS,
  generateImplementationEvidence,
} from '../scripts/rollout-implementation-evidence.mjs'

const exec = promisify(execFile)

export async function createImplementationRepositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'implementation-evidence-'))
  const { stdout: tracked } = await exec('git', ['ls-files'], { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 })
  const paths = [...new Set([
    ...tracked.trim().split('\n').filter(Boolean),
    ...IMPLEMENTATION_EVIDENCE_REQUIREMENTS.flatMap(
    (id) => IMPLEMENTATION_EVIDENCE_CONTRACTS[id].sourcePaths,
    ),
  ])]
  for (const path of paths) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(new URL(`../${path}`, import.meta.url), target)
  }
  await symlink(resolve(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')
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
