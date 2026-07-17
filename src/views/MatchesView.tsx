import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, History, Search } from 'lucide-react'
import type { PublicMatchHistoryEntry, PublicMatchHistorySeriesRef } from '../lib/publicArtifacts/schema'
import type { MatchHistoryState } from '../hooks/usePublicArtifacts'
import { formatDate, formatNumber, formatRatio, formatSigned } from '../lib/display'
import { Alert } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { LoadingState } from '../components/ui/loading'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { cn } from '../lib/utils'

const PAGE_SIZES = [25, 50] as const

type ViewState = {
  scopeKey: string
  search: string
  league: string
  event: string
  pageSize: number
  page: number
}

type MatchSeries = {
  id: string
  games: PublicMatchHistoryEntry[]
  summary: PublicMatchHistoryEntry
}

export function MatchesView({ state, scopeLabel, onRequestPages }: { state: MatchHistoryState; scopeLabel: string; onRequestPages: (pages: number[]) => void }) {
  const [view, setView] = useState<ViewState>(readViewState)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const catalog = state.status === 'ready' ? state.data.catalog : undefined
  const refs = useMemo(() => catalog?.series ?? [], [catalog])
  const leagues = useMemo(() => unique(refs.map((match) => match.league)), [refs])
  const events = useMemo(() => unique(refs.map((match) => match.event)), [refs])
  const filtered = useMemo(() => refs.filter((entry) => matchesFilters(entry, view)), [refs, view])
  const filteredGameCount = useMemo(
    () => filtered.reduce((total, entry) => total + entry.gameCount, 0),
    [filtered],
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / view.pageSize))
  const scopeKey = catalog ? scopeForFilter(catalog.filter) : ''
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
  const pageLoading = state.status === 'ready' && neededPages.some((pageNumber) => state.data.pages[pageNumber]?.status !== 'ready')

  useEffect(() => {
    if (neededPagesKey) onRequestPages(neededPagesKey.split(',').map(Number))
  }, [neededPagesKey, onRequestPages])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const [route, queryString = ''] = window.location.hash.slice(1).split('?', 2)
    if (route !== 'matches') return
    const query = new URLSearchParams(queryString)
    setOrDelete(query, 'team', view.search)
    setOrDelete(query, 'league', view.league === 'All' ? '' : view.league)
    setOrDelete(query, 'event', view.event === 'All' ? '' : view.event)
    setOrDelete(query, 'page', page > 1 ? String(page) : '')
    setOrDelete(query, 'size', view.pageSize !== PAGE_SIZES[0] ? String(view.pageSize) : '')
    window.history.replaceState(null, '', `#matches?${query.toString()}`)
  }, [page, view.event, view.league, view.pageSize, view.search])

  function update(patch: Partial<ViewState>, resetPage = true) {
    setView((current) => ({ ...current, ...patch, scopeKey, ...(resetPage ? { page: 1 } : {}) }))
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
    return <section className="px-[var(--page-x)] pt-6"><Alert className="rounded-[var(--r)] border-[var(--line-strong)] bg-[var(--surface)] p-5 text-[var(--muted)]">Match history has not been requested.</Alert></section>
  }
  if (state.status === 'loading') return <LoadingState presentation="page" label="Loading match history" description="Fetching the selected match ledger." />
  if (state.status === 'missing' || state.status === 'error') {
    return <section className="px-[var(--page-x)] pt-6"><Alert className="rounded-[var(--r)] border-[var(--line-strong)] bg-[var(--surface)] p-5 text-[var(--muted)]">{state.message}</Alert></section>
  }
  const readyCatalog = state.data.catalog

  const first = filtered.length === 0 ? 0 : pageStart + 1
  const last = pageStart + visible.length

  return (
    <section className="flex min-w-0 flex-col gap-4 px-[var(--page-x)] pt-6" aria-label="Match history results">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[0.78rem] text-[var(--muted)]">{scopeLabel} · newest first</p>
          <p className="mt-1 text-[0.92rem] font-bold text-[var(--text-strong)]">{formatNumber(filtered.length)} {filtered.length === 1 ? 'match' : 'matches'} <span className="font-normal text-[var(--faint)]">· {formatNumber(filteredGameCount)} {filteredGameCount === 1 ? 'game' : 'games'}</span></p>
        </div>
        <p className="text-[0.72rem] text-[var(--faint)]">Generated {formatDate(readyCatalog.generatedAt)}</p>
      </div>

      <Card className="grid gap-2 rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] p-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_180px_220px_140px]">
        <label className="relative min-w-0">
          <span className="sr-only">Search teams</span><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--faint)]" aria-hidden="true" />
          <Input className="w-full pl-9" value={view.search} onChange={(event) => update({ search: event.target.value })} placeholder="Search team" />
        </label>
        <label className="grid min-w-0 gap-1"><span className="sr-only">League</span><Select className="w-full max-w-none" value={view.league} onChange={(event) => update({ league: event.target.value })}><option>All</option>{leagues.map((league) => <option key={league}>{league}</option>)}</Select></label>
        <label className="grid min-w-0 gap-1"><span className="sr-only">Event</span><Select className="w-full max-w-none" value={view.event} onChange={(event) => update({ event: event.target.value })}><option>All</option>{events.map((event) => <option key={event}>{event}</option>)}</Select></label>
        <label className="grid min-w-0 gap-1"><span className="sr-only">Matches per page</span><Select className="w-full max-w-none" value={view.pageSize} onChange={(event) => update({ pageSize: Number(event.target.value) })}>{PAGE_SIZES.map((size) => <option value={size} key={size}>{size} per page</option>)}</Select></label>
      </Card>

      {visibleRefs.length === 0 ? (
        <Card className="grid min-h-44 place-items-center rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] p-6 text-center"><div><History className="mx-auto mb-3 text-[var(--faint)]" aria-hidden="true" /><h2 className="font-bold text-[var(--text-strong)]">No matches fit these filters</h2><p className="mt-1 text-sm text-[var(--muted)]">Try another team, league, or event.</p></div></Card>
      ) : pageFailure?.status === 'error' || pageFailure?.status === 'missing' ? (
        <Alert className="rounded-[var(--r)] border-[var(--line-strong)] bg-[var(--surface)] p-5 text-[var(--muted)]">{pageFailure.message}</Alert>
      ) : (
        <>
          {visible.length > 0 ? (
            <>
              <Card className="hidden overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] md:block">
                <Table containerClassName="overflow-x-auto">
                  <TableHeader><TableRow className="border-[var(--line)] bg-[var(--surface-2)] hover:bg-[var(--surface-2)]"><TableHead>Date</TableHead><TableHead>Competition</TableHead><TableHead>Outcome</TableHead><TableHead>Score</TableHead><TableHead>Power impact</TableHead><TableHead>Context</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
                  <TableBody>{visible.map((entry) => <DesktopSeriesRows series={entry} expanded={expanded.has(entry.id)} onToggle={() => toggleSeries(entry.id)} key={entry.id} />)}</TableBody>
                </Table>
              </Card>
              <div className="grid gap-2 md:hidden">{visible.map((entry) => <MobileSeriesCard series={entry} expanded={expanded.has(entry.id)} onToggle={() => toggleSeries(entry.id)} key={entry.id} />)}</div>
            </>
          ) : null}
          {pageLoading ? <LoadingState presentation="rows" label="Loading matches" description="Fetching the missing rows for this page." /> : null}
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-[0.78rem] text-[var(--muted)]" aria-label="Match history pagination">
        <span>{formatNumber(first)}–{formatNumber(last)} of {formatNumber(filtered.length)}</span>
        <div className="flex items-center gap-2"><Button variant="outline" size="icon" onClick={() => update({ page: Math.max(1, page - 1) }, false)} disabled={page === 1} aria-label="Previous page"><ChevronLeft /></Button><span className="min-w-20 text-center font-semibold text-[var(--text)]">Page {page} of {pageCount}</span><Button variant="outline" size="icon" onClick={() => update({ page: Math.min(pageCount, page + 1) }, false)} disabled={page === pageCount} aria-label="Next page"><ChevronRight /></Button></div>
      </div>
    </section>
  )
}

