import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export async function assertExternalShadowParity({
  expectedSnapshot,
  actualSnapshot,
  expectedPublicDir,
  actualPublicWrites,
}: {
  expectedSnapshot: string
  actualSnapshot: string
  expectedPublicDir: string
  actualPublicWrites: Array<{ relativePath: string; contents: string }>
}) {
  await assertFilesEqual(expectedSnapshot, actualSnapshot, 'full-snapshot')
  const expectedPaths = await directoryFilePaths(expectedPublicDir)
  const actualPaths = actualPublicWrites.map((write) => write.relativePath).toSorted()
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error(`Public artifact path mismatch (${expectedPaths.length} reference != ${actualPaths.length} incremental)`)
  }
  const actualByPath = new Map(actualPublicWrites.map((write) => [write.relativePath, write.contents]))
  for (const relativePath of expectedPaths) {
    const contents = actualByPath.get(relativePath)
    if (contents === undefined) throw new Error(`Incremental public artifact is missing ${relativePath}`)
    const expected = await fileDigest(resolve(expectedPublicDir, relativePath))
    const actual = createHash('sha256').update(contents).digest('hex')
    if (expected.digest !== actual || expected.bytes !== Buffer.byteLength(contents)) {
      throw new Error(`Public artifact mismatch: ${relativePath}`)
    }
  }
}

async function assertFilesEqual(expected: string, actual: string, label: string) {
  const [expectedDigest, actualDigest] = await Promise.all([fileDigest(expected), fileDigest(actual)])
  if (expectedDigest.bytes !== actualDigest.bytes || expectedDigest.digest !== actualDigest.digest) {
    throw new Error(`${label} mismatch`)
  }
}

async function fileDigest(path: string) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { digest: hash.digest('hex'), bytes }
}

async function directoryFilePaths(root: string, current = root): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name)
    if (entry.isDirectory()) paths.push(...await directoryFilePaths(root, path))
    else if (entry.isFile()) paths.push(relative(root, path).split(sep).join('/'))
  }
  return paths.toSorted()
}
