import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { teamBranding } from '../src/data/teamBranding.generated.ts'
import { withAuditedTeamCodes } from '../src/data/teamBranding.ts'
import { teamCodeFor } from '../src/data/teamIdentity.ts'

test('every published team has audited branding metadata', async () => {
  const directory = JSON.parse(await readFile(resolve('public/data/entities/teams.json'), 'utf8')) as {
    teams: Array<{ name: string }>
  }

  for (const team of directory.teams) {
    const branding = (teamBranding as Record<string, { code: string; source: string; logo?: string }>)[team.name]
    assert.ok(branding, `missing branding for ${team.name}`)
    assert.ok(branding.code, `missing code for ${team.name}`)
    assert.match(branding.source, /^(lol-esports|leaguepedia|name-derived)$/)
    if (branding.logo) await access(resolve('public', branding.logo.replace(/^\//, '')))
  }
})

test('source-provided shorthand replaces generated acronyms', () => {
  assert.equal(teamCodeFor('Movistar KOI'), 'MKOI')
  assert.equal(teamCodeFor('FURIA'), 'FUR')
  assert.equal(teamCodeFor('DN Freecs'), 'DNS')
  assert.equal(teamCodeFor('ThunderTalk Gaming'), 'TT')
  assert.equal(teamCodeFor('DetonatioN FocusMe'), 'DFM')
})

test('public artifacts receive audited shorthand at the read boundary', () => {
  const artifact = {
    standings: [{ team: 'Movistar KOI', code: 'MK' }],
    match: { teamA: { name: 'FURIA', code: 'FURI' }, teamB: { name: 'DN SOOPers', code: 'DS' } },
  }

  assert.deepEqual(withAuditedTeamCodes(artifact), {
    standings: [{ team: 'Movistar KOI', code: 'MKOI' }],
    match: { teamA: { name: 'FURIA', code: 'FUR' }, teamB: { name: 'DN SOOPers', code: 'DNS' } },
  })
})