function DesktopSeriesRows({ series, expanded, onToggle }: { series: MatchSeries; expanded: boolean; onToggle: () => void }) {
  const match = series.summary
  const winner = match.winnerId === match.teamA.id ? match.teamA : match.teamB
  const loser = winner.id === match.teamA.id ? match.teamB : match.teamA
  const score = winner.id === match.teamA.id ? [match.seriesWinsA, match.seriesWinsB] : [match.seriesWinsB, match.seriesWinsA]
  const expandable = series.games.length > 1
  return <Fragment><TableRow className={cn('border-[var(--line)] hover:bg-[var(--surface-2)]', expandable && 'cursor-pointer')} aria-expanded={expandable ? expanded : undefined} onClick={expandable ? onToggle : undefined}><TableCell className="text-[var(--muted)]">{formatDate(match.datetimeUtc ?? match.date)}</TableCell><TableCell><b className="block max-w-48 overflow-hidden text-ellipsis text-[var(--text-strong)]">{match.event}</b><Badge className="mt-1" variant="secondary">{match.league}</Badge></TableCell><TableCell><span className="mr-2 inline-grid size-6 place-items-center rounded-full bg-[var(--win-soft)] text-[0.68rem] font-extrabold text-[var(--win)]">W</span><b className="text-[var(--win)]">{winner.name}</b><small className="mt-1 block pl-8 text-[var(--muted)]">{loser.name}</small></TableCell><TableCell className="font-extrabold text-[var(--text-strong)]">{score[0]}–{score[1]}</TableCell><TableCell><Impact match={match} /></TableCell><TableCell><span className="inline-flex items-center gap-1">Bo{match.bestOf}{expandable ? <Button type="button" variant="ghost" size="icon-xs" className="size-6" onClick={(event) => { event.stopPropagation(); onToggle() }} aria-label={`${expanded ? 'Hide' : 'Show'} games in ${winner.name} versus ${loser.name}`}><ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} /></Button> : null}</span><small className="mt-1 block text-[var(--faint)]">{series.games.length} {series.games.length === 1 ? 'game' : 'games'} · {match.patch || 'Patch unknown'}</small></TableCell><TableCell><Badge variant="secondary">{providerLabel(match.source.provider)}</Badge></TableCell></TableRow>{expanded ? series.games.map((game) => <DesktopGameRow game={game} key={game.id} />) : null}</Fragment>
}

