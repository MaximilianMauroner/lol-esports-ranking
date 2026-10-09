import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { auditTournamentSource } from '../scripts/audit-tournament-source.ts'

test('retained captures expose coverage and identity ambiguity without approving a source or mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tournament-source-audit-'))
  try {
    const capture = join(root, 'capture.json')
    const directory = join(root, 'teams.json')
    await writeFile(capture, JSON.stringify({ fetchedAt: '2026-10-09T00:00:00Z', start: '2026-10-01', end: '2026-10-31',
      events: ['m1', 'm2'].map((id) => ({ league: { slug: 'lck' }, startTime: '2026-10-10T00:00:00Z', state: 'unstarted', match: { id } })),
      eventDetails: ['Alpha', 'Later alias'].map((name, index) => ({ id: `m${index + 1}`, event: { tournament: { id: 'source-tournament' },
        match: { strategy: { count: 3 }, teams: [{ id: 'stable-source-id', name }, { id: 'other', name: 'Other' }] } } })) }))
    await writeFile(directory, JSON.stringify({ teams: [{ name: 'Alpha', teamId: 'team:a' }, { name: 'Later alias', teamId: 'team:b' }] }))
    const original = await readFile(capture)
    const evidence = await auditTournamentSource([capture], directory)
    assert.equal(evidence.sourceApproval, 'unverified')
    assert.equal(evidence.liveAcceptance, false)
    const participant = evidence.mappingReviewCandidates.find((team) => team.sourceTeamId === 'stable-source-id')!
    assert.equal(participant.reviewed, false)
    assert.deepEqual(participant.sourceNames, ['Alpha', 'Later alias'])
    assert.equal(participant.exactNameCandidates.length, 2, 'Ambiguous names must remain separate review candidates')
    assert.equal(evidence.captures[0]?.families.worlds.series, 0)
    assert.equal(evidence.requestBudget.collectorMaximumLogicalRequests, 137)
    assert.deepEqual(await readFile(capture), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})
