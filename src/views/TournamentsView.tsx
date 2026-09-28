import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Select } from '../components/ui/select'
import { LoadingState } from '../components/ui/loading'
import { currentHashQuery, hashParam } from '../lib/urlState'
import { formatTournamentTime, groupTournamentSeries, isTournamentFeed, type TournamentEvent, type TournamentFeed, type TournamentSeries } from '../lib/tournamentFeed'

type FeedHealth = { checkedAt: string; complete: boolean; warnings: string[] }
type FeedState = { status: 'loading' } | { status: 'ready'; feed: TournamentFeed; health: FeedHealth | null; error?: string } | { status: 'error'; message: string }
const REFRESH_MS = 60_000
const STALE_MS = 3 * REFRESH_MS

export function TournamentsView() {
  const [state, setState] = useState<FeedState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState(() => hashParam('event') ?? '')
  const [now, setNow] = useState(() => Date.now())
  const refreshSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const response = await fetch('/tournament-data/feed.json', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Tournament feed returned HTTP ${response.status}`)
      const body: unknown = await response.json()
      if (!isTournamentFeed(body)) throw new Error('Tournament feed schema is unsupported or incomplete')
      if (sequence !== refreshSequence.current) return
      setState({ status: 'ready', feed: body, health: null })
      const healthResponse = await fetch('/tournament-data/feed.json.health.json', { cache: 'no-store', signal: AbortSignal.timeout(5_000) }).catch(() => null)
      const healthBody: unknown = healthResponse?.ok ? await healthResponse.json().catch(() => null) : null
      const health = isHealth(healthBody) ? healthBody : null
      if (sequence !== refreshSequence.current) return
      setState((previous) => previous.status === 'ready' && previous.feed === body ? { ...previous, health } : previous)
    } catch (error) {
      if (sequence !== refreshSequence.current) return
      const message = error instanceof Error ? error.message : String(error)
      setState((previous) => previous.status === 'ready' ? { ...previous, error: message } : { status: 'error', message })
    }
  }, [])
  useEffect(() => {
    const sequenceRef = refreshSequence
    const initialTimer = window.setTimeout(() => { void refresh() }, 0)
    const refreshTimer = window.setInterval(() => { void refresh() }, REFRESH_MS)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => { ++sequenceRef.current; window.clearTimeout(initialTimer); window.clearInterval(refreshTimer); window.clearInterval(clockTimer) }
  }, [refresh])
  useEffect(() => {
    const onHashChange = () => setSelectedId(hashParam('event') ?? '')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const events = state.status === 'ready' ? state.feed.events : []
  const selected = events.find((event) => event.id === selectedId) ?? nextEvent(events, now)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  const grouped = useMemo(() => groupTournamentSeries(selected?.series ?? []), [selected])

  if (state.status === 'loading') return <LoadingState presentation="page" label="Loading tournament schedule" />
  if (state.status === 'error') return <div className="px-[var(--page-x)] py-6"><Alert variant="warning" role="alert">Tournament schedule unavailable: {state.message} <Button className="ml-2" onClick={() => void refresh()}>Retry</Button></Alert></div>
  const sourceAge = now - Date.parse(state.health?.checkedAt ?? state.feed.fetchedAt)
  const stale = !state.health || !state.health.complete || !Number.isFinite(sourceAge) || sourceAge > STALE_MS || Boolean(state.error)
  return (
    <div className="grid min-w-0 gap-5 px-[var(--page-x)] py-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <label htmlFor="tournament-event" className="text-sm font-semibold">Competition</label>
          <Select id="tournament-event" className="max-w-full" value={selected?.id ?? ''} onChange={(event) => selectEvent(event.target.value, setSelectedId)}>
            {events.length === 0 ? <option value="">No supported events</option> : null}
            {events.map((event) => <option key={event.id} value={event.id}>{event.label} · {event.sourceTournamentId}</option>)}
          </Select>
        </div>
        <div className="text-sm text-[var(--muted)]">Times shown in {timezone} · Feed last changed {formatTournamentTime(state.feed.fetchedAt, timezone)} · Checked {state.health ? formatTournamentTime(state.health.checkedAt, timezone) : 'unknown'} <Button variant="outline" size="sm" className="ml-2" onClick={() => void refresh()}>Refresh</Button></div>
      </div>
      {stale ? <Alert variant="warning" role="status">Schedule may be stale. Last successful feed change: {formatTournamentTime(state.feed.fetchedAt, timezone)}.{state.error ? ` Latest browser check failed: ${state.error}` : ''}{state.health?.warnings.length ? ` Collector: ${state.health.warnings.join(' ')}` : ''}</Alert> : null}
      {state.feed.dataMode === 'synthetic-fixture' ? <Alert variant="warning" role="status">Local synthetic fixture. These are not official LoL Esports fixtures or results.</Alert> : null}
      {!state.feed.coverage.complete || state.feed.coverage.warnings.length ? (
        <Alert variant="warning" role="status">Coverage {state.feed.coverage.complete ? 'has warnings' : 'is incomplete'} for {state.feed.coverage.start.slice(0, 10)} to {state.feed.coverage.end.slice(0, 10)}. {state.feed.coverage.warnings.join(' ')}</Alert>
      ) : null}
      <p className="text-sm text-[var(--muted)]">Source: LoL Esports public site schedule reference (unsupported API). Series results here are source reported and are separate from scored rankings. Forecast unavailable: rules not verified.</p>
      {!selected ? <Card><CardContent>No supported tournament is in the available schedule window.</CardContent></Card> : (
        <>
          <h2 className="text-lg font-semibold">{selected.label}</h2>
          {(['live', 'upcoming', 'results', 'unresolved'] as const).map((group) => <section key={group} aria-label={group} className="grid gap-3">
            <h3 className="text-base font-semibold capitalize">{group === 'unresolved' ? 'Unresolved results' : group}</h3>
            {grouped[group].length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{grouped[group].map((series) => <SeriesCard key={series.id} series={series} timezone={timezone} />)}</div> : <p className="text-sm text-[var(--muted)]">No {group} series in this schedule window.</p>}
          </section>)}
        </>
      )}
    </div>
  )
}

function SeriesCard({ series, timezone }: { series: TournamentSeries; timezone: string }) {
  const [first, second] = series.teams
  return <Card size="sm">
    <CardHeader><CardTitle>{first?.name ?? 'TBD'} {score(first?.gameWins)}–{score(second?.gameWins)} {second?.name ?? 'TBD'}</CardTitle></CardHeader>
    <CardContent className="grid gap-1 text-sm text-[var(--muted)]">
      <span>{series.stage ?? 'Stage not supplied'} · {series.bestOf ? `Best of ${series.bestOf}` : 'Format not supplied'}</span>
      <span>{series.startTime ? formatTournamentTime(series.startTime, timezone) : 'Start time not supplied'} · {series.status === 'unknown' ? `Source state: ${series.sourceState || 'unknown'}` : series.status}</span>
      {series.vodUrls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="underline">Watch VOD</a>)}
    </CardContent>
  </Card>
}
function score(value: number | null | undefined) { return value ?? '–' }
function nextEvent(events: TournamentEvent[], now: number) {
  const live = events.find((event) => event.series.some((series) => series.status === 'live'))
  if (live) return live
  let nearest: { event: TournamentEvent; startsAt: number } | null = null
  for (const event of events) {
    for (const series of event.series) {
      if (series.status !== 'upcoming') continue
      const startsAt = Date.parse(series.startTime ?? '')
      if (!Number.isFinite(startsAt) || startsAt < now) continue
      if (!nearest || startsAt < nearest.startsAt) nearest = { event, startsAt }
    }
  }
  return nearest?.event ?? events.at(-1)
}
function selectEvent(id: string, update: (value: string) => void) {
  update(id)
  const query = currentHashQuery()
  if (id) query.set('event', id)
  else query.delete('event')
  window.location.hash = `tournaments${query.size ? `?${query}` : ''}`
}
function isHealth(value: unknown): value is FeedHealth {
  if (!value || typeof value !== 'object') return false
  const health = value as Partial<FeedHealth>
  return typeof health.checkedAt === 'string' && typeof health.complete === 'boolean' && Array.isArray(health.warnings)
}
