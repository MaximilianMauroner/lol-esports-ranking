import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchScheduleProbe } from '../scripts/lolesports-schedule-probe.mjs'

test('probe paginates to its watermark and targets details only for uncertain completions', async () => {
  const calls: string[] = []
  const responses = new Map<string, unknown>([
    ['getSchedule', schedulePage([
      event('complete-with-result', '2026-07-11T12:00:00Z', 'completed', 2, 0),
      event('uncertain', '2026-07-11T11:00:00Z', 'completed'),
    ], 'older-page')],
    ['getSchedule:older-page', schedulePage([
      event('older', '2026-07-10T10:00:00Z', 'completed', 1, 0),
    ])],
    ['getEventDetails:uncertain', { data: { event: event('uncertain', '2026-07-11T11:00:00Z', 'completed', 2, 1) } }],
  ])
  const fetcher = async (urlValue: URL) => {
    const url = new URL(urlValue)
    const operation = url.pathname.split('/').at(-1)!
    const key = operation === 'getSchedule'
      ? `getSchedule${url.searchParams.get('pageToken') ? `:${url.searchParams.get('pageToken')}` : ''}`
      : `getEventDetails:${url.searchParams.get('id')}`
    calls.push(key)
    const body = responses.get(key)
    assert.ok(body, `missing response for ${key}`)
    return { ok: true, json: async () => body }
  }

  const probe = await fetchScheduleProbe({
    fetcher,
    watermark: '2026-07-10T12:00:00Z',
    now: '2026-07-11T13:00:00Z',
  })

  assert.equal(probe.coverageComplete, true)
  assert.equal(probe.pageCount, 2)
  assert.deepEqual(calls, ['getSchedule', 'getSchedule:older-page', 'getEventDetails:uncertain'])
  assert.equal(probe.events.find((entry) => entry.matchId === 'uncertain')?.teams[0]?.gameWins, 2)
})

test('probe reports incomplete coverage without silently accepting a page limit', async () => {
  const fetcher = async () => ({
    ok: true,
    json: async () => schedulePage([event('recent', '2026-07-11T12:00:00Z', 'unstarted')], 'still-older'),
  })
  const probe = await fetchScheduleProbe({
    fetcher,
    watermark: '2026-07-01T00:00:00Z',
    now: '2026-07-11T13:00:00Z',
    maxOlderPages: 1,
  })
  assert.equal(probe.coverageComplete, false)
})

function schedulePage(events: unknown[], older?: string) {
  return { data: { schedule: { events, pages: { older } } } }
}

function event(id: string, startTime: string, state: string, winsA?: number, winsB?: number) {
  return {
    id,
    startTime,
    state,
    match: {
      id,
      teams: [
        { id: 'a', name: 'Alpha', ...(winsA === undefined ? {} : { result: { gameWins: winsA, outcome: winsA > (winsB ?? 0) ? 'win' : 'loss' } }) },
        { id: 'b', name: 'Beta', ...(winsB === undefined ? {} : { result: { gameWins: winsB, outcome: winsB > (winsA ?? 0) ? 'win' : 'loss' } }) },
      ],
    },
  }
}
