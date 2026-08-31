import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { auditSemanticManifestFreshness } from '../scripts/raw-manifest-freshness.ts'

test('semantic manifest freshness rejects unreferenced newer scored coverage', async () => {
  const rawDir = await mkdtemp(join(tmpdir(), 'ranking-freshness-'))
  const leaguepediaDir = join(rawDir, 'leaguepedia')
  await mkdir(leaguepediaDir)
  const referenced = join(leaguepediaDir, 'scoreboard-games-2026-07-01_to_2026-07-16.json')
  const unreferenced = join(leaguepediaDir, 'scoreboard-games-2026-07-17_to_2026-07-26.json')
  await writeFile(referenced, snapshot('2026-07-16', 'game-a'))
  await writeFile(unreferenced, snapshot('2026-07-26', 'game-b'))
  const manifestPath = join(rawDir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ files: { leaguepediaJson: [referenced] } }))

  await assert.rejects(auditSemanticManifestFreshness(manifestPath), /omits eligible scored input/)
})

test('semantic manifest freshness ignores exact-content duplicate snapshots', async () => {
  const rawDir = await mkdtemp(join(tmpdir(), 'ranking-freshness-'))
  const leaguepediaDir = join(rawDir, 'leaguepedia')
  await mkdir(leaguepediaDir)
  const referenced = join(leaguepediaDir, 'scoreboard-games-2026-07-01_to_2026-07-16.json')
  const duplicate = join(leaguepediaDir, 'scoreboard-games-duplicate.json')
  const content = snapshot('2026-07-16', 'game-a')
  await writeFile(referenced, content)
  await writeFile(duplicate, content)
  const manifestPath = join(rawDir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ files: { leaguepediaJson: [referenced] } }))

  const audit = await auditSemanticManifestFreshness(manifestPath)
  assert.deepEqual(audit.unreferencedEligibleFiles, [])
})

function snapshot(date: string, id: string) {
  return JSON.stringify({
    fetchedAt: `${date}T12:00:00.000Z`,
    start: date,
    end: date,
    matches: [{ id, date, teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha' }],
  })
}