function DesktopGameRow({ game }: { game: PublicMatchHistoryEntry }) {
  const aWon = game.winnerId === game.teamA.id
  return <TableRow className="border-dotted border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_62%,transparent)] hover:bg-[var(--surface-2)]"><TableCell className="pl-7 text-[var(--faint)]">↳ Game {game.gameNumber}</TableCell><TableCell className="text-[var(--faint)]">{game.patch || 'Patch unknown'}</TableCell><TableCell><b className="text-[var(--text)]">{aWon ? game.teamA.name : game.teamB.name}</b><small className="mt-1 block text-[var(--faint)]">def. {aWon ? game.teamB.name : game.teamA.name}</small></TableCell><TableCell className="font-bold">1–0</TableCell><TableCell className="text-[var(--faint)]">Result evidence</TableCell><TableCell className="text-[var(--faint)]">Series after game: {game.seriesWinsA}–{game.seriesWinsB}</TableCell><TableCell><Badge variant="secondary">{providerLabel(game.source.provider)}</Badge></TableCell></TableRow>
}

function MobileSeriesCard({ series, expanded, onToggle }: { series: MatchSeries; expanded: boolean; onToggle: () => void }) {
  const match = series.summary
  const aWon = match.winnerId === match.teamA.id
  const expandable = series.games.length > 1
  return <Card className="overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)]"><button type="button" className={cn('w-full p-3.5 text-left', expandable ? 'cursor-pointer' : 'cursor-default')} onClick={expandable ? onToggle : undefined} aria-expanded={expandable ? expanded : undefined}><div className="flex justify-between gap-3 text-[0.72rem] text-[var(--faint)]"><span>{formatDate(match.datetimeUtc ?? match.date)} · {match.event}</span><span className="inline-flex items-center gap-1">Bo{match.bestOf}{expandable ? <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} /> : null}</span></div><div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm"><b className={aWon ? 'text-[var(--win)]' : 'text-[var(--text)]'}>{match.teamA.name}</b><b>{match.seriesWinsA}</b><b className={!aWon ? 'text-[var(--win)]' : 'text-[var(--text)]'}>{match.teamB.name}</b><b>{match.seriesWinsB}</b></div><p className="mt-2 text-[0.72rem] text-[var(--faint)]">{series.games.length} {series.games.length === 1 ? 'game' : 'games'} · {match.patch || 'Patch unknown'}</p><div className="mt-2 border-t border-dotted border-[var(--line)] pt-2"><Impact match={match} /></div></button>{expanded ? <div className="border-t border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_62%,transparent)] px-3.5 py-1">{series.games.map((game) => { const gameAWon = game.winnerId === game.teamA.id; return <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-dotted border-[var(--line)] py-2 first:border-0" key={game.id}><span className="text-[0.7rem] text-[var(--faint)]">G{game.gameNumber}</span><span className="truncate text-[0.78rem] text-[var(--text)]">{gameAWon ? game.teamA.name : game.teamB.name} def. {gameAWon ? game.teamB.name : game.teamA.name}</span><b className="text-[0.75rem]">1–0</b></div> })}</div> : null}</Card>
}

