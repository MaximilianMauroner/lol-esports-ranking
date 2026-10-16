import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dependencyState, assertOwnedTemp } from './source-guards.mjs'
const [root, out, pinsPath] = process.argv.slice(2)
assertOwnedTemp(out, process.env, process.getuid())
const pins = JSON.parse(readFileSync(pinsPath, 'utf8'))
const state = dependencyState(root, pins)
assert.deepEqual(state, { sharedStore: pins.sharedStore, packages: pins.packages })
writeFileSync(join(process.env.TMPDIR, 'dependencies-preloader.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
