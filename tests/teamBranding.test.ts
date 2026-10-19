import { referencePublicDataDir } from '../scripts/reference-public-data.mjs'
import assert from 'node:assert/strict'
import { access, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { teamBranding } from '../src/data/teamBranding.generated.ts'
import { withAuditedTeamCodes } from '../src/data/teamBranding.ts'
import { teamCodeFor } from '../src/domains/rankings/internal/evidence/teamIdentity.ts'

test('every published team has audited branding metadata', async () => {
  const directory = JSON.parse(await readFile(resolve(join(referencePublicDataDir, 'entities/teams.json')), 'utf8')) as {
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

test('published team marks stay within the icon image budget', async () => {
  const logos = new Set(Object.values(teamBranding).flatMap((branding) => 'logo' in branding ? [branding.logo] : []))
  let bytes = 0
  for (const logo of logos) {
    const file = await stat(resolve('public', logo.replace(/^\//, '')))
    assert.ok(file.size <= 32 * 1024, `${logo} is ${file.size} bytes; use an icon-sized derivative`)
    bytes += file.size
  }
  assert.ok(bytes <= 1024 * 1024, `Team marks total ${bytes} bytes; budget is 1 MiB`)
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
