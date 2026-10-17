import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { AlertTriangle, BarChart3, CalendarDays, Globe2, History, RefreshCw, Search } from 'lucide-react'
import type { SnapshotCheckpointOption, PublicTeamStanding as RankingSummaryStanding } from './domains/rankings/types'
import type { PublicSnapshotState } from './browser/rankings/published/resolver'
import {
  formatDate,
  formatRating,
  teamKey,
} from './shared/display'
import type { RegionStrength } from './domains/rankings/read'
import {
  REGION_COMPARE_ROWS,
  TEAM_COMPARE_ROWS,
  regionCompareColumns,
  regionKey,
  teamCompareColumns,
} from './views/rankings/compareAnalysisData'
import { TeamsView, type PlayerLoadState } from './views/rankings/TeamsView'
import { DataState, RegionBadge } from './components/ui'
import { ScopeBar } from './views/rankings/ScopeBar'
import { CompareDock, type CompareDockEntity } from './views/rankings/CompareDock'
import { HeadToHead } from './views/rankings/HeadToHead'
import { Button, buttonVariants } from './components/ui/button'
import { Input } from './components/ui/input'
import { Alert } from './components/ui/alert'
import { Card } from './components/ui/card'
import { LoadingState, type PageLayout } from './components/ui/loading'
import { TooltipProvider } from './components/ui/tooltip'
import { RegionCompareDrawer, TeamCompareDrawer } from './views/rankings/CompareDrawer'
import { currentSeasonScope } from './domains/rankings/read'
import { emptyPlayerScope, resolvePlayerScope } from './domains/rankings/read'
import { PROJECT_FEEDBACK_URL, PROJECT_REPOSITORY_URL, RIOT_PROJECT_NOTICE } from './data/legal'
import { tournamentIdFromFilter, type TournamentFilterValue } from './domains/rankings/evidence'
import { deriveRankingUniverse } from './domains/rankings/read'
import { cn } from './shared/utils'
import { currentHashQuery, hashParam } from './browser/navigation'
import { canUseBackgroundPrefetch, scheduleIdleWork } from './browser/rankings/prefetch'
import { initialModeFromLocation, showsManifestErrorInAppShell, type AppMode } from './browser/bootstrap'
import {
  checkpointFromScope,
  checkpointOptionsForSeason,
  checkpointScope,
  scopeLabel,
  seasonFromScope,
  usePublicArtifacts,
} from './browser/rankings/usePublicArtifacts'

type Mode = AppMode
type MovementBaseline = {
  label: string
}
const COMPARE_LIMIT = 4
const CHECKPOINT_SEQUENCE = ['split-1', 'split-2', 'split-3'] as const
const loadRegionsView = () => import('./views/regions/RegionsView').then((module) => ({ default: module.RegionsView }))
const loadMatchesView = () => import('./views/matches/MatchesView').then((module) => ({ default: module.MatchesView }))
const loadTournamentsView = () => import('./views/tournaments/TournamentsView').then((module) => ({ default: module.TournamentsView }))
const loadCompareAnalysis = () => import('./views/rankings/CompareAnalysis')
const RegionsView = lazy(loadRegionsView)
const MatchesView = lazy(loadMatchesView)
const TournamentsView = lazy(loadTournamentsView)
const RegionCompareAnalysis = lazy(() => loadCompareAnalysis().then((module) => ({ default: module.RegionCompareAnalysis })))
const TeamCompareAnalysis = lazy(() => loadCompareAnalysis().then((module) => ({ default: module.TeamCompareAnalysis })))
const VIEW_LOADERS = {
  rankings: undefined,
  regions: loadRegionsView,
  matches: loadMatchesView,
  tournaments: loadTournamentsView,
}

function preloadView(mode: Mode) {
  const load = VIEW_LOADERS[mode]
  if (load) void load().catch(() => { /* Navigation can retry a failed preload. */ })
}

function preloadComparison() {
  void loadCompareAnalysis().catch(() => { /* Opening the drawer retries. */ })
}

const MODES: { id: Mode; label: string; icon: typeof BarChart3 }[] = [
  { id: 'rankings', label: 'Rankings', icon: BarChart3 },
  { id: 'regions', label: 'Regions', icon: Globe2 },
  { id: 'matches', label: 'Matches', icon: History },
  { id: 'tournaments', label: 'Tournaments', icon: CalendarDays },
]

/** One title per view and one short line that says what the numbers are. */
/** The skeleton each view shows while its data loads. */
const PAGE_LAYOUTS: Record<Mode, PageLayout> = { rankings: 'board', regions: 'regions', matches: 'ledger', tournaments: 'schedule' }

