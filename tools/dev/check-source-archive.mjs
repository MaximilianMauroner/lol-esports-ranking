import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, realpathSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { referencePublicDataDir, verifyReferencePublicData } from '../../scripts/reference-public-data.mjs'

const root = process.cwd()
const archive = resolve(process.argv[2] ?? '.agents/artifacts/source-archive')
assert.ok(archive.startsWith(`${root}/.agents/artifacts/`), 'Keep the source archive in ignored artifacts')
assert.ok(!existsSync(archive), 'Use a fresh source archive')
await verifyReferencePublicData(referencePublicDataDir)
mkdirSync(archive, { recursive: true })
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const file of files) {
  if (!existsSync(resolve(file))) continue
  mkdirSync(dirname(resolve(archive, file)), { recursive: true })
  cpSync(resolve(file), resolve(archive, file))
}
assert.equal(existsSync(resolve(archive, '.git')), false)
assert.equal(existsSync(resolve(archive, 'node_modules')), false)
mkdirSync(resolve(archive, 'data'), { recursive: true })
cpSync(resolve('data/reference'), resolve(archive, 'data/reference'), { recursive: true })
const env = { ...process.env, GIT_CEILING_DIRECTORIES: root }
execFileSync('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: archive, stdio: 'inherit', env })
const require = createRequire(pathToFileURL(resolve(archive, 'package.json')))
for (const name of ['react', 'typescript', 'vite', 'tsx']) {
  const path = realpathSync(require.resolve(name))
  assert.ok(path.startsWith(`${archive}/node_modules/`), `${name} resolves inside the archive: ${path}`)
}
function checkLinks(directory) {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry)
    if (lstatSync(path).isSymbolicLink()) {
      const target = realpathSync(path)
      const local = relative(archive, target)
      assert.ok(!local.startsWith('..') && !isAbsolute(local), `Archive dependency escapes: ${path} -> ${target}`)
    } else if (lstatSync(path).isDirectory()) checkLinks(path)
  }
}
checkLinks(resolve(archive, 'node_modules'))
for (const [command, args] of [
  [process.execPath, ['tools/dev/check-dependencies.mjs']],
  ['pnpm', ['run', 'railway:build']],
]) {
  console.log('Running without Git metadata', command, ...args)
  execFileSync(command, args, { cwd: archive, stdio: 'inherit', env })
}
