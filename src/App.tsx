import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BarChart3, Globe2, RefreshCw, UserRound, Users } from 'lucide-react'
import type {
  CompactPlayer,
  PublicPlayerDirectory as PlayerDirectory,
  PublicRankingManifest as RankingData,
  SnapshotFilter,
  PublicTeamHistoryDirectory as TeamHistoryDirectory,
  PublicTeamStanding as RankingSummaryStanding,
} from './lib/publicArtifacts/schema'
import {
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicTeamHistory,
  snapshotKey as publicSnapshotKey,
} from './lib/publicArtifacts/schema'
import {
  resolvePublicSnapshotState,
  validatePublicSnapshotShard,
  type PublicSnapshotCacheEntry,
  type PublicSnapshotState,
} from './lib/publicArtifacts/resolver'
import {
  formatDate,
  formatNumber,
  teamKey,
} from './lib/display'
import type { RegionStrength } from './lib/regionStrength'
import { CompareDrawer } from './components/CompareDrawer'
import { CompareProfileChart, RegionCompareAnalysis, TeamCompareAnalysis } from './components/CompareAnalysis'
import {
  PLAYER_COMPARE_ROWS,
  PLAYER_PROFILE_METRICS,
  REGION_COMPARE_ROWS,
  TEAM_COMPARE_ROWS,
  playerCompareColumns,
  regionCompareColumns,
  regionKey,
  teamCompareColumns,
} from './components/compareAnalysisData'
import { RegionsView } from './views/RegionsView'
import { TeamsView } from './views/TeamsView'
import { PlayersView } from './views/PlayersView'
import { RegionBadge } from './components/ui'
import { Button } from './components/ui/button'
import { Alert } from './components/ui/alert'
import { Card } from './components/ui/card'
import { Skeleton } from './components/ui/skeleton'
import { cn } from './lib/utils'

type Mode = 'regions' | 'teams' | 'players'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: RankingData }
  | { status: 'error'; message: string }

const DATA_URL = import.meta.env.VITE_RANKING_DATA_URL || '/data/ranking-summary.json'
const PLAYERS_URL = import.meta.env.VITE_PLAYER_DATA_URL || '/data/players.json'
const TEAM_HISTORY_URL = import.meta.env.VITE_TEAM_HISTORY_URL || '/data/team-history.json'
const COMPARE_LIMIT = 4

const MODES: { id: Mode; label: string; tagline: string; icon: typeof Globe2 }[] = [
  { id: 'regions', label: 'Regions', tagline: 'Power by league', icon: Globe2 },
  { id: 'teams', label: 'Teams', tagline: 'Ratings & matchups', icon: Users },
  { id: 'players', label: 'Players', tagline: 'Role-rated index', icon: UserRound },
]

const MODE_TITLES: Record<Mode, { eyebrow: string; title: string }> = {
  regions: { eyebrow: 'Regional strength', title: 'Region Power Index' },
  teams: { eyebrow: 'Tier 1 team strength', title: 'Global Power Rankings' },
  players: { eyebrow: 'Player strength', title: 'Player Ratings' },
}

