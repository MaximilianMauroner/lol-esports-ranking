import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { canonicalPublicLogicalPath, prepareSemanticArtifact } from './public-artifact-storage.mjs'

export async function materializePublicArtifactPatch(publicDataDir, patch, {
  move = rename,
  remove = rm,
} = {}) {
  const root = resolve(publicDataDir)
  const staging = `${root}.patch-${process.pid}-${Date.now()}`
  const backup = `${root}.previous-${process.pid}-${Date.now()}`
  const changed = new Map()
  for (const entry of patch.changedArtifacts ?? []) {
    const logicalPath = canonicalPublicLogicalPath(entry.logicalPath)
    if (changed.has(logicalPath)) throw new Error(`Duplicate local public artifact patch path: ${logicalPath}`)
    changed.set(logicalPath, entry.value)
  }
  if (!changed.has('/data/ranking-summary.json')) {
    throw new Error('Local public artifact patch requires ranking-summary.json')
  }
  const expected = [...new Set((patch.expectedLogicalPaths ?? []).map(canonicalPublicLogicalPath))].sort()
  if (!expected.length || !expected.includes('/data/ranking-summary.json')) {
    throw new Error('Local public artifact patch requires a complete expected mapping')
  }
  const previous = patch.previousManifest?.artifacts
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new Error('Local public artifact patch requires a previous generation manifest')
  }
  const removed = new Set((patch.removedLogicalPaths ?? []).map(canonicalPublicLogicalPath))
  const composed = [...new Set([
    ...Object.keys(previous).map(canonicalPublicLogicalPath).filter((logicalPath) => !removed.has(logicalPath) && !changed.has(logicalPath)),
    ...changed.keys(),
  ])].sort()
  if (composed.join('\0') !== expected.join('\0')) {
    throw new Error('Local public artifact patch mapping is not exhaustive')
  }

  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    const mapping = {}
    for (const logicalPath of expected) {
      const relativePath = localRelativePath(logicalPath)
      const value = changed.has(logicalPath)
        ? changed.get(logicalPath)
        : await readVerifiedLocalArtifact(root, logicalPath, previous[logicalPath])
      const prepared = prepareSemanticArtifact(value)
      mapping[logicalPath] = { sha256: prepared.digest, bytes: prepared.bytes }
      if (logicalPath === '/data/ranking-summary.json') continue
      const output = join(staging, relativePath)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify(value)}\n`)
    }
    const rootValue = changed.get('/data/ranking-summary.json')
    await writeFile(join(staging, 'ranking-summary.json'), `${JSON.stringify(rootValue)}\n`)

    let movedPrevious = false
    try {
      await move(root, backup)
      movedPrevious = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await move(staging, root)
      let cleanupWarning
      if (movedPrevious) {
        try {
          await remove(backup, { recursive: true, force: true })
        } catch (error) {
          cleanupWarning = {
            stage: 'backup-cleanup',
            message: error instanceof Error ? error.message : String(error),
            backupPath: backup,
          }
        }
      }
      return {
        materialized: true,
        logicalArtifactCount: expected.length,
        mapping,
        ...(cleanupWarning ? { cleanupWarning } : {}),
      }
    } catch (error) {
      if (movedPrevious) {
        try {
          await move(backup, root)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Local public artifact swap failed and rollback requires inspection',
            { cause: rollbackError },
          )
        }
      }
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function readVerifiedLocalArtifact(root, logicalPath, identity) {
  if (!identity || typeof identity !== 'object' || identity.logicalPath !== logicalPath
    || !/^[a-f0-9]{64}$/.test(identity.sha256 ?? '')
    || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) {
    throw new Error(`Local reused public artifact mapping is invalid: ${logicalPath}`)
  }
  let value
  try {
    value = JSON.parse(await readFile(join(root, localRelativePath(logicalPath)), 'utf8'))
  } catch (error) {
    throw new Error(`Local reused public artifact is missing or unreadable: ${logicalPath}`, { cause: error })
  }
  const prepared = prepareSemanticArtifact(value)
  if (prepared.digest !== identity.sha256 || prepared.bytes !== identity.bytes) {
    throw new Error(`Local reused public artifact authority mismatch: ${logicalPath}`)
  }
  return value
}

function localRelativePath(logicalPath) {
  const canonical = canonicalPublicLogicalPath(logicalPath)
  return canonical.slice('/data/'.length)
}
