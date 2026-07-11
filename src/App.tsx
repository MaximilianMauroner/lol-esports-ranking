import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { AlertTriangle, BarChart3, Globe2, RefreshCw, X } from 'lucide-react'
import type {
  SnapshotCheckpointOption,
  PublicTeamStanding as RankingSummaryStanding,
} from './lib/publicArtifacts/schema'
import type { PublicSnapshotState } from './lib/publicArtifacts/resolver'
import {
  formatDate,
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
import { RegionBadge } from './components/ui'
import { Button } from './components/ui/button'
import { Alert } from './components/ui/alert'
import { Card } from './components/ui/card'
import { Skeleton } from './components/ui/skeleton'
import { currentSeasonScope } from './lib/defaultScope'
import { emptyPlayerScope, resolvePlayerScope } from './lib/playerScopes'
import { PROJECT_FEEDBACK_URL, PROJECT_REPOSITORY_URL, RIOT_PROJECT_NOTICE } from './lib/legal'
import { projectTournamentStandings, tournamentIdFromFilter, type TournamentFilterValue } from './lib/internationalTournaments'
import { cn } from './lib/utils'
import {
  checkpointFromScope,
  checkpointOptionsForSeason,
  checkpointScope,
  scopeLabel,
  seasonFromScope,
  usePublicArtifacts,
} from './hooks/usePublicArtifacts'

type Mode = 'rankings' | 'regions'
type MovementBaseline = {
  label: string
}
const COMPARE_LIMIT = 4
const CHECKPOINT_SEQUENCE = ['split-1', 'split-2', 'split-3'] as const
const RegionsView = lazy(() => import('./views/RegionsView').then((module) => ({ default: module.RegionsView })))
const RegionCompareDrawer = lazy(() => import('./components/CompareDrawer').then((module) => ({ default: module.RegionCompareDrawer })))
const RegionCompareAnalysis = lazy(() => import('./components/CompareAnalysis').then((module) => ({ default: module.RegionCompareAnalysis })))
const TeamCompareDrawer = lazy(() => import('./components/CompareDrawer').then((module) => ({ default: module.TeamCompareDrawer })))
const TeamCompareAnalysis = lazy(() => import('./components/CompareAnalysis').then((module) => ({ default: module.TeamCompareAnalysis })))

const MODES: { id: Mode; label: string; tagline: string; icon: typeof BarChart3 }[] = [
  { id: 'rankings', label: 'Rankings', tagline: 'Board, tiers, podium', icon: BarChart3 },
  { id: 'regions', label: 'Regions', tagline: 'Regional strength', icon: Globe2 },
]

const MODE_TITLES: Record<Mode, { eyebrow: string; title: string }> = {
  regions: { eyebrow: 'Regional strength', title: 'Region power scores' },
  rankings: { eyebrow: 'Tier 1 team strength', title: 'Team Power Index' },
}

function checkpointButtonClassName(active: boolean, ongoing = false) {
  return cn(
    'h-[38px] min-w-[86px] shrink-0 rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 text-[var(--muted)] shadow-none hover:border-[var(--line-strong)] hover:text-[var(--text)] [&>small]:mt-0.5 [&>small]:block [&>small]:text-[0.68rem] [&>small]:font-[560] [&>small]:leading-[1.1] [&>small]:text-[var(--muted)] [&>span]:block [&>span]:text-[0.86rem] [&>span]:font-bold [&>span]:leading-[1.1]',
    active && 'border-[color-mix(in_oklch,var(--accent),white_12%)] bg-[color-mix(in_oklch,var(--accent),transparent_86%)] text-[var(--text-strong)]',
    ongoing && 'border-[color-mix(in_oklch,var(--win),var(--line)_55%)]',
  )
}

function App() {
  const [mode, setMode] = useState<Mode>(readModeFromHash)
  const [scope, setScope] = useState(() => readScopeFromHash() ?? currentSeasonScope())
  const [loadPlayers, setLoadPlayers] = useState(false)
  const [loadTeamHistory, setLoadTeamHistory] = useState(false)
  const [loadRegionHistory, setLoadRegionHistory] = useState(() => readModeFromHash() === 'regions')
  const [tournamentFilter, setTournamentFilter] = useState<TournamentFilterValue>('All')
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
    retryTournamentMovements,
    prefetchScope,
    prefetchTournament,
  } = usePublicArtifacts(scope, {
    loadPlayers,
    loadTeamHistory,
    loadRegionHistory,
    loadTournamentMovements: mode === 'rankings',
    tournamentId,
  })
  const [regionPicks, setRegionPicks] = useState<RegionStrength[]>([])
  const [teamPicks, setTeamPicks] = useState<RankingSummaryStanding[]>([])
  const [teamSearch, setTeamSearch] = useState('')
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
  const trayPicks = mode === 'regions' ? activeRegionPicks.length : activeTeamPicks.length

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

  if (manifestState.status === 'loading') return <BootScreen />
  if (manifestState.status !== 'ready') {
    return (
      <ErrorScreen
        message={manifestState.status === 'idle' ? 'Ranking manifest has not been requested yet.' : manifestState.message}
      />
    )
  }

  const loadedData = manifestState.data
  const seeded = loadedData.dataMode === 'seeded-sample' || loadedData.coverage?.seededSample === true
  const matchCount = snapshot?.matchCount ?? loadedData.coverage?.matchCount
  const trayLabel = mode === 'regions' ? 'Region compare' : 'Team compare'
  const teamColumns = teamCompareColumns(activeTeamPicks)
  const regionColumns = regionCompareColumns(activeRegionPicks)
  const movementBaseline = movementBaselineFor(activeCheckpoint, checkpointTabs)
  const pendingCheckpoint = pendingCheckpointForSeason(activeSeason, seasonYears, checkpointTabs)
  const ongoingCheckpointId = pendingCheckpoint ? checkpointTabs.at(-1)?.id : undefined
  const teamCompareAfter = drawerOpen && mode === 'rankings' ? (
    <Suspense fallback={<p className="px-[18px] py-[22px] text-[var(--muted)]">Loading comparison...</p>}>
      <TeamCompareAnalysis teams={activeTeamPicks} columns={teamColumns} historyState={teamHistoryState} />
    </Suspense>
  ) : null
  const regionCompareAfter = drawerOpen && mode === 'regions' ? (
    <Suspense fallback={<p className="px-[18px] py-[22px] text-[var(--muted)]">Loading comparison...</p>}>
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
  const goHome = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setMode('rankings')
    replaceHashForModeAndScope('rankings', effectiveScope)
  }

  function preloadOnIntent(nextScope: string) {
    if (nextScope !== effectiveScope) prefetchScope(nextScope)
  }

  return (
    <div className="flex min-h-full flex-col">
      <a className="fixed top-[-56px] left-3 z-80 rounded-[var(--r)] border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-[0.84rem] font-[650] text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] transition-[top] duration-120 ease-out focus-visible:top-3" href="#main-content">Skip to content</a>
        <nav className="sticky top-0 z-50 grid min-h-[var(--app-nav-h)] grid-cols-[minmax(158px,max-content)_minmax(0,1fr)] items-center gap-[clamp(10px,1.6vw,22px)] border-b border-[var(--line)] bg-[oklch(0.135_0.004_250/0.96)] px-[var(--page-x)] py-2.5 backdrop-blur-[16px] max-[1040px]:gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)] max-[900px]:items-stretch max-[900px]:gap-x-3 max-[900px]:gap-y-2 max-[900px]:px-3 max-[900px]:pt-2 max-[900px]:pb-2.5" aria-label="Primary">
          <a className="flex min-w-0 items-center gap-[11px] rounded-[var(--r-sm)] text-left text-inherit no-underline transition-colors duration-160 hover:bg-[color-mix(in_oklab,var(--surface-2)_46%,transparent)] max-[1040px]:min-w-auto max-[900px]:mr-auto max-[900px]:min-h-9 max-[900px]:justify-self-start [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11" href={hashForModeAndScope('rankings', effectiveScope)} onClick={goHome} title="Go to Rankings home">
            <span className="grid size-[37px] shrink-0 place-items-center overflow-hidden rounded-[7px]">
              <img className="block size-full" src="/logo.svg" alt="" aria-hidden="true" width={37} height={37} />
            </span>
            <div className="min-w-0">
              <b className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.94rem] tracking-normal text-[var(--text-strong)]">Power Index</b>
              <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.68rem] tracking-[0.13em] text-[var(--faint)] uppercase">LoL Esports</span>
            </div>
          </a>
        <div className="hidden">Compare</div>
        <div className="-m-0.5 flex min-w-0 items-center justify-center gap-1.5 overflow-x-auto p-0.5 [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[900px]:m-0 max-[900px]:w-full max-[900px]:justify-start max-[900px]:p-0">
          {MODES.map((entry) => {
            const Icon = entry.icon
            return (
              <a
                key={entry.id}
                href={hashForModeAndScope(entry.id, effectiveScope)}
                className={cn(
                  'flex min-h-11 min-w-0 flex-[1_1_132px] max-w-[min(186px,100%)] cursor-pointer items-center gap-[9px] rounded-[var(--r-sm)] border border-transparent px-2.5 py-[7px] text-left text-[var(--muted)] no-underline transition-[background,color,border-color] duration-160 hover:bg-[var(--surface-2)] hover:text-[var(--text)] max-[900px]:min-h-10 max-[900px]:flex-[0_0_min(38vw,144px)] max-[900px]:justify-start max-[900px]:px-1.5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [&>svg]:shrink-0 [&>span]:min-w-0 [&_b]:block [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:text-[0.88rem] [&_b]:font-semibold [&_small]:block [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-[0.72rem] [&_small]:text-[var(--faint)] max-[1040px]:[&_small]:hidden',
                  mode === entry.id && 'border-[color-mix(in_oklch,var(--rank-gold),var(--line)_38%)] bg-[var(--surface-2)] text-[var(--text-strong)] shadow-[inset_0_-2px_0_var(--rank-gold)] [&_small]:text-[var(--rank-gold)]',
                )}
                aria-current={mode === entry.id ? 'page' : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>
                  <b>{entry.label}</b>
                  <small>{entry.tagline}</small>
                </span>
              </a>
            )
          })}
        </div>
      </nav>

      <main id="main-content" className="flex min-w-0 flex-col pb-[calc(var(--tray-h)+24px+env(safe-area-inset-bottom))] max-sm:pb-[calc(96px+24px+env(safe-area-inset-bottom))]" tabIndex={-1} ref={mainRef}>
        <header className="flex flex-wrap items-end gap-x-6 gap-y-4 border-b border-[var(--line)] bg-[oklch(0.125_0.004_250/0.72)] px-[var(--page-x)] pt-[18px] pb-3.5">
          <div className="mr-auto min-w-0 flex-[1_1_320px]">
            <p className="text-[0.7rem] tracking-[0.16em] text-[var(--muted)] uppercase">{MODE_TITLES[mode].eyebrow}</p>
            <h1 className="text-[1.7rem] font-[640] tracking-normal text-[var(--text-strong)]">{MODE_TITLES[mode].title}</h1>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-[var(--line)] bg-[color-mix(in_oklch,var(--surface)_76%,var(--bg))] px-[var(--page-x)] py-2" aria-label="Snapshot scope controls">
          <div className="flex min-h-[38px] items-stretch gap-1 overflow-x-auto [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Season">
            {seasonTabs.map((season) => (
              <Button
                key={season}
                type="button"
                variant="ghost"
                aria-pressed={activeSeason === season}
                className={cn(
                  'relative h-[38px] min-w-[62px] shrink-0 self-stretch rounded-md border border-transparent bg-[color-mix(in_oklch,var(--surface-2)_58%,transparent)] px-3 text-[0.86rem] font-[680] tracking-normal text-[var(--muted)] shadow-none hover:text-[var(--text)]',
                  activeSeason === season && 'border-[color-mix(in_oklch,var(--accent),var(--line)_46%)] bg-[color-mix(in_oklch,var(--accent),transparent_88%)] text-[var(--text-strong)]',
                )}
                onClick={() => selectScope(scopeForSeasonTab(season))}
                onFocus={() => preloadOnIntent(scopeForSeasonTab(season))}
                onPointerEnter={() => preloadOnIntent(scopeForSeasonTab(season))}
              >
                {season}
              </Button>
            ))}
          </div>

          {activeSeason && activeSeason !== 'All' && checkpointTabs.length > 0 ? (
            <div className="flex min-h-[38px] items-center gap-2 overflow-x-auto [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label={`${activeSeason} checkpoints`}>
              <Button
                type="button"
                variant="ghost"
                aria-pressed={!activeCheckpoint}
                className={checkpointButtonClassName(!activeCheckpoint)}
                onClick={() => selectScope(`season:${activeSeason}`)}
                onFocus={() => preloadOnIntent(`season:${activeSeason}`)}
                onPointerEnter={() => preloadOnIntent(`season:${activeSeason}`)}
              >
                <span>Full year</span>
              </Button>
              {checkpointTabs.map((checkpoint) => {
                const ongoing = checkpoint.id === ongoingCheckpointId
                return (
                  <Button
                    key={checkpoint.id}
                    type="button"
                    variant="ghost"
                    title={ongoing ? `${checkpoint.description}. This split is still ongoing.` : checkpoint.description}
                    aria-pressed={activeCheckpoint === checkpoint.id}
                    className={checkpointButtonClassName(activeCheckpoint === checkpoint.id, ongoing)}
                    onClick={() => selectScope(checkpointScope(activeSeason, checkpoint.id))}
                    onFocus={() => preloadOnIntent(checkpointScope(activeSeason, checkpoint.id))}
                    onPointerEnter={() => preloadOnIntent(checkpointScope(activeSeason, checkpoint.id))}
                  >
                    <span>
                      {checkpoint.label}
                      {ongoing ? <em className="ml-[7px] inline-flex items-center rounded-full bg-[var(--win-soft)] px-[5px] pt-px pb-0.5 align-[1px] text-[0.6rem] font-[760] text-[var(--win)] not-italic uppercase">Ongoing</em> : null}
                    </span>
                    <small>{formatDate(checkpoint.endDate)}</small>
                  </Button>
                )
              })}
              {pendingCheckpoint ? (
                <div
                  className="grid h-[38px] min-w-[86px] shrink-0 cursor-default place-content-center rounded-md border border-dashed border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2),transparent_34%)] px-3 text-[var(--faint)] [&>small]:mt-0.5 [&>small]:block [&>small]:text-[0.68rem] [&>small]:leading-[1.1] [&>small]:text-[var(--faint)] [&>span]:block [&>span]:text-[0.86rem] [&>span]:font-bold [&>span]:leading-[1.1]"
                  aria-disabled="true"
                  title={`${pendingCheckpoint.label} has not started yet.`}
                >
                  <span>{pendingCheckpoint.label}</span>
                  <small>Not started</small>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {seeded ? (
          <div className="flex min-w-0 flex-col gap-[22px] px-[var(--page-x)] pt-6 pb-0">
            <Alert className="flex items-center gap-2.5 rounded-[var(--r)] border-[var(--warn-soft)] bg-[var(--warn-soft)] px-3.5 py-[11px] text-[0.84rem] text-[var(--warn)]" role="status">
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
              <Suspense fallback={<ViewLoading label="Loading region view" />}>
                <RegionsView
                  regions={regions}
                  standings={standings}
                  regionHistory={activeRegionHistory}
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
                    seeded,
                    sourceBreakdown: snapshot?.sourceBreakdown ?? [],
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
          </>
        )}
        <footer className="mx-[var(--page-x)] mt-[30px] flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--line)] pt-[15px] text-[0.72rem] leading-[1.55] text-[var(--faint)]" aria-label="Project disclaimer">
          <span>{RIOT_PROJECT_NOTICE}</span>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href={PROJECT_REPOSITORY_URL}>Source code</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href={PROJECT_FEEDBACK_URL}>Report feedback</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href="/legal">Legal notice</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href="/privacy">Privacy</a>
          <a className="text-[var(--muted)] underline-offset-2 hover:text-[var(--text)] hover:underline" href="/licenses">Licenses</a>
        </footer>
      </main>

      {trayPicks > 0 ? (
        <div className="fixed right-0 bottom-0 left-[var(--rail-w)] z-40 grid min-h-[var(--tray-h)] items-center border-t border-[var(--line-strong)] bg-[color-mix(in_oklch,var(--surface)_92%,var(--bg))] pt-2 pr-[max(var(--page-x),env(safe-area-inset-right))] pb-[calc(8px+env(safe-area-inset-bottom))] pl-[max(var(--page-x),env(safe-area-inset-left))] max-sm:pr-[max(12px,env(safe-area-inset-right))] max-sm:pl-[max(12px,env(safe-area-inset-left))]">
          <div className="mx-auto grid min-h-10 w-full max-w-[1440px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 max-sm:min-h-[76px] max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-2" role="region" aria-label={`${trayLabel}: ${trayPicks} selected`}>
            <span className="whitespace-nowrap text-[0.8rem] font-[650] text-[var(--muted)]">{trayLabel}</span>
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-sm:col-span-full max-sm:col-start-1 max-sm:row-start-2 max-sm:w-full">
              {mode === 'regions'
                ? activeRegionPicks.map((region) => (
                    <span className="inline-flex min-h-7 max-w-[min(220px,38vw)] items-center gap-1.5 whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-2)] py-[3px] pr-1 pl-2 text-[0.78rem] text-[var(--text)] max-sm:max-w-[min(180px,48vw)] [&>b]:min-w-0 [&>b]:overflow-hidden [&>b]:text-ellipsis [&>b]:font-[650]" key={regionKey(region)}>
                      <RegionBadge region={region.region} size="sm" />
                      <b>{region.region}</b>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-[22px] shrink-0 cursor-pointer rounded-[var(--r-sm)] border border-transparent bg-transparent text-[var(--muted)] hover:border-[var(--line-strong)] hover:bg-[var(--surface-3)] hover:text-[var(--loss)]"
                        onClick={() => toggleRegion(region)}
                        aria-label={`Remove ${region.region}`}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </span>
                  ))
                : null}
              {mode === 'rankings'
                ? activeTeamPicks.map((team) => (
                    <span className="inline-flex min-h-7 max-w-[min(220px,38vw)] items-center gap-1.5 whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-2)] py-[3px] pr-1 pl-2 text-[0.78rem] text-[var(--text)] max-sm:max-w-[min(180px,48vw)] [&>b]:min-w-0 [&>b]:overflow-hidden [&>b]:text-ellipsis [&>b]:font-[650]" key={teamKey(team)}>
                      <b>{team.code ?? team.team}</b>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-[22px] shrink-0 cursor-pointer rounded-[var(--r-sm)] border border-transparent bg-transparent text-[var(--muted)] hover:border-[var(--line-strong)] hover:bg-[var(--surface-3)] hover:text-[var(--loss)]"
                        onClick={() => toggleTeam(team)}
                        aria-label={`Remove ${team.team}`}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </span>
                  ))
                : null}
            </div>
            <div className="flex min-w-max items-center justify-end gap-2 max-sm:col-start-2 max-sm:row-start-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-[var(--muted)]"
                onClick={() => {
                  if (mode === 'regions') setRegionPicks([])
                  else setTeamPicks([])
                }}
              >
                Clear
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="min-w-[92px]"
                onClick={() => {
                  if (mode === 'regions') {
                    requestRegionHistory()
                    requestTeamHistory()
                  } else {
                    requestTeamHistory()
                  }
                  setDrawerOpen(true)
                }}
                disabled={trayPicks < 2}
              >
                Compare {trayPicks}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {drawerOpen && mode === 'regions' ? (
        <Suspense fallback={null}>
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
        <Suspense fallback={null}>
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
  const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  const segment = hashModeSegment(hash)
  if (segment === 'teams') return 'rankings'
  if (isKnownMode(segment)) return segment

  const pathSegment = typeof window !== 'undefined'
    ? pathModeSegment(window.location.pathname)
    : ''
  if (pathSegment === 'teams') return 'rankings'
  return isKnownMode(pathSegment) ? pathSegment : 'rankings'
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

function hashModeSegment(hash: string) {
  return hash.split(/[/?]/, 1)[0]
}

function pathModeSegment(pathname: string) {
  return pathname.split('/').filter(Boolean)[0] ?? ''
}

function isKnownMode(value: string): value is Mode {
  return value === 'rankings'
    || value === 'regions'
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
  const isLoading = state.status === 'loading'
  return (
    <section className="flex min-w-0 flex-col gap-[22px] px-[var(--page-x)] pt-6">
      <Card className="min-w-0 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)]">
        <div className="grid place-items-center gap-3 px-6 py-16 text-center text-[var(--muted)] [&>h3]:text-[1.05rem] [&>h3]:text-[var(--text-strong)] [&>p]:max-w-[46ch] [&>p]:text-[0.88rem] [&>svg]:text-[var(--faint)]" aria-busy={isLoading}>
          {isLoading ? <BarChart3 size={26} aria-hidden="true" /> : <AlertTriangle size={26} aria-hidden="true" />}
          <h3>{isLoading ? `Loading ${scope}` : `Snapshot unavailable for ${scope}`}</h3>
          <p>{isLoading ? 'Fetching the exact public shard for this scope.' : state.message}</p>
          {isLoading ? (
            <div className="mt-1 grid w-[min(280px,100%)] gap-2.5" aria-hidden="true">
              <Skeleton className="h-3.5 w-full rounded-md" />
              <Skeleton className="h-3.5 w-[70%] rounded-md" />
              <Skeleton className="h-3.5 w-[40%] rounded-md" />
            </div>
          ) : null}
        </div>
      </Card>
    </section>
  )
}

function ViewLoading({ label }: { label: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-[22px] px-[var(--page-x)] pt-6">
      <Card className="min-w-0 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)]">
        <div className="grid place-items-center gap-3 px-6 py-16 text-center text-[var(--muted)] [&>h3]:text-[1.05rem] [&>h3]:text-[var(--text-strong)] [&>svg]:text-[var(--faint)]" aria-busy="true">
          <RefreshCw size={26} aria-hidden="true" />
          <h3>{label}</h3>
          <div className="mt-1 grid w-[min(280px,100%)] gap-2.5" aria-hidden="true">
            <Skeleton className="h-3.5 w-full rounded-md" />
            <Skeleton className="h-3.5 w-[70%] rounded-md" />
            <Skeleton className="h-3.5 w-[40%] rounded-md" />
          </div>
        </div>
      </Card>
    </section>
  )
}

function BootScreen() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="grid w-[min(440px,92vw)] gap-3.5 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)] p-[26px] shadow-[var(--shadow-2)]" aria-busy="true">
        <div className="flex items-center gap-[11px] font-semibold text-[var(--text-strong)]">
          <BarChart3 size={20} aria-hidden="true" />
          Loading power index
        </div>
        <Skeleton className="h-3.5 w-full rounded-md" />
        <Skeleton className="h-3.5 w-[70%] rounded-md" />
        <Skeleton className="h-3.5 w-[40%] rounded-md" />
      </Card>
    </main>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="grid w-[min(440px,92vw)] gap-3.5 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)] p-[26px] shadow-[var(--shadow-2)]">
        <div className="flex items-center gap-[11px] font-semibold text-[var(--text-strong)] [&>svg]:text-[var(--loss)]">
          <AlertTriangle size={20} aria-hidden="true" />
          Snapshot unavailable
        </div>
        <p className="text-[var(--muted)]">{message}</p>
        <Button type="button" variant="default" onClick={() => window.location.reload()}>
          <RefreshCw size={15} aria-hidden="true" />
          Retry
        </Button>
      </Card>
    </main>
  )
}

export default App
