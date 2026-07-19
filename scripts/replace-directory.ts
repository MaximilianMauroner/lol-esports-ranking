import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

type ReplaceDirectoryOptions = {
  publishLast?: string
  preserveTarget?: boolean
  expectedFiles?: readonly string[]
  renameDirectory?: typeof rename
}

export async function replaceDirectory(
  nextDir: string,
  targetDir: string,
  { publishLast, preserveTarget = false, expectedFiles, renameDirectory = rename }: ReplaceDirectoryOptions = {},
) {
  if (preserveTarget) {
    await publishInPlace(nextDir, targetDir, publishLast, expectedFiles)
    return
  }

  const previousDir = `${targetDir}.previous-${process.pid}`
  await rm(previousDir, { recursive: true, force: true })
  let hasPrevious = false

  try {
    await renameDirectory(targetDir, previousDir)
    hasPrevious = true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      await publishAcrossFilesystems(nextDir, targetDir, publishLast)
      return
    }
    if (code !== 'ENOENT') throw error
  }

  try {
    await renameDirectory(nextDir, targetDir)
  } catch (error) {
    if (hasPrevious) await renameDirectory(previousDir, targetDir)
    throw error
  }

  if (hasPrevious) await rm(previousDir, { recursive: true, force: true })
}

async function publishAcrossFilesystems(nextDir: string, targetDir: string, publishLast?: string) {
  await publishInPlace(nextDir, targetDir, publishLast)
}

async function publishInPlace(nextDir: string, targetDir: string, publishLast?: string, expectedFiles?: readonly string[]) {
  const root = resolve(nextDir)
  const files = await listFiles(root)
  const targetRoot = resolve(targetDir)
  const previousFiles = await listFilesIfPresent(targetRoot)
  const previousRelativePaths = new Set(previousFiles.map((file) => relativePath(targetRoot, file)))
  const stagedRelativePaths = new Set(files.map((file) => relativePath(root, file)))
  const finalRelativePaths = new Set(expectedFiles ?? stagedRelativePaths)
  for (const expected of finalRelativePaths) {
    if (!stagedRelativePaths.has(expected) && !previousRelativePaths.has(expected)) {
      throw new Error(`Cannot publish incomplete directory: missing expected file ${expected}`)
    }
  }

  const publishFile = async (source: string, index: number) => {
    const target = resolve(targetRoot, relative(root, source))
    const temp = `${target}.${process.pid}.${index}.tmp`
    await mkdir(dirname(target), { recursive: true })
    try {
      await copyFile(source, temp)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  const publishLastSource = publishLast
    ? files.find((file) => relativePath(root, file) === publishLast)
    : undefined
  const ordinaryFiles = publishLastSource ? files.filter((file) => file !== publishLastSource) : files
  for (const [index, source] of ordinaryFiles.entries()) await publishFile(source, index)

  for (const previousFile of previousFiles) {
    if (!finalRelativePaths.has(relativePath(targetRoot, previousFile))) {
      await rm(previousFile, { force: true })
    }
  }
  if (publishLastSource) await publishFile(publishLastSource, ordinaryFiles.length)
  await rm(nextDir, { recursive: true, force: true })
}

async function listFilesIfPresent(dir: string): Promise<string[]> {
  try {
    return await listFiles(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function relativePath(root: string, path: string) {
  return relative(root, path).split(sep).join('/')
}
