import assert from 'node:assert/strict'
import test from 'node:test'
import { collectTournamentFeed } from '../scripts/tournament-feed-collector'
import { competitionForLeague, formatTournamentTime, isTournamentFeed, normalizeTournamentFeed, reconcileTournamentFeed } from '../src/lib/tournamentFeed'

const at = '2026-09-26T12:00:00.000Z'

function event(id: string, league: string, startTime: string, state = 'unstarted', teams: Array<Record<string, unknown>> = [{ name: 'LCK representative' }, { name: 'LCP representative' }]) {
  return { startTime, state, blockName: 'Playoffs', league: { slug: league, name: league }, match: { id, teams, strategy: { type: 'bestOf', count: 5 } } }
}
function detail(id: string, tournamentId = 't-1') { return { id, tournament: { id: tournamentId }, match: { strategy: { count: 5 }, games: [] } } }
function feed(observations: Array<{ event: ReturnType<typeof event>; detail?: Record<string, unknown> }>, complete = true) {
  return normalizeTournamentFeed({ observations, fetchedAt: at, coverageStart: '2026-09-01T00:00:00Z', coverageEnd: '2026-10-31T00:00:00Z', coverageComplete: complete })
}

test('discovers an allowed upcoming event without rated games or a manually supplied event ID', () => {
  const result = feed([
    { event: event('worlds-1', 'worlds', at), detail: detail('worlds-1', 'new-source-id') },
    { event: event('excluded', 'cblol-brazil', at), detail: detail('excluded') },
  ])
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0]?.id, 'worlds:2026')
  assert.equal(result.events[0]?.series[0]?.status, 'upcoming')
  assert.equal(result.events[0]?.series[0]?.teams[1]?.name, 'LCP representative')
  assert.equal(result.coverage.complete, true)
  assert.equal(isTournamentFeed(result), true)
  assert.equal(isTournamentFeed({ ...result, events: [{ ...result.events[0], series: [{ ...result.events[0]?.series[0], vodUrls: ['javascript:alert(1)'] }] }] }), false)
})

test('competition allowlist covers four domestic and three international families', () => {
  for (const slug of ['lcs', 'lec', 'lpl', 'lck', 'worlds', 'msi', 'first_stand']) {
    assert.ok(competitionForLeague({ slug, name: slug }), slug)
  }
  for (const slug of ['cblol-brazil', 'lcp', 'ewc', 'emea_masters']) assert.equal(competitionForLeague({ slug, name: slug }), null)
})

test('accepts only HTTPS VOD destinations and formats Vienna daylight changes', () => {
  const result = feed([{ event: event('series', 'lck', at), detail: {
    ...detail('series'),
    match: { games: [{ vods: [
      { provider: 'youtube', parameter: 'MyhFr03s0Xw' },
      { provider: 'other', parameter: 'http://unsafe.example/watch' },
    ] }] },
  } }])
  assert.deepEqual(result.events[0]?.series[0]?.vodUrls, ['https://www.youtube.com/watch?v=MyhFr03s0Xw'])
  assert.match(formatTournamentTime('2026-03-29T00:30:00Z', 'Europe/Vienna'), /1:30.*GMT\+1/)
  assert.match(formatTournamentTime('2026-03-29T01:30:00Z', 'Europe/Vienna'), /3:30.*GMT\+2/)
})

