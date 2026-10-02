import { useEffect, useMemo, useState, type RefObject } from 'react'
import { History, Search } from 'lucide-react'
import type { PublicMatchHistoryEntry, PublicMatchHistorySeriesRef } from '../lib/publicArtifacts/schema'
import type { MatchHistoryState } from '../hooks/usePublicArtifacts'
import { formatDate, formatNumber } from '../lib/display'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { DataState } from '../components/ui'
import { Input } from '../components/ui/input'
import { PageShell, StatCell, StatRibbon } from '../components/ui/page-shell'
import { Pager } from '../components/ui/pager'
import { Panel, PanelBody, PanelFooter, PanelHeader } from '../components/ui/panel'
import { Select } from '../components/ui/select'
import { LoadingState } from '../components/ui/loading'
import { hashInt, hashParam, useHashSync } from '../lib/urlState'
import { compatibleMatchEvents, matchEventLabel } from '../lib/matchLedger'
import { SeriesCards, SeriesTable, type MatchSeries } from '../components/matches/SeriesLedger'

const PAGE_SIZES = [25, 50] as const

type ViewState = {
  scopeKey: string
  search: string
  league: string
  event: string
  pageSize: number
  page: number
}

export function MatchesView({ state, scopeLabel, onRequestPages, searchRef, archiveYears = [], archiveYear, onYearChange }: { archiveYears?: string[]; archiveYear?: string; onYearChange?: (year: string) => void; searchRef?: RefObject<HTMLInputElement | null>; state: MatchHistoryState; scopeLabel: string; onRequestPages: (pages: number[]) => void }) {
  const [view, setView] = useState<ViewState>(readViewState)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const catalog = state.status === 'ready' ? state.data.catalog : undefined
  const refs = useMemo(() => catalog?.series ?? [], [catalog])
  const leagues = useMemo(() => unique(refs.map((match) => match.league)), [refs])
  const events = useMemo(() => compatibleMatchEvents(refs, view.league), [refs, view.league])
  const filtered = useMemo(() => refs.filter((entry) => matchesFilters(entry, view)), [refs, view])
  const filteredGameCount = useMemo(
    () => filtered.reduce((total, entry) => total + entry.gameCount, 0),
    [filtered],
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / view.pageSize))
  const scopeKey = catalog ? `${scopeForFilter(catalog.filter)}:${archiveYear ?? 'All'}` : ''
  const page = view.scopeKey === scopeKey ? Math.min(view.page, pageCount) : 1
  const pageStart = (page - 1) * view.pageSize
  const visibleRefs = filtered.slice(pageStart, pageStart + view.pageSize)
  const neededPages = useMemo(() => [...new Set(visibleRefs.map((entry) => entry.page))], [visibleRefs])
  const neededPagesKey = neededPages.join(',')
  const loadedMatches = useMemo(() => state.status === 'ready' ? neededPages.flatMap((pageNumber) => {
    const pageState = state.data.pages[pageNumber]
    return pageState?.status === 'ready' ? pageState.data.matches : []
  }) : [], [neededPages, state])
  const loadedSeries = useMemo(() => new Map(groupMatchSeries(loadedMatches).map((entry) => [entry.id, entry])), [loadedMatches])
  const visible = visibleRefs.map((entry) => loadedSeries.get(entry.id)).filter((entry): entry is MatchSeries => Boolean(entry))
  const pageFailure = state.status === 'ready' ? neededPages.map((pageNumber) => state.data.pages[pageNumber]).find((entry) => entry?.status === 'error' || entry?.status === 'missing') : undefined
  const pageLoading = state.status === 'ready' && neededPages.some((pageNumber) => {
    const pageState = state.data.pages[pageNumber]
    return !pageState || pageState.status === 'idle' || pageState.status === 'loading'
  })

  useEffect(() => {
    if (neededPagesKey) onRequestPages(neededPagesKey.split(',').map(Number))
  }, [neededPagesKey, onRequestPages])

  // Same helper, same param names and same "omit the default" rule as the
  // other two views.
  useHashSync('matches', {
    matchesYear: archiveYear ?? '',
    team: view.search.trim(),
    league: view.league === 'All' ? '' : view.league,
    event: view.event === 'All' ? '' : view.event,
    page: page > 1 ? String(page) : '',
    size: view.pageSize === PAGE_SIZES[0] ? '' : String(view.pageSize),
  })

  function update(patch: Partial<ViewState>, resetPage = true) {
    setView((current) => ({ ...current, ...patch, scopeKey, ...(resetPage ? { page: 1 } : {}) }))
  }

  function clearFilters() {
    update({ search: '', league: 'All', event: 'All' })
  }

  function toggleSeries(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (state.status === 'idle') {
    return (
      <PageShell>
        <Card><DataState icon={<History size={26} aria-hidden="true" />} title="Match history has not been requested" /></Card>
      </PageShell>
    )
  }
  if (state.status === 'loading') return <LoadingState presentation="page" label="Loading match history" description="Fetching the selected match ledger." />
  if (state.status === 'missing' || state.status === 'error') {
    return (
      <PageShell>
        <Card>
          <DataState
            icon={<History size={26} aria-hidden="true" />}
            title="Match ledger unavailable"
            action={<Button type="button" variant="outline" onClick={() => onRequestPages([1])}>Retry</Button>}
          >
            {state.message}
          </DataState>
        </Card>
      </PageShell>
    )
  }
  const readyCatalog = state.data.catalog
  const publication = `Publication: ${readyCatalog.generatedAt} · Model: ${readyCatalog.modelVersion} / ${readyCatalog.modelConfigHash}`

  const filtersActive = Boolean(view.search.trim()) || view.league !== 'All' || view.event !== 'All'
  const first = filtered.length === 0 ? 0 : pageStart + 1
  const last = pageStart + visibleRefs.length

  return (
    <PageShell
      aria-label="Match history results"
      ribbon={
        <StatRibbon label="Match ledger summary">
          <StatCell icon={<History aria-hidden="true" />} label="Series" value={formatNumber(filtered.length)} detail={`${formatNumber(filteredGameCount)} games`} />
          <StatCell label="Scope" value={scopeLabel} detail="Newest first" />
          <StatCell label="Generated" value={formatDate(readyCatalog.generatedAt)} detail={`${formatNumber(leagues.length)} leagues, ${formatNumber(events.length)} events`} />
        </StatRibbon>
      }
    >
      <Panel>
        <PanelHeader
          title="Series ledger"
          description="Filter by team, league or event. Expand a series to see its games."
        />
        <PanelBody className="grid gap-2 items-end sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_180px_220px_auto]">
          {archiveYears.length > 1 && onYearChange ? <label className="grid min-w-0 gap-1"><span className="text-xs text-[var(--muted)]">Year</span><Select aria-label="Match history year" value={archiveYear ?? 'All'} onChange={(event) => onYearChange(event.target.value)}><option value="All">All years</option>{archiveYears.map((year) => <option key={year} value={year}>{year}</option>)}</Select></label> : null}
          <label className="relative min-w-0">
            <span className="sr-only">Search teams</span><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--faint)]" aria-hidden="true" />
            <Input ref={searchRef} type="search" aria-keyshortcuts="/" className="w-full pl-9" value={view.search} onChange={(event) => update({ search: event.target.value })} placeholder="Search team" />
          </label>
          <label className="grid min-w-0 gap-1"><span className="text-xs text-[var(--muted)]">League</span><Select className="w-full max-w-none" value={view.league} onChange={(event) => { const league = event.target.value; update({ league, event: compatibleMatchEvents(refs, league).includes(view.event) ? view.event : 'All' }) }}><option>All</option>{leagues.map((league) => <option key={league}>{league}</option>)}</Select></label>
          <label className="grid min-w-0 gap-1"><span className="text-xs text-[var(--muted)]">Event</span><Select className="w-full max-w-none" value={view.event} onChange={(event) => update({ event: event.target.value })}><option>All</option>{events.map((event) => <option key={event} value={event}>{matchEventLabel(event)}</option>)}</Select></label>
          {filtersActive ? <Button variant="ghost" onClick={clearFilters}>Clear filters</Button> : null}
        </PanelBody>

        {visibleRefs.length === 0 ? (
          filtersActive ? (
            <DataState icon={<History size={26} aria-hidden="true" />} title="No series match these filters" action={<Button type="button" variant="outline" onClick={clearFilters}>Clear filters</Button>}>
              Try another team, league, or event.
            </DataState>
          ) : (
            <DataState icon={<History size={26} aria-hidden="true" />} title="No series recorded for this scope" />
          )
        ) : (
          <>
            {visible.length > 0 ? (
              <>
                <SeriesTable series={visible} expanded={expanded} onToggle={toggleSeries} publication={publication} />
                <SeriesCards series={visible} expanded={expanded} onToggle={toggleSeries} publication={publication} />
              </>
            ) : null}
            {pageLoading ? <LoadingState presentation="rows" className="m-4" label="Loading matches" description="Fetching the missing rows for this page." /> : null}
            {pageFailure?.status === 'error' || pageFailure?.status === 'missing' ? (
              <Alert className="m-4 w-auto">{pageFailure.message}</Alert>
            ) : null}
          </>
        )}

        <PanelFooter>
          <Pager
            label="Match history pagination"
            page={page}
            pageCount={pageCount}
            onPage={(next) => update({ page: Math.min(Math.max(1, next), pageCount) }, false)}
            pageSize={view.pageSize}
            pageSizes={PAGE_SIZES}
            onPageSize={(size) => update({ pageSize: size })}
            rangeLabel={`${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(filtered.length)}`}
            className="w-full"
          />
        </PanelFooter>
      </Panel>
    </PageShell>
  )
}

