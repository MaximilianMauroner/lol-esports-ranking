import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SeriesCards, SeriesTable, type MatchSeries } from '../src/views/matches/SeriesLedger.tsx'
import type { PublicMatchHistoryEntry } from '../src/domains/rankings/internal/published/schema.ts'

const c9 = { id: 'team:c9', name: 'Cloud9', code: 'C9' }
const kc = { id: 'team:kc', name: 'Karmine Corp', code: 'KC' }

function game(gameNumber: number, picks: PublicMatchHistoryEntry['picks'], patch = '26.20'): PublicMatchHistoryEntry {
  return {
    id: `c9-kc-${gameNumber}`,
    date: '2026-10-15',
    event: 'Worlds 2026 Play-In',
    phase: 'Play-in',
    league: 'WLDs',
    region: 'International',
    patch,
    bestOf: 5,
    gameNumber,
    seriesId: 'c9-kc',
    seriesState: 'completed',
    seriesWinsA: 0,
    seriesWinsB: gameNumber,
    teamA: c9,
    teamB: kc,
    winnerId: kc.id,
    impact: gameNumber === 2 ? { unit: 'series-applied', teamA: -12, teamB: 12, expectedTeamA: 0.5 } : { unit: 'held' },
    source: { provider: 'leaguepedia-cargo' },
    ...(picks ? { picks } : {}),
  }
}

const opening = game(1, {
  teamA: ['Ambessa', 'Jarvan IV', 'Locke', 'Jhin', 'Karma'],
  teamB: ['Rumble', 'Wukong', 'Ryze', "Kai'Sa", null],
})
const unknownPatch = game(2, {
  teamA: ['Gnar', 'Vi', 'Azir', 'Varus', 'Rakan'],
  teamB: ["K'Sante", 'Sejuani', 'Taliyah', 'Ezreal', 'Nautilus'],
}, '')
const series: MatchSeries[] = [{ id: 'c9-kc', games: [opening, unknownPatch], summary: unknownPatch }]

function render(component: typeof SeriesTable | typeof SeriesCards) {
  return renderToStaticMarkup(createElement(component, { series, expanded: new Set(['c9-kc']), onToggle: () => {}, publication: 'test' }))
}

function namedIcons(html: string) {
  return [...html.matchAll(/role="img" aria-label="([^"]*)" title="([^"]*)"/g)].map(([, label, title]) => {
    assert.equal(title, label, 'icon title matches its accessible name')
    return label.replaceAll('&#x27;', "'")
  })
}

for (const component of [SeriesTable, SeriesCards]) {
  test(`${component.name} shows both teams' champions in role order for each expanded game`, () => {
    const html = render(component)

    assert.deepEqual(namedIcons(html), [
      'Ambessa', 'Jarvan IV', 'Locke', 'Jhin', 'Karma', 'Rumble', 'Wukong', 'Ryze', "Kai'Sa", 'Unknown champion',
      'Gnar', 'Vi', 'Azir', 'Varus', 'Rakan', "K'Sante", 'Sejuani', 'Taliyah', 'Ezreal', 'Nautilus',
    ])
    assert.match(html, /aria-label="Cloud9 champions"/)
    assert.match(html, /aria-label="Karmine Corp champions"/)
    assert.match(html, /<img[^>]*src="https:\/\/ddragon\.leagueoflegends\.com\/cdn\/16\.20\.1\/img\/champion\/MonkeyKing\.png"[^>]*width="24" height="24" loading="lazy"/)
  })

  test(`${component.name} shows initials instead of an image when the champion or patch is missing`, () => {
    const html = render(component)
    const images = [...html.matchAll(/src="https:\/\/ddragon[^"]*"/g)]

    assert.equal(images.length, 9, 'only game 1 has a patch, and one of its picks is unknown')
    assert.match(html, /aria-label="Unknown champion" title="Unknown champion"[^>]*><span>\?<\/span><\/span>/)
    assert.match(html, /aria-label="Gnar" title="Gnar"[^>]*><span>Gn<\/span><\/span>/)
  })
}
