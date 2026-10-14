import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TournamentBracket } from '../src/components/TournamentBracket.tsx'
import type { TournamentSeries } from '../src/lib/tournamentFeed'

/** [Leaguepedia tab_N, start, team 1, team 2, winner (1 or 2)] */
function completed(rows: Array<[string, string, string, string, 1 | 2]>): TournamentSeries[] {
  return rows.map(([tabMatch, start, first, second, winner]) => ({
    id: `Event_${tabMatch}`, eventId: 'Event', startTime: `2025-${start}:00.000Z`, stage: tabMatch.replace(/_\d+$/, ''),
    status: 'completed', sourceState: 'completed', bestOf: 3, vodUrls: [],
    teams: [first, second].map((name, index) => ({
      id: name, name, code: null, gameWins: winner === index + 1 ? 2 : 1, outcome: winner === index + 1 ? 'win' : 'loss',
    })),
  }))
}

/** The top offset, in rem, of the card whose accessible name starts with the stage. */
function cardTop(html: string, stage: string) {
  const match = new RegExp(`top:([\\d.]+)rem;[^"]*"><article aria-label="${stage}:`).exec(html)
  assert.ok(match, `No card for ${stage}`)
  return Number(match[1])
}

test('a third-place match renders under the final of a single-elimination bracket', () => {
  // Esports World Cup 2025 playoffs.
  const html = renderToStaticMarkup(createElement(TournamentBracket, { timezone: 'UTC', series: completed([
    ['Quarterfinals_1', '07-17T11:00', 'AG.AL', 'Hanwha Life Esports', 1],
    ['Quarterfinals_2', '07-17T14:00', 'Bilibili Gaming', 'G2 Esports', 2],
    ['Quarterfinals_3', '07-18T09:00', 'T1', 'Movistar KOI', 1],
    ['Quarterfinals_4', '07-18T12:00', 'Gen.G', 'FlyQuest', 1],
    ['Semifinals_1', '07-19T09:00', 'AG.AL', 'T1', 1],
    ['Semifinals_2', '07-19T12:00', 'Gen.G', 'G2 Esports', 1],
    ['Third-Place Match_1', '07-20T08:00', 'G2 Esports', 'T1', 2],
    ['Finals_1', '07-20T11:00', 'Gen.G', 'AG.AL', 1],
  ]) }))
  assert.doesNotMatch(html, /Lower bracket|Double-elimination/)
  assert.match(html, />Third place</)
  assert.ok(cardTop(html, 'Third-Place Match') > cardTop(html, 'Finals'), 'The third-place card sits below the final')
  assert.equal(/Event winner<\/span><span[^>]*>([^<]+)</.exec(html)?.[1], 'Gen.G')
})

/** A Finals series the source left as 'unknown' with the given source state. */
function unknownFinal(sourceState: string) {
  return renderToStaticMarkup(createElement(TournamentBracket, { timezone: 'UTC', series: [{
    id: 'Event_Finals_1', eventId: 'Event', startTime: '2026-10-15T13:00:00.000Z', stage: 'Finals',
    status: 'unknown', sourceState, bestOf: 5, vodUrls: [],
    teams: [{ id: 'T1', name: 'T1', code: null, gameWins: null, outcome: null }, { id: 'Gen.G', name: 'Gen.G', code: null, gameWins: null, outcome: null }],
  }] }))
}

test('a series the source ended without a confirmed result says so instead of showing a start time', () => {
  const html = unknownFinal('result-missing')
  const text = html.replace(/<[^>]+>/g, ' ')
  assert.match(text, /Oct 15, result missing/)
  assert.doesNotMatch(text, /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|\d:\d\d/, 'No weekday or start time')
  assert.match(html, /aria-label="Finals: [^"]*result missing"/)
})

test('an unknown series without a terminal source state keeps its scheduled time', () => {
  assert.doesNotMatch(unknownFinal('weird'), /result missing/i)
})