const MODE_TITLES: Record<Mode, { title: string; intro: string }> = {
  rankings: {
    title: 'Team Power Index',
    intro: 'Match results weighted by opponent and event. Higher is stronger.',
  },
  regions: {
    title: 'Region power',
    intro: 'Average Power of each region\u2019s top three teams.',
  },
  matches: {
    title: 'Match history',
    intro: 'Every rated series, newest first.',
  },
  tournaments: {
    title: 'Tournaments',
    intro: 'Leaguepedia schedule and the Worlds Swiss preview. Not part of the Power Index.',
  },
}


function App() {
  const [route, setRoute] = useState<Mode>(readModeFromHash)
  useEffect(() => {
    const onHashChange = () => startTransition(() => setRoute(readModeFromHash()))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return <TooltipProvider>
    <Suspense fallback={<ManifestRouteShell mode={route} scope={readScopeFromHash() ?? currentSeasonScope()} />}>
      {route === 'tournaments' ? <TournamentRoute /> : <RankingApp />}
    </Suspense>
  </TooltipProvider>
}

function TournamentRoute() {
  const [scope] = useState(() => readScopeFromHash() ?? currentSeasonScope())
  const mainRef = useRef<HTMLElement | null>(null)
  const goHome = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    window.location.hash = hashForModeAndScope('rankings', scope)
  }, [scope])
  return <div className="flex min-h-full flex-col">
    <a className="fixed top-[-56px] left-3 z-80 rounded-md border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 focus-visible:top-3" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); mainRef.current?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
    <AppNavigation mode="tournaments" scope={scope} onGoHome={goHome} />
    <main id="main-content" tabIndex={-1} ref={mainRef} className="min-w-0 flex-1 pb-6 max-sm:pb-[calc(var(--tabbar-h)+24px+env(safe-area-inset-bottom))]">
      <ModeHeader mode="tournaments" />
      <TournamentsView />
    </main>
  </div>
}