function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [players, setPlayers] = useState<PlayerDirectory | undefined>()
  const [teamHistory, setTeamHistory] = useState<TeamHistoryDirectory | undefined>()
  const [mode, setMode] = useState<Mode>(readModeFromHash)
  const [scope, setScope] = useState(currentYearScope)
  const [snapshotCache, setSnapshotCache] = useState<Record<string, PublicSnapshotCacheEntry>>({})
  const snapshotCacheRef = useRef(snapshotCache)
  const [regionPicks, setRegionPicks] = useState<RegionStrength[]>([])
  const [teamPicks, setTeamPicks] = useState<RankingSummaryStanding[]>([])
  const [playerPicks, setPlayerPicks] = useState<CompactPlayer[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const data = loadState.status === 'ready' ? loadState.data : undefined

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(DATA_URL, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}`)
        const data = parsePublicRankingManifest(await response.json())
        setLoadState({ status: 'ready', data })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load snapshot' })
      }
    }
    void load()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!data) return
    const controller = new AbortController()
    const url = resolveArtifactUrl(data.playerDirectoryUrl ?? PLAYERS_URL, DATA_URL)
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) return
        setPlayers(parsePublicPlayerDirectory(await response.json()))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.error(error)
      }
    }
    void load()
    return () => controller.abort()
  }, [data])

  useEffect(() => {
    if (!data) return
    const controller = new AbortController()
    const url = resolveArtifactUrl(data.teamHistoryUrl ?? TEAM_HISTORY_URL, DATA_URL)
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) return
        setTeamHistory(parsePublicTeamHistory(await response.json()))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.error(error)
      }
    }
    void load()
    return () => controller.abort()
  }, [data])

  useEffect(() => {
    replaceHashForMode(mode)
    function onHashChange() {
      const nextMode = readModeFromHash()
      setMode(nextMode)
      replaceHashForMode(nextMode)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [mode])

  const effectiveScope = useMemo(() => (data ? normalizeScopeForData(scope, data) : scope), [data, scope])
  const filter = useMemo(() => scopeToFilter(effectiveScope), [effectiveScope])
  const snapshotState = useMemo(() => resolvePublicSnapshotState(data, filter, snapshotCache), [data, filter, snapshotCache])
  const snapshot = snapshotState.status === 'ready' ? snapshotState.snapshot : undefined
  const activeTeamHistory = useMemo(() => teamHistoryForScope(teamHistory, filter), [teamHistory, filter])

  useEffect(() => {
    snapshotCacheRef.current = snapshotCache
  }, [snapshotCache])

  useEffect(() => {
    if (!data) return
    const manifest = data
    const key = publicSnapshotKey(filter)
    const cacheEntry = snapshotCacheRef.current[key]
    if (cacheEntry?.status === 'ready' || cacheEntry?.status === 'loading') return
    const embeddedSnapshot = manifest.snapshots?.[key]
    const embeddedHasRecentMatches = embeddedSnapshot?.standings.some((standing) => standing.recentMatches.length > 0) ?? false
    if (embeddedSnapshot && embeddedHasRecentMatches) return
    const expected = manifest.snapshotIndex?.[key]
    if (!expected) {
      setSnapshotCache((current) => ({
        ...current,
        [key]: { status: 'missing', message: `No generated snapshot exists for ${scopeLabel(effectiveScope)}.` },
      }))
      return
    }
    const url = resolveArtifactUrl(expected.url, DATA_URL)
    const controller = new AbortController()
    setSnapshotCache((current) => ({ ...current, [key]: { status: 'loading' } }))
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Filter snapshot failed with ${response.status}`)
        const next = parsePublicRankingShard(await response.json())
        validatePublicSnapshotShard(key, expected, next, manifest)
        setSnapshotCache((current) => ({ ...current, [key]: { status: 'ready', snapshot: next } }))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setSnapshotCache((current) => ({
          ...current,
          [key]: { status: 'error', message: error instanceof Error ? error.message : 'Unable to load filtered snapshot' },
        }))
      }
    }
    void load()
    return () => controller.abort()
  }, [data, effectiveScope, filter])

  const standings = useMemo(() => snapshot?.standings ?? [], [snapshot])
  const regions = useMemo(() => snapshot?.regions ?? [], [snapshot])

  const regionPickIds = useMemo(() => new Set(regionPicks.map(regionKey)), [regionPicks])
  const playerPickIds = useMemo(() => new Set(playerPicks.map((player) => player.id)), [playerPicks])
  const activePlayers = useMemo(() => playersForScope(players, filter), [players, filter])
  const activePlayerRoles = useMemo(
    () => players?.roles.filter((role) => activePlayers.some((player) => player.role === role)) ?? [],
    [activePlayers, players],
  )

  useEffect(() => {
    setRegionPicks((current) => reconcilePicks(current, regions, regionKey))
  }, [regions])

  useEffect(() => {
    setTeamPicks((current) => reconcilePicks(current, standings, teamKey))
  }, [standings])

  useEffect(() => {
    setPlayerPicks((current) => reconcilePicks(current, activePlayers, (player) => player.id))
  }, [activePlayers])

  function toggleRegion(region: RegionStrength) {
    const key = regionKey(region)
    setRegionPicks((current) =>
      current.some((entry) => regionKey(entry) === key)
        ? current.filter((entry) => regionKey(entry) !== key)
        : current.length >= COMPARE_LIMIT
          ? [...current.slice(1), region]
          : [...current, region],
    )
  }

  function toggleTeam(team: RankingSummaryStanding) {
    const key = teamKey(team)
    setTeamPicks((current) =>
      current.some((entry) => teamKey(entry) === key)
        ? current.filter((entry) => teamKey(entry) !== key)
        : current.length >= COMPARE_LIMIT
          ? [...current.slice(1), team]
          : [...current, team],
    )
  }

  function togglePlayer(player: CompactPlayer) {
    setPlayerPicks((current) =>
      current.some((entry) => entry.id === player.id)
        ? current.filter((entry) => entry.id !== player.id)
        : current.length >= COMPARE_LIMIT
          ? [...current.slice(1), player]
          : [...current, player],
    )
  }

  if (loadState.status === 'loading') return <BootScreen />
  if (loadState.status === 'error') return <ErrorScreen message={loadState.message} />

  const readyData = loadState.data
  const provenance = {
    source: readyData.source ?? 'Unknown source',
    model: snapshot?.modelVersion ?? readyData.model?.version ?? 'unknown',
    config: snapshot?.modelConfigHash ?? readyData.model?.configHash ?? 'unknown',
  }
  const seeded = readyData.dataMode === 'seeded-sample' || readyData.coverage?.seededSample === true
  const status = seeded ? 'sample' : readyData.dataMode === 'no-data' ? 'empty' : 'public'
  const matchCount = snapshot?.matchCount ?? readyData.coverage?.matchCount
  const trayPicks = mode === 'regions' ? regionPicks.length : mode === 'teams' ? teamPicks.length : mode === 'players' ? playerPicks.length : 0
  const trayLabel = mode === 'regions' ? 'Region compare' : mode === 'teams' ? 'Team compare' : 'Player compare'
  const teamColumns = teamCompareColumns(teamPicks)
  const playerColumns = playerCompareColumns(playerPicks)
  const regionColumns = regionCompareColumns(regionPicks)
  const yearTabs = orderedSeasonYears(readyData)
  const seasonTabs = [...yearTabs.slice(0, 4), 'All']
  const activeSeason = effectiveScope.startsWith('season:') ? effectiveScope.slice(7) : effectiveScope === 'all' ? 'All' : undefined
  const goHome = () => {
    setMode('teams')
    replaceHashForMode('teams')
  }

  return (
    <div className="app">
      <nav className="rail" aria-label="Primary">
        <button type="button" className="rail__brand" onClick={goHome} aria-label="Go to Teams home">
          <span className="rail__mark">
            <img src="/logo.svg" alt="" aria-hidden="true" />
          </span>
          <div>
            <b>Power Index</b>
            <span>LoL Esports</span>
          </div>
        </button>
        <div className="rail__label">Compare</div>
        <div className="rail__nav">
          {MODES.map((entry) => {
            const Icon = entry.icon
            return (
              <button
                key={entry.id}
                type="button"
                className={`rail__mode${mode === entry.id ? ' is-active' : ''}`}
                onClick={() => setMode(entry.id)}
                aria-current={mode === entry.id ? 'page' : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>
                  <b>{entry.label}</b>
                  <small>{entry.tagline}</small>
                </span>
              </button>
            )
          })}
        </div>
        <div className="rail__foot">
          <span className={`statusdot ${status}`}>
            {seeded ? 'Seeded sample' : readyData.dataMode === 'no-data' ? 'No ranking data' : 'Public-source data'}
          </span>
          <div>
            <span>Matches</span>
            <b>{formatNumber(matchCount)}</b>
          </div>
          <div>
            <span>Model</span>
            <b>{provenance.model}</b>
          </div>
          <div>
            <span>Updated</span>
            <b>{formatDate(readyData.generatedAt)}</b>
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">
            <p className="eyebrow">{MODE_TITLES[mode].eyebrow}</p>
            <h1>{MODE_TITLES[mode].title}</h1>
            <p>{scopeLabel(effectiveScope)} · {provenance.source}</p>
          </div>
        </header>

        <div className="season-tabs" role="group" aria-label="Year-over-year data split">
          {seasonTabs.map((season) => (
            <Button
              key={season}
              type="button"
              variant="ghost"
              aria-pressed={activeSeason === season}
              className={cn('season-tabs__button', activeSeason === season && 'is-active')}
              onClick={() => setScope(season === 'All' ? 'all' : `season:${season}`)}
            >
              {season}
            </Button>
          ))}
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
            {mode === 'regions' ? <RegionsView regions={regions} pickedIds={regionPickIds} onToggle={toggleRegion} /> : null}
            {mode === 'teams' ? (
              <TeamsView
                standings={standings}
                regions={regions}
                model={readyData.model}
                players={activePlayers}
                search=""
                pickedTeams={teamPicks}
                history={activeTeamHistory?.series}
                updatedAt={formatDate(readyData.generatedAt)}
                dataSummary={{
                  source: readyData.source,
                  matchCount,
                  coverageStart: readyData.coverage?.coverageStart,
                  coverageEnd: readyData.coverage?.coverageEnd,
                  latestMatchDate: readyData.coverage?.latestMatchDate,
                  seeded,
                  sourceBreakdown: snapshot?.sourceBreakdown ?? [],
                  notes: readyData.dataQuality?.notes,
                }}
                onToggle={toggleTeam}
              />
            ) : null}
            {mode === 'players' ? (
              <PlayersView
                players={activePlayers}
                roles={activePlayerRoles}
                search=""
                pickedIds={playerPickIds}
                onToggle={togglePlayer}
              />
            ) : null}
          </>
        )}

        <p className="footnote">
          Ratings sourced from {provenance.source}. Model {provenance.model} · config {provenance.config}.
          {readyData.playerData?.description ? ` ${readyData.playerData.description}` : ''}
        </p>
      </div>

      <div className={`tray${trayPicks > 0 ? ' is-shown' : ''}`}>
        <span className="tray__label">{trayLabel}</span>
        <div className="tray__chips">
          {mode === 'regions'
            ? regionPicks.map((region) => (
                <span className="chip" key={regionKey(region)}>
                  <RegionBadge region={region.region} size="sm" />
                  <b>{region.region}</b>
                  <button type="button" onClick={() => toggleRegion(region)} aria-label={`Remove ${region.region}`}>
                    ✕
                  </button>
                </span>
              ))
            : null}
          {mode === 'teams'
            ? teamPicks.map((team) => (
                <span className="chip" key={teamKey(team)}>
                  <b>{team.code ?? team.team}</b>
                  <button type="button" onClick={() => toggleTeam(team)} aria-label={`Remove ${team.team}`}>
                    ✕
                  </button>
                </span>
              ))
            : null}
          {mode === 'players'
            ? playerPicks.map((player) => (
                <span className="chip" key={player.id}>
                  <b>{player.name}</b>
                  <button type="button" onClick={() => togglePlayer(player)} aria-label={`Remove ${player.name}`}>
                    ✕
                  </button>
                </span>
              ))
            : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="border border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          onClick={() => {
            if (mode === 'regions') setRegionPicks([])
            else if (mode === 'teams') setTeamPicks([])
            else setPlayerPicks([])
          }}
        >
          Clear
        </Button>
        <Button type="button" variant="default" className="border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-strong)]" onClick={() => setDrawerOpen(true)} disabled={trayPicks < 2}>
          Compare {trayPicks}
        </Button>
      </div>

      <CompareDrawer
        open={drawerOpen && mode === 'regions'}
        title="Region comparison"
        entities={regionPicks}
        columns={regionColumns}
        rows={REGION_COMPARE_ROWS}
        after={<RegionCompareAnalysis regions={regionPicks} columns={regionColumns} standings={standings} history={activeTeamHistory} />}
        onClose={() => setDrawerOpen(false)}
        onRemove={(id) => setRegionPicks((current) => current.filter((region) => regionKey(region) !== id))}
      />
      <CompareDrawer
        open={drawerOpen && mode === 'teams'}
        title="Team comparison"
        entities={teamPicks}
        columns={teamColumns}
        rows={TEAM_COMPARE_ROWS}
        after={<TeamCompareAnalysis teams={teamPicks} columns={teamColumns} history={activeTeamHistory} />}
        onClose={() => setDrawerOpen(false)}
        onRemove={(id) => setTeamPicks((current) => current.filter((team) => teamKey(team) !== id))}
      />
      <CompareDrawer
        open={drawerOpen && mode === 'players'}
        title="Player comparison"
        entities={playerPicks}
        columns={playerColumns}
        rows={PLAYER_COMPARE_ROWS}
        after={<CompareProfileChart title="Player profile" eyebrow="Current scope" entities={playerPicks} columns={playerColumns} metrics={PLAYER_PROFILE_METRICS} />}
        onClose={() => setDrawerOpen(false)}
        onRemove={(id) => setPlayerPicks((current) => current.filter((player) => player.id !== id))}
      />
    </div>
  )
}

