import { useEffect, useMemo, useState } from 'react'
import { currentHashQuery, hashParam, writeNavigationHash } from '../../browser/navigation'
import { FORECASTS_ENABLED, REFRESH_MS, useTournamentResources, type ForecastArtifacts } from '../../browser/tournaments/resources'
import { worldsFeedEventKey } from '../../browser/tournaments/worldsArtifacts'
import { TeamMark } from '../../components/TeamMark'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import { LoadingState } from '../../components/ui/loading'
import { Select } from '../../components/ui/select'
import { forecastTournamentSeries, pinnedForecast, scoreConditionedSeriesOdds, type ForecastReceipt, type TournamentForecast } from '../../domains/tournaments/forecast'
import { formatTournamentTime, groupTournamentSeries, seriesWinner, type TournamentEvent, type TournamentFeed, type TournamentSeries } from '../../domains/tournaments/read'
import { findSwissEvent } from '../../domains/tournaments/simulation'
import { ConditionalPowerPreview } from './ConditionalPowerPreview'
import { SwissPreview } from './SwissPreview'
import { TournamentBracket } from './TournamentBracket'
import { WorldsTournamentPanel } from './WorldsTournamentPanel'

/** The server rechecks Leaguepedia every five minutes while the hub is viewed. */
const STALE_MS = 15 * REFRESH_MS
export function TournamentsView() {
  const { state, now, forecastArtifacts, refresh } = useTournamentResources()
  const [selectedId, setSelectedId] = useState(() => hashParam('event') ?? '')
  const [view, setView] = useState(() => hashParam('view'))
  useEffect(() => {
    const onHashChange = () => { setSelectedId(hashParam('event') ?? ''); setView(hashParam('view')) }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const events = state.status === 'ready' ? state.feed.events : []
  const selected = events.find((event) => event.id === selectedId) ?? nextEvent(events, now)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  const grouped = useMemo(() => groupTournamentSeries(selected?.series ?? []), [selected])

  if (state.status === 'loading') return <LoadingState presentation="page" layout="schedule" delay={false} label="Loading tournament schedule" />
  if (state.status === 'error') return <div className="px-[var(--page-x)] py-6"><Alert variant="warning" role="alert">Tournament schedule unavailable: {state.message} <Button className="ml-2" onClick={() => void refresh()}>Retry</Button></Alert></div>
  const sourceAge = now - Date.parse(state.health?.checkedAt ?? state.feed.fetchedAt)
  const stale = Boolean(state.error) || (state.health
    ? !state.health.complete || !Number.isFinite(sourceAge) || sourceAge > STALE_MS
    : !state.healthPending)
  const swissAvailable = selected !== undefined && selected === findSwissEvent(events)
  const shown: TournamentPanel = view === 'swiss' && swissAvailable ? 'swiss' : view === 'schedule' ? 'schedule' : 'bracket'
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
          {selected ? (
            <div role="group" aria-label="View" className="flex flex-wrap gap-1.5">
              <Button variant="tab" size="tab" aria-pressed={shown === 'bracket'} onClick={() => selectView('bracket', setView)}>Bracket</Button>
              <Button variant="tab" size="tab" aria-pressed={shown === 'schedule'} onClick={() => selectView('schedule', setView)}>Schedule</Button>
              {swissAvailable ? <Button variant="tab" size="tab" aria-pressed={shown === 'swiss'} onClick={() => selectView('swiss', setView)}>Swiss preview</Button> : null}
            </div>
          ) : null}
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Times in {timezone}</span>
          <span className="min-w-[30ch]">Checked {state.health ? formatTournamentTime(state.health.checkedAt, timezone) : state.healthPending ? 'checking…' : 'unknown'}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>Refresh</Button>
        </div>
      </div>
      {stale ? <Alert variant="warning" role="status">
        Schedule may be stale. Feed changed {formatFeedAge(state.feed.fetchedAt, now)}, last checked {state.health ? formatFeedAge(state.health.checkedAt, now) : 'unknown'}.
        {[state.error, ...(state.health?.warnings ?? [])].filter(Boolean).map((warning) => ` ${warning}`).join('')}
        <Button variant="outline" size="sm" className="ml-2" onClick={() => void refresh()}>Retry</Button>
      </Alert> : null}
      {state.feed.dataMode === 'synthetic-fixture' ? <Alert variant="warning" role="status">Test fixture data. Not official LoL Esports results.</Alert> : null}
      {FORECASTS_ENABLED && forecastArtifacts.ledgerWarning ? <Alert variant="warning" role="status">{forecastArtifacts.ledgerWarning}</Alert> : null}
      {!state.feed.coverage.complete || state.feed.coverage.warnings.length ? (
        <Alert variant="warning" role="status">Coverage {state.feed.coverage.complete ? 'has warnings' : 'is incomplete'} for {state.feed.coverage.start.slice(0, 10)} to {state.feed.coverage.end.slice(0, 10)}. {state.feed.coverage.warnings.join(' ')}</Alert>
      ) : null}
      {!selected ? <Card><CardContent>No tournaments in the schedule window.</CardContent></Card> : shown === 'bracket' ? (
        <>
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">{selected.label}</h2>
          <TournamentBracket key={selected.id} series={selected.series} timezone={timezone} />
        </>
      ) : shown === 'swiss' ? (
        <>
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">Worlds 2026 Swiss preview</h2>
          <SwissPreview event={selected}
            playInEvent={events.find((event) => event.competition === 'worlds' && event.season === selected.season && /\/Play-In$/.test(event.sourceTournamentId))}
            checkedAt={state.health?.checkedAt ?? state.feed.fetchedAt} timezone={timezone} />
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">{selected.label}</h2>
          {!FORECASTS_ENABLED ? <p className="text-sm text-muted-foreground">Match forecasts are not enabled for this schedule.</p> : null}
          {FORECASTS_ENABLED && selected.competition === 'worlds' ? <WorldsTournamentPanel
            key={JSON.stringify([worldsFeedEventKey(selected), forecastArtifacts.basis?.snapshotId, forecastArtifacts.basis?.model.version,
              forecastArtifacts.basis?.model.configHash, forecastArtifacts.basis?.ratingDataAsOf, forecastArtifacts.basis?.ratingPublishedAt, forecastArtifacts.basis?.identityMap.revision])}
            event={selected} basis={forecastArtifacts.basis} fixtureFeed={state.feed.dataMode === 'synthetic-fixture'} /> : null}
          {SECTION_ORDER.some((group) => grouped[group].length > 0)
            ? SECTION_ORDER.filter((group) => grouped[group].length > 0).map((group) => <section key={group} aria-label={group} className="grid gap-2">
              <h3 className="flex items-baseline gap-2 text-base font-semibold text-[var(--text-strong)]">{SECTION_TITLES[group]}{' '}<span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{grouped[group].length}</span></h3>
              <SeriesList series={grouped[group]} timezone={timezone} now={now} forecasts={FORECASTS_ENABLED ? forecastArtifacts : null} />
            </section>)
            : <p className="text-sm text-muted-foreground">No series in the schedule window.</p>}
        </>
      )}
      <p className="border-t border-border pt-3 text-xs leading-[1.6] text-muted-foreground"><SourceNote feed={state.feed} event={selected} /></p>
    </div>
  )
}

const SECTION_ORDER = ['live', 'upcoming', 'results', 'unresolved'] as const
const SECTION_TITLES = { live: 'Live', upcoming: 'Upcoming', results: 'Results', unresolved: 'Unresolved results' } as const

function formatFeedAge(timestamp: string, now: number) {
  const age = now - Date.parse(timestamp)
  if (!Number.isFinite(age)) return 'age unknown'
  if (age < 0) return 'timestamp is in the future'
  const minutes = Math.floor(age / REFRESH_MS)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

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
  const winner = seriesWinner(series)
  const winningTeam = winner !== null ? series.teams[winner] : undefined
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
  return <li className="grid gap-x-4 gap-y-0.5 px-3 py-2 md:grid-cols-[8.5rem_6.5rem_minmax(0,1fr)_minmax(0,1fr)] md:items-baseline">
    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground md:contents">
      <span className="font-mono text-foreground tabular-nums">{series.startTime ? formatClock(series.startTime, timezone) : 'Time not supplied'}</span>
      <span>{series.stage ?? 'Stage not supplied'}</span>
    </div>
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 gap-1" aria-hidden="true">
        {[first, second].map((team, index) => team?.name
          ? <TeamMark key={index} team={team.name} code={team.code ?? undefined} fallback="initial" className="size-5" />
          : <span key={index} className="size-5 shrink-0 rounded-sm border border-dashed border-border" />)}
      </span>
      <p className="min-w-0 text-sm text-[var(--text-strong)]">
        <span className={winner === 0 && winningTeam?.name ? 'font-bold' : undefined}>{first?.name ?? 'TBD'}</span> {scored ? <span className="font-mono tabular-nums">{score(first?.gameWins)}–{score(second?.gameWins)}</span> : <span className="text-[var(--faint)]">vs</span>} <span className={winner === 1 && winningTeam?.name ? 'font-bold' : undefined}>{second?.name ?? 'TBD'}</span>
      </p>
    </div>
    <p className="flex min-w-0 flex-wrap gap-x-3 text-xs text-muted-foreground md:justify-end">
      <span>{series.bestOf ? `Best of ${series.bestOf}` : 'Format not supplied'}</span>
      {series.status === 'live' ? <Badge variant="live">Live</Badge> : <span>{series.status === 'unknown' ? `Source state: ${series.sourceState || 'unknown'}` : STATUS_LABELS[series.status]}</span>}
      {winningTeam?.name ? <span className="min-w-0 font-semibold text-[var(--text-strong)]">Winner: {winningTeam.name}</span> : null}
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
  if (feed.source === 'lolesports-persisted-site-api') return <>Source: LoL Esports public schedule.</>
  return <>Source: <a href={leaguepediaPageUrl(event?.sourceTournamentId ?? 'League of Legends Esports Wiki')} target="_blank" rel="noopener noreferrer" className="underline">Leaguepedia</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer" className="underline">CC BY-SA 3.0</a>). Live means the start time has passed and no result is in yet.</>
}
function leaguepediaPageUrl(page: string) {
  return `https://lol.fandom.com/wiki/${page.replaceAll(' ', '_').split('/').map(encodeURIComponent).join('/')}`
}
function score(value: number | null | undefined) { return value ?? '–' }
function percent(value: number) { return `${(value * 100).toFixed(1)}%` }
/** Live first, then the next to start; tracked competitions before other events. */
function nextEvent(events: TournamentEvent[], now: number) {
  const tracked = events.filter((event) => event.competition !== null)
  return liveOrNext(tracked, now) ?? liveOrNext(events, now) ?? events.at(-1)
}
function liveOrNext(events: TournamentEvent[], now: number) {
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
  return nearest?.event
}
function selectEvent(id: string, update: (value: string) => void) {
  update(id)
  const query = currentHashQuery()
  if (id) query.set('event', id)
  else query.delete('event')
  writeNavigationHash(`tournaments${query.size ? `?${query}` : ''}`, 'navigate')
}
type TournamentPanel = 'bracket' | 'schedule' | 'swiss'
function selectView(view: TournamentPanel, update: (value: string | undefined) => void) {
  const value = view === 'bracket' ? undefined : view
  update(value)
  const query = currentHashQuery()
  if (value) query.set('view', value)
  else query.delete('view')
  writeNavigationHash(`tournaments${query.size ? `?${query}` : ''}`, 'navigate')
}
