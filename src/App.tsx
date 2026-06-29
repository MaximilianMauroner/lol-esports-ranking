import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Activity, AlertTriangle, BarChart3, FileText, Globe2, RefreshCw, Swords, Trophy, Users } from 'lucide-react'
import type {
  CompactPlayer,
  PublicPlayerDirectory as PlayerDirectory,
  SnapshotCheckpointOption,
  SnapshotFilter,
  PublicTeamStanding as RankingSummaryStanding,
} from './lib/publicArtifacts/schema'
import { snapshotKey } from './lib/publicArtifacts/schema'
import type { PublicSnapshotState } from './lib/publicArtifacts/resolver'
import {
  formatDate,
  formatNumber,
  formatSigned,
  teamKey,
} from './lib/display'
import { deriveRankingFlair, type RankingFlair, type RankingMovementPick } from './lib/rankingFlair'
import type { RegionStrength } from './lib/regionStrength'
import { CompareDrawer } from './components/CompareDrawer'
import { CompareProfileChart, RegionCompareAnalysis, TeamCompareAnalysis } from './components/CompareAnalysis'
import { RankingShowcase, type RankingShowcaseProps } from './components/RankingShowcase'
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
import { ArenaView } from './views/ArenaView'
import { WorldsLabView } from './views/WorldsLabView'
import { SplitRaceView } from './views/SplitRaceView'
import { ReceiptsView } from './views/ReceiptsView'
import { RegionBadge } from './components/ui'
import { Button } from './components/ui/button'
import { Alert } from './components/ui/alert'
import { Card } from './components/ui/card'
import { Skeleton } from './components/ui/skeleton'
import { cn } from './lib/utils'
import {
  checkpointFromScope,
  checkpointOptionsForSeason,
  checkpointScope,
  scopeLabel,
  seasonFromScope,
  usePublicArtifacts,
} from './hooks/usePublicArtifacts'

type ToolMode = 'rankings' | 'arena' | 'worlds-lab' | 'split-race' | 'receipts'
type LegacyMode = 'regions' | 'players'
type Mode = ToolMode | LegacyMode

const COMPARE_LIMIT = 4
const CHECKPOINT_SEQUENCE = ['split-1', 'split-2', 'split-3'] as const

const MODES: { id: Mode; label: string; tagline: string; icon: typeof BarChart3 }[] = [
  { id: 'rankings', label: 'Rankings', tagline: 'Board, tiers, podium', icon: BarChart3 },
  { id: 'regions', label: 'Regions', tagline: 'Regional strength', icon: Globe2 },
  { id: 'arena', label: 'Arena', tagline: 'Series matchup lab', icon: Swords },
  { id: 'worlds-lab', label: 'Worlds Lab', tagline: 'Swiss & bracket odds', icon: Trophy },
  { id: 'split-race', label: 'Split Race', tagline: 'Rank race timeline', icon: Activity },
  { id: 'players', label: 'Players', tagline: 'Role power', icon: Users },
  { id: 'receipts', label: 'Receipts', tagline: 'Shareable ranking proof', icon: FileText },
]

const MODE_TITLES: Record<Mode, { eyebrow: string; title: string }> = {
  regions: { eyebrow: 'Regional strength', title: 'Region power scores' },
  rankings: { eyebrow: 'Tier 1 team strength', title: 'Global Power Rankings' },
  arena: { eyebrow: 'Matchup tools', title: 'Arena' },
  'worlds-lab': { eyebrow: 'Tournament simulation', title: 'Worlds Lab' },
  'split-race': { eyebrow: 'Season movement', title: 'Split Race' },
  receipts: { eyebrow: 'Ranking provenance', title: 'Receipts' },
  players: { eyebrow: 'Role-conditioned player strength', title: 'Player Role Power' },
}