function RankingApp() {
  const [mode, setMode] = useState<Mode>(readModeFromHash)
  const [scope, setScope] = useState(() => readScopeFromHash() ?? currentSeasonScope())
  const [loadPlayers, setLoadPlayers] = useState(false)
  const [loadTeamHistory, setLoadTeamHistory] = useState(false)
  const [historyTeams, setHistoryTeams] = useState<readonly string[]>([])
  const [teamPicks, setTeamPicks] = useState<RankingSummaryStanding[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [matchYear, setMatchYear] = useState(() => hashParam('matchesYear'))
  const [loadRegionHistory, setLoadRegionHistory] = useState(() => readModeFromHash() === 'regions')
  const [loadMatchHistory, setLoadMatchHistory] = useState(() => ['matches', 'regions'].includes(readModeFromHash()))
  // Board filters that App owns are seeded from the hash for the same reason
  // the ones TeamsView owns are: a shared or reloaded board must come back.
  const [tournamentFilter, setTournamentFilter] = useState<TournamentFilterValue>(() => readTournamentFilterFromHash())
  const tournamentId = tournamentIdFromFilter(tournamentFilter)
  const {
    manifestState,
    effectiveScope,
    filter,
    seasonYears,
    snapshotState,
    snapshot,
    playersState,
    teamHistoryState,
    regionHistoryState,
    tournamentMovementIndexState,
    tournamentMovementEntries,
    tournamentMovementState,
    matchHistoryState,
    requestMatchHistoryPages,
    matchHistoryYears,
    selectedMatchYear,
    retryTournamentMovements,
    prefetchScope,
    prefetchTournament,
  } = usePublicArtifacts(scope, {
    loadPlayers,
    loadTeamHistory,
    teamHistoryTeams: drawerOpen && mode === 'rankings' ? teamPicks.map(teamKey) : historyTeams,
    matchHistoryYear: matchYear,
    loadRegionHistory,
    loadTournamentMovements: mode === 'rankings',
    loadMatchHistory,
    tournamentId,
  })
  const [regionPicks, setRegionPicks] = useState<RegionStrength[]>([])
  const [teamSearch, setTeamSearch] = useState(() => hashParam('team') ?? '')
  const [boardHashQuery, setBoardHashQuery] = useState(currentHashQuery)
  const mainRef = useRef<HTMLElement | null>(null)
  const didMountModeRef = useRef(false)
  const selectScope = useCallback((nextScope: string) => {
    setTournamentFilter('All')
    setScope(nextScope)
  }, [])

  function selectScopeFromControl(nextScope: string) {
    if (mode === 'matches' && nextScope !== effectiveScope) {
      // A cold scope unmounts Matches before it can reset its page. Clear the
      // old page before loading, while address restoration keeps its own page.
      const query = currentHashQuery()
      query.delete('page')
      window.history.replaceState(null, '', `#matches?${query.toString()}`)
    }
    selectScope(nextScope)
  }

  const searchRef = useRef<HTMLInputElement | null>(null)
  const searchTeams = useCallback((value: string) => {
    setTeamSearch(value)
    // The search finds teams on the board, so typing from another view takes
    // the reader to the board rather than filtering a view with no teams.
    setMode('rankings')
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    function onHashChange() {
      const nextMode = readModeFromHash()
      setMode(nextMode)
      setMatchYear(hashParam('matchesYear'))
      if (nextMode === 'regions') setLoadRegionHistory(true)
      if (nextMode === 'matches' || nextMode === 'regions') setLoadMatchHistory(true)
      const nextScope = readScopeFromHash()
      if (nextScope) selectScope(nextScope)
      // Every board filter is read in this one listener. React renders after
      // each hashchange listener, and that render would write the old board
      // filters back to the hash before a second listener could read them.
      if (nextMode === 'rankings') {
        const query = currentHashQuery()
        setTournamentFilter(readTournamentFilterFromHash(query))
        setTeamSearch(hashParam('team', query) ?? '')
        setBoardHashQuery(query)
      }
    }
    const transition = () => startTransition(onHashChange)
    window.addEventListener('hashchange', transition)
    return () => window.removeEventListener('hashchange', transition)
  }, [selectScope])

  useEffect(() => {
    replaceHashForModeAndScope(mode, effectiveScope)
  }, [effectiveScope, mode])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    if (didMountModeRef.current) {
      requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }))
    } else {
      didMountModeRef.current = true
    }
  }, [mode])

  const standings = useMemo(() => snapshot?.standings ?? [], [snapshot])
  const regions = useMemo(() => snapshot?.regions ?? [], [snapshot])
  const activeRegionHistory = regionHistoryState.status === 'ready' ? regionHistoryState.data : undefined
  const readyData = manifestState.status === 'ready' ? manifestState.data : undefined
  const latestMatchDate = readyData?.coverage?.latestMatchDate
  const tournamentShard = tournamentMovementState.status === 'ready' ? tournamentMovementState.data : undefined
  const universe = useMemo(
    () => deriveRankingUniverse({
      standings,
      regions,
      requestedTournamentFilter: tournamentFilter,
      tournamentEntries: tournamentMovementEntries,
      tournamentShard,
      latestMatchDate,
      rollingWindow: snapshot?.rollingWindow,
    }),
    [latestMatchDate, regions, snapshot?.rollingWindow, standings, tournamentFilter, tournamentMovementEntries, tournamentShard],
  )
  const seasonTabs = useMemo(() => readyData ? [...seasonYears.slice(0, 4), 'All'] : [], [readyData, seasonYears])
  const activeSeason = seasonFromScope(effectiveScope)
  const activeCheckpoint = checkpointFromScope(effectiveScope)
  const checkpointTabs = useMemo(
    () => readyData && activeSeason && activeSeason !== 'All'
      ? checkpointOptionsForSeason(readyData, activeSeason)
      : [],
    [activeSeason, readyData],
  )
  const preloadScopes = useMemo(
    () => visiblePreloadScopes(seasonTabs, activeSeason, checkpointTabs, effectiveScope),
    [activeSeason, checkpointTabs, effectiveScope, seasonTabs],
  )
  const preloadScopesKey = preloadScopes.join('\u0000')
  const requestPlayers = useCallback(() => setLoadPlayers(true), [])
  const requestTeamHistory = useCallback((teams?: readonly string[]) => {
    setLoadTeamHistory(true)
    if (teams) {
      const selection = [...new Set(teams)].sort()
      setHistoryTeams((current) => current.join('\u0000') === selection.join('\u0000') ? current : selection)
    }
  }, [])
  const requestRegionHistory = useCallback(() => setLoadRegionHistory(true), [])
  const prepareMode = useCallback((nextMode: Mode) => {
    preloadView(nextMode)
    if (nextMode === 'regions') setLoadRegionHistory(true)
    if (nextMode === 'matches' || nextMode === 'regions') setLoadMatchHistory(true)
  }, [])
  // The logo opens the same clean board as the Rankings tab, and the
  // hashchange listener applies it. Keeping the current query would carry
  // board filters, or another view's page, into the board.
  const goHome = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    window.location.hash = hashForModeAndScope('rankings', effectiveScope)
  }, [effectiveScope])

  const activePlayerScope = useMemo(
    () => playersState.status === 'ready' ? resolvePlayerScope(playersState.data, filter) : emptyPlayerScope(filter),
    [filter, playersState],
  )
  const activePlayers = activePlayerScope.players
  const playerLoadState = useMemo<PlayerLoadState>(() => {
    if (playersState.status === 'ready') return { status: 'ready' }
    if (playersState.status === 'idle' || playersState.status === 'loading') return { status: playersState.status }
    return { status: playersState.status, message: playersState.message }
  }, [playersState])
  const activeRegionPicks = useMemo(() => reconcilePicks(regionPicks, regions, regionKey), [regionPicks, regions])
  const activeTeamPicks = useMemo(() => reconcilePicks(teamPicks, universe.standings, teamKey), [teamPicks, universe.standings])
  const regionPickIds = useMemo(() => new Set(activeRegionPicks.map(regionKey)), [activeRegionPicks])

  function toggleRegion(region: RegionStrength) {
    preloadComparison()
    setRegionPicks((current) => toggleLimitedPick(reconcilePicks(current, regions, regionKey), region, regionKey))
  }

  function toggleTeam(team: RankingSummaryStanding) {
    preloadComparison()
    setTeamPicks((current) => toggleLimitedPick(reconcilePicks(current, universe.standings, teamKey), team, teamKey))
  }

  useEffect(() => {
    if (snapshotState.status !== 'ready') return undefined
    if (!canUseBackgroundPrefetch()) return undefined
    return scheduleIdleWork(() => {
      preloadView('regions')
      preloadView('matches')
      for (const preloadScope of preloadScopes) prefetchScope(preloadScope)
    })
  }, [prefetchScope, preloadScopes, preloadScopesKey, snapshotState.status])

  if (manifestState.status === 'loading') {
    return <ManifestRouteShell mode={mode} scope={effectiveScope} onGoHome={goHome} />
  }
  if (manifestState.status !== 'ready') {
    const message = manifestState.status === 'idle' ? 'Ranking manifest has not been requested yet.' : manifestState.message
    if (showsManifestErrorInAppShell(mode)) return <ManifestRouteShell mode={mode} scope={effectiveScope} onGoHome={goHome} error={message} />
    return (
      <ErrorScreen message={message} />
    )
  }

  const loadedData = manifestState.data
  const hasCompareTray = mode === 'rankings' || mode === 'regions'
  const seeded = loadedData.dataMode === 'seeded-sample' || loadedData.coverage?.seededSample === true
  const matchCount = snapshot?.matchCount ?? loadedData.coverage?.matchCount
  const compareEntities: CompareDockEntity[] = mode === 'regions'
    ? activeRegionPicks.map((region) => ({
        id: regionKey(region),
        code: region.region,
        name: region.region,
        meta: `${region.teamCount} flagship teams`,
        badge: <RegionBadge region={region.region} size="sm" />,
      }))
    : activeTeamPicks.map((team) => ({
        id: teamKey(team),
        code: team.code ?? team.team.slice(0, 3).toUpperCase(),
        name: team.code ?? team.team,
        meta: `${formatRating(team.rating)}${team.rank ? ` · #${team.rank}` : ''}`,
      }))
  // Only the team board has a matchup model. Two regions do not play each other.
  const compareMatchup = mode === 'rankings' && activeTeamPicks.length >= 2
    ? { home: activeTeamPicks[0], away: activeTeamPicks[1], model: loadedData.model }
    : undefined
  const teamColumns = teamCompareColumns(activeTeamPicks)
  const regionColumns = regionCompareColumns(activeRegionPicks)
  const movementBaseline = movementBaselineFor(activeCheckpoint, checkpointTabs)
  const pendingCheckpoint = pendingCheckpointForSeason(activeSeason, seasonYears, checkpointTabs)
  const teamCompareAfter = drawerOpen && mode === 'rankings' ? (
    <Suspense fallback={<LoadingState label="Loading team comparison" />}>
      <TeamCompareAnalysis teams={activeTeamPicks} columns={teamColumns} historyState={teamHistoryState} />
    </Suspense>
  ) : null
  const regionCompareAfter = drawerOpen && mode === 'regions' ? (
    <Suspense fallback={<LoadingState label="Loading region comparison" />}>
      <RegionCompareAnalysis
        regions={activeRegionPicks}
        columns={regionColumns}
        standings={standings}
        historyState={teamHistoryState}
        regionHistoryState={regionHistoryState}
        regionHistory={activeRegionHistory}
      />
    </Suspense>
  ) : null
  function preloadOnIntent(nextScope: string) {
    if (nextScope !== effectiveScope) prefetchScope(nextScope)
  }

  return (
    <div className="flex min-h-full flex-col">
      <a className="fixed top-[-56px] left-3 z-80 rounded-md border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-sm font-semibold text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] transition-[top] duration-120 ease-out focus-visible:top-3" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); mainRef.current?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
      <AppNavigation mode={mode} scope={effectiveScope} onGoHome={goHome} search={teamSearch} onSearch={mode === 'matches' ? undefined : searchTeams} searchRef={searchRef} onIntent={prepareMode} />

      {/* Space is reserved for the fixed compare tray on the two views that have
          one, and for the bottom tab bar on phones. */}
      <main
        id="main-content"
        className={cn(
          'flex min-w-0 flex-col pb-6 max-sm:pb-[calc(var(--tabbar-h)+24px+env(safe-area-inset-bottom))]',
          hasCompareTray && 'pb-[calc(var(--tray-h)+24px)]',
          hasCompareTray && compareEntities.length > 0 && 'max-sm:pb-[calc(var(--tabbar-h)+var(--tray-h)+24px+env(safe-area-inset-bottom))]',
        )}
        tabIndex={-1}
        ref={mainRef}
      >
        <ModeHeader mode={mode} />

        <ScopeBar
          seasons={seasonTabs}
          activeSeason={activeSeason}
          checkpoints={checkpointTabs}
          activeCheckpoint={activeCheckpoint}
          pendingCheckpoint={pendingCheckpoint}
          throughDate={loadedData.coverage?.latestMatchDate}
          scopeThroughDate={snapshot?.rollingWindow?.endDate}
          publishedAt={loadedData.generatedAt}
          onSelectSeason={(season) => selectScopeFromControl(scopeForSeasonTab(season))}
          onSelectCheckpoint={(checkpointId) =>
            selectScopeFromControl(checkpointId && activeSeason ? checkpointScope(activeSeason, checkpointId) : `season:${activeSeason}`)
          }
          onIntent={(checkpointId) => {
            if (!activeSeason) return
            preloadOnIntent(checkpointId ? checkpointScope(activeSeason, checkpointId) : `season:${activeSeason}`)
          }}
        />

        {/* Fixed to the bottom edge and, on wider screens, present before the
            first pick. Inline, it scrolled out of view while the reader picked
            teams further down the board, and it only appeared after the first
            pick, so nothing said the feature existed. Phones show it from the
            first pick: there the labelled row checkbox announces the feature
            and the screen height is better spent on teams. */}
        {hasCompareTray ? (
          <div className={cn('fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line-strong)] bg-[color-mix(in_oklch,var(--surface)_94%,var(--bg))] px-[var(--page-x)] py-2 shadow-[var(--shadow-tray)] max-sm:bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] max-sm:px-3', compareEntities.length === 0 && 'max-sm:hidden')}>
            <CompareDock
              subject={mode === 'regions' ? 'regions' : 'teams'}
              limit={COMPARE_LIMIT}
              entities={compareEntities}
              matchup={compareMatchup}
              onRemove={(id) => {
                if (compareEntities.length === 1) mainRef.current?.focus({ preventScroll: true })
                if (mode === 'regions') setRegionPicks((current) => current.filter((region) => regionKey(region) !== id))
                else setTeamPicks((current) => current.filter((team) => teamKey(team) !== id))
              }}
              onClear={() => {
                mainRef.current?.focus({ preventScroll: true })
                if (mode === 'regions') setRegionPicks([])
                else setTeamPicks([])
              }}
              onOpen={() => {
                if (mode === 'regions') {
                  requestRegionHistory()
                  requestTeamHistory()
                } else {
                  requestTeamHistory(activeTeamPicks.map(teamKey))
                }
                setDrawerOpen(true)
              }}
            />
          </div>
        ) : null}

        {seeded ? (
          <div className="flex min-w-0 flex-col px-[var(--page-x)] pt-6 pb-0">
            <Alert variant="warning" className="flex items-center gap-2.5" role="status">
              <AlertTriangle size={17} aria-hidden="true" />
              Seeded sample data is loaded. These are not official LoL Esports rankings.
            </Alert>
          </div>
        ) : null}

        {snapshotState.status !== 'ready' ? (
          <ScopedSnapshotState state={snapshotState} scope={scopeLabel(effectiveScope)} layout={PAGE_LAYOUTS[mode]} />
        ) : (
          <Suspense fallback={<LoadingState presentation="page" layout={PAGE_LAYOUTS[mode]} label={`Loading ${MODE_TITLES[mode].title}`} />}>
            {mode === 'regions' ? (
              <RegionsView
                regions={regions}
                standings={standings}
                regionHistory={activeRegionHistory}
                matchHistoryState={matchHistoryState}
                onRequestMatchHistoryPages={requestMatchHistoryPages}
                pickedIds={regionPickIds}
                onToggle={toggleRegion}
                onRequestRegionHistory={requestRegionHistory}
              />
            ) : null}
            {mode === 'rankings' ? (
              <>
                <TeamsView
                  universe={universe}
                  regions={regions}
                  model={loadedData.model}
                  players={activePlayers}
                  currentLineups={activePlayerScope.currentLineups}
                  playerLoadState={playerLoadState}
                  playerScopeLabel={activePlayerScope.label}
                  search={teamSearch}
                  onSearchChange={setTeamSearch}
                  pickedTeams={activeTeamPicks}
                  historyState={teamHistoryState}
                  requestedTournamentFilter={tournamentFilter}
                  tournamentMovementIndexState={tournamentMovementIndexState}
                  tournamentMovementState={tournamentMovementState}
                  onRetryTournamentMovements={retryTournamentMovements}
                  regionsHref={hashForModeAndScope('regions', effectiveScope)}
                  hashQuery={boardHashQuery}
                  dataSummary={{
                    source: loadedData.source,
                    sources: loadedData.sources,
                    scopeLabel: scopeLabel(effectiveScope),
                    matchCount,
                    coverageStart: loadedData.coverage?.coverageStart,
                    coverageEnd: loadedData.coverage?.coverageEnd,
                    latestMatchDate: loadedData.coverage?.latestMatchDate,
                    movementBaseline: movementBaseline.label,
                    rollingWindow: snapshot?.rollingWindow,
                    seeded,
                    sourceBreakdown: snapshot?.sourceBreakdown ?? [],
                    rosterCoverage: loadedData.dataQuality?.rosterCoverage,
                  }}
                  onToggle={toggleTeam}
                  onRequestPlayers={requestPlayers}
                  onRequestTeamHistory={drawerOpen ? undefined : requestTeamHistory}
                  onTournamentFilterChange={setTournamentFilter}
                  onPrefetchTournament={prefetchTournament}
                />
              </>
            ) : null}
            {mode === 'matches' ? (
              <MatchesView archiveYears={matchHistoryYears} archiveYear={selectedMatchYear} onYearChange={setMatchYear} searchRef={searchRef} state={matchHistoryState} onRequestPages={requestMatchHistoryPages} />
            ) : null}
          </Suspense>
        )}
        <footer aria-label="Project disclaimer" className="mx-[var(--page-x)] mt-7 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-4 text-xs leading-[1.55] text-[var(--faint)] [&>a]:inline-flex [&>a]:min-h-6 [&>a]:min-w-6 [&>a]:items-center">
          <span>{RIOT_PROJECT_NOTICE}</span>
          <a className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href={PROJECT_REPOSITORY_URL}>Source code</a>
          <a className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href={PROJECT_FEEDBACK_URL}>Report feedback</a>
          <a className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href="/legal">Legal notice</a>
          <a className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href="/privacy">Privacy</a>
          <a className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href="/licenses">Licenses</a>
        </footer>
      </main>

      {drawerOpen && mode === 'regions' ? (
        <RegionCompareDrawer
          open
          title="Region comparison"
          entities={activeRegionPicks}
          columns={regionColumns}
          rows={REGION_COMPARE_ROWS}
          after={regionCompareAfter}
          onClose={() => setDrawerOpen(false)}
          onRemove={(id) => setRegionPicks((current) => current.filter((region) => regionKey(region) !== id))}
        />
      ) : null}
      {drawerOpen && mode === 'rankings' ? (
        <TeamCompareDrawer
          open
          title="Team comparison"
          entities={activeTeamPicks}
          columns={teamColumns}
          rows={TEAM_COMPARE_ROWS}
          before={compareMatchup ? <HeadToHead home={compareMatchup.home} away={compareMatchup.away} model={compareMatchup.model} /> : undefined}
          after={teamCompareAfter}
          onClose={() => setDrawerOpen(false)}
          onRemove={(id) => setTeamPicks((current) => current.filter((team) => teamKey(team) !== id))}
        />
      ) : null}
    </div>
  )
}