function groupMatchSeries(matches: PublicMatchHistoryEntry[]): MatchSeries[] {
  const groups = new Map<string, PublicMatchHistoryEntry[]>()
  for (const match of matches) groups.set(match.seriesId, [...(groups.get(match.seriesId) ?? []), match])
  return [...groups.entries()].map(([id, inputGames]) => {
    const games = inputGames.toSorted((left, right) => left.gameNumber - right.gameNumber || left.id.localeCompare(right.id))
    const summary = games.findLast((game) => game.impact.unit === 'series-applied') ?? games.at(-1)
    if (!summary) throw new Error(`Cannot display empty match series ${id}`)
    return { id, games, summary }
  })
}
function matchesFilters(match: PublicMatchHistorySeriesRef, view: ViewState) { const search = view.search.trim().toLocaleLowerCase(); return (!search || `${match.teamA.name} ${match.teamA.code} ${match.teamB.name} ${match.teamB.code}`.toLocaleLowerCase().includes(search)) && (view.league === 'All' || match.league === view.league) && (view.event === 'All' || match.event === view.event) }
function unique(values: string[]) { return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right)) }
function scopeForFilter(filter: { season: string; checkpoint?: string }) { return filter.season === 'All' ? 'all' : `season:${filter.season}${filter.checkpoint ? `:checkpoint:${filter.checkpoint}` : ''}` }
function readViewState(): ViewState {
  const size = hashInt('size', PAGE_SIZES[0])
  return {
    scopeKey: hashParam('scope') ?? '',
    search: hashParam('team') ?? '',
    league: hashParam('league') ?? 'All',
    event: hashParam('event') ?? 'All',
    pageSize: PAGE_SIZES.includes(size as typeof PAGE_SIZES[number]) ? size : PAGE_SIZES[0],
    page: hashInt('page', 1),
  }
}