function App() {
  const [mode, setMode] = useState<Mode>(readModeFromHash)
  const [scope, setScope] = useState(() => readScopeFromHash() ?? currentYearScope())
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
  } = usePublicArtifacts(scope)
  const [regionPicks, setRegionPicks] = useState<RegionStrength[]>([])
  const [teamPicks, setTeamPicks] = useState<RankingSummaryStanding[]>([])
  const [playerPicks, setPlayerPicks] = useState<CompactPlayer[]>([])
  const [teamSearch, setTeamSearch] = useState('')
  const [playerSearch, setPlayerSearch] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const mainRef = useRef<HTMLElement | null>(null)
  const didMountModeRef = useRef(false)

  useEffect(() => {
    function onHashChange() {
      setMode(readModeFromHash())
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
  const rankingFlair = useMemo(() => deriveRankingFlair(standings), [standings])
  const activeRegionHistory = regionHistoryState.status === 'ready' ? regionHistoryState.data : undefined

  const activePlayers = useMemo(
    () => playersState.status === 'ready' ? playersForScope(playersState.data, filter) : [],
    [filter, playersState],
  )
  const activePlayerRoles = useMemo(
    () => playersState.status === 'ready' ? playersState.data.roles.filter((role) => activePlayers.some((player) => player.role === role)) : [],
    [activePlayers, playersState],
  )
  const activeRegionPicks = useMemo(() => reconcilePicks(regionPicks, regions, regionKey), [regionPicks, regions])
  const activeTeamPicks = useMemo(() => reconcilePicks(teamPicks, standings, teamKey), [standings, teamPicks])
  const activePlayerPicks = useMemo(() => reconcilePicks(playerPicks, activePlayers, (player) => player.id), [activePlayers, playerPicks])
  const regionPickIds = useMemo(() => new Set(activeRegionPicks.map(regionKey)), [activeRegionPicks])
  const playerPickIds = useMemo(() => new Set(activePlayerPicks.map((player) => player.id)), [activePlayerPicks])

  function toggleRegion(region: RegionStrength) {
    setRegionPicks((current) => toggleLimitedPick(reconcilePicks(current, regions, regionKey), region, regionKey))
  }

  function toggleTeam(team: RankingSummaryStanding) {
    setTeamPicks((current) => toggleLimitedPick(reconcilePicks(current, standings, teamKey), team, teamKey))
  }

  function togglePlayer(player: CompactPlayer) {
    setPlayerPicks((current) => toggleLimitedPick(reconcilePicks(current, activePlayers, (entry) => entry.id), player, (entry) => entry.id))
  }

  if (manifestState.status === 'loading') return <BootScreen />
  if (manifestState.status !== 'ready') return <ErrorScreen message={manifestState.message} />

  const readyData = manifestState.data
  const provenance = {
    source: readyData.source ?? 'Unknown source',
    model: snapshot?.modelVersion ?? readyData.model?.version ?? 'unknown',
    config: snapshot?.modelConfigHash ?? readyData.model?.configHash ?? 'unknown',
  }
  const seeded = readyData.dataMode === 'seeded-sample' || readyData.coverage?.seededSample === true
  const status = seeded ? 'sample' : readyData.dataMode === 'no-data' ? 'empty' : 'public'
  const matchCount = snapshot?.matchCount ?? readyData.coverage?.matchCount
  const trayPicks = mode === 'regions'
    ? activeRegionPicks.length
    : isTeamToolMode(mode)
      ? activeTeamPicks.length
      : mode === 'players'
        ? activePlayerPicks.length
        : 0
  const trayLabel = mode === 'regions' ? 'Region compare' : isTeamToolMode(mode) ? 'Team compare' : 'Player compare'
  const teamColumns = teamCompareColumns(activeTeamPicks)
  const playerColumns = playerCompareColumns(activePlayerPicks)
  const regionColumns = regionCompareColumns(activeRegionPicks)
  const seasonTabs = [...seasonYears.slice(0, 4), 'All']
  const activeSeason = seasonFromScope(effectiveScope)
  const activeCheckpoint = checkpointFromScope(effectiveScope)
  const checkpointTabs = activeSeason && activeSeason !== 'All'
    ? checkpointOptionsForSeason(readyData, activeSeason)
    : []
  const pendingCheckpoint = pendingCheckpointForSeason(activeSeason, seasonYears, checkpointTabs)
  const ongoingCheckpointId = pendingCheckpoint ? checkpointTabs.at(-1)?.id : undefined
  const goHome = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setMode('rankings')
    replaceHashForModeAndScope('rankings', effectiveScope)
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Skip to content</a>
        <nav className="rail" aria-label="Primary">
          <a className="rail__brand" href={hashForModeAndScope('rankings', effectiveScope)} onClick={goHome} aria-label="Go to Rankings home">
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
          <div className="topbar__meta" aria-label="Data status">
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

        {activeSeason && activeSeason !== 'All' && checkpointTabs.length > 0 ? (
          <div className="checkpoint-tabs" role="group" aria-label={`${activeSeason} checkpoints`}>
            <Button
              type="button"
              variant="ghost"
              aria-pressed={!activeCheckpoint}
              className={cn('checkpoint-tabs__button', !activeCheckpoint && 'is-active')}
              onClick={() => setScope(`season:${activeSeason}`)}
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
                  aria-label={`${checkpoint.label} through ${checkpoint.boundaryEvent}${ongoing ? ', ongoing' : ''}`}
                  className={cn('checkpoint-tabs__button', activeCheckpoint === checkpoint.id && 'is-active', ongoing && 'is-ongoing')}
                  onClick={() => setScope(checkpointScope(activeSeason, checkpoint.id))}
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
                aria-label={`${pendingCheckpoint.label} has not started yet`}
                title={`${pendingCheckpoint.label} has not started yet.`}
              >
                <span>{pendingCheckpoint.label}</span>
                <small>Not started</small>
              </div>
            ) : null}
          </div>
        ) : null}

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
            {mode === 'regions' ? <RegionsView regions={regions} standings={standings} pickedIds={regionPickIds} onToggle={toggleRegion} /> : null}
            {mode === 'rankings' ? (
              <>
                <div className="view">
                  <RankingShowcase {...rankingShowcaseProps(rankingFlair, standings)} />
                </div>
                <TeamsView
                  standings={standings}
                  regions={regions}
                  model={readyData.model}
                  players={activePlayers}
                  search={teamSearch}
                  onSearchChange={setTeamSearch}
                  pickedTeams={activeTeamPicks}
                  historyState={teamHistoryState}
                  updatedAt={formatDate(readyData.generatedAt)}
                  dataSummary={{
                    source: readyData.source,
                    sources: readyData.sources,
                    scopeLabel: scopeLabel(effectiveScope),
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
              </>
            ) : null}
            {mode === 'arena' ? <ArenaView standings={standings} pickedTeams={activeTeamPicks} model={readyData.model} historyState={teamHistoryState} /> : null}
            {mode === 'worlds-lab' ? <WorldsLabView standings={standings} pickedTeams={activeTeamPicks} model={readyData.model} /> : null}
            {mode === 'split-race' ? <SplitRaceView standings={standings} pickedTeams={activeTeamPicks} model={readyData.model} historyState={teamHistoryState} /> : null}
            {mode === 'receipts' ? <ReceiptsView standings={standings} players={activePlayers} manifest={readyData} snapshot={snapshot} pickedTeams={activeTeamPicks} /> : null}
            {mode === 'players' ? (
              <PlayersView
                players={activePlayers}
                metric={playersState.status === 'ready' ? playersState.data.metric : readyData.playerData.metric}
                roles={activePlayerRoles}
                search={playerSearch}
                onSearchChange={setPlayerSearch}
                pickedIds={playerPickIds}
                artifactState={playersState}
                onToggle={togglePlayer}
              />
            ) : null}
          </>
        )}

        <p className="footnote">
          Ratings sourced from {provenance.source}. Model {provenance.model} · config {provenance.config}.
          {readyData.playerData?.description ? ` ${readyData.playerData.description}` : ''}
        </p>
      </main>

      {trayPicks > 0 ? (
        <div className="tray is-shown">
          <span className="tray__label">{trayLabel}</span>
          <div className="tray__chips">
            {mode === 'regions'
              ? activeRegionPicks.map((region) => (
                  <span className="chip" key={regionKey(region)}>
                    <RegionBadge region={region.region} size="sm" />
                    <b>{region.region}</b>
                    <Button type="button" variant="ghost" size="icon" onClick={() => toggleRegion(region)} aria-label={`Remove ${region.region}`}>
                      ✕
                    </Button>
                  </span>
                ))
              : null}
            {isTeamToolMode(mode)
              ? activeTeamPicks.map((team) => (
                  <span className="chip" key={teamKey(team)}>
                    <b>{team.code ?? team.team}</b>
                    <Button type="button" variant="ghost" size="icon" onClick={() => toggleTeam(team)} aria-label={`Remove ${team.team}`}>
                      ✕
                    </Button>
                  </span>
                ))
              : null}
            {mode === 'players'
              ? activePlayerPicks.map((player) => (
                  <span className="chip" key={player.id}>
                    <b>{player.name}</b>
                    <Button type="button" variant="ghost" size="icon" onClick={() => togglePlayer(player)} aria-label={`Remove ${player.name}`}>
                      ✕
                    </Button>
                  </span>
                ))
              : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (mode === 'regions') setRegionPicks([])
              else if (isTeamToolMode(mode)) setTeamPicks([])
              else setPlayerPicks([])
            }}
          >
            Clear
          </Button>
          <Button type="button" variant="default" onClick={() => setDrawerOpen(true)} disabled={trayPicks < 2}>
            Compare {trayPicks}
          </Button>
        </div>
      ) : null}

      <CompareDrawer
        open={drawerOpen && mode === 'regions'}
        title="Region comparison"
        entities={activeRegionPicks}
        columns={regionColumns}
        rows={REGION_COMPARE_ROWS}
        after={<RegionCompareAnalysis regions={activeRegionPicks} columns={regionColumns} standings={standings} historyState={teamHistoryState} regionHistoryState={regionHistoryState} regionHistory={activeRegionHistory} />}
        onClose={() => setDrawerOpen(false)}
        onRemove={(id) => setRegionPicks((current) => current.filter((region) => regionKey(region) !== id))}
      />
      <CompareDrawer
        open={drawerOpen && isTeamToolMode(mode)}
        title="Team comparison"
        entities={activeTeamPicks}
        columns={teamColumns}
        rows={TEAM_COMPARE_ROWS}
        after={<TeamCompareAnalysis teams={activeTeamPicks} columns={teamColumns} historyState={teamHistoryState} />}
        onClose={() => setDrawerOpen(false)}
        onRemove={(id) => setTeamPicks((current) => current.filter((team) => teamKey(team) !== id))}
      />
      <CompareDrawer
        open={drawerOpen && mode === 'players'}
        title="Player comparison"
        entities={activePlayerPicks}
        columns={playerColumns}
        rows={PLAYER_COMPARE_ROWS}
        after={<CompareProfileChart title="Player profile" eyebrow="Current scope" entities={activePlayerPicks} columns={playerColumns} metrics={PLAYER_PROFILE_METRICS} />}
        onClose={() => setDrawerOpen(false)}
        onRemove={(id) => setPlayerPicks((current) => current.filter((player) => player.id !== id))}
      />
    </div>
  )
}

