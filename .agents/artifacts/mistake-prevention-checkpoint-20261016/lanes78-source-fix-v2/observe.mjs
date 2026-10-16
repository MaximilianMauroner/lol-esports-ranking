import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const [out, separator, command, ...args] = process.argv.slice(2)
assert.ok(isAbsolute(out) && separator === '--' && command, 'usage: <new absolute output directory> -- <command> [args]')
mkdirSync(out)
const started = new Date().toISOString()
writeFileSync(join(out, 'invocation.json'), JSON.stringify({ started, cwd: process.cwd(), command: [command, ...args], pid: process.pid }, null, 2) + '\n', { flag: 'wx' })
const fd = openSync(join(out, 'process.log'), 'wx')
const child = spawn(command, args, { stdio: ['ignore', fd, fd] })
let spawnError
child.once('error', (error) => { spawnError = String(error) })
const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
closeSync(fd)
const ended = new Date().toISOString()
const log = readFileSync(join(out, 'process.log'), 'utf8')
const excerpt = log.split('\n').filter((line) => /unit=|inner_exit=|tests |pass |fail |cancelled |skipped |todo |ERR_|AssertionError|error|failed|timeout|BLOCKED/i.test(line)).join('\n')
writeFileSync(join(out, 'count-failure-excerpt.txt'), excerpt + '\n', { flag: 'wx' })
writeFileSync(join(out, 'observed-exit.json'), JSON.stringify({ started, ended, childPid: child.pid ?? null, ...result, spawnError: spawnError ?? null, basis: 'outer observer received child close event; no test verdict is inferred' }, null, 2) + '\n', { flag: 'wx' })
const artifacts = []
function inventory(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const info = lstatSync(path)
    if (info.isDirectory() && !info.isSymbolicLink()) inventory(path)
    else if (info.isFile()) artifacts.push({ path, bytes: info.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    else artifacts.push({ path, bytes: info.size, nonregular: true, sha256: null })
  }
}
inventory(out)
writeFileSync(join(out, 'artifact-sha256.json'), JSON.stringify(artifacts, null, 2) + '\n', { flag: 'wx' })
process.exitCode = spawnError || result.signal || result.code !== 0 ? (result.code || 1) : 0
