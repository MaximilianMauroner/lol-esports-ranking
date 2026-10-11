import assert from 'node:assert/strict'
import test from 'node:test'
import { collectLeaguepediaTournamentFeed, createTournamentFeedService, normalizeLeaguepediaSchedule } from '../scripts/leaguepedia-tournament-feed'
import { groupTournamentSeries, isTournamentFeed, type TournamentFeed } from '../src/lib/tournamentFeed'

const now = new Date('2026-10-15T20:00:00.000Z')
const window = { now, coverageStart: '2026-10-01T00:00:00.000Z', coverageEnd: '2026-11-29T23:59:59.999Z' }

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    MatchId: `2026 Season World Championship/Play-In_${id}`, OverviewPage: '2026 Season World Championship/Play-In',
    Team1: 'FURIA', Team2: 'MVK Esports', Team1Score: null, Team2Score: null, Winner: null,
    DateTimeUTC: '2026-10-16 18:00:00', HasTime: 1, BestOf: 5, Tab: 'Round 1', IsNullified: 0,
    TournamentName: 'Worlds 2026 Play-In', League: 'World Championship', Region: 'International', Year: 2026,
    ...overrides,
  }
}

/** Background refreshes finish within one macrotask when collect resolves immediately. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

function seriesFor(rows: Array<ReturnType<typeof row>>) {
  const series = normalizeLeaguepediaSchedule(rows, window).events.flatMap((event) => event.series)
  return rows.map((input) => series.find((entry) => entry.id === input.MatchId))
}

test('maps Leaguepedia schedule rows to a valid hub feed', () => {
  const feed = normalizeLeaguepediaSchedule([
    row('Round 1_1', { Team1Score: 3, Team2Score: 1, Winner: 1, DateTimeUTC: '2026-10-15 10:00:00' }),
    row('Round 2_1', { Team1: 'TBD', Team2: 'TBD' }),
  ], window)
  assert.equal(isTournamentFeed(feed), true)
  assert.equal(feed.source, 'leaguepedia-cargo')
  assert.equal(feed.coverage.complete, true)
  const [event] = feed.events
  assert.deepEqual({ id: event?.id, competition: event?.competition, label: event?.label, season: event?.season },
    { id: '2026 Season World Championship/Play-In', competition: 'worlds', label: 'Worlds 2026 Play-In', season: '2026' })
  const [completed, upcoming] = event!.series
  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.startTime, '2026-10-15T10:00:00.000Z')
  assert.deepEqual(completed?.teams.map((team) => [team.id, team.gameWins, team.outcome]), [['FURIA', 3, 'win'], ['MVK Esports', 1, 'loss']])
  assert.equal(upcoming?.status, 'upcoming')
  assert.deepEqual(upcoming?.teams.map((team) => team.name), [null, null])
})

test('infers live and missing results from the scheduled start and best-of', () => {
  const [live, missing, cancelled, undated] = seriesFor([
    row('live', { DateTimeUTC: '2026-10-15 15:30:00', BestOf: 3 }),
    row('missing', { DateTimeUTC: '2026-10-15 14:30:00', BestOf: 3 }),
    row('nullified', { IsNullified: 1, DateTimeUTC: '2026-10-15 15:00:00' }),
    row('undated', { HasTime: 0, DateTimeUTC: '2026-10-15 00:00:00' }),
  ])
  assert.equal(live?.status, 'live')
  assert.equal(missing?.status, 'unknown')
  assert.equal(groupTournamentSeries([missing!]).unresolved.length, 1)
  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(undated?.startTime, null)
  assert.equal(undated?.status, 'upcoming')
})

test('tags international competitions only for international events', () => {
  const feed = normalizeLeaguepediaSchedule([
    row('main'),
    row('qualifier', { OverviewPage: 'LPL/2026 Season/Regional Finals', TournamentName: 'LPL 2026 Regional Finals', Region: 'China' }),
    row('lck', { OverviewPage: 'LCK/2026 Season/Playoffs', League: 'LoL Champions Korea', Region: 'Korea' }),
  ], window)
  assert.deepEqual(Object.fromEntries(feed.events.map((event) => [event.id, event.competition])), {
    '2026 Season World Championship/Play-In': 'worlds',
    'LPL/2026 Season/Regional Finals': null,
    'LCK/2026 Season/Playoffs': 'lck',
  })
})

test('marks conflicting or unidentified rows as incomplete coverage', () => {
  const feed = normalizeLeaguepediaSchedule([row('a'), row('a', { Winner: 2 }), row('b', { MatchId: null })], window)
  assert.equal(feed.coverage.complete, false)
  assert.equal(feed.coverage.warnings.length, 2)
  assert.equal(feed.events[0]?.series.length, 1)
})

test('pages through the Cargo export until a short page', async () => {
  const urls: URL[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    urls.push(url)
    const offset = Number(url.searchParams.get('offset'))
    const rows = offset === 0 ? Array.from({ length: 500 }, (_, index) => row(`page1_${index}`)) : [row('page2_0')]
    return Response.json(rows)
  }
  const feed = await collectLeaguepediaTournamentFeed({ fetcher, now, baseUrl: 'https://cargo.test/export' })
  assert.equal(urls.length, 2)
  assert.equal(feed.events[0]?.series.length, 501)
  assert.equal(urls[0]?.searchParams.get('format'), 'json')
  assert.equal(urls[0]?.searchParams.get('join_on'), 'MS.OverviewPage=T.OverviewPage')
  assert.match(urls[0]?.searchParams.get('where') ?? '', /^MS\.DateTime_UTC >= "2026-10-01 00:00:00" AND MS\.DateTime_UTC <= "2026-11-29 23:59:59" AND /)
  await assert.rejects(collectLeaguepediaTournamentFeed({ fetcher: async () => Response.json({ error: 'ratelimited' }), now }), /unexpected schedule response/)
  await assert.rejects(collectLeaguepediaTournamentFeed({ fetcher: async () => new Response('missing', { status: 404 }), now }), /HTTP 404/)
})

test('feed service caches, refreshes when due and keeps the last complete feed', async () => {
  let clock = Date.parse('2026-10-15T20:00:00.000Z')
  const feeds: Array<TournamentFeed | Error> = []
  let calls = 0
  const service = createTournamentFeedService({
    now: () => clock, refreshMs: 300_000, retryMs: 60_000,
    collect: async () => {
      calls += 1
      const next = feeds.shift()
      if (!next) throw new Error('no fixture')
      if (next instanceof Error) throw next
      return next
    },
  })
  const first = normalizeLeaguepediaSchedule([row('a')], { ...window, now: new Date(clock) })
  feeds.push(first)
  assert.equal((await service.read()).feed, first)
  assert.equal((await service.read()).feed, first)
  assert.equal(calls, 1)

  clock += 300_000
  feeds.push(normalizeLeaguepediaSchedule([row('a')], { ...window, now: new Date(clock) }))
  await service.read()
  await settle()
  const unchanged = await service.read()
  assert.equal(calls, 2)
  assert.equal(unchanged.feed, first, 'Unchanged content keeps the time it last changed')

  clock += 300_000
  feeds.push(new Error('HTTP 503'))
  await service.read()
  await settle()
  const failed = await service.read()
  assert.equal(failed.feed, first)
  assert.equal(failed.health?.complete, false)
  assert.match(failed.health?.warnings[0] ?? '', /HTTP 503/)

  clock += 60_000
  feeds.push(normalizeLeaguepediaSchedule([row('a'), row('a', { Winner: 2 })], { ...window, now: new Date(clock) }))
  await service.read()
  await settle()
  const incomplete = await service.read()
  assert.equal(incomplete.feed, first, 'An incomplete check keeps the last complete feed')
  assert.equal(incomplete.health?.complete, false)

  clock += 60_000
  const corrected = normalizeLeaguepediaSchedule([row('a', { Winner: 1, Team1Score: 3, Team2Score: 0, DateTimeUTC: '2026-10-15 10:00:00' })], { ...window, now: new Date(clock) })
  feeds.push(corrected)
  await service.read()
  await settle()
  assert.equal((await service.read()).feed, corrected)
  assert.equal(calls, 5)
})

test('feed service reports an unavailable feed when the first check fails', async () => {
  const service = createTournamentFeedService({ collect: async () => { throw new Error('offline') } })
  const state = await service.read()
  assert.equal(state.feed, null)
  assert.match(state.health?.warnings[0] ?? '', /offline/)
})
