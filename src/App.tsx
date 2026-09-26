import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { AlertTriangle, BarChart3, Globe2, History, RefreshCw } from 'lucide-react'
import type {
  PublicRankingManifest,
  SnapshotCheckpointOption,
  PublicTeamStanding as RankingSummaryStanding,
} from './lib/publicArtifacts/schema'
import type { PublicSnapshotState } from './lib/publicArtifacts/resolver'
import {
  formatDate,
  formatRating,
  teamKey,
} from './lib/display'
import type { RegionStrength } from './lib/regionStrength'
import {
  REGION_COMPARE_ROWS,
  TEAM_COMPARE_ROWS,
  regionCompareColumns,
  regionKey,
  teamCompareColumns,
} from './components/compareAnalysisData'
import { TeamsView, type PlayerLoadState } from './views/TeamsView'
import { DataState, RegionBadge } from './components/ui'
import { ScopeBar } from './components/ScopeBar'
import { CompareDock, type CompareDockEntity } from './components/CompareDock'
import { Button, buttonVariants } from './components/ui/button'
import { Alert } from './components/ui/alert'
import { Card } from './components/ui/card'
import { LoadingState } from './components/ui/loading'
import { currentSeasonScope } from './lib/defaultScope'
import { emptyPlayerScope, resolvePlayerScope } from './lib/playerScopes'
import { PROJECT_FEEDBACK_URL, PROJECT_REPOSITORY_URL, RIOT_PROJECT_NOTICE } from './lib/legal'
import { projectTournamentStandings, tournamentIdFromFilter, type TournamentFilterValue } from './lib/internationalTournaments'
import { cn } from './lib/utils'
import { hashParam } from './lib/urlState'
import { initialModeFromLocation, showsManifestErrorInAppShell, type AppMode } from './lib/bootstrap'
import {
  checkpointFromScope,
  checkpointOptionsForSeason,
  checkpointScope,
  scopeLabel,
  seasonFromScope,
  usePublicArtifacts,
} from './hooks/usePublicArtifacts'

type Mode = AppMode
type MovementBaseline = {
  label: string
}
const COMPARE_LIMIT = 4
const CHECKPOINT_SEQUENCE = ['split-1', 'split-2', 'split-3'] as const
const RegionsView = lazy(() => import('./views/RegionsView').then((module) => ({ default: module.RegionsView })))
const MatchesView = lazy(() => import('./views/MatchesView').then((module) => ({ default: module.MatchesView })))
const RegionCompareDrawer = lazy(() => import('./components/CompareDrawer').then((module) => ({ default: module.RegionCompareDrawer })))
const RegionCompareAnalysis = lazy(() => import('./components/CompareAnalysis').then((module) => ({ default: module.RegionCompareAnalysis })))
const TeamCompareDrawer = lazy(() => import('./components/CompareDrawer').then((module) => ({ default: module.TeamCompareDrawer })))
const TeamCompareAnalysis = lazy(() => import('./components/CompareAnalysis').then((module) => ({ default: module.TeamCompareAnalysis })))

const MODES: { id: Mode; label: string; icon: typeof BarChart3 }[] = [
  { id: 'rankings', label: 'Rankings', icon: BarChart3 },
  { id: 'regions', label: 'Regions', icon: Globe2 },
  { id: 'matches', label: 'Matches', icon: History },
]

/**
 * One title per view, plus the line that tells a first-time visitor what the
 * numbers mean. Rankings is the landing view and previously shipped no
 * explanation at all, while Regions, which nobody lands on, carried one.
 *
 * There is no eyebrow. Each view used to render an uppercase grey label above
 * its title which restated the title in different words.
 */