test('preserves source state, corrections, TBD slots and confirmed terminal status', () => {
  const first = feed([{ event: event('series', 'lcs', at, 'unstarted', [{ name: 'Alpha' }, {}]), detail: detail('series') }])
  const live = feed([{ event: event('series', 'lcs', at, 'inProgress'), detail: detail('series') }])
  const postponed = feed([{ event: event('series', 'lcs', at, 'postponed'), detail: detail('series') }])
  const completed = feed([{ event: event('series', 'lcs', at, 'completed', [{ name: 'Alpha', result: { gameWins: 3, outcome: 'win' } }, { name: 'Beta', result: { gameWins: 1, outcome: 'loss' } }]), detail: detail('series') }])
  assert.equal(first.events[0]?.series[0]?.teams[1]?.name, null)
  assert.equal(first.events[0]?.series[0]?.status, 'upcoming')
  assert.equal(live.events[0]?.series[0]?.status, 'live')
  assert.equal(postponed.events[0]?.series[0]?.status, 'postponed')
  assert.equal(completed.events[0]?.series[0]?.status, 'completed')
  assert.equal(feed([{ event: event('series', 'lcs', at, 'completed'), detail: detail('series') }]).events[0]?.series[0]?.status, 'unknown')
  assert.equal(feed([{ event: event('series', 'lcs', '2026-09-20T12:00:00Z'), detail: detail('series') }]).events[0]?.series[0]?.status, 'upcoming')
})

test('partial and contradictory observations cannot replace complete last-good state', () => {
  const prior = feed([{ event: event('series', 'lec', at), detail: detail('series') }])
  const partial = feed([{ event: event('series', 'lec', at, 'completed') }], false)
  const retained = reconcileTournamentFeed(prior, partial)
  assert.deepEqual(retained.events, prior.events)
  assert.match(retained.coverage.warnings.at(-1)!, /last complete observation/)
  const contradiction = feed([
    { event: event('series', 'lec', at), detail: detail('series') },
    { event: event('series', 'lec', at, 'completed'), detail: detail('series') },
  ])
  assert.equal(contradiction.coverage.complete, false)
  assert.equal(contradiction.events.length, 0)
  assert.deepEqual(reconcileTournamentFeed(prior, contradiction).events, prior.events)
  const empty = feed([])
  assert.deepEqual(reconcileTournamentFeed(prior, empty).events, [])
})

test('collector follows both cursors and withholds a capped incomplete read', async () => {
  const calls: string[] = []
  const fetcher = (async (urlValue: string | URL | Request) => {
    const url = new URL(String(urlValue))
    const key = `${url.pathname.split('/').at(-1)}:${url.searchParams.get('pageToken') ?? url.searchParams.get('id') ?? ''}`
    calls.push(key)
    const data = new Map<string, unknown>([
      ['getSchedule:', { data: { schedule: { events: [event('middle', 'lcs', at)], pages: { older: 'old', newer: 'new' } } } }],
      ['getSchedule:old', { data: { schedule: { events: [event('old', 'lck', '2026-08-01T00:00:00Z')], pages: {} } } }],
      ['getSchedule:new', { data: { schedule: { events: [event('new', 'worlds', '2026-12-01T00:00:00Z')], pages: {} } } }],
      ['getEventDetails:middle', { data: { event: detail('middle') } }],
    ])
    return { ok: true, status: 200, json: async () => data.get(key) } as Response
  }) as typeof fetch
  const result = await collectTournamentFeed({ fetcher, now: new Date(at), maxPagesPerDirection: 2 })
  assert.equal(result.feed.coverage.complete, true)
  assert.deepEqual(calls, ['getSchedule:', 'getSchedule:old', 'getSchedule:new', 'getEventDetails:middle'])
  assert.equal(result.feed.events[0]?.id, 'lcs:2026:t-1')
  const capped = await collectTournamentFeed({ fetcher, now: new Date(at), maxPagesPerDirection: 0 })
  assert.equal(capped.feed.coverage.complete, false)
})

test('collector retries 429 with the shared provider helper and rejects malformed coverage', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls += 1
    if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } })
    return new Response(JSON.stringify({ data: { schedule: { events: [], pages: {} } } }))
  }) as typeof fetch
  const result = await collectTournamentFeed({ fetcher, now: new Date(at) })
  assert.equal(result.requests, 2)
  assert.equal(result.retries, 1)
  await assert.rejects(
    collectTournamentFeed({ fetcher: (async () => new Response(JSON.stringify({ data: { schedule: { events: null } } }))) as typeof fetch }),
    /Malformed getSchedule/,
  )
})
