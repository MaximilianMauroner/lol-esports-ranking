import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function sourceIdentity(root, expectedHead, expectedTree) {
  assert.ok(isAbsolute(root), 'one explicit absolute source root is required')
  assert.equal(realpathSync(root), root, 'source root must be canonical')
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd()
  assert.equal(git('rev-parse', '--show-toplevel'), root)
  assert.match(expectedHead, /^[a-f0-9]{40}$/)
  assert.match(expectedTree, /^[a-f0-9]{40}$/)
  assert.equal(git('rev-parse', 'HEAD'), expectedHead, 'exact released head')
  assert.equal(git('rev-parse', 'HEAD^{tree}'), expectedTree, 'exact released tree')
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'clean tracked state')
  const relevant = (file) => /^(src|scripts|tests|public|\.github)\//.test(file) || !file.includes('/')
  const extra = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter((file) => file && relevant(file))
  assert.deepEqual(extra, [], 'no untracked product or config files')
  assert.ok(lstatSync(join(root, 'node_modules')).isDirectory(), 'source root must own its node_modules directory')
  assert.equal(realpathSync(join(root, 'node_modules')), join(root, 'node_modules'), 'no shared whole node_modules link')
  if (existsSync(join(root, 'node_modules/.vite'))) assert.equal(realpathSync(join(root, 'node_modules/.vite')), join(root, 'node_modules/.vite'), 'no shared Vite cache link')
  const hashAlgorithm = git('rev-parse', '--show-object-format')
  const sources = {}
  for (const record of git('ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean)) {
    const [header, file] = record.split('\t')
    if (!relevant(file)) continue
    const [mode, kind, blob] = header.split(' ')
    assert.ok(kind === 'blob' && mode !== '120000', `regular tracked file required: ${file}`)
    assert.equal(realpathSync(join(root, file)), join(root, file), `no source parent symlink: ${file}`)
    assert.ok(lstatSync(join(root, file)).isFile(), `no source symlink: ${file}`)
    const body = readFileSync(join(root, file))
    const actualBlob = createHash(hashAlgorithm).update(`blob ${body.length}\0`).update(body).digest('hex')
    assert.equal(actualBlob, blob, `exact committed bytes: ${file}`)
    sources[file] = { gitBlob: blob, sha256: createHash('sha256').update(body).digest('hex') }
  }
  const dependencyLock = readFileSync(join(root, 'node_modules/.pnpm/lock.yaml'))
  const installedLockSha256 = createHash('sha256').update(dependencyLock).digest('hex')
  assert.equal(installedLockSha256, '3887d73689714304614674614fd51bd5c62f5f704050a5ca7dea4f4b8fc9c0e9', 'released installed lock identity')
  return { root, head: expectedHead, tree: expectedTree, commonDir: git('rev-parse', '--path-format=absolute', '--git-common-dir'), installedLockSha256, sharedStoreRealpath: realpathSync(join(root, 'node_modules/.pnpm')), ignoredPublicData: { path: join(root, 'public/data'), exists: existsSync(join(root, 'public/data')) }, sources }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, head, tree, output] = process.argv.slice(2)
  writeFileSync(output, JSON.stringify(sourceIdentity(root, head, tree), null, 2) + '\n', { flag: 'wx' })
}
