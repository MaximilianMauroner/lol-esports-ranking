import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

// Frozen Node reference corpus for artifact regression tests and the performance
// gate. Current rankings are produced by data:crunch or served from the bucket.
const referenceCommit = '8adbc0a4239fd0dfba2094b3e70f60b513560de4'
const referenceDigest = '873eb6c5d35b1f43f83e9f248bd53090be9c99932a13bef5079396c18075fc0c'
const root = fileURLToPath(new URL('..', import.meta.url))
export const referencePublicDir = join(root, 'data/reference', referenceCommit, 'public')
export const referencePublicDataDir = join(referencePublicDir, 'data')
const exec = promisify(execFile)

export async function ensureReferencePublicData() {
  try {
    await verifyReferencePublicData(referencePublicDataDir)
    return referencePublicDataDir
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  await mkdir(dirname(referencePublicDir), { recursive: true })
  const staging = await mkdtemp(join(dirname(referencePublicDir), '.download-'))
  try {
    const url = `https://codeload.github.com/MaximilianMauroner/lol-esports-ranking/tar.gz/${referenceCommit}`
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) throw new Error(`Reference data download failed: HTTP ${response.status}`)
    const archive = join(staging, 'reference.tar.gz')
    await pipeline(response.body, createWriteStream(archive))
    await exec('tar', ['-xzf', archive, '-C', staging, '--strip-components=2', `lol-esports-ranking-${referenceCommit}/public/data`])
    await verifyReferencePublicData(join(staging, 'data'))
    await mkdir(referencePublicDir, { recursive: true })
    await rename(join(staging, 'data'), referencePublicDataDir)
    return referencePublicDataDir
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function verifyReferencePublicData(directory) {
  const files = await jsonPaths(directory)
  const digest = createHash('sha256')
  for (const path of files.sort()) {
    digest.update(path).update('\0').update(createHash('sha256').update(await readFile(join(directory, path))).digest())
  }
  if (digest.digest('hex') !== referenceDigest) {
    throw new Error(`Reference data checksum mismatch: remove ${directory} and download it again`)
  }
}

async function jsonPaths(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await jsonPaths(directory, path))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
    else throw new Error(`Unexpected reference data entry: ${path}`)
  }
  return files
}