function readModeFromHash(): Mode {
  const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  return hash === 'teams' || hash === 'players' || hash === 'regions' ? hash : 'teams'
}

function replaceHashForMode(mode: Mode) {
  if (typeof window === 'undefined' || window.location.hash.slice(1) === mode) return
  window.history.replaceState(null, '', `#${mode}`)
}

function currentYearScope() {
  return `season:${new Date().getFullYear()}`
}

function orderedSeasonYears(data: RankingData) {
  return [...new Set((data.filterOptions?.seasons ?? []).filter(isSeasonYear))].sort((left, right) => Number(right) - Number(left))
}

function normalizeScopeForData(scope: string, data: RankingData) {
  if (!scope.startsWith('season:')) return scope
  const years = orderedSeasonYears(data)
  if (years.includes(scope.slice(7))) return scope
  return years[0] ? `season:${years[0]}` : 'all'
}

function isSeasonYear(value: string) {
  return /^\d{4}$/.test(value)
}

function scopeToFilter(scope: string): SnapshotFilter {
  if (scope.startsWith('season:')) return { season: scope.slice(7), event: 'All', region: 'All' }
  if (scope.startsWith('event:')) return { season: 'All', event: scope.slice(6), region: 'All' }
  return { season: 'All', event: 'All', region: 'All' }
}

