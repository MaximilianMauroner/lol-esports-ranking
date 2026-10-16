import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertOwnedTemp, tempInventory } from './source-guards.mjs'
const [out, temp] = process.argv.slice(2)
assert.equal(temp, `${out}.tmp`)
assertOwnedTemp(out, process.env, process.getuid())
const metadata = join(out, 'owned-processes.json')
const ownership = existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')) : null
const survivors = [], inspectionErrors = []
for (const item of ownership?.processes ?? []) {
  const path = `/proc/${item.pid}/stat`
  if (!existsSync(path)) continue
  try {
    const raw = readFileSync(path, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    if (fields[19] === item.startTicks && fields[0] !== 'Z') survivors.push({ ...item, state: fields[0] })
  } catch (error) { if (existsSync(path)) inspectionErrors.push({ pid: item.pid, error: String(error) }) }
}
const tempReferences = []
for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  if (Number(pid) === process.pid) continue
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (argv.some((arg) => arg.includes(temp))) tempReferences.push({ pid: Number(pid), basis: 'owned temp path in argv' })
  } catch (error) { if (existsSync(`/proc/${pid}`)) inspectionErrors.push({ pid: Number(pid), error: String(error) }) }
}
const result = { temp: tempInventory(temp), ownership, survivors, tempReferences, inspectionErrors, deletedFiles: [], signalsSent: [], locks: 'Still held by outer allocation. Canonical after inspector with actual exit is required after caller close.', status: ownership && !survivors.length && !tempReferences.length && !inspectionErrors.length ? 'OWNED_DESCENDANTS_ABSENT_LOCK_PROOF_PENDING' : 'BLOCKED' }
const destination = existsSync(out) ? join(out, 'owned-cleanup.json') : join(temp, 'owned-cleanup.json')
writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
assert.ok(ownership, 'driver ownership receipt missing')
assert.deepEqual(survivors, [])
assert.deepEqual(tempReferences, [])
assert.deepEqual(inspectionErrors, [])
