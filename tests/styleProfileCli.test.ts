import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parseStyleProfileArtifact } from '../src/domains/style/profile.ts'
import { styleGame } from './styleProfileFixtures.ts'

test('the build CLI requires an output, pins input bytes and writes only the chosen artifact path', () => {
  mkdirSync(resolve('.agents/artifacts'), { recursive: true })
  const directory = mkdtempSync(resolve('.agents/artifacts/style-cli-test-'))
  const input = resolve(directory, 'input.json')
  const output = resolve(directory, 'chosen', 'style.json')
  const body = JSON.stringify({ matches: [styleGame()] })
  writeFileSync(input, body)
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'tools/profiles/build-style-profiles.ts', ...args], { encoding: 'utf8', timeout: 20_000 })
  try {
    assert.notEqual(run(['--input', input]).status, 0)
    assert.equal(existsSync(output), false)
    assert.notEqual(run(['--input', input, '--output', input]).status, 0)
    assert.equal(readFileSync(input, 'utf8'), body)
    assert.notEqual(run(['--input', input, '--output', resolve('public/data/style-profiles.json')]).status, 0)
    const result = run(['--input', input, '--output', output])
    assert.equal(result.status, 0, result.stderr)
    const artifact = parseStyleProfileArtifact(JSON.parse(readFileSync(output, 'utf8')))
    assert.equal(artifact.sourceSha256, createHash('sha256').update(body).digest('hex'))
    assert.equal(artifact.scopes.all.countedGames, 1)
    assert.equal(artifact.scopes.all.teams[0].observed.towersPerGame?.mean, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
