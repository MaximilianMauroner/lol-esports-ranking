import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { inspector, sha } from './source-guards.mjs'
const [directory, phase, receiptPath] = process.argv.slice(2)
assert.equal(process.argv.length, 5)
assert.ok([directory, receiptPath].every(isAbsolute))
assert.ok(['before', 'after'].includes(phase))
assert.equal(realpathSync(dirname(directory)), dirname(directory))
assert.equal(realpathSync(dirname(receiptPath)), dirname(receiptPath))
assert.ok(!existsSync(receiptPath) && !existsSync(`${receiptPath}.stdout`) && !existsSync(`${receiptPath}.stderr`))
assert.equal(sha(readFileSync(inspector.path)), inspector.sha256)
const command = ['python3', inspector.path, directory, phase]
const startedAt = new Date().toISOString()
const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
const endedAt = new Date().toISOString()
writeFileSync(`${receiptPath}.stdout`, result.stdout ?? '', { flag: 'wx', mode: 0o600 })
writeFileSync(`${receiptPath}.stderr`, result.stderr ?? '', { flag: 'wx', mode: 0o600 })
writeFileSync(receiptPath, JSON.stringify({ command, inspector, startedAt, endedAt, exitCode: result.status, signal: result.signal, spawnError: result.error ? String(result.error) : null, basis: 'Actual spawnSync status and signal of the pinned canonical command. No result inferred.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
process.exitCode = result.error || result.signal || result.status !== 0 ? result.status || 1 : 0
