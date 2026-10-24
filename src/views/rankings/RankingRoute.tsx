import { AlertTriangle } from 'lucide-react'
import { startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { showsManifestErrorInAppShell } from '../../browser/bootstrap'
import { currentHashQuery, hashForModeAndScope, hashParam, readModeFromHash, readScopeFromHash, readTournamentFilterFromHash, replaceHashForModeAndScope, writeNavigationHash } from '../../browser/navigation'
import { canUseBackgroundPrefetch, scheduleIdleWork } from '../../browser/rankings/prefetch'
import {
  checkpointFromScope,
  checkpointOptionsForSeason,
  checkpointScope,
  scopeLabel,
  seasonFromScope,
  usePublicArtifacts,
} from '../../browser/rankings/usePublicArtifacts'
import { RegionBadge } from '../../components/ui'
import { RouteErrorBoundary } from '../../components/RouteErrorBoundary'
import { Alert } from '../../components/ui/alert'
import { LoadingState } from '../../components/ui/loading'
import { PROJECT_FEEDBACK_URL, PROJECT_REPOSITORY_URL, RIOT_PROJECT_NOTICE } from '../../data/legal'
import { tournamentIdFromFilter, type TournamentFilterValue } from '../../domains/rankings/evidence'
import type { RegionStrength } from '../../domains/rankings/read'
import { currentSeasonScope, createRankingBoard, emptyPlayerScope, resolvePlayerScope } from '../../domains/rankings/read'
import type { PublicTeamStanding as RankingSummaryStanding, SnapshotCheckpointOption } from '../../domains/rankings/types'
import {
  formatDate,
  formatRating,
  teamKey,
} from '../../shared/display'
import { cn } from '../../shared/utils'
import { AppNavigation, ErrorScreen, ManifestRouteShell, ModeHeader, ScopedSnapshotState } from '../AppShell'
import { MODE_TITLES, PAGE_LAYOUTS, type Mode } from '../shellConfig'
import {
  REGION_COMPARE_ROWS,
  regionCompareColumns,
  regionKey,
  TEAM_COMPARE_ROWS,
  teamCompareColumns,
} from './compareAnalysisData'
import { CompareDock, type CompareDockEntity } from './CompareDock'
import { RegionCompareDrawer, TeamCompareDrawer } from './CompareDrawer'
import { HeadToHead } from './HeadToHead'
import { MatchesView, preloadComparison, preloadView, RegionCompareAnalysis, RegionsView, TeamCompareAnalysis } from './routeLoading'
import { ScopeBar } from './ScopeBar'
import { TeamsView } from './TeamsView'
import type { PlayerLoadState } from './types'

type MovementBaseline = {
  label: string
}

const COMPARE_LIMIT = 4

const CHECKPOINT_SEQUENCE = ['split-1', 'split-2', 'split-3'] as const

export function RankingRoute() {
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
  const [matchesHashQuery, setMatchesHashQuery] = useState(currentHashQuery)
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
      writeNavigationHash(`#matches?${query.toString()}`, 'replace')
    }
    selectScope(nextScope)
  }

  function selectMatchYearFromControl(nextYear: string) {
    if (nextYear === (selectedMatchYear ?? 'All')) return
    const query = currentHashQuery()
    if (nextYear === 'All') query.delete('matchesYear')
    else query.set('matchesYear', nextYear)
    query.delete('page')
    writeNavigationHash(`#matches?${query.toString()}`, 'replace')
    setMatchYear(nextYear)
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
      if (nextMode === 'matches') setMatchesHashQuery(currentHashQuery())
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
    () => createRankingBoard({
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
    writeNavigationHash(hashForModeAndScope('rankings', effectiveScope), 'navigate')
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
          <RouteErrorBoundary key={mode}>
            <Suspense fallback={<LoadingState presentation="page" layout={PAGE_LAYOUTS[mode]} label={`Loading ${MODE_TITLES[mode].title}`} />}>
              {mode === 'regions' ? (
                <RegionsView
                  regions={regions}
                  standings={standings}
                  regionHistoryState={regionHistoryState}
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
                    requestedScope={scope}
                    effectiveScope={effectiveScope}
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
                <MatchesView hashQuery={matchesHashQuery} archiveYears={matchHistoryYears} archiveYear={selectedMatchYear} onYearChange={selectMatchYearFromControl} searchRef={searchRef} state={matchHistoryState} onRequestPages={requestMatchHistoryPages} />
              ) : null}
            </Suspense>
          </RouteErrorBoundary>
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

function scopeForSeasonTab(season: string) {
  return season === 'All' ? 'all' : `season:${season}`
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
