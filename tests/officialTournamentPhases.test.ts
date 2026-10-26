import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalTeamNameFor, inferEventTier, mergeCommunityMatchSources, resolveCanonicalSeries } from '../src/domains/rankings/evidence.ts'
import { normalizeTournamentPhase } from '../src/domains/rankings/internal/replay/placementResiduals.ts'
import { eventWeightContextForMatches } from '../src/domains/rankings/internal/replay/eventWeighting.ts'
import { importLolEsportsScheduleSnapshot } from '../scripts/rankings/providers/lolEsports.ts'
import type { MatchRecord, PublicMatchHistoryEntry } from '../src/domains/rankings/types.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/worlds2026References.json', import.meta.url), 'utf8'))
const references = importLolEsportsScheduleSnapshot({ events: fixture.events }).events
const matches: MatchRecord[] = (fixture.games as PublicMatchHistoryEntry[]).map((game) => ({
  id: game.id, sourceProvider: game.source.provider, sourceGameId: game.source.gameId,
  sourceMatchId: game.source.matchId, date: game.date, datetimeUtc: game.datetimeUtc,
  season: 2026, event: game.event, league: game.league, phase: game.phase, region: game.region,
  patch: game.patch, bestOf: game.bestOf, bestOfBasis: 'provider', gameNumber: game.gameNumber,
  tier: inferEventTier(game), teamA: game.teamA.name, teamB: game.teamB.name,
  winner: game.winnerId === game.teamA.id ? game.teamA.name : game.teamB.name,
  teamAKills: 0, teamBKills: 0, teamAGold: 0, teamBGold: 0,
}))

test('captured Worlds games match all 26 completed official series without changing game facts', () => {
  const merged = mergeCommunityMatchSources({ oracleMatches: matches, leaguepediaMatches: [], lolEsportsReferences: references })
  const facts = (records: MatchRecord[]) => records.map(({ id, date, teamA, teamB, winner }) => ({ id, date, teamA, teamB, winner }))
  assert.deepEqual(facts(merged), facts(matches))
  assert.equal(merged.length, 45)
  const series = resolveCanonicalSeries(merged)
  assert.equal(series.length, 26)
  for (const reference of references) {
    const names = reference.teams.map((team) => canonicalTeamNameFor(team.name))
    const resolved = series.find((entry) => entry.games[0].date === reference.date && names.includes(entry.teamA) && names.includes(entry.teamB))
    assert.ok(resolved, reference.matchId)
    assert.equal(resolved.state, 'completed', reference.matchId)
    for (const [team, wins] of [[resolved.teamA, resolved.winsA], [resolved.teamB, resolved.winsB]] as const) {
      assert.equal(wins, reference.teams.find((entry) => canonicalTeamNameFor(entry.name) === team)?.gameWins, reference.matchId)
    }
  }
  const playIns = merged.filter((match) => match.date <= '2026-10-18')
  assert.equal(playIns.length, 22)
  assert.ok(playIns.every((match) => match.phase === 'Play-Ins'))
  assert.equal(merged.filter((match) => match.phase === 'Swiss').length, 23)
})

test('singular and plural play-ins retain early-stage identity even with a final label', () => {
  for (const phase of ['Play-In', 'Play-Ins', 'Play In', 'Play Ins', 'PlayIn', 'PlayIns']) {
    assert.equal(normalizeTournamentPhase(phase), 'play-in', phase)
    assert.equal(inferEventTier({ league: 'MSI', event: `MSI 2026/${phase}`, phase: `${phase} Finals`, playoffs: true }), 'msi-play-in', phase)
    const final = matches.slice(0, 3).map((match, index) => ({
      ...match, id: `play-in-final-${index}`, sourceMatchId: 'play-in-final', gameNumber: index + 1,
      event: `Worlds 2026/${phase}`, phase: 'Final', bestOf: 5, winner: match.teamA,
      teamA: 'Alpha', teamB: 'Beta',
    }))
    for (const game of final) game.winner = 'Alpha'
    assert.equal(eventWeightContextForMatches(final).worldsEndDateByCalendarYear.size, 0, phase)
  }
})

test('official sponsor aliases leave affiliate identities separate', () => {
  for (const name of ['Cloud9 Academy', 'Cloud9 Kia Academy', 'Team Liquid Academy', 'LOS Academy']) {
    assert.equal(canonicalTeamNameFor(name), name)
  }
})