function readModeFromHash(): Mode {
  const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  const segment = hashModeSegment(hash)
  if (segment === 'teams') return 'rankings'
  return isKnownMode(segment) ? segment : 'rankings'
}

function readScopeFromHash() {
  if (typeof window === 'undefined') return undefined
  const query = window.location.hash.slice(1).split('?', 2)[1]
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
  return `#${hashPathForMode(mode, currentHash)}${queryString ? `?${queryString}` : ''}`
}

function hashPathForMode(mode: Mode, currentHash: string) {
  const path = currentHash.split('?', 1)[0]
  if (mode === 'receipts' && path.startsWith('receipts/') && path.length > 'receipts/'.length) return path
  return mode
}

function hashModeSegment(hash: string) {
  return hash.split(/[/?]/, 1)[0]
}

function isKnownMode(value: string): value is Mode {
  return value === 'rankings'
    || value === 'arena'
    || value === 'worlds-lab'
    || value === 'split-race'
    || value === 'receipts'
    || value === 'regions'
    || value === 'players'
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

function isTeamToolMode(mode: Mode): mode is ToolMode {
  return mode === 'rankings'
    || mode === 'arena'
    || mode === 'worlds-lab'
    || mode === 'split-race'
    || mode === 'receipts'
}

function rankingShowcaseProps(flair: RankingFlair, standings: RankingSummaryStanding[]): RankingShowcaseProps {
  const standingsByCode = new Map(standings.map((standing) => [standing.code, standing]))
  const spicy = flair.spicyTakeConfidence[0]
  return {
    title: 'GPR show board',
    subtitle: 'Tier bands, podium, movement, upset evidence, and confidence context from the current public snapshot.',
    podium: flair.podium.map((entry) => {
      const standing = standingsByCode.get(entry.code)
      return {
        id: entry.code,
        team: entry.team,
        code: entry.code,
        region: entry.region,
        league: entry.league,
        rank: entry.rank,
        rating: entry.rating,
        movement: standing?.movement,
      }
    }),
    tierCounts: tierCountsFor(flair),
    biggestRiser: movementSpotlight(flair.movement.biggestRiser),
    biggestFaller: movementSpotlight(flair.movement.biggestFaller),
    upset: flair.upsetHeadline ? {
      headline: flair.upsetHeadline.headline,
      winner: flair.upsetHeadline.winner,
      loser: flair.upsetHeadline.opponent,
      event: flair.upsetHeadline.event,
      score: `${formatSigned(flair.upsetHeadline.matchDelta)} rating`,
      date: flair.upsetHeadline.date,
      description: `Upset score ${formatNumber(flair.upsetHeadline.score)} from match delta, rating gap, and rank gap.`,
    } : undefined,
    confidenceBand: spicy ? {
      label: `${spicy.code}: ${spicy.label}`,
      value: spicy.score,
      tone: spicy.band === 'high' ? 'spicy' : spicy.band === 'medium' ? 'warm' : 'cool',
      description: `${formatNumber(spicy.recentMatchCount)} recent matches with +/-${formatNumber(spicy.uncertainty)} uncertainty.`,
    } : undefined,
  }
}

function tierCountsFor(flair: RankingFlair) {
  return (['S', 'A', 'B', 'C'] as const).map((tier) => {
    const teams = flair.tiers.filter((entry) => entry.tier === tier)
    return {
      tier,
      label: `${tier}-tier`,
      count: teams.length,
      teams: teams.slice(0, 4).map((entry) => entry.code),
    }
  })
}

function movementSpotlight(pick: RankingMovementPick | null) {
  if (!pick) return undefined
  return {
    team: pick.team,
    code: pick.code,
    movement: pick.movement,
    fromRank: pick.previousRank,
    toRank: pick.rank,
    ratingDelta: pick.ratingDelta,
    description: `${formatSigned(pick.ratingDelta)} rating over the previous snapshot.`,
  }
}

function currentYearScope() {
  return `season:${new Date().getFullYear()}`
}

function playersForScope(directory: PlayerDirectory | undefined, filter: SnapshotFilter) {
  if (!directory) return []
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') return directory.players
  if (filter.season !== 'All' && filter.event === 'All' && filter.region === 'All') return directory.scopedPlayers?.[snapshotKey(filter)] ?? []
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
