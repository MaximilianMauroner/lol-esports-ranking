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
import { RIOT_PROJECT_NOTICE } from './lib/legal'
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

function App() {
  const [mode, setMode] = useState<Mode>(readModeFromHash)
  const [scope, setScope] = useState(() => readScopeFromHash() ?? currentSeasonScope())
  const [loadPlayers, setLoadPlayers] = useState(false)
  const [loadTeamHistory, setLoadTeamHistory] = useState(false)
  const [loadRegionHistory, setLoadRegionHistory] = useState(() => readModeFromHash() === 'regions')
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
    prefetchScope,
  } = usePublicArtifacts(scope, { loadPlayers, loadTeamHistory, loadRegionHistory })
  const [regionPicks, setRegionPicks] = useState<RegionStrength[]>([])
  const [teamPicks, setTeamPicks] = useState<RankingSummaryStanding[]>([])
  const [teamSearch, setTeamSearch] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const mainRef = useRef<HTMLElement | null>(null)
  const didMountModeRef = useRef(false)

  useEffect(() => {
    function onHashChange() {
      const nextMode = readModeFromHash()
      setMode(nextMode)
      if (nextMode === 'regions') setLoadRegionHistory(true)
      const nextScope = readScopeFromHash()
      if (nextScope) setScope(nextScope)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

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
  const activeTeamPicks = useMemo(() => reconcilePicks(teamPicks, standings, teamKey), [standings, teamPicks])
  const regionPickIds = useMemo(() => new Set(activeRegionPicks.map(regionKey)), [activeRegionPicks])
  const trayPicks = mode === 'regions' ? activeRegionPicks.length : activeTeamPicks.length

  function toggleRegion(region: RegionStrength) {
    setRegionPicks((current) => toggleLimitedPick(reconcilePicks(current, regions, regionKey), region, regionKey))
  }

  function toggleTeam(team: RankingSummaryStanding) {
    setTeamPicks((current) => toggleLimitedPick(reconcilePicks(current, standings, teamKey), team, teamKey))
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
    <Suspense fallback={<p className="muted compare-chart__empty">Loading comparison...</p>}>
      <TeamCompareAnalysis teams={activeTeamPicks} columns={teamColumns} historyState={teamHistoryState} />
    </Suspense>
  ) : null
  const regionCompareAfter = drawerOpen && mode === 'regions' ? (
    <Suspense fallback={<p className="muted compare-chart__empty">Loading comparison...</p>}>
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
    <div className="app">
      <a className="skip-link" href="#main-content">Skip to content</a>
        <nav className="rail" aria-label="Primary">
          <a className="rail__brand" href={hashForModeAndScope('rankings', effectiveScope)} onClick={goHome} title="Go to Rankings home">
            <span className="rail__mark">
              <img src="/logo.svg" alt="" aria-hidden="true" width={37} height={37} />
            </span>
            <div>
              <b>Power Index</b>
              <span>LoL Esports</span>
            </div>
          </a>
        <div className="rail__label">Compare</div>
        <div className="rail__nav">
          {MODES.map((entry) => {
            const Icon = entry.icon
            return (
              <a
                key={entry.id}
                href={hashForModeAndScope(entry.id, effectiveScope)}
                className={`rail__mode${mode === entry.id ? ' is-active' : ''}`}
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

      <main id="main-content" className="main" tabIndex={-1} ref={mainRef}>
        <header className="topbar">
          <div className="topbar__title">
            <p className="eyebrow">{MODE_TITLES[mode].eyebrow}</p>
            <h1>{MODE_TITLES[mode].title}</h1>
          </div>
        </header>

        <div className="scope-tabs" aria-label="Snapshot scope controls">
          <div className="season-tabs" role="group" aria-label="Season">
            {seasonTabs.map((season) => (
              <Button
                key={season}
                type="button"
                variant="ghost"
                aria-pressed={activeSeason === season}
                className={cn('season-tabs__button', activeSeason === season && 'is-active')}
                onClick={() => setScope(scopeForSeasonTab(season))}
                onFocus={() => preloadOnIntent(scopeForSeasonTab(season))}
                onPointerEnter={() => preloadOnIntent(scopeForSeasonTab(season))}
              >
                {season}
              </Button>
            ))}
          </div>

          {activeSeason && activeSeason !== 'All' && checkpointTabs.length > 0 ? (
            <div className="checkpoint-tabs" role="group" aria-label={`${activeSeason} checkpoints`}>
              <Button
                type="button"
                variant="ghost"
                aria-pressed={!activeCheckpoint}
                className={cn('checkpoint-tabs__button', !activeCheckpoint && 'is-active')}
                onClick={() => setScope(`season:${activeSeason}`)}
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
                    className={cn('checkpoint-tabs__button', activeCheckpoint === checkpoint.id && 'is-active', ongoing && 'is-ongoing')}
                    onClick={() => setScope(checkpointScope(activeSeason, checkpoint.id))}
                    onFocus={() => preloadOnIntent(checkpointScope(activeSeason, checkpoint.id))}
                    onPointerEnter={() => preloadOnIntent(checkpointScope(activeSeason, checkpoint.id))}
                  >
                    <span>
                      {checkpoint.label}
                      {ongoing ? <em>Ongoing</em> : null}
                    </span>
                    <small>{formatDate(checkpoint.endDate)}</small>
                  </Button>
                )
              })}
              {pendingCheckpoint ? (
                <div
                  className="checkpoint-tabs__button checkpoint-tabs__button--future"
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
          <div className="view" style={{ paddingBottom: 0 }}>
            <Alert className="notice" role="status">
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
                  playerLoadState={playerLoadState}
                  playerScopeLabel={activePlayerScope.label}
                  search={teamSearch}
                  onSearchChange={setTeamSearch}
                  pickedTeams={activeTeamPicks}
                  historyState={teamHistoryState}
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
                />
              </>
            ) : null}
          </>
        )}
        <footer className="site-footer" aria-label="Project disclaimer">
          {RIOT_PROJECT_NOTICE}
        </footer>
      </main>

      {trayPicks > 0 ? (
        <div className="tray is-shown">
          <div className="tray__bar" role="region" aria-label={`${trayLabel}: ${trayPicks} selected`}>
            <span className="tray__label">{trayLabel}</span>
            <div className="tray__chips">
              {mode === 'regions'
                ? activeRegionPicks.map((region) => (
                    <span className="chip" key={regionKey(region)}>
                      <RegionBadge region={region.region} size="sm" />
                      <b>{region.region}</b>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="chip__remove"
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
                    <span className="chip" key={teamKey(team)}>
                      <b>{team.code ?? team.team}</b>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="chip__remove"
                        onClick={() => toggleTeam(team)}
                        aria-label={`Remove ${team.team}`}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </span>
                  ))
                : null}
            </div>
            <div className="tray__actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="tray__clear"
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
                className="tray__primary"
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
    <section className="view">
      <Card className="panel">
        <div className="state" aria-busy={isLoading}>
          {isLoading ? <BarChart3 size={26} aria-hidden="true" /> : <AlertTriangle size={26} aria-hidden="true" />}
          <h3>{isLoading ? `Loading ${scope}` : `Snapshot unavailable for ${scope}`}</h3>
          <p>{isLoading ? 'Fetching the exact public shard for this scope.' : state.message}</p>
          {isLoading ? (
            <div className="state__skeleton" aria-hidden="true">
              <Skeleton className="wide" />
              <Skeleton className="mid" />
              <Skeleton className="short" />
            </div>
          ) : null}
        </div>
      </Card>
    </section>
  )
}

function ViewLoading({ label }: { label: string }) {
  return (
    <section className="view">
      <Card className="panel">
        <div className="state" aria-busy="true">
          <RefreshCw size={26} aria-hidden="true" />
          <h3>{label}</h3>
          <div className="state__skeleton" aria-hidden="true">
            <Skeleton className="wide" />
            <Skeleton className="mid" />
            <Skeleton className="short" />
          </div>
        </div>
      </Card>
    </section>
  )
}

function BootScreen() {
  return (
    <main className="bootscreen">
      <Card className="bootcard" aria-busy="true">
        <div className="bootcard__head">
          <BarChart3 size={20} aria-hidden="true" />
          Loading power index
        </div>
        <Skeleton className="wide" />
        <Skeleton className="mid" />
        <Skeleton className="short" />
      </Card>
    </main>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="bootscreen">
      <Card className="bootcard error">
        <div className="bootcard__head">
          <AlertTriangle size={20} aria-hidden="true" />
          Snapshot unavailable
        </div>
        <p className="muted">{message}</p>
        <Button type="button" variant="default" onClick={() => window.location.reload()}>
          <RefreshCw size={15} aria-hidden="true" />
          Retry
        </Button>
      </Card>
    </main>
  )
}

export default App
