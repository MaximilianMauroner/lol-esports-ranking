import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Select } from '../components/ui/select'
import { LoadingState } from '../components/ui/loading'
import { currentHashQuery, hashParam } from '../lib/urlState'
import { loadTournamentForecastArtifacts, loadTournamentForecastLedger } from '../lib/tournamentForecastArtifacts'
import { emptyForecastLedger, forecastTournamentSeries, pinnedForecast, scoreConditionedSeriesOdds, type ForecastBasis, type ForecastLedger, type ForecastReceipt, type TournamentForecast } from '../lib/tournamentForecast'
import { ConditionalPowerPreview } from '../components/ConditionalPowerPreview'
import { WorldsTournamentPanel } from '../components/WorldsTournamentPanel'
import { SwissPreview } from '../components/SwissPreview'
import { findSwissEvent } from '../lib/swissScenario'
import { worldsFeedEventKey } from '../lib/worldsArtifacts'
import type { ConditionalPowerResultLedger } from '../lib/conditionalPowerResultReceipts'
import { formatTournamentTime, groupTournamentSeries, isTournamentFeed, type TournamentEvent, type TournamentFeed, type TournamentSeries } from '../lib/tournamentFeed'

type FeedHealth = { checkedAt: string; complete: boolean; warnings: string[] }
type FeedState = { status: 'loading' } | { status: 'ready'; feed: TournamentFeed; health: FeedHealth | null; error?: string } | { status: 'error'; message: string }
const REFRESH_MS = 60_000
/** The server rechecks Leaguepedia every five minutes while the hub is viewed. */
const STALE_MS = 15 * REFRESH_MS
const FORECASTS_ENABLED = import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED === '1'
type ForecastArtifacts = { basis: ForecastBasis | null; ledger: ForecastLedger; powerPreviews?: ConditionalPowerResultLedger | null; reason?: string; ledgerWarning?: string }

