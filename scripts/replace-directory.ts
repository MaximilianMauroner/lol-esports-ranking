import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

type ReplaceDirectoryOptions = {
  publishLast?: string
  renameDirectory?: typeof rename
}

export async function replaceDirectory(
  nextDir: string,
  targetDir: string,
  { publishLast, renameDirectory = rename }: ReplaceDirectoryOptions = {},
) {
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
  const root = resolve(nextDir)
  const files = await listFiles(root)
  if (publishLast) {
    files.sort((left, right) => Number(relativePath(root, left) === publishLast) - Number(relativePath(root, right) === publishLast))
  }

  for (const [index, source] of files.entries()) {
    const target = resolve(targetDir, relative(root, source))
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

  await rm(nextDir, { recursive: true, force: true })
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