function visiblePreloadScopes(
  seasonTabs: string[],
  activeSeason: string | undefined,
  checkpoints: SnapshotCheckpointOption[],
  effectiveScope: string,
) {
  const targets = [
    ...(activeSeason && activeSeason !== 'All'
      ? [`season:${activeSeason}`, ...checkpoints.map((checkpoint) => checkpointScope(activeSeason, checkpoint.id))]
      : []),
    ...seasonTabs.map(scopeForSeasonTab),
  ]
  return [...new Set(targets.filter((target) => target !== effectiveScope))].slice(0, 3)
}

function ManifestRouteShell({
  mode,
  scope,
  onGoHome,
  error,
}: {
  mode: Mode
  scope: string
  onGoHome?: (event: MouseEvent<HTMLAnchorElement>) => void
  error?: string
}) {
  return (
    <div className="flex min-h-full flex-col">
      <a className="fixed top-[-56px] left-3 z-80 rounded-md border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-sm font-semibold text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] focus-visible:top-3" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); document.getElementById('main-content')?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
      <AppNavigation mode={mode} scope={scope} onGoHome={onGoHome} />
      <main id="main-content" className="flex min-w-0 flex-col" tabIndex={-1}>
        <ModeHeader mode={mode} />
        {mode !== 'tournaments' ? <div className="flex min-h-[57px] items-center border-b border-border bg-[color-mix(in_oklch,var(--surface)_76%,var(--bg))] px-[var(--page-x)] py-2 text-sm text-muted-foreground max-sm:min-h-[141px]">
          Requested scope: <b className="ml-2 text-foreground">{scopeLabel(scope)}</b>
        </div> : null}
        {error ? (
          <section className="px-[var(--page-x)] pt-6">
            <Card role="alert">
              <DataState
                icon={<AlertTriangle size={26} aria-hidden="true" />}
                title="Rankings could not be loaded"
                action={
                  <Button type="button" variant="default" onClick={() => window.location.reload()}>
                    <RefreshCw size={15} aria-hidden="true" />
                    Retry
                  </Button>
                }
              >
                {error}
              </DataState>
            </Card>
          </section>
        ) : (
          <LoadingState presentation="page" layout={PAGE_LAYOUTS[mode]} label={`Loading ${MODE_TITLES[mode].title}`} />
        )}
      </main>
    </div>
  )
}

