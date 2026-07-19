import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { replaceDirectory } from '../scripts/replace-directory.ts'

test('directory promotion falls back to atomic file replacement across filesystems', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-directory-publish-'))
  const target = join(root, 'public-data')
  const next = join(root, 'public-data-next')

  try {
    await mkdir(join(target, 'scopes'), { recursive: true })
    await mkdir(join(next, 'scopes'), { recursive: true })
    await writeFile(join(target, 'ranking-summary.json'), 'old manifest')
    await writeFile(join(target, 'scopes', 'all.json'), 'old shard')
    await writeFile(join(next, 'ranking-summary.json'), 'new manifest')
    await writeFile(join(next, 'scopes', 'all.json'), 'new shard')

    const crossDeviceRename = async () => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    }
    await replaceDirectory(next, target, {
      publishLast: 'ranking-summary.json',
      renameDirectory: crossDeviceRename,
    })

    assert.equal(await readFile(join(target, 'scopes', 'all.json'), 'utf8'), 'new shard')
    assert.equal(await readFile(join(target, 'ranking-summary.json'), 'utf8'), 'new manifest')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('in-place publication preserves the watched directory and removes stale files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-directory-in-place-'))
  const target = join(root, 'public-data')
  const next = join(root, 'public-data-next')

  try {
    await mkdir(join(target, 'scopes'), { recursive: true })
    await mkdir(join(next, 'scopes'), { recursive: true })
    await writeFile(join(target, 'ranking-summary.json'), 'old manifest')
    await writeFile(join(target, 'scopes', 'stale.json'), 'stale shard')
    await writeFile(join(next, 'ranking-summary.json'), 'new manifest')
    await writeFile(join(next, 'scopes', 'all.json'), 'new shard')

    await replaceDirectory(next, target, {
      publishLast: 'ranking-summary.json',
      preserveTarget: true,
    })

    assert.equal(await readFile(join(target, 'scopes', 'all.json'), 'utf8'), 'new shard')
    assert.equal(await readFile(join(target, 'ranking-summary.json'), 'utf8'), 'new manifest')
    await assert.rejects(readFile(join(target, 'scopes', 'stale.json'), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('filtered in-place publication retains declared reused files and removes only stale files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-directory-filtered-'))
  const target = join(root, 'public-data')
  const next = join(root, 'public-data-next')

  try {
    await mkdir(join(target, 'scopes'), { recursive: true })
    await mkdir(join(next, 'scopes'), { recursive: true })
    await writeFile(join(target, 'ranking-summary.json'), 'old manifest')
    await writeFile(join(target, 'scopes', 'all.json'), 'reused shard')
    await writeFile(join(target, 'scopes', 'stale.json'), 'stale shard')
    await writeFile(join(next, 'ranking-summary.json'), 'new manifest')

    await replaceDirectory(next, target, {
      publishLast: 'ranking-summary.json',
      preserveTarget: true,
      expectedFiles: ['ranking-summary.json', 'scopes/all.json'],
    })

    assert.equal(await readFile(join(target, 'scopes', 'all.json'), 'utf8'), 'reused shard')
    assert.equal(await readFile(join(target, 'ranking-summary.json'), 'utf8'), 'new manifest')
    await assert.rejects(readFile(join(target, 'scopes', 'stale.json'), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materialized publication rolls back after the target is evacuated and the final rename fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-directory-rollback-'))
  const target = join(root, 'public-data')
  const next = join(root, 'public-data-next')
  try {
    await mkdir(join(target, 'scopes'), { recursive: true })
    await mkdir(join(next, 'scopes'), { recursive: true })
    await writeFile(join(target, 'ranking-summary.json'), 'old manifest')
    await writeFile(join(target, 'scopes', 'all.json'), 'old shard')
    await writeFile(join(next, 'ranking-summary.json'), 'new manifest')
    await writeFile(join(next, 'scopes', 'all.json'), 'new shard')
    let renameCalls = 0
    const failSecondRename: typeof rename = async (oldPath, newPath) => {
      renameCalls += 1
      if (renameCalls === 2) throw Object.assign(new Error('injected final swap failure'), { code: 'EIO' })
      await rename(oldPath, newPath)
    }

    await assert.rejects(replaceDirectory(next, target, {
      preserveTarget: true,
      expectedFiles: ['ranking-summary.json', 'scopes/all.json'],
      renameDirectory: failSecondRename,
    }), /injected final swap failure/)

    assert.equal(renameCalls, 3)
    assert.equal(await readFile(join(target, 'ranking-summary.json'), 'utf8'), 'old manifest')
    assert.equal(await readFile(join(target, 'scopes', 'all.json'), 'utf8'), 'old shard')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('empty preserve publication is a target no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-directory-noop-'))
  const target = join(root, 'public-data')
  const next = join(root, 'public-data-next')
  try {
    await mkdir(target, { recursive: true })
    await mkdir(next, { recursive: true })
    await writeFile(join(target, 'ranking-summary.json'), 'unchanged')
    let renameCalls = 0
    await replaceDirectory(next, target, {
      preserveTarget: true,
      renameDirectory: async (oldPath, newPath) => {
        renameCalls += 1
        await rename(oldPath, newPath)
      },
    })
    assert.equal(renameCalls, 0)
    assert.equal(await readFile(join(target, 'ranking-summary.json'), 'utf8'), 'unchanged')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
