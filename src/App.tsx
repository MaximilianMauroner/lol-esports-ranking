import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarDays,
  GitCompare,
  Info,
  ListFilter,
  Scale,
  Search,
  Shield,
  SlidersHorizontal,
  Trophy,
  UserRound,
} from 'lucide-react'
import { clsx } from 'clsx'
import './App.css'
import { eventTierConfig, modelFactors } from './data/rankingConfig'
import { formatDate, formatDateTime, formatSigned, percent } from './lib/format'
import { factorLabel } from './lib/model'
import { snapshotKey, type SnapshotFilter, type StaticRankingData } from './lib/snapshot'
import type { EventSummary, FactorBreakdown, LeagueStrength, PlayerStanding, Region, SeasonSummary, SourceTrace, TeamProfile, TeamStanding } from './types'
import { Sparkline } from './components/Sparkline'

type ViewKey = 'rankings' | 'weights' | 'teams' | 'players' | 'seasons' | 'events' | 'methodology'

const viewOptions: { key: ViewKey; label: string; icon: typeof BarChart3 }[] = [
  { key: 'rankings', label: 'Global rankings', icon: BarChart3 },
  { key: 'weights', label: 'Tournament weighting', icon: Scale },
  { key: 'teams', label: 'Team timeline', icon: Activity },
  { key: 'players', label: 'Player timeline', icon: UserRound },
  { key: 'seasons', label: 'Season timeline', icon: CalendarDays },
  { key: 'events', label: 'Event timeline', icon: Trophy },
  { key: 'methodology', label: 'Methodology', icon: Info },
]