const MODE_TITLES: Record<Mode, { title: string; intro: string }> = {
  rankings: {
    title: 'Team Power Index',
    intro: 'Power score rates every tier 1 team on one scale from its match results, weighted by opponent strength and event importance. Higher is stronger, and a 100 point gap is roughly a 64% game win chance for the stronger side. Movement compares against the previous rating update in the selected scope.',
  },
  regions: {
    title: 'Region power',
    intro: 'Region power is the average Power score of the three strongest ranked teams in a region. Each row compares that against the average across all of the region’s ranked teams: a small gap means depth, a large gap means the region is top-heavy.',
  },
  matches: {
    title: 'Match history',
    intro: 'Every published series behind the ratings, newest first. Power impact shows how much each side’s score moved as a result, after opponent strength and event weight are applied.',
  },
}


function App({ initialManifest, initialManifestError }: { initialManifest?: PublicRankingManifest; initialManifestError?: string }) {
  const [mode, setMode] = useState<Mode>(readModeFromHash)
  const [scope, setScope] = useState(() => readScopeFromHash() ?? currentSeasonScope())
  const [loadPlayers, setLoadPlayers] = useState(false)
  const [loadTeamHistory, setLoadTeamHistory] = useState(false)
  const [loadRegionHistory, setLoadRegionHistory] = useState(() => readModeFromHash() === 'regions')
  // Board filters that App owns are seeded from the hash for the same reason
  // the ones TeamsView owns are: a shared or reloaded board must come back.
  const [tournamentFilter, setTournamentFilter] = useState<TournamentFilterValue>(() => (hashParam('tournament') as TournamentFilterValue | undefined) ?? 'All')
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
    retryTournamentMovements,
    prefetchScope,
    prefetchTournament,
  } = usePublicArtifacts(scope, {
    initialManifest,
    initialManifestError,
    loadPlayers,
    loadTeamHistory,
    loadRegionHistory,
    loadTournamentMovements: mode === 'rankings',
    loadMatchHistory: mode === 'matches' || mode === 'regions',
    tournamentId,
  })
  const [regionPicks, setRegionPicks] = useState<RegionStrength[]>([])
  const [teamPicks, setTeamPicks] = useState<RankingSummaryStanding[]>([])
  const [teamSearch, setTeamSearch] = useState(() => hashParam('team') ?? '')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const mainRef = useRef<HTMLElement | null>(null)
  const didMountModeRef = useRef(false)
  const selectScope = useCallback((nextScope: string) => {
    setTournamentFilter('All')
    setScope(nextScope)
  }, [])

  useEffect(() => {
    function onHashChange() {
      const nextMode = readModeFromHash()
      setMode(nextMode)
      if (nextMode === 'regions') setLoadRegionHistory(true)
      const nextScope = readScopeFromHash()
      if (nextScope) selectScope(nextScope)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
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
  const comparisonStandings = useMemo(
    () => tournamentMovementState.status === 'ready' && tournamentMovementState.data.id === tournamentId
      ? projectTournamentStandings(standings, tournamentMovementState.data)
      : standings,
    [standings, tournamentId, tournamentMovementState],
  )
  const regions = useMemo(() => snapshot?.regions ?? [], [snapshot])
  const activeRegionHistory = regionHistoryState.status === 'ready' ? regionHistoryState.data : undefined
  const readyData = manifestState.status === 'ready' ? manifestState.data : undefined
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
  const requestTeamHistory = useCallback(() => setLoadTeamHistory(true), [])
  const requestRegionHistory = useCallback(() => setLoadRegionHistory(true), [])
  const goHome = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setMode('rankings')
    replaceHashForModeAndScope('rankings', effectiveScope)
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
  const activeTeamPicks = useMemo(() => reconcilePicks(teamPicks, comparisonStandings, teamKey), [comparisonStandings, teamPicks])
  const regionPickIds = useMemo(() => new Set(activeRegionPicks.map(regionKey)), [activeRegionPicks])

  function toggleRegion(region: RegionStrength) {
    setRegionPicks((current) => toggleLimitedPick(reconcilePicks(current, regions, regionKey), region, regionKey))
  }

  function toggleTeam(team: RankingSummaryStanding) {
    setTeamPicks((current) => toggleLimitedPick(reconcilePicks(current, comparisonStandings, teamKey), team, teamKey))
  }

  useEffect(() => {
    if (preloadScopes.length === 0) return undefined
    if (!canUseBackgroundPrefetch()) return undefined
    return scheduleIdleWork(() => {
      for (const preloadScope of preloadScopes) prefetchScope(preloadScope)
    })
  }, [prefetchScope, preloadScopes, preloadScopesKey])

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
  const seeded = loadedData.dataMode === 'seeded-sample' || loadedData.coverage?.seededSample === true
  const matchCount = snapshot?.matchCount ?? loadedData.coverage?.matchCount
  const trayLabel = mode === 'regions' ? 'Region compare' : 'Team compare'
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
    <Suspense fallback={<LoadingState label="Loading team comparison" description="Preparing the selected team analysis." />}>
      <TeamCompareAnalysis teams={activeTeamPicks} columns={teamColumns} historyState={teamHistoryState} />
    </Suspense>
  ) : null
  const regionCompareAfter = drawerOpen && mode === 'regions' ? (
    <Suspense fallback={<LoadingState label="Loading region comparison" description="Preparing the selected region analysis." />}>
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
      <a className="fixed top-[-56px] left-3 z-80 rounded-[var(--r-2)] border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-[var(--t-3)] font-semibold text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] transition-[top] duration-120 ease-out focus-visible:top-3" href="#main-content">Skip to content</a>
      <AppNavigation mode={mode} scope={effectiveScope} onGoHome={goHome} />

      {/* Space is reserved for the dock only where the dock is fixed, which is
          phones on the two views that have one. */}
      <main
        id="main-content"
        className={cn(
          'flex min-w-0 flex-col pb-6',
          (mode === 'rankings' || mode === 'regions') && 'max-sm:pb-[calc(84px+env(safe-area-inset-bottom))]',
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
          onSelectSeason={(season) => selectScope(scopeForSeasonTab(season))}
          onSelectCheckpoint={(checkpointId) =>
            selectScope(checkpointId && activeSeason ? checkpointScope(activeSeason, checkpointId) : `season:${activeSeason}`)
          }
          onIntent={(checkpointId) => {
            if (!activeSeason) return
            preloadOnIntent(checkpointId ? checkpointScope(activeSeason, checkpointId) : `season:${activeSeason}`)
          }}
        />

        {/* Inline under the scope bar on desktop. On a phone it is fixed to the
            bottom edge instead: the board is thousands of pixels long there, so
            an inline dock would scroll out of reach the moment you started
            picking. Sticky cannot do this, because the dock's natural position
            is above the fold rather than below it. */}
        {mode === 'rankings' || mode === 'regions' ? (
          <div className="px-[var(--page-x)] pt-4 max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:border-t max-sm:border-[var(--line-strong)] max-sm:bg-[color-mix(in_oklch,var(--surface)_92%,var(--bg))] max-sm:px-3 max-sm:pt-2 max-sm:pb-[max(8px,env(safe-area-inset-bottom))]">
            <CompareDock
              label={trayLabel}
              limit={COMPARE_LIMIT}
              entities={compareEntities}
              matchup={compareMatchup}
              onRemove={(id) => {
                if (mode === 'regions') setRegionPicks((current) => current.filter((region) => regionKey(region) !== id))
                else setTeamPicks((current) => current.filter((team) => teamKey(team) !== id))
              }}
              onClear={() => {
                if (mode === 'regions') setRegionPicks([])
                else setTeamPicks([])
              }}
              onOpen={() => {
                if (mode === 'regions') {
                  requestRegionHistory()
                  requestTeamHistory()
                } else {
                  requestTeamHistory()
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
          <ScopedSnapshotState state={snapshotState} scope={scopeLabel(effectiveScope)} />
        ) : (
          <>
            {mode === 'regions' ? (
              <Suspense fallback={<LoadingState presentation="page" label="Loading region view" />}>
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
              </Suspense>
            ) : null}
            {mode === 'rankings' ? (
              <>
                <TeamsView
                  standings={standings}
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
                  tournamentFilter={tournamentFilter}
                  tournamentMovementEntries={tournamentMovementEntries}
                  tournamentMovementIndexState={tournamentMovementIndexState}
                  tournamentMovementState={tournamentMovementState}
                  onRetryTournamentMovements={retryTournamentMovements}
                  regionsHref={hashForModeAndScope('regions', effectiveScope)}
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
                    notes: loadedData.dataQuality?.notes,
                  }}
                  onToggle={toggleTeam}
                  onRequestPlayers={requestPlayers}
                  onRequestTeamHistory={requestTeamHistory}
                  onTournamentFilterChange={setTournamentFilter}
                  onPrefetchTournament={prefetchTournament}
                />
              </>
            ) : null}
            {mode === 'matches' ? (
              <Suspense fallback={<LoadingState presentation="page" label="Loading match history" />}>
                <MatchesView state={matchHistoryState} scopeLabel={scopeLabel(effectiveScope)} onRequestPages={requestMatchHistoryPages} />
              </Suspense>
            ) : null}
          </>
        )}
        <footer className="mx-[var(--page-x)] mt-[30px] flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--line)] pt-[15px] text-[var(--t-2)] leading-[1.55] text-[var(--faint)]" aria-label="Project disclaimer">
          <span>{RIOT_PROJECT_NOTICE}</span>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href={PROJECT_REPOSITORY_URL}>Source code</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href={PROJECT_FEEDBACK_URL}>Report feedback</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href="/legal">Legal notice</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href="/privacy">Privacy</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href="/licenses">Licenses</a>
        </footer>
      </main>

      {drawerOpen && mode === 'regions' ? (
        <Suspense fallback={<div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"><LoadingState label="Opening region comparison" /></div>}>
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
        </Suspense>
      ) : null}
      {drawerOpen && mode === 'rankings' ? (
        <Suspense fallback={<div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"><LoadingState label="Opening team comparison" /></div>}>
          <TeamCompareDrawer
            open
            title="Team comparison"
            entities={activeTeamPicks}
            columns={teamColumns}
            rows={TEAM_COMPARE_ROWS}
            after={teamCompareAfter}
            onClose={() => setDrawerOpen(false)}
            onRemove={(id) => setTeamPicks((current) => current.filter((team) => teamKey(team) !== id))}
          />
        </Suspense>
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
    ...seasonTabs.map(scopeForSeasonTab),
    ...(activeSeason && activeSeason !== 'All'
      ? [`season:${activeSeason}`, ...checkpoints.map((checkpoint) => checkpointScope(activeSeason, checkpoint.id))]
      : []),
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
  onGoHome: (event: MouseEvent<HTMLAnchorElement>) => void
  error?: string
}) {
  return (
    <div className="flex min-h-full flex-col">
      <a className="fixed top-[-56px] left-3 z-80 rounded-[var(--r-2)] border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-[var(--t-3)] font-semibold text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] focus-visible:top-3" href="#main-content">Skip to content</a>
      <AppNavigation mode={mode} scope={scope} onGoHome={onGoHome} />
      <main id="main-content" className="flex min-w-0 flex-col" tabIndex={-1}>
        <ModeHeader mode={mode} />
        <div className="flex min-h-[55px] items-center border-b border-[var(--line)] bg-[color-mix(in_oklch,var(--surface)_76%,var(--bg))] px-[var(--page-x)] py-2 text-[var(--t-3)] text-[var(--muted)]">
          Requested scope: <b className="ml-2 text-[var(--text)]">{scopeLabel(scope)}</b>
        </div>
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
          <LoadingState presentation="page" label={`Loading ${MODE_TITLES[mode].title}`} description="Fetching the published ranking manifest." />
        )}
      </main>
    </div>
  )
}

/**
 * Title and the one explanatory line, rendered in the same slot for every view
 * so no view can ship without one. Rankings, the landing view, previously went
 * straight from its title into a filter bar.
 */
function ModeHeader({ mode }: { mode: Mode }) {
  return (
    <header className="grid gap-1.5 border-b border-[var(--line)] px-[var(--page-x)] pt-4 pb-3.5">
      <h1 className="text-xl font-semibold tracking-normal text-[var(--text-strong)]">{MODE_TITLES[mode].title}</h1>
      <p className="max-w-[86ch] text-sm leading-[1.55] text-[var(--muted)]">{MODE_TITLES[mode].intro}</p>
    </header>
  )
}

function AppNavigation({ mode, scope, onGoHome }: { mode: Mode; scope: string; onGoHome: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <nav className="sticky top-0 z-50 flex min-h-[var(--app-nav-h)] flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--line)] bg-[oklch(0.135_0.004_250/0.97)] px-[var(--page-x)] py-2.5 backdrop-blur-[8px] max-[900px]:px-3" aria-label="Primary">
      <a className="mr-auto flex min-w-0 items-center gap-2.5 rounded-[var(--r-2)] py-1 pr-2 text-left text-inherit no-underline transition-colors hover:bg-[color-mix(in_oklab,var(--surface-2)_46%,transparent)]" href={hashForModeAndScope('rankings', scope)} onClick={onGoHome} title="Go to Rankings home">
        {/* logo.svg is 400 bytes. The 512x512 PNG this replaced was 226 KB and
            rendered into a 36px box on first paint. */}
        <img className="block size-9 shrink-0 rounded-[var(--r-2)]" src="/logo.svg" alt="" aria-hidden="true" width={36} height={36} />
        <b className="block overflow-hidden text-ellipsis whitespace-nowrap text-md font-semibold text-[var(--text-strong)]">Power Index</b>
      </a>
      {/* Same tab treatment as the scope rows below. The active item used to be
          marked with a gold underline, which collided with --rank-gold's other
          meaning of rank quality. Taglines are gone: they restated the label
          and were hidden below 1040px anyway. */}
      <div className="-m-0.5 flex min-w-0 items-center gap-1.5 overflow-x-auto p-0.5 [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[900px]:w-full">
        {MODES.map((entry) => {
          const Icon = entry.icon
          return (
            <a
              key={entry.id}
              href={hashForModeAndScope(entry.id, scope)}
              className={cn(
                buttonVariants({ variant: 'tab', size: 'tab' }),
                'min-w-0 shrink-0 gap-2 font-semibold no-underline max-[900px]:flex-1',
              )}
              aria-current={mode === entry.id ? 'page' : undefined}
            >
              <Icon size={17} aria-hidden="true" />
              {entry.label}
            </a>
          )
        })}
      </div>
    </nav>
  )
}

function scopeForSeasonTab(season: string) {
  return season === 'All' ? 'all' : `season:${season}`
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean
    effectiveType?: string
    downlink?: number
  }
}

function canUseBackgroundPrefetch() {
  if (typeof navigator === 'undefined') return false
  const connection = (navigator as NavigatorWithConnection).connection
  if (!connection) return true
  if (connection.saveData) return false
  if (connection.effectiveType && /(^|-)2g$/i.test(connection.effectiveType)) return false
  if (typeof connection.downlink === 'number' && connection.downlink > 0 && connection.downlink < 1.5) return false
  return true
}

function scheduleIdleWork(callback: () => void) {
  if (typeof window === 'undefined') return () => undefined
  const idleWindow = window as IdleWindow
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 2500 })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }
  const handle = window.setTimeout(callback, 900)
  return () => window.clearTimeout(handle)
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

function reconcilePicks<T>(current: T[], available: T[], keyFor: (item: T) => string) {
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

function ScopedSnapshotState({ state, scope }: { state: Exclude<PublicSnapshotState, { status: 'ready' }>; scope: string }) {
  if (state.status === 'loading') {
    return <LoadingState presentation="page" label={`Loading ${scope}`} description="Fetching the exact public shard for this scope." />
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