function scopeLabel(scope: string) {
  if (scope.startsWith('season:')) return `${scope.slice(7)} source season`
  if (scope.startsWith('event:')) return scope.slice(6)
  return 'All seasons & events'
}

function resolveArtifactUrl(url: string, baseUrl: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('/')) return url
  const resolvedBase = /^[a-z][a-z\d+.-]*:/i.test(baseUrl)
    ? baseUrl
    : new URL(baseUrl, window.location.origin).toString()
  return new URL(url, resolvedBase).toString()
}

function teamHistoryForScope(history: TeamHistoryDirectory | undefined, filter: SnapshotFilter) {
  if (!history) return undefined
  const scopedSeries = history.scopedSeries?.[publicSnapshotKey(filter)]
  if (!scopedSeries && filter.season === 'All' && filter.event === 'All' && filter.region === 'All') return history
  if (!scopedSeries) {
    return {
      ...history,
      teamCount: 0,
      pointCount: 0,
      series: {},
    }
  }
  return {
    ...history,
    teamCount: Object.keys(scopedSeries).length,
    pointCount: Object.values(scopedSeries).reduce((total, series) => total + series.points.length, 0),
    series: scopedSeries,
  }
}

function playersForScope(directory: PlayerDirectory | undefined, filter: SnapshotFilter) {
  if (!directory) return []
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') return directory.players
  if (filter.season !== 'All' && filter.event === 'All' && filter.region === 'All') return directory.scopedPlayers?.[publicSnapshotKey(filter)] ?? []
  return []
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

function ScopedSnapshotState({ state, scope }: { state: Exclude<PublicSnapshotState, { status: 'ready' }>; scope: string }) {
  const isLoading = state.status === 'loading'
  return (
    <section className="view">
      <Card className="panel">
        <div className="state" aria-busy={isLoading}>
          {isLoading ? <BarChart3 size={26} aria-hidden="true" /> : <AlertTriangle size={26} aria-hidden="true" />}
          <h3>{isLoading ? `Loading ${scope}` : `Snapshot unavailable for ${scope}`}</h3>
          <p>{isLoading ? 'Fetching the exact public shard for this scope.' : state.message}</p>
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
        <Skeleton className="skeleton wide" />
        <Skeleton className="skeleton mid" />
        <Skeleton className="skeleton short" />
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
        <Button type="button" variant="default" className="border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-strong)]" onClick={() => window.location.reload()}>
          <RefreshCw size={15} aria-hidden="true" />
          Retry
        </Button>
      </Card>
    </main>
  )
}

export default App
