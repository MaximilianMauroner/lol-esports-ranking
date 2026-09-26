import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCollectorLock, collectTournamentFeed, publishTournamentFeed } from '../scripts/tournament-feed-collector'
import { competitionForLeague, formatTournamentTime, groupTournamentSeries, isTournamentFeed, normalizeTournamentFeed, reconcileTournamentFeed } from '../src/lib/tournamentFeed'

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
  assert.equal(isTournamentFeed({ ...result, dataMode: 'seeded-sample' }), false)
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
  const unresolved = feed([{ event: event('series', 'lcs', at, 'completed'), detail: detail('series') }]).events[0]?.series[0]
  assert.equal(groupTournamentSeries([unresolved!]).unresolved.length, 1)
  assert.equal(groupTournamentSeries([unresolved!]).upcoming.length, 0)
  assert.equal(feed([{ event: event('series', 'lcs', '2026-09-20T12:00:00Z'), detail: detail('series') }]).events[0]?.series[0]?.status, 'upcoming')
})

test('withholds identifier-less rows and recovers result evidence from event details', () => {
  const withoutId = feed([{ event: { ...event('series', 'lcs', at), match: { ...event('series', 'lcs', at).match, id: '' } }, detail: detail('series') }])
  assert.equal(withoutId.coverage.complete, false)
  assert.match(withoutId.coverage.warnings.join(' '), /lack a match ID/)
  const corrected = feed([{
    event: event('series', 'lcs', at, 'completed'),
    detail: { ...detail('series'), match: { teams: [
      { name: 'LCK representative', result: { gameWins: 3, outcome: 'win' } },
      { name: 'LCP representative', result: { gameWins: 1, outcome: 'loss' } },
    ] } },
  }])
  assert.equal(corrected.events[0]?.series[0]?.status, 'completed')
  assert.deepEqual(corrected.events[0]?.series[0]?.teams.map((team) => team.gameWins), [3, 1])
})

test('collector lock rejects a live owner and reclaims a dead local owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tournament-lock-test-'))
  const lock = join(directory, 'feed.lock')
  try {
    const release = await acquireCollectorLock(lock)
    await assert.rejects(acquireCollectorLock(lock), /lock is held/)
    await release()
    await mkdir(lock)
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ host: hostname(), pid: 999999999, startedAt: '2020-01-01T00:00:00Z' }))
    const staleTime = new Date('2020-01-01T00:00:00Z')
    await utimes(lock, staleTime, staleTime)
    const releaseRecovered = await acquireCollectorLock(lock)
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { pid: number }
    assert.equal(owner.pid, process.pid)
    await releaseRecovered()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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

test('invalid times in allowed cancelled or postponed source rows prevent a complete replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tournament-invalid-time-test-'))
  const output = join(directory, 'feed.json')
  const prior = feed([{ event: event('moved', 'lcs', at), detail: detail('moved') }])
  await writeFile(output, JSON.stringify(prior))
  try {
    for (const [badTime, status] of [['', 'postponed'], ['not-a-date', 'cancelled'], ['2026-02-30T12:00:00Z', 'postponed']] as const) {
      const sourceRow = event('moved', 'lcs', badTime, status)
      const fetcher = (async () => new Response(JSON.stringify({ data: { schedule: { events: [sourceRow], pages: {} } } }))) as typeof fetch
      const collected = await collectTournamentFeed({ fetcher, now: new Date(at) })
      assert.equal(collected.feed.coverage.complete, false, `time=${badTime}`)
      assert.match(collected.feed.coverage.warnings.join(' '), /start time/i)
      assert.equal(await publishTournamentFeed(output, prior, collected.feed), false)
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), prior)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('malformed schedule rows cannot replace a prior feed after collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tournament-malformed-row-test-'))
  const output = join(directory, 'feed.json')
  const prior = feed([{ event: event('series', 'lcs', at), detail: detail('series') }])
  await writeFile(output, `${JSON.stringify(prior)}\n`)
  const original = await readFile(output, 'utf8')
  try {
    for (const sourceRows of [[null], [event('series', 'lcs', at), null]]) {
      const fetcher = (async (urlValue: string | URL | Request) => {
        const path = new URL(String(urlValue)).pathname.split('/').at(-1)
        return new Response(JSON.stringify(path === 'getSchedule'
          ? { data: { schedule: { events: sourceRows, pages: {} } } }
          : { data: { event: detail('series') } }))
      }) as typeof fetch
      const collected = await collectTournamentFeed({ fetcher, now: new Date(at) })
      assert.equal(collected.feed.coverage.complete, false)
      assert.match(collected.feed.coverage.warnings.join(' '), /malformed schedule rows/i)
      assert.equal(await publishTournamentFeed(output, prior, collected.feed), false)
      assert.equal(await readFile(output, 'utf8'), original)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a rolling coverage window is published even when event rows are unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tournament-coverage-test-'))
  const output = join(directory, 'feed.json')
  try {
    const prior = feed([{ event: event('series', 'lec', at), detail: detail('series') }])
    await writeFile(output, JSON.stringify(prior))
    const next = { ...prior, fetchedAt: '2026-09-27T12:00:00.000Z', coverage: { ...prior.coverage, start: '2026-09-02T00:00:00Z', end: '2026-11-01T00:00:00Z' } }
    assert.equal(await publishTournamentFeed(output, prior, next), true)
    const published = JSON.parse(await readFile(output, 'utf8')) as typeof prior
    assert.deepEqual(published.coverage, next.coverage)
    assert.equal(published.fetchedAt, next.fetchedAt)
    const checkedAgain = { ...next, fetchedAt: '2026-09-27T12:01:00.000Z' }
    assert.equal(await publishTournamentFeed(output, next, checkedAgain), false)
    assert.equal((JSON.parse(await readFile(output, 'utf8')) as typeof prior).fetchedAt, next.fetchedAt)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('coverage bounds roll by UTC day rather than every unchanged poll', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ data: { schedule: { events: [], pages: {} } } }))) as typeof fetch
  const first = (await collectTournamentFeed({ fetcher, now: new Date('2026-09-26T12:00:00Z') })).feed
  const sameDay = (await collectTournamentFeed({ fetcher, now: new Date('2026-09-26T12:01:00Z') })).feed
  const nextDay = (await collectTournamentFeed({ fetcher, now: new Date('2026-09-27T00:01:00Z') })).feed
  assert.deepEqual(sameDay.coverage, first.coverage)
  assert.notDeepEqual(nextDay.coverage, first.coverage)
})
