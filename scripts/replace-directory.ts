import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

type ReplaceDirectoryOptions = {
  publishLast?: string
  preserveTarget?: boolean
  expectedFiles?: readonly string[]
  renameDirectory?: typeof rename
  copyFileOperation?: typeof copyFile
}

export async function replaceDirectory(
  nextDir: string,
  targetDir: string,
  {
    publishLast,
    preserveTarget = false,
    expectedFiles,
    renameDirectory = rename,
    copyFileOperation = copyFile,
  }: ReplaceDirectoryOptions = {},
) {
  if (preserveTarget) {
    await publishMaterialized(nextDir, targetDir, {
      publishLast,
      expectedFiles,
      renameDirectory,
      copyFileOperation,
    })
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
      await publishMaterialized(nextDir, targetDir, { publishLast })
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

async function publishMaterialized(
  nextDir: string,
  targetDir: string,
  {
    publishLast,
    expectedFiles,
    renameDirectory = rename,
    copyFileOperation = copyFile,
  }: Pick<ReplaceDirectoryOptions, 'publishLast' | 'expectedFiles' | 'renameDirectory' | 'copyFileOperation'>,
) {
  const root = resolve(nextDir)
  const files = await listFiles(root)
  const targetRoot = resolve(targetDir)
  const previousFiles = await listFilesIfPresent(targetRoot)
  const previousByPath = new Map(previousFiles.map((file) => [relativePath(targetRoot, file), file]))
  const stagedByPath = new Map(files.map((file) => [relativePath(root, file), file]))
  const finalRelativePaths = new Set(expectedFiles ?? stagedByPath.keys())
  for (const expected of finalRelativePaths) {
    if (!stagedByPath.has(expected) && !previousByPath.has(expected)) {
      throw new Error(`Cannot publish incomplete directory: missing expected file ${expected}`)
    }
  }

  if (files.length === 0 && expectedFiles === undefined) {
    await rm(nextDir, { recursive: true, force: true })
    return
  }

  const materializedDir = `${targetDir}.materialized-${process.pid}`
  const previousDir = `${targetDir}.previous-${process.pid}`
  await rm(materializedDir, { recursive: true, force: true })
  await rm(previousDir, { recursive: true, force: true })
  const orderedPaths = [...finalRelativePaths].sort((left, right) => {
    if (left === publishLast) return 1
    if (right === publishLast) return -1
    return left.localeCompare(right)
  })
  try {
    for (const relativePath of orderedPaths) {
      const source = stagedByPath.get(relativePath) ?? previousByPath.get(relativePath)
      if (!source) throw new Error(`Cannot materialize missing file ${relativePath}`)
      const destination = resolve(materializedDir, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await copyFileOperation(source, destination)
    }

    let hasPrevious = false
    try {
      await renameDirectory(targetDir, previousDir)
      hasPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await renameDirectory(materializedDir, targetDir)
    } catch (error) {
      if (hasPrevious) await renameDirectory(previousDir, targetDir)
      throw error
    }
    if (hasPrevious) await rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(nextDir, { recursive: true, force: true })
  } catch (error) {
    await rm(materializedDir, { recursive: true, force: true })
    throw error
  }
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