function Impact({ match }: { match: PublicMatchHistoryEntry }) {
  if (match.impact.unit === 'held') return <div><b className="text-[0.78rem] text-[var(--text)]">Result evidence recorded</b><small className="block text-[0.68rem] text-[var(--faint)]">Power impact held until series completion</small></div>
  if (!hasConsistentImpactDirection(match)) return <div><b className="text-[0.78rem] text-[var(--warn)]">Power impact unavailable</b><small className="block text-[0.68rem] text-[var(--faint)]">Artifact consistency check failed</small></div>
  const context = [typeof match.impact.expectedTeamA === 'number' ? `${match.teamA.code} expected ${formatRatio(match.impact.expectedTeamA)}` : '', typeof match.impact.eventWeight === 'number' ? `${formatNumber(match.impact.eventWeight)}× event weight` : ''].filter(Boolean).join(' · ')
  return <div className="tabular-nums"><b className={cn('mr-2', impactTone(match.impact.teamA))}>{match.teamA.code} {formatImpact(match.impact.teamA)}</b><b className={impactTone(match.impact.teamB)}>{match.teamB.code} {formatImpact(match.impact.teamB)}</b><small className="block text-[0.68rem] text-[var(--faint)]" title={context || undefined}>Series impact applied{context ? ` · ${context}` : ''}</small></div>
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
function hasConsistentImpactDirection(match: PublicMatchHistoryEntry) {
  const { teamA, teamB } = match.impact
  if (typeof teamA !== 'number' || typeof teamB !== 'number' || (teamA === 0 && teamB === 0)) return false
  return match.winnerId === match.teamA.id ? teamA >= 0 && teamB <= 0 : teamB >= 0 && teamA <= 0
}
function unique(values: string[]) { return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right)) }
function impactTone(value: number | undefined) { return typeof value !== 'number' ? 'text-[var(--faint)]' : value > 0 ? 'text-[var(--up)]' : value < 0 ? 'text-[var(--down)]' : 'text-[var(--faint)]' }
function formatImpact(value: number | undefined) { return typeof value === 'number' ? formatSigned(Number(value.toFixed(1))) : '—' }
function providerLabel(provider: PublicMatchHistoryEntry['source']['provider']) { return provider === 'oracles-elixir' ? "Oracle's Elixir" : provider === 'leaguepedia-cargo' ? 'Leaguepedia' : 'Seed' }
function setOrDelete(query: URLSearchParams, key: string, value: string) { if (value) query.set(key, value); else query.delete(key) }
function scopeForFilter(filter: { season: string; checkpoint?: string }) { return filter.season === 'All' ? 'all' : `season:${filter.season}${filter.checkpoint ? `:checkpoint:${filter.checkpoint}` : ''}` }
function readViewState(): ViewState { if (typeof window === 'undefined') return { scopeKey: '', search: '', league: 'All', event: 'All', pageSize: 25, page: 1 }; const query = new URLSearchParams(window.location.hash.slice(1).split('?', 2)[1] ?? ''); const size = Number(query.get('size')); const page = Number(query.get('page')); return { scopeKey: query.get('scope') ?? '', search: query.get('team') ?? '', league: query.get('league') ?? 'All', event: query.get('event') ?? 'All', pageSize: PAGE_SIZES.includes(size as typeof PAGE_SIZES[number]) ? size : 25, page: Number.isInteger(page) && page > 0 ? page : 1 } }