export function TournamentsView() {
  const [state, setState] = useState<FeedState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState(() => hashParam('event') ?? '')
  const [view, setView] = useState(() => hashParam('view'))
  const [now, setNow] = useState(() => Date.now())
  const [forecastArtifacts, setForecastArtifacts] = useState<ForecastArtifacts>({ basis: null, ledger: emptyForecastLedger, reason: 'Forecast inputs are loading.' })
  const refreshSequence = useRef(0)
  const basisLoading = useRef(false)
  const basisNextRefreshAt = useRef(0)
  const basisGeneration = useRef(0)

  useEffect(() => {
    const generationRef = basisGeneration
    return () => { ++generationRef.current }
  }, [])

  const refreshBasisIfDue = useCallback(() => {
    if (!FORECASTS_ENABLED || basisLoading.current || Date.now() < basisNextRefreshAt.current) return
    basisLoading.current = true
    const generation = basisGeneration.current
    void loadTournamentForecastArtifacts().then((loaded) => {
      basisLoading.current = false
      if (generation !== basisGeneration.current) {
        basisNextRefreshAt.current = 0
        return
      }
      basisNextRefreshAt.current = Date.now() + (loaded.basis ? 10 * REFRESH_MS : REFRESH_MS)
      setForecastArtifacts((previous) => ({ ...previous, ...loaded }))
    })
  }, [])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    refreshBasisIfDue()
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
      if (FORECASTS_ENABLED) {
        try {
          const ledger = await loadTournamentForecastLedger()
          if (sequence !== refreshSequence.current) return
          setForecastArtifacts((previous) => ({ ...previous, ledger, ledgerWarning: undefined }))
        } catch {
          if (sequence !== refreshSequence.current) return
          setForecastArtifacts((previous) => ({ ...previous, ledgerWarning: 'Forecast receipt check failed; showing the last valid ledger.' }))
        }
      }
    } catch (error) {
      if (sequence !== refreshSequence.current) return
      const message = error instanceof Error ? error.message : String(error)
      setState((previous) => previous.status === 'ready' ? { ...previous, error: message } : { status: 'error', message })
    }
  }, [refreshBasisIfDue])
  useEffect(() => {
    const sequenceRef = refreshSequence
    const initialTimer = window.setTimeout(() => { void refresh() }, 0)
    const refreshTimer = window.setInterval(() => { void refresh() }, REFRESH_MS)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => { ++sequenceRef.current; window.clearTimeout(initialTimer); window.clearInterval(refreshTimer); window.clearInterval(clockTimer) }
  }, [refresh])
  useEffect(() => {
    const onHashChange = () => { setSelectedId(hashParam('event') ?? ''); setView(hashParam('view')) }
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
  const swissAvailable = selected !== undefined && selected === findSwissEvent(events)
  const showSwiss = view === 'swiss' && swissAvailable
  return (
    <div className="grid min-w-0 gap-5 px-[var(--page-x)] py-5">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
          <div className="grid min-w-0 gap-1">
            <label htmlFor="tournament-event" className="text-sm font-semibold">Competition</label>
            <Select id="tournament-event" className="max-w-full" value={selected?.id ?? ''} onChange={(event) => selectEvent(event.target.value, setSelectedId)}>
              {events.length === 0 ? <option value="">No supported events</option> : null}
              {events.map((event) => <option key={event.id} value={event.id}>{event.label}{events.some((other) => other !== event && other.label === event.label) ? ` · ${event.sourceTournamentId}` : ''}</option>)}
            </Select>
          </div>
          {swissAvailable ? (
            <div role="group" aria-label="View" className="flex gap-1.5">
              <Button variant="tab" size="tab" aria-pressed={!showSwiss} onClick={() => selectView('schedule', setView)}>Schedule</Button>
              <Button variant="tab" size="tab" aria-pressed={showSwiss} onClick={() => selectView('swiss', setView)}>Swiss preview</Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Times in {timezone}</span>
          <span>Feed changed {formatTournamentTime(state.feed.fetchedAt, timezone)}</span>
          <span>Checked {state.health ? formatTournamentTime(state.health.checkedAt, timezone) : 'unknown'}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>Refresh</Button>
        </div>
      </div>
      {stale ? <Alert variant="warning" role="status">Schedule may be stale. Last successful feed change: {formatTournamentTime(state.feed.fetchedAt, timezone)}.{state.error ? ` Latest browser check failed: ${state.error}` : ''}{state.health?.warnings.length ? ` Collector: ${state.health.warnings.join(' ')}` : ''}</Alert> : null}
      {state.feed.dataMode === 'synthetic-fixture' ? <Alert variant="warning" role="status">Local synthetic fixture. These are not official LoL Esports fixtures or results.</Alert> : null}
      {FORECASTS_ENABLED && forecastArtifacts.ledgerWarning ? <Alert variant="warning" role="status">{forecastArtifacts.ledgerWarning}</Alert> : null}
      {!state.feed.coverage.complete || state.feed.coverage.warnings.length ? (
        <Alert variant="warning" role="status">Coverage {state.feed.coverage.complete ? 'has warnings' : 'is incomplete'} for {state.feed.coverage.start.slice(0, 10)} to {state.feed.coverage.end.slice(0, 10)}. {state.feed.coverage.warnings.join(' ')}</Alert>
      ) : null}
      {!selected ? <Card><CardContent>No supported tournament is in the available schedule window.</CardContent></Card> : showSwiss ? (
        <>
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">Worlds 2026 Swiss preview</h2>
          <SwissPreview event={selected} checkedAt={state.health?.checkedAt ?? state.feed.fetchedAt} timezone={timezone} />
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">{selected.label}</h2>
          {FORECASTS_ENABLED && selected.competition === 'worlds' ? <WorldsTournamentPanel
            key={JSON.stringify([worldsFeedEventKey(selected), forecastArtifacts.basis?.snapshotId, forecastArtifacts.basis?.model.version,
              forecastArtifacts.basis?.model.configHash, forecastArtifacts.basis?.ratingDataAsOf, forecastArtifacts.basis?.ratingPublishedAt, forecastArtifacts.basis?.identityMap.revision])}
            event={selected} basis={forecastArtifacts.basis} fixtureFeed={state.feed.dataMode === 'synthetic-fixture'} /> : null}
          {(['live', 'upcoming', 'results', 'unresolved'] as const).map((group) => <section key={group} aria-label={group} className="grid gap-2">
            <h3 className="flex items-baseline gap-2 text-base font-semibold">{SECTION_TITLES[group]}{' '}<span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{grouped[group].length}</span></h3>
            {grouped[group].length
              ? <SeriesList series={grouped[group]} timezone={timezone} now={now} forecasts={FORECASTS_ENABLED ? forecastArtifacts : null} />
              : <p className="text-sm text-muted-foreground">No {group} series in this schedule window.</p>}
          </section>)}
        </>
      )}
      <p className="border-t border-border pt-3 text-xs leading-[1.6] text-muted-foreground"><SourceNote feed={state.feed} event={selected} /> Series results here are source reported and are separate from scored rankings. {FORECASTS_ENABLED ? 'Match estimates use a separately dated Power snapshot. Worlds advancement requires a coherent, reviewed per-season state companion.' : 'Forecast unavailable: rules not verified.'}</p>
    </div>
  )
}

const SECTION_TITLES = { live: 'Live', upcoming: 'Upcoming', results: 'Results', unresolved: 'Unresolved results' } as const

/** Series grouped under one heading per local day, in feed order. */
function SeriesList({ series, timezone, now, forecasts }: { series: TournamentSeries[]; timezone: string; now: number; forecasts: ForecastArtifacts | null }) {
  const days: Array<{ label: string; series: TournamentSeries[] }> = []
  for (const entry of series) {
    const label = entry.startTime ? formatDay(entry.startTime, timezone) : 'Date not supplied'
    const day = days.find((candidate) => candidate.label === label)
    if (day) day.series.push(entry)
    else days.push({ label, series: [entry] })
  }
  return <div className="grid gap-3">
    {days.map((day) => <div key={day.label} className="grid gap-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground">{day.label}</h4>
      <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {day.series.map((entry) => <SeriesRow key={entry.id} series={entry} timezone={timezone} now={now} forecasts={forecasts} />)}
      </ol>
    </div>)}
  </div>
}

function SeriesRow({ series, timezone, now, forecasts }: { series: TournamentSeries; timezone: string; now: number; forecasts: ForecastArtifacts | null }) {
  const [first, second] = series.teams
  const scheduledStartPassed = !series.startTime || now >= Date.parse(series.startTime)
  const forecast = useMemo<TournamentForecast | ForecastReceipt | null>(() => {
    if (!forecasts) return null
    if (series.status === 'upcoming') {
      if (scheduledStartPassed) return { status: 'unavailable', reason: 'already-started', detail: 'Scheduled start has passed; a new pre-match estimate is withheld.' }
      return forecasts.basis ? forecastTournamentSeries(series, forecasts.basis)
        : { status: 'unavailable', reason: 'stale-model-basis', detail: forecasts.reason ?? 'Current ratings are unavailable.' }
    }
    return pinnedForecast(forecasts.ledger, series)
  }, [forecasts, scheduledStartPassed, series])
  const receipt = forecast?.status === 'ready' && 'receiptKey' in forecast ? forecast : null
  const conditional = receipt && (series.status === 'live' || series.status === 'completed') ? scoreConditionedSeriesOdds(receipt, series) : null
  const scored = first?.gameWins != null || second?.gameWins != null
  return <li className="grid gap-x-4 gap-y-0.5 px-3 py-2 md:grid-cols-[8.5rem_6.5rem_minmax(0,1fr)_auto] md:items-baseline">
    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground md:contents">
      <span className="font-mono text-foreground tabular-nums">{series.startTime ? formatClock(series.startTime, timezone) : 'Time not supplied'}</span>
      <span>{series.stage ?? 'Stage not supplied'}</span>
    </div>
    <p className="min-w-0 text-sm font-semibold text-[var(--text-strong)]">
      {first?.name ?? 'TBD'} {scored ? <span className="font-mono tabular-nums">{score(first?.gameWins)}–{score(second?.gameWins)}</span> : <span className="font-normal text-[var(--faint)]">vs</span>} {second?.name ?? 'TBD'}
    </p>
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground md:justify-end">
      <span>{series.bestOf ? `Best of ${series.bestOf}` : 'Format not supplied'}</span>
      <span>{series.status === 'unknown' ? `Source state: ${series.sourceState || 'unknown'}` : STATUS_LABELS[series.status]}</span>
      {series.vodUrls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="underline">Watch VOD</a>)}
    </p>
    {forecasts ? <div className="grid min-w-0 gap-1 md:col-span-2 md:col-start-3">
      {forecast ? <div className="mt-1 grid gap-1 border-t border-border pt-2 text-sm text-muted-foreground">
        {forecast.status === 'ready' ? <>
          <strong className="text-foreground">{receipt ? 'Published pre-match forecast' : 'Current model estimate · not archived'}</strong>
          <span>Game win: {first?.name ?? 'Home'} {percent(forecast.homeGameWinProbability)} · {second?.name ?? 'Away'} {percent(forecast.awayGameWinProbability)}</span>
          <span>Series win (Bo{forecast.bestOf}): {first?.name ?? 'Home'} {percent(forecast.homeSeriesWinProbability)} · {second?.name ?? 'Away'} {percent(forecast.awaySeriesWinProbability)}</span>
          {conditional?.status === 'ready' ? <span>Score-conditioned series odds: {percent(conditional.homeSeriesWinProbability)} · {percent(conditional.awaySeriesWinProbability)}. Uses the frozen pre-series model, not in-game telemetry.</span> : null}
          {conditional?.status === 'unavailable' ? <span>Score-conditioned odds unavailable: {conditional.detail}</span> : null}
          <span>Power data through {forecast.ratingDataAsOf.slice(0, 10)} · Published {formatTournamentTime(forecast.ratingPublishedAt, timezone)} · Model {forecast.modelVersion} / {forecast.modelConfigHash} · Snapshot {forecast.snapshotId}</span>
          <span>{forecast.sideBasis} {receipt ? `Receipt published ${formatTournamentTime(receipt.publishedAt, timezone)} before the scheduled start, while source state was upcoming. Not certified for out-of-sample evaluation.` : ''}</span>
          {forecast.warnings.map((warning) => <span key={warning}>{warning}</span>)}
          <a href="#matches" className="underline">Rating evidence ledger</a>
        </> : <span>Forecast unavailable: {forecast.detail}</span>}
      </div> : null}
      <div className="text-sm text-muted-foreground"><ConditionalPowerPreview key={JSON.stringify([series, forecast, forecasts.powerPreviews])} series={series} forecast={forecast} now={now} basis={forecasts.basis} powerPreviews={forecasts.powerPreviews} /></div>
    </div> : null}
  </li>
}
const STATUS_LABELS = { upcoming: 'Upcoming', live: 'Live', completed: 'Completed', postponed: 'Postponed', cancelled: 'Cancelled', unknown: 'Unknown' } as const
function formatDay(value: string, timezone: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone }).format(date) : 'Date not supplied'
}
function formatClock(value: string, timezone: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone, timeZoneName: 'short' }).format(date) : 'Unknown time'
}
function SourceNote({ feed, event }: { feed: TournamentFeed; event: TournamentEvent | undefined }) {
  if (feed.source === 'lolesports-persisted-site-api') return <>Source: LoL Esports public site schedule reference (unsupported API).</>
  return <>Source: <a href={leaguepediaPageUrl(event?.sourceTournamentId ?? 'League of Legends Esports Wiki')} target="_blank" rel="noopener noreferrer" className="underline">Leaguepedia</a>, licensed under <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer" className="underline">CC BY-SA 3.0</a>. Live status means the scheduled start has passed and no result is entered yet.</>
}
function leaguepediaPageUrl(page: string) {
  return `https://lol.fandom.com/wiki/${page.replaceAll(' ', '_').split('/').map(encodeURIComponent).join('/')}`
}
function score(value: number | null | undefined) { return value ?? '–' }
function percent(value: number) { return `${(value * 100).toFixed(1)}%` }
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
function selectView(view: 'schedule' | 'swiss', update: (value: string | undefined) => void) {
  const value = view === 'swiss' ? view : undefined
  update(value)
  const query = currentHashQuery()
  if (value) query.set('view', value)
  else query.delete('view')
  window.location.hash = `tournaments${query.size ? `?${query}` : ''}`
}
function isHealth(value: unknown): value is FeedHealth {
  if (!value || typeof value !== 'object') return false
  const health = value as Partial<FeedHealth>
  return typeof health.checkedAt === 'string' && typeof health.complete === 'boolean' && Array.isArray(health.warnings)
}
