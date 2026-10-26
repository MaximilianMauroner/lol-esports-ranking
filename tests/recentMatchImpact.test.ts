import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { compactStanding } from '../src/domains/rankings/internal/published/schema.ts'
import type { TeamHistoryPoint } from '../src/domains/rankings/types.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RecentMatches } from '../src/views/rankings/RecentMatches.tsx'
import type { PublicRecentMatch, TeamHistorySeries } from '../src/domains/rankings/types.ts'

const loss: PublicRecentMatch = { date: '2026-09-19', event: 'LEC 2026 Summer', opponent: 'Movistar KOI', result: 'L', rating: 1878, delta: -59, matchImpact: -29 }
const win: PublicRecentMatch = { date: '2026-10-15', event: 'WLDs 2026', opponent: 'Cloud9', result: 'W', rating: 1839, delta: -39, matchImpact: 33 }

function render(matches: PublicRecentMatch[]) {
  return renderToStaticMarkup(createElement(RecentMatches, { matches, standings: [], historyState: { status: 'loading' } }))
}

test('a win displays its recorded impact apart from changes since the previous match', () => {
  const markup = render([loss, win])
  assert.match(markup, /Recorded match impact \+33/)
  assert.match(markup, /Other changes -72/)
  assert.match(markup, />1,839<\/strong>/)
  assert.doesNotMatch(markup, /Recorded match impact -39/)
})

test('no other movement is invented when a previous match is unavailable', () => {
  const markup = render([win])
  assert.match(markup, /Recorded match impact \+33/)
  assert.doesNotMatch(markup, /Other changes/)
})

test('the recorded impact stays negative for a loss despite a positive interval change', () => {
  const markup = render([win, { ...loss, date: '2026-10-24', rating: 1900, matchImpact: -59 }])
  assert.match(markup, /Recorded match impact -59/)
  assert.match(markup, /Other changes \+120/)
})

test('a match with no other movement shows only its match impact', () => {
  const markup = render([loss, { ...win, rating: 1911 }])
  assert.match(markup, /Recorded match impact \+33/)
  assert.doesNotMatch(markup, /Other changes/)
})

function historySeries(includeDelta = true): TeamHistorySeries {
  return {
    team: 'Karmine Corp',
    points: [loss, win].map((match, index) => [match.date, match.rating, index + 1, {
      event: match.event, opponent: match.opponent, result: match.result,
      ...(includeDelta ? { delta: match.matchImpact } : {}),
    }]),
    currentStanding: { asOf: win.date, rating: win.rating, rank: 4, lastMatchRating: win.rating, adjustment: 0 },
  }
}

test('loaded history exposes its recorded impact', () => {
  const markup = renderToStaticMarkup(createElement(RecentMatches, {
    series: historySeries(), standings: [], historyState: { status: 'loading' }, seriesOnly: true,
  }))
  assert.match(markup, /Recorded match impact \+33/)
  assert.match(markup, /Other changes -72/)
})

test('history without recorded deltas does not claim a zero match impact', () => {
  const markup = renderToStaticMarkup(createElement(RecentMatches, {
    series: historySeries(false), standings: [], historyState: { status: 'loading' }, seriesOnly: true,
  }))
  assert.match(markup, /Match impact unavailable/)
  assert.doesNotMatch(markup, /Recorded match impact 0/)
  assert.doesNotMatch(markup, /Other changes/)
})

const capture = JSON.parse(readFileSync(new URL('./fixtures/recentMatchImpact.json', import.meta.url), 'utf8'))

function producedSummary() {
  const history = capture.games.map((game: { date: string; event: string; seriesId: string; bestOf: number; winnerId: string; teamA: { id: string; name: string }; teamB: { id: string; name: string }; impact: { teamA?: number; teamB?: number } }) => {
    const point = capture.history.points.find((entry: [string]) => entry[0] === game.date)
    const context = point[3]
    const side = game.teamA.name === 'Karmine Corp' ? 'teamA' : 'teamB'
    return {
      date: game.date, event: game.event, opponent: context.opponent, rating: point[1], rank: point[2],
      result: game.winnerId === game[side].id ? 'W' : 'L', delta: game.impact[side] ?? 0,
      source: { seriesId: game.seriesId, seriesState: 'completed', seriesOutcome: context.result === 'W' ? 1 : 0, bestOf: game.bestOf },
    }
  }) as TeamHistoryPoint[]
  return compactStanding({ ...capture.standing, history }).recentMatches
}

test('the real producer preserves interval movement and emits a separate match impact', () => {
  const matches = producedSummary()
  const cloud9 = matches.find((match) => match.opponent === 'Cloud9')!
  assert.equal(cloud9.delta, -39)
  assert.equal(cloud9.matchImpact, 33)
  assert.equal(cloud9.wins, 3)
  assert.equal(cloud9.losses, 2)
  assert.equal(cloud9.games, 5)
  assert.match(render(matches), /Recorded match impact \+33/)
  assert.match(render(matches), /Other changes -72/)
})

test('stored summary rows without an impact are never relabeled as match impact', () => {
  const markup = render(capture.standing.recentMatches)
  assert.match(markup, /Match impact unavailable/)
  assert.doesNotMatch(markup, /Recorded match impact -39/)
  assert.doesNotMatch(markup, /Other changes/)
})

test('equally long loaded history takes precedence over a stored summary', () => {
  const markup = renderToStaticMarkup(createElement(RecentMatches, {
    matches: capture.standing.recentMatches, series: capture.history, standings: [], historyState: { status: 'loading' },
  }))
  assert.match(markup, /Recorded match impact \+33/)
  assert.match(markup, /Other changes -72/)
})