/**
 * Title and the one explanatory line, rendered in the same slot for every view
 * so no view can ship without one.
 */
function ModeHeader({ mode }: { mode: Mode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-[var(--page-x)] pt-4 pb-3">
      <h1 className="text-xl font-semibold tracking-normal text-[var(--text-strong)]">{MODE_TITLES[mode].title}</h1>
      <p className="max-w-[80ch] text-sm leading-[1.5] text-muted-foreground">{MODE_TITLES[mode].intro}</p>
    </div>
  )
}

function AppNavigation({
  mode,
  scope,
  onGoHome,
  search,
  onSearch,
  searchRef,
  onIntent,
}: {
  mode: Mode
  scope: string
  onGoHome?: (event: MouseEvent<HTMLAnchorElement>) => void
  search?: string
  onSearch?: (value: string) => void
  searchRef?: RefObject<HTMLInputElement | null>
  onIntent?: (mode: Mode) => void
}) {
  const tabs = MODES.map((entry) => {
    const Icon = entry.icon
    return (
      <a
        key={entry.id}
        href={hashForModeAndScope(entry.id, scope)}
        className={cn(
          buttonVariants({ variant: 'tab', size: 'tab' }),
          'min-w-0 shrink-0 gap-2 font-semibold no-underline max-sm:h-full max-sm:flex-1 max-sm:flex-col max-sm:gap-0.5 max-sm:rounded-none max-sm:border-0 max-sm:text-2xs',
        )}
        aria-current={mode === entry.id ? 'page' : undefined}
        onPointerEnter={() => (onIntent ?? preloadView)(entry.id)}
        onFocus={() => (onIntent ?? preloadView)(entry.id)}
        onTouchStart={() => (onIntent ?? preloadView)(entry.id)}
      >
        <Icon size={17} className="sm:max-lg:hidden" aria-hidden="true" />
        {entry.label}
      </a>
    )
  })

  return (
    <>
      <header className="sticky top-0 z-50 flex min-h-[var(--app-nav-h)] items-center gap-x-4 border-b border-border bg-[var(--rail)]/98 px-[var(--page-x)] py-2.5 max-[900px]:px-3">
        <a className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-md py-1 pr-2 text-left text-inherit no-underline transition-colors hover:bg-[color-mix(in_oklab,var(--surface-2)_46%,transparent)]" href={hashForModeAndScope('rankings', scope)} onClick={onGoHome} title="Go to Rankings home">
          <img className="block size-9 shrink-0 rounded-md" src="/logo.svg" alt="" aria-hidden="true" width={36} height={36} />
          <b className="block overflow-hidden text-ellipsis whitespace-nowrap text-md font-semibold text-[var(--text-strong)] max-[420px]:sr-only sm:max-lg:sr-only">Power Index</b>
        </a>
        {/* The active tab uses the shared selected treatment. Gold stays
            reserved for rank quality. The tabs never shrink: the search gives
            way instead, and between the phone tab bar and desktop the
            wordmark, tab icons and shortcut hint make room for it. */}
        <nav className="flex shrink-0 items-center gap-1.5 max-sm:hidden" aria-label="Primary">{tabs}</nav>
        {onSearch ? (
          <label className="relative ml-auto w-[min(280px,100%)] min-w-0 max-sm:flex-1">
            <span className="sr-only">Find a team</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--faint)]" aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              className="pl-9 lg:pr-9"
              value={search ?? ''}
              placeholder="Find a team"
              aria-keyshortcuts="/"
              onChange={(event) => onSearch(event.target.value)}
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm border border-[var(--line-strong)] px-1.5 font-mono text-2xs text-[var(--faint)] max-lg:hidden" aria-hidden="true">/</kbd>
          </label>
        ) : null}
      </header>
      {/* Phones get the views as a bottom tab bar, so the top of the screen
          holds data instead of three full-width buttons. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-50 flex h-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] items-stretch border-t border-border bg-[var(--rail)] pb-[env(safe-area-inset-bottom)] sm:hidden"
        aria-label="Primary"
      >
        {tabs}
      </nav>
    </>
  )
}

function scopeForSeasonTab(season: string) {
  return season === 'All' ? 'all' : `season:${season}`
}

function readModeFromHash(): Mode {
  return typeof window === 'undefined'
    ? 'rankings'
    : initialModeFromLocation(window.location.hash, window.location.pathname)
}

function readScopeFromHash() {
  if (typeof window === 'undefined') return undefined
  const query = window.location.hash.slice(1).split('?', 2)[1] ?? window.location.search.slice(1)
  if (!query) return undefined
  const scope = new URLSearchParams(query).get('scope')
  return isKnownScope(scope) ? scope : undefined
}

function readTournamentFilterFromHash(query = currentHashQuery()) {
  return (hashParam('tournament', query) as TournamentFilterValue | undefined) ?? 'All'
}

function replaceHashForModeAndScope(mode: Mode, scope: string) {
  if (typeof window === 'undefined') return
  const nextHash = hashForModeAndScope(mode, scope, window.location.hash.slice(1))
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

function hashForModeAndScope(mode: Mode, scope: string, currentHash = '') {
  const query = new URLSearchParams(currentHash.split('?', 2)[1] ?? '')
  query.set('scope', scope)
  const queryString = query.toString()
  return `#${mode}${queryString ? `?${queryString}` : ''}`
}

function isKnownScope(value: string | null): value is string {
  return value === 'all' || Boolean(value?.startsWith('event:')) || /^season:\d{4}(?::(?:checkpoint:)?[A-Za-z0-9_-]+)?$/.test(value ?? '')
}

function pendingCheckpointForSeason(
  activeSeason: string | undefined,
  seasonYears: string[],
  checkpoints: SnapshotCheckpointOption[],
) {
  if (!activeSeason || activeSeason !== seasonYears[0] || checkpoints.length === 0) return undefined
  const checkpointIds = new Set(checkpoints.map((checkpoint) => checkpoint.id))
  const latestCheckpoint = checkpoints.at(-1)
  const latestIndex = latestCheckpoint ? CHECKPOINT_SEQUENCE.indexOf(latestCheckpoint.id as typeof CHECKPOINT_SEQUENCE[number]) : -1
  if (latestIndex < 0) return undefined
  const nextId = CHECKPOINT_SEQUENCE[latestIndex + 1]
  if (!nextId || checkpointIds.has(nextId)) return undefined
  return { id: nextId, label: checkpointLabel(nextId) }
}

function checkpointLabel(id: string) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function movementBaselineFor(activeCheckpoint: string | undefined, checkpoints: SnapshotCheckpointOption[]): MovementBaseline {
  const checkpoint = checkpoints.find((entry) => entry.id === activeCheckpoint)
  if (!checkpoint) return { label: 'the previous rating update in this scope' }
  if (checkpoint.previousEndDate) {
    return { label: `the previous checkpoint ending ${formatDate(checkpoint.previousEndDate)}` }
  }
  return { label: `the pre-${checkpoint.label} baseline before ${formatDate(checkpoint.startDate)}` }
}

function reconcilePicks<T>(current: T[], available: readonly T[], keyFor: (item: T) => string) {
  if (current.length === 0) return current
  const availableByKey = new Map(available.map((item) => [keyFor(item), item]))
  const next = current
    .map((item) => availableByKey.get(keyFor(item)))
    .filter((item): item is T => Boolean(item))
  if (next.length === current.length && next.every((item, index) => item === current[index])) return current
  return next
}

function toggleLimitedPick<T>(current: T[], item: T, keyFor: (item: T) => string) {
  const key = keyFor(item)
  if (current.some((entry) => keyFor(entry) === key)) {
    return current.filter((entry) => keyFor(entry) !== key)
  }
  return current.length >= COMPARE_LIMIT ? [...current.slice(1), item] : [...current, item]
}

function ScopedSnapshotState({ state, scope, layout }: { state: Exclude<PublicSnapshotState, { status: 'ready' }>; scope: string; layout: PageLayout }) {
  if (state.status === 'loading') {
    return <LoadingState presentation="page" layout={layout} label={`Loading ${scope}`} />
  }
  return (
    <section className="flex min-w-0 flex-col px-[var(--page-x)] pt-6">
      <Card>
        <DataState icon={<AlertTriangle size={26} aria-hidden="true" />} title={`Snapshot unavailable for ${scope}`}>
          {state.message}
        </DataState>
      </Card>
    </section>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-[min(460px,92vw)] shadow-[var(--shadow-2)]">
        <DataState
          icon={<AlertTriangle size={26} aria-hidden="true" />}
          title="Snapshot unavailable"
          action={
            <Button type="button" variant="default" onClick={() => window.location.reload()}>
              <RefreshCw size={15} aria-hidden="true" />
              Retry
            </Button>
          }
        >
          {message}
        </DataState>
      </Card>
    </main>
  )
}

export default App