function App() {
  const [staticData, setStaticData] = useState<StaticRankingData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<ViewKey>('rankings')
  const [selectedTeamName, setSelectedTeamName] = useState('Gen.G')
  const [season, setSeason] = useState('All')
  const [region, setRegion] = useState<Region | 'All'>('All')
  const [event, setEvent] = useState('All')
  const [query, setQuery] = useState('')
  const [compareTeams, setCompareTeams] = useState<string[]>(['Gen.G', 'Bilibili Gaming'])
  const dataUrl = import.meta.env.VITE_RANKING_DATA_URL ?? '/data/ranking-snapshot.json'

  useEffect(() => {
    const controller = new AbortController()

    async function loadStaticData() {
      try {
        const response = await fetch(dataUrl, { cache: 'no-cache', signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const nextData = (await response.json()) as StaticRankingData
        setStaticData(nextData)
        setLoadError(null)
      } catch (error) {
        if (controller.signal.aborted) return
        setLoadError(error instanceof Error ? error.message : 'Failed to load ranking data')
      }
    }

    void loadStaticData()

    return () => controller.abort()
  }, [dataUrl])

  const snapshot = useMemo(() => {
    if (!staticData) return null
    const filter: SnapshotFilter = { season, event, region }
    return staticData.snapshots[snapshotKey(filter)] ?? staticData.snapshots[staticData.defaultSnapshotKey]
  }, [event, region, season, staticData])

  if (!staticData || !snapshot) {
    return (
      <main className="loading-screen">
        <Shield aria-hidden="true" />
        <h1>Global Power Rankings</h1>
        <p>{loadError ? `Static data failed to load: ${loadError}` : 'Loading static ranking snapshot...'}</p>
        <code>{dataUrl}</code>
      </main>
    )
  }

  const seasons = staticData.filterOptions.seasons
  const events = staticData.filterOptions.events
  const regions = staticData.filterOptions.regions
  const ranking = snapshot
  const playerRanking = snapshot.players
  const standings = ranking.standings.filter((standing) => {
    const matchesQuery = query.trim().length === 0 || `${standing.team} ${standing.code} ${standing.league}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery
  })
  const hasNoData = staticData.dataMode === 'no-data' || staticData.coverage.matchCount === 0

  const selectedTeam = standings.find((standing) => standing.team === selectedTeamName) ?? standings[0]
  const biggestRiser = maxBy(ranking.standings, (standing) => standing.movement)
  const biggestFaller = minBy(ranking.standings, (standing) => standing.movement)
  const activeWeight = activeEventWeight(event, ranking.events)

  function toggleCompare(team: string) {
    setCompareTeams((current) => {
      if (current.includes(team)) return current.filter((item) => item !== team)
      return [...current, team].slice(-4)
    })
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand-block">
          <Shield aria-hidden="true" />
          <div>
            <strong>GPR Workbench</strong>
            <span>Transparent LoL esports ratings</span>
          </div>
        </div>
        <nav className="nav-list">
          {viewOptions.map((option) => {
            const Icon = option.icon
            return (
              <button
                key={option.key}
                type="button"
                className={clsx('nav-item', activeView === option.key && 'is-active')}
                onClick={() => setActiveView(option.key)}
              >
                <Icon aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="source-note">
          <span>Data mode</span>
          <strong>{dataModeLabel(staticData.dataMode)}</strong>
          <p>
            {staticData.coverage.matchCount} matches from {staticData.coverage.sourceProviders.join(', ') || 'no active source'}. Model {staticData.model.version}.
          </p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Global Power Rankings</h1>
            <p>Rankings with visible tournament weights, movement reasons, and team/player timelines.</p>
          </div>
          <div className="topbar-actions">
            <span>Generated: {formatDateTime(staticData.generatedAt)}</span>
            <span>Coverage: {formatDate(staticData.coverage.coverageStart)} - {formatDate(staticData.coverage.coverageEnd)}</span>
            <a href="https://lolesports.com/en-US/gpr/2026/current" target="_blank" rel="noreferrer">
              Riot reference
            </a>
          </div>
        </header>

        <section className="control-bar" aria-label="Ranking controls">
          <label>
            <span>Season</span>
            <select value={season} onChange={(eventValue) => setSeason(eventValue.target.value)}>
              {seasons.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Event</span>
            <select value={event} onChange={(eventValue) => setEvent(eventValue.target.value)}>
              {events.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Region</span>
            <select value={region} onChange={(eventValue) => setRegion(eventValue.target.value as Region | 'All')}>
              {regions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select defaultValue="transparent-gpr" disabled aria-describedby="model-version-note">
              <option value="transparent-gpr">Transparent GPR</option>
            </select>
          </label>
          <label className="search-field">
            <span>Search</span>
            <div>
              <Search aria-hidden="true" />
              <input value={query} onChange={(eventValue) => setQuery(eventValue.target.value)} placeholder="Team or league" />
            </div>
          </label>
        </section>

        <section className="context-strip" aria-label="Ranking context">
          <ContextMetric label="Current top" value={ranking.standings[0]?.code ?? 'N/A'} detail={ranking.standings[0]?.team ?? 'No team'} />
          <ContextMetric label="Strongest league" value={ranking.leagues[0]?.league ?? 'N/A'} detail={ranking.leagues[0] ? `${ranking.leagues[0].score} league score` : 'No data'} />
          <ContextMetric label="Biggest riser" value={biggestRiser?.code ?? 'N/A'} detail={biggestRiser ? `${formatSigned(biggestRiser.movement)} rank movement` : 'No data'} tone="positive" />
          <ContextMetric label="Biggest faller" value={biggestFaller?.code ?? 'N/A'} detail={biggestFaller ? `${formatSigned(biggestFaller.movement)} rank movement` : 'No data'} tone="negative" />
          <ContextMetric label="Active K" value={activeWeight.kFactor.toString()} detail={activeWeight.label} />
          <ContextMetric label="Static rows" value={ranking.matchCount.toString()} detail="matches in selected snapshot" />
          <ContextMetric label="Model" value={staticData.model.version} detail={staticData.model.configHash} />
          <ContextMetric label="Coverage" value={formatDate(staticData.coverage.latestMatchDate)} detail={`${formatDate(staticData.coverage.coverageStart)} to ${formatDate(staticData.coverage.coverageEnd)}`} />
        </section>

        {hasNoData && (
          <section className="reference-warning">
            <Info aria-hidden="true" />
            <span>No usable match data is loaded. Rankings, timelines, and league strength will appear after a public source produces rows.</span>
          </section>
        )}

        {(staticData.dataMode === 'seeded-sample' || staticData.coverage.seededSample) && (
          <section className="reference-warning">
            <Info aria-hidden="true" />
            <span>Seeded demo data is active. These rankings are model demonstrations, not official or current LoL Esports standings.</span>
          </section>
        )}
        <p id="model-version-note" className="sr-only">
          Rankings use {staticData.model.name} {staticData.model.version} with config hash {staticData.model.configHash}. Riot GPR is linked only as a reference source until imported reference snapshots are available.
        </p>

        <section className="main-grid">
          <div className="primary-panel">
            {hasNoData && <NoDataPanel staticData={staticData} />}
            {!hasNoData && activeView === 'rankings' && (
              <RankingsTable
                standings={standings}
                selectedTeam={selectedTeam?.team}
                compareTeams={compareTeams}
                onSelect={setSelectedTeamName}
                onToggleCompare={toggleCompare}
              />
            )}
            {!hasNoData && activeView === 'weights' && <TournamentWeights events={ranking.events} leagues={ranking.leagues} />}
            {!hasNoData && activeView === 'teams' && <TeamTimeline standings={ranking.standings} selectedTeam={selectedTeam} onSelect={setSelectedTeamName} />}
            {!hasNoData && activeView === 'players' && <PlayerTimeline players={playerRanking} selectedTeam={selectedTeam?.team} />}
            {!hasNoData && activeView === 'seasons' && <SeasonTimeline seasons={ranking.seasons} />}
            {!hasNoData && activeView === 'events' && <EventTimeline events={ranking.events} teams={staticData.teams} />}
            {!hasNoData && activeView === 'methodology' && <Methodology staticData={staticData} />}
          </div>

          <aside className="insight-panel" aria-label="Selected team insight">
            {hasNoData ? <NoDataAside /> : selectedTeam && <TeamInsight team={selectedTeam} compareTeams={compareTeams} allTeams={ranking.standings} onToggleCompare={toggleCompare} />}
          </aside>
        </section>
      </section>
    </main>
  )
}

function dataModeLabel(dataMode: StaticRankingData['dataMode']) {
  if (dataMode === 'no-data') return 'No data'
  if (dataMode === 'seeded-sample') return 'Seeded static snapshot'
  return 'Scheduled static snapshot'
}

function ContextMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'positive' | 'negative' }) {
  return (
    <div className={clsx('context-metric', tone && `tone-${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function NoDataPanel({ staticData }: { staticData: StaticRankingData }) {
  return (
    <section>
      <PanelHeader icon={Info} title="No data" detail="No usable match rows are available" />
      <div className="empty-state">
        <strong>No data</strong>
        <p>
          The app loaded a valid snapshot, but it contains zero match rows. Connect an Oracle's Elixir CSV or Leaguepedia snapshot, then rebuild the ranking data.
        </p>
        <div className="empty-state-grid">
          <span>Source</span>
          <strong>{staticData.source}</strong>
          <span>Model</span>
          <strong>{staticData.model.version}</strong>
          <span>Rows</span>
          <strong>{staticData.coverage.matchCount}</strong>
        </div>
      </div>
    </section>
  )
}

function NoDataAside() {
  return (
    <div className="insight-content">
      <div className="rating-block">
        <span>Status</span>
        <strong>No data</strong>
        <small>No team, player, event, or league rankings are available from the current snapshot.</small>
      </div>
    </div>
  )
}

function RankingsTable({
  standings,
  selectedTeam,
  compareTeams,
  onSelect,
  onToggleCompare,
}: {
  standings: TeamStanding[]
  selectedTeam?: string
  compareTeams: string[]
  onSelect: (team: string) => void
  onToggleCompare: (team: string) => void
}) {
  return (
    <section>
      <PanelHeader icon={ListFilter} title="Ranking table" detail={`${standings.length} teams in current filter`} />
      <div className="table-wrap">
        <table className="ranking-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Team</th>
              <th>League</th>
              <th>League score</th>
              <th>Rating</th>
              <th>Delta</th>
              <th>Band</th>
              <th>Form</th>
              <th>Driver</th>
              <th>Compare</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((standing) => (
              <tr key={standing.team} className={clsx(selectedTeam === standing.team && 'is-selected')} onClick={() => onSelect(standing.team)}>
                <td>
                  <div className="rank-cell">
                    <strong>{standing.rank}</strong>
                    <RankMovement movement={standing.movement} />
                  </div>
                </td>
                <td>
                  <div className="team-cell">
                    <span>{standing.code}</span>
                    <div>
                      <strong>{standing.team}</strong>
                      <small>{standing.recentEvents[0] ?? 'No event'}</small>
                    </div>
                  </div>
                </td>
                <td>{standing.league}</td>
                <td className="numeric">
                  <strong>{standing.leagueScore}</strong>
                  <small className={standing.leagueAdjustment >= 0 ? 'positive' : 'negative'}>{formatSigned(standing.leagueAdjustment)} power comp.</small>
                </td>
                <td className="numeric">{standing.rating}</td>
                <td className={clsx('numeric', standing.delta >= 0 ? 'positive' : 'negative')}>{formatSigned(standing.delta)}</td>
                <td>
                  <strong>±{standing.uncertainty}</strong>
                  <small>
                    {standing.rating - standing.uncertainty} - {standing.rating + standing.uncertainty}
                  </small>
                </td>
                <td>
                  <FormDots form={standing.form} />
                </td>
                <td>{factorLabel(standing.strongestFactor)}</td>
                <td>
                  <button
                    type="button"
                    className={clsx('icon-button', compareTeams.includes(standing.team) && 'is-active')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleCompare(standing.team)
                    }}
                    aria-label={`Toggle ${standing.team} comparison`}
                  >
                    <GitCompare aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function TeamInsight({
  team,
  compareTeams,
  allTeams,
  onToggleCompare,
}: {
  team: TeamStanding
  compareTeams: string[]
  allTeams: TeamStanding[]
  onToggleCompare: (team: string) => void
}) {
  const compared = allTeams.filter((standing) => compareTeams.includes(standing.team))
  const lastMatch = team.history.at(-1)

  return (
    <div className="insight-content">
      <div className="insight-heading">
        <div className="team-mark">{team.code}</div>
        <div>
          <h2>{team.team}</h2>
          <p>
            #{team.rank} global, {team.league}
          </p>
        </div>
      </div>

      <div className="rating-block">
        <span>Rating</span>
        <strong>{team.rating}</strong>
        <small className={team.delta >= 0 ? 'positive' : 'negative'}>{formatSigned(team.delta)} last movement</small>
        <div className="rating-components">
          <span>Base {team.baseRating}</span>
          <span className={team.leagueAdjustment >= 0 ? 'positive' : 'negative'}>League component {formatSigned(team.leagueAdjustment)}</span>
          <span>Range ±{team.uncertainty}</span>
        </div>
      </div>

      <section className="factor-list" aria-label={`${team.team} score factors`}>
        {(Object.entries(team.factors) as [keyof FactorBreakdown, number][]).map(([key, value]) => (
          <div key={key} className="factor-row">
            <div>
              <span>{factorLabel(key)}</span>
              <small>{percent(value)}</small>
            </div>
            <div className="factor-bar">
              <span style={{ width: `${Math.round(value * 100)}%` }} />
            </div>
          </div>
        ))}
      </section>

      <section className="timeline-card">
        <div>
          <span>Rating timeline</span>
          <small>{team.history.length} scored matches</small>
        </div>
        <Sparkline values={team.history.map((point) => point.rating)} label={`${team.team} rating timeline`} />
      </section>

      {lastMatch && (
        <section className="why-box">
          <strong>Why this rank changed</strong>
          <p>
            Last result was a {lastMatch.result === 'W' ? 'win' : 'loss'} against {lastMatch.opponent} in {lastMatch.event}. The match used a{' '}
            {eventTierConfig[lastMatch.tier].label.toLowerCase()} EventK of {eventTierConfig[lastMatch.tier].kFactor} before series damping and moved the blended rating by{' '}
            {formatSigned(lastMatch.delta)}. {team.league} contributes 20% of the power rating, currently {formatSigned(team.leagueAdjustment)} points versus team Elo.
            Source: {sourceTraceLabel(lastMatch.source)}.
          </p>
        </section>
      )}

      <section>
        <div className="section-title-row">
          <strong>Compare tray</strong>
          <span>{compared.length}/4</span>
        </div>
        <div className="compare-list">
          {compared.map((standing) => (
            <button key={standing.team} type="button" onClick={() => onToggleCompare(standing.team)}>
              <span>{standing.code}</span>
              <strong>{standing.rating}</strong>
              <Sparkline values={standing.history.map((point) => point.rating).slice(-8)} width={90} height={26} label={`${standing.team} comparison timeline`} />
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function TournamentWeights({ events, leagues }: { events: EventSummary[]; leagues: LeagueStrength[] }) {
  return (
    <section>
      <PanelHeader icon={Scale} title="Tournament weighting" detail="EventK values; game updates are damped by best-of length" />
      <div className="weight-grid">
        {Object.entries(eventTierConfig).map(([tier, config]) => {
          const eventCount = events.filter((event) => event.tier === tier).length
          return (
            <article key={tier} className="weight-card">
              <div>
                <strong>{config.label}</strong>
                <span>K {config.kFactor}</span>
              </div>
              <p>{config.description}</p>
              <div className="weight-scale" aria-label={`${config.label} weight`}>
                <span style={{ width: `${Math.round((config.kFactor / 34) * 100)}%` }} />
              </div>
              <small>
                League K {config.leagueKFactor}; {eventCount} events in current filter
              </small>
            </article>
          )
        })}
      </div>
      <div className="league-strength-list">
        <div className="section-title-row">
          <strong>League strength from international play</strong>
          <span>Blended as 20% of each team power rating</span>
        </div>
        {leagues.map((league) => (
          <article key={league.league} className="league-row">
            <div>
              <strong>{league.league}</strong>
              <span>
                {league.wins}-{league.losses} international record
              </span>
            </div>
            <div>
              <small>League score</small>
              <strong>{league.score}</strong>
            </div>
            <div>
              <small>Power component</small>
              <strong className={league.adjustment >= 0 ? 'positive' : 'negative'}>{formatSigned(league.adjustment)}</strong>
            </div>
            <FormDots form={league.form} />
          </article>
        ))}
      </div>
    </section>
  )
}

function TeamTimeline({
  standings,
  selectedTeam,
  onSelect,
}: {
  standings: TeamStanding[]
  selectedTeam?: TeamStanding
  onSelect: (team: string) => void
}) {
  return (
    <section>
      <PanelHeader icon={Activity} title="Team timeline" detail="Rating changes by match and event" />
      <div className="timeline-layout">
        <div className="team-picker">
          {standings.slice(0, 12).map((standing) => (
            <button key={standing.team} type="button" className={clsx(selectedTeam?.team === standing.team && 'is-active')} onClick={() => onSelect(standing.team)}>
              <span>{standing.code}</span>
              <strong>{standing.team}</strong>
              <small>{standing.rating}</small>
            </button>
          ))}
        </div>
        <div className="event-list">
          {(selectedTeam?.history ?? []).slice().reverse().map((point) => (
            <article key={`${point.date}-${point.event}-${point.opponent}`} className="event-row">
              <div>
                <strong>{formatDate(point.date)}</strong>
                <span>{point.event}</span>
              </div>
              <div>
                <span>{point.result} vs {point.opponent}</span>
                <strong className={point.delta >= 0 ? 'positive' : 'negative'}>{formatSigned(point.delta)}</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function PlayerTimeline({ players, selectedTeam }: { players: PlayerStanding[]; selectedTeam?: string }) {
  const visiblePlayers = players.filter((player) => !selectedTeam || player.team === selectedTeam).slice(0, 10)

  return (
    <section>
      <PanelHeader icon={UserRound} title="Player skill timeline" detail="Dynamic share estimate; not sourced official player ratings" />
      <div className="player-grid">
        {visiblePlayers.map((player) => (
          <article key={player.id} className="player-row">
            <div className="player-rank">{player.rank}</div>
            <div>
              <strong>{player.name}</strong>
              <span>
                {player.role}, {player.team}
              </span>
              <small>
                Share {percent(player.playerShare)} from {percent(player.baseShare)} base; impact {player.impactMultiplier.toFixed(2)}x
              </small>
            </div>
            <Sparkline values={player.history.map((point) => point.rating)} width={140} height={34} label={`${player.name} skill timeline`} />
            <div className="numeric">
              <strong>{player.rating}</strong>
              <small className={player.delta >= 0 ? 'positive' : 'negative'}>{formatSigned(player.delta, 1)}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function SeasonTimeline({ seasons }: { seasons: SeasonSummary[] }) {
  return (
    <section>
      <PanelHeader icon={CalendarDays} title="Season timeline" detail="Season-level event and rating summary" />
      <div className="season-list">
        {seasons.map((season) => (
          <article key={season.season} className="season-row">
            <div>
              <strong>{season.season}</strong>
              <span>
                {formatDate(season.startDate)} to {formatDate(season.endDate)}
              </span>
            </div>
            <div>
              <small>Matches</small>
              <strong>{season.matches}</strong>
            </div>
            <div>
              <small>Events</small>
              <strong>{season.events}</strong>
            </div>
            <div>
              <small>Top team</small>
              <strong>{season.topTeam}</strong>
            </div>
            <div>
              <small>Most improved</small>
              <strong>{season.mostImproved}</strong>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function EventTimeline({ events, teams }: { events: EventSummary[]; teams: Record<string, TeamProfile> }) {
  return (
    <section>
      <PanelHeader icon={Trophy} title="Event timeline" detail="Event impact, tier, and participants" />
      <div className="event-list">
        {events.map((event) => (
          <article key={`${event.event}-${event.startDate}`} className="event-row">
            <div>
              <strong>{event.event}</strong>
              <span>
                {formatDate(event.startDate)} to {formatDate(event.endDate)}
              </span>
            </div>
            <div>
              <span>{eventTierConfig[event.tier].label}</span>
              <strong>{event.ratingImpact} rating impact</strong>
              <small>{event.sourceBreakdown.map((source) => `${source.provider}: ${source.matchCount}`).join(', ')}</small>
            </div>
            <div className="event-teams">
              {event.topTeams.map((team) => (
                <span key={team}>{teams[team]?.code ?? team}</span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function Methodology({ staticData }: { staticData: StaticRankingData }) {
  return (
    <section>
      <PanelHeader icon={SlidersHorizontal} title="Methodology" detail="Transparent model, official reference kept separate" />
      <div className="method-grid">
        {modelFactors.map((factor) => (
          <article key={factor.key} className="method-card">
            <strong>{factor.label}</strong>
            <p>{factor.description}</p>
          </article>
        ))}
      </div>
      <div className="method-notes">
        <strong>Source strategy</strong>
        <p>
          Leaguepedia Cargo is the default broad historical source. Oracle's Elixir CSVs are the preferred game-level import when available. Riot GPR page
          snapshots are stored as official reference data, not as the transparent model formula.
        </p>
        <p>
          Active model: {staticData.model.name} {staticData.model.version}, config {staticData.model.configHash}. Team power is an 80/20 blend of team Elo and league
          Elo, updated result-only by game with EventK divided by the square root of the series length. Active coverage: {staticData.coverage.matchCount} matches,{' '}
          {formatDate(staticData.coverage.coverageStart)} to {formatDate(staticData.coverage.coverageEnd)}.
        </p>
        <p>
          Player shares start from role priors, then shift with objective-impact, award-residual, recent-form, availability, and role-certainty signals. Current public
          snapshots only use this as a transparent demo layer until sourced player-game stats and award feeds are ingested.
        </p>
        <p>{staticData.playerData.description}</p>
      </div>
      <div className="source-grid">
        {staticData.sources.map((source) => (
          <article key={source.name} className="source-card">
            <div>
              <strong>{source.name}</strong>
              <span>{source.status}</span>
            </div>
            <p>{source.description}</p>
            <small>
              {[
                source.rowCount !== undefined ? `${source.rowCount} rows` : undefined,
                source.retrievedAt ? `retrieved ${formatDateTime(source.retrievedAt)}` : undefined,
                source.coverageStart || source.coverageEnd ? `${formatDate(source.coverageStart)} to ${formatDate(source.coverageEnd)}` : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            </small>
            {source.url && (
              <a href={source.url} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function sourceTraceLabel(source: SourceTrace) {
  return [source.provider ?? 'unknown', source.gameId ? `game ${source.gameId}` : undefined, source.fileName ?? source.url, source.completeness]
    .filter(Boolean)
    .join(' / ')
}

function PanelHeader({ icon: Icon, title, detail }: { icon: typeof BarChart3; title: string; detail: string }) {
  return (
    <div className="panel-header">
      <div>
        <Icon aria-hidden="true" />
        <h2>{title}</h2>
      </div>
      <span>{detail}</span>
    </div>
  )
}

function RankMovement({ movement }: { movement: number }) {
  if (movement === 0) return <span className="movement neutral">0</span>
  const Icon = movement > 0 ? ArrowUp : ArrowDown
  return (
    <span className={clsx('movement', movement > 0 ? 'positive' : 'negative')}>
      <Icon aria-hidden="true" />
      {Math.abs(movement)}
    </span>
  )
}

function FormDots({ form }: { form: string[] }) {
  return (
    <div className="form-dots" aria-label={`Recent form ${form.join(' ')}`}>
      {form.map((result, index) => (
        <span key={`${result}-${index}`} className={result === 'W' ? 'is-win' : 'is-loss'}>
          {result}
        </span>
      ))}
    </div>
  )
}

function activeEventWeight(eventName: string, events: EventSummary[]) {
  if (eventName === 'All') return { label: 'Mixed events', kFactor: averageKFactor(events) }
  const event = events.find((candidate) => candidate.event === eventName)
  if (!event) return { label: 'No event', kFactor: 0 }
  const config = eventTierConfig[event.tier]
  return { label: config.label, kFactor: config.kFactor }
}

function averageKFactor(events: EventSummary[]) {
  if (events.length === 0) return 0
  const total = events.reduce((sum, event) => sum + eventTierConfig[event.tier].kFactor, 0)
  return Math.round(total / events.length)
}

function maxBy<T>(items: T[], score: (item: T) => number) {
  let best: T | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const item of items) {
    const itemScore = score(item)
    if (itemScore > bestScore) {
      best = item
      bestScore = itemScore
    }
  }
  return best
}

function minBy<T>(items: T[], score: (item: T) => number) {
  let best: T | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const item of items) {
    const itemScore = score(item)
    if (itemScore < bestScore) {
      best = item
      bestScore = itemScore
    }
  }
  return best
}

export default App
