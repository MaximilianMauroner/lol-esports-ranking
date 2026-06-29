import { useMemo, useState } from 'react'
import { Activity, ArrowLeftRight, BarChart3, Gauge, Shield, Swords } from 'lucide-react'
import type { ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type { TeamHistoryArtifactState } from '../hooks/usePublicArtifacts'
import { estimatePublicMatchup } from '../lib/publicMatchup'
import { seriesSwingStates as coreSeriesSwingStates } from '../lib/matchupMath'
import { Button } from '../components/ui/button'
import { Card, CardHeader } from '../components/ui/card'
import { CountBadge, DataState, Field, Segmented } from '../components/ui'
import { formatDate, formatNumber, formatRating, formatRecord, formatRatio, formatSigned, teamKey } from '../lib/display'

type SeriesFormat = 'bo1' | 'bo3' | 'bo5'
type SideSetting = 'neutral' | 'team-a-blue' | 'team-b-blue'

export type ArenaViewProps = {
  standings: RankingSummaryStanding[]
  pickedTeams: RankingSummaryStanding[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
  historyState: TeamHistoryArtifactState
  historySeries?: Record<string, TeamHistorySeries>
}

type ArenaForecast = {
  teamA: RankingSummaryStanding
  teamB: RankingSummaryStanding
  bestOf: 1 | 3 | 5
  side: SideSetting
  ratingEdge: number
  sideEdge: number
  gameProbability: number
  seriesProbability: number
  teamBSeriesProbability: number
  uncertaintyBand: { low: number; high: number }
  uncertaintyPenalty: number
  combinedUncertainty: number
  favorite: RankingSummaryStanding
  modelVersion: string
  modelConfigHash: string
}

type HeadToHeadSummary = {
  home: RankingSummaryStanding
  away: RankingSummaryStanding
  homeSeriesWins: number
  awaySeriesWins: number
  homeGameWins: number
  awayGameWins: number
  meetings: number
  latest?: {
    date: string
    event?: string
    homeWins: number
    awayWins: number
  }
}

const FORMAT_OPTIONS: { value: SeriesFormat; label: string }[] = [
  { value: 'bo1', label: 'Bo1' },
  { value: 'bo3', label: 'Bo3' },
  { value: 'bo5', label: 'Bo5' },
]

const SIDE_OPTIONS: { value: SideSetting; label: string }[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'team-a-blue', label: 'Team A blue' },
  { value: 'team-b-blue', label: 'Team B blue' },
]

const BEST_OF_BY_FORMAT: Record<SeriesFormat, 1 | 3 | 5> = {
  bo1: 1,
  bo3: 3,
  bo5: 5,
}

const ARENA_TEAM_LIMIT = 200
const BLUE_SIDE_SCENARIO_EDGE = 24

export function ArenaView({
  standings,
  pickedTeams,
  model,
  historyState,
  historySeries,
}: ArenaViewProps) {
  const [format, setFormat] = useState<SeriesFormat>('bo5')
  const [side, setSide] = useState<SideSetting>('neutral')
  const [teamAKey, setTeamAKey] = useState('')
  const [teamBKey, setTeamBKey] = useState('')

  const options = useMemo(() => standings.slice(0, ARENA_TEAM_LIMIT), [standings])
  const optionKeys = useMemo(() => new Set(options.map(teamKey)), [options])
  const seedKeys = useMemo(() => {
    const picked = pickedTeams.map(teamKey).filter((key) => optionKeys.has(key))
    const first = picked[0] ?? (options[0] ? teamKey(options[0]) : '')
    const second = picked.find((key) => key !== first)
      ?? options.map(teamKey).find((key) => key !== first)
      ?? ''
    return { a: first, b: second }
  }, [optionKeys, options, pickedTeams])

  const selectedAKey = optionKeys.has(teamAKey) ? teamAKey : seedKeys.a
  const selectedBKey = optionKeys.has(teamBKey) && teamBKey !== selectedAKey
    ? teamBKey
    : seedKeys.b !== selectedAKey
      ? seedKeys.b
      : options.map(teamKey).find((key) => key !== selectedAKey) ?? ''

  const teamA = options.find((team) => teamKey(team) === selectedAKey)
  const teamB = options.find((team) => teamKey(team) === selectedBKey)
  const history = historySeries ?? (historyState.status === 'ready' ? historyState.data.series : undefined)
  const forecast = useMemo(
    () => teamA && teamB ? buildArenaForecast(teamA, teamB, model, BEST_OF_BY_FORMAT[format], side) : undefined,
    [format, model, side, teamA, teamB],
  )
  const headToHead = useMemo(
    () => forecast ? headToHeadForTeams(forecast.teamA, forecast.teamB, history) : undefined,
    [forecast, history],
  )
  const swingStates = useMemo(
    () => forecast ? seriesSwingStates(forecast.gameProbability, forecast.bestOf, forecast.seriesProbability) : [],
    [forecast],
  )
  const seedNote = teamAKey || teamBKey
    ? 'Custom arena'
    : pickedTeams.length >= 2
      ? 'Seeded from picks'
      : 'Top-ranked default'

  function replacementKey(exclude: string) {
    return options.map(teamKey).find((key) => key !== exclude) ?? ''
  }

  function onSelectTeamA(nextKey: string) {
    setTeamAKey(nextKey)
    if (nextKey === selectedBKey) setTeamBKey(replacementKey(nextKey))
  }

  function onSelectTeamB(nextKey: string) {
    setTeamBKey(nextKey)
    if (nextKey === selectedAKey) setTeamAKey(replacementKey(nextKey))
  }

  function onSwapTeams() {
    setTeamAKey(selectedBKey)
    setTeamBKey(selectedAKey)
  }

  if (options.length < 2) {
    return (
      <div className="view arena-view">
        <Card className="panel arena-panel">
          <DataState icon={<Swords size={26} aria-hidden="true" />} title="Arena needs two teams">
            Load a ranking scope with at least two teams before building a matchup.
          </DataState>
        </Card>
      </div>
    )
  }

  return (
    <div className="view arena-view">
      <Card className="panel arena-panel">
        <CardHeader className="panel__head arena-panel__head">
          <div className="panel__title">
            <p className="eyebrow">Arena</p>
            <h2>Series lab</h2>
            <p className="panel__hint">Public power-score matchup with format, side, confidence, and recent H2H context.</p>
          </div>
          <div className="arena-panel__badges">
            <CountBadge>{seedNote}</CountBadge>
            <CountBadge>{model?.version ?? 'unknown model'}</CountBadge>
          </div>
        </CardHeader>

        <div className="arena-controls">
          <div className="arena-controls__teams">
            <Field
              label="Team A"
              value={selectedAKey}
              options={options.map((team) => ({ value: teamKey(team), label: optionLabel(team) }))}
              onChange={onSelectTeamA}
            />
            <Button
              className="arena-swap"
              variant="secondary"
              size="icon"
              type="button"
              onClick={onSwapTeams}
              aria-label="Swap Arena teams"
            >
              <ArrowLeftRight size={16} aria-hidden="true" />
            </Button>
            <Field
              label="Team B"
              value={selectedBKey}
              options={options.map((team) => ({ value: teamKey(team), label: optionLabel(team) }))}
              onChange={onSelectTeamB}
            />
          </div>
          <div className="arena-controls__scenario">
            <div className="arena-control">
              <span>Format</span>
              <Segmented value={format} options={FORMAT_OPTIONS} onChange={setFormat} ariaLabel="Arena series format" />
            </div>
            <div className="arena-control arena-control--wide">
              <span>Side</span>
              <Segmented value={side} options={SIDE_OPTIONS} onChange={setSide} ariaLabel="Arena side setting" />
            </div>
          </div>
        </div>

        {forecast ? (
          <div className="arena-body">
            <section className="arena-stage" aria-label={`${forecast.teamA.team} versus ${forecast.teamB.team}`}>
              <ArenaTeam team={forecast.teamA} label="Team A" probability={forecast.seriesProbability} />
              <div className="arena-versus" aria-hidden="true">
                <Swords size={18} />
                <b>{format.toUpperCase()}</b>
                <span>{sideLabel(side)}</span>
              </div>
              <ArenaTeam team={forecast.teamB} label="Team B" probability={forecast.teamBSeriesProbability} align="right" />
            </section>

            <section className="arena-odds" aria-label="Arena win probability">
              <div className="arena-odds__labels">
                <strong>{formatProbability(forecast.seriesProbability)}</strong>
                <span>{forecast.teamA.code ?? forecast.teamA.team}</span>
                <em>{forecast.favorite.team} favored</em>
                <span>{forecast.teamB.code ?? forecast.teamB.team}</span>
                <strong>{formatProbability(forecast.teamBSeriesProbability)}</strong>
              </div>
              <div
                className="arena-odds__bar"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={probabilityValue(forecast.seriesProbability)}
                aria-valuetext={`${forecast.teamA.team} ${formatProbability(forecast.seriesProbability)}, ${forecast.teamB.team} ${formatProbability(forecast.teamBSeriesProbability)}`}
                aria-label={`${forecast.teamA.team} ${formatProbability(forecast.seriesProbability)}, ${forecast.teamB.team} ${formatProbability(forecast.teamBSeriesProbability)}`}
              >
                <i style={{ width: formatProbability(forecast.seriesProbability) }} aria-hidden="true" />
                <span className="arena-odds__midline" />
              </div>
            </section>

            <section className="arena-metrics" aria-label="Arena scenario metrics">
              <Metric icon={<BarChart3 size={16} />} label="Game win" value={formatProbability(forecast.gameProbability)} detail="Team A per game" />
              <Metric icon={<Gauge size={16} />} label="Series band" value={formatBand(forecast.uncertaintyBand)} detail={`${formatRating(forecast.combinedUncertainty)} combined uncertainty`} />
              <Metric icon={<Activity size={16} />} label="Power edge" value={formatSigned(forecast.ratingEdge)} detail={sideDetail(forecast.sideEdge)} />
              <Metric icon={<Shield size={16} />} label="Model fit" value={`${Math.round(forecast.uncertaintyPenalty * 100)}%`} detail={forecast.modelConfigHash} />
            </section>

            {headToHead ? (
              <section className="arena-h2h" aria-label="Actual head-to-head context">
                <div>
                  <small>Actual H2H</small>
                  <b>{formatHeadToHeadRecord(headToHead)}</b>
                </div>
                <p>{formatHeadToHeadDetail(headToHead)}</p>
              </section>
            ) : historyState.status === 'loading' ? (
              <p className="arena-context-note">Loading H2H context.</p>
            ) : historyState.status !== 'ready' ? (
              <p className="arena-context-note">{historyState.message}</p>
            ) : null}

            <section className="arena-swing" aria-label="Series swing states">
              <div className="arena-section-head">
                <div>
                  <small>Series swing</small>
                  <h3>State pressure</h3>
                </div>
                <CountBadge>{swingStates.length} states</CountBadge>
              </div>
              <div className="arena-swing__list">
                {swingStates.map((state) => (
                  <div className="arena-swing__row" key={state.key}>
                    <span>
                      <b>{state.label}</b>
                      <small>{state.score}</small>
                    </span>
                    <div
                      className="arena-swing__meter"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={probabilityValue(state.probability)}
                      aria-valuetext={`${state.label} ${formatProbability(state.probability)}`}
                      aria-label={`${state.label} ${formatProbability(state.probability)}`}
                    >
                      <i style={{ width: formatProbability(state.probability) }} aria-hidden="true" />
                    </div>
                    <strong>{formatProbability(state.probability)}</strong>
                    <em className={state.delta > 0 ? 'up' : state.delta < 0 ? 'down' : 'flat'}>{formatSigned(state.delta * 100)}</em>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : (
          <DataState icon={<Swords size={26} aria-hidden="true" />} title="Pick two different teams">
            Arena needs a Team A and Team B selection from the current ranking scope.
          </DataState>
        )}
      </Card>
    </div>
  )
}

function buildArenaForecast(
  teamA: RankingSummaryStanding,
  teamB: RankingSummaryStanding,
  model: ArenaViewProps['model'],
  bestOf: 1 | 3 | 5,
  side: SideSetting,
): ArenaForecast {
  const coreEstimate = estimatePublicMatchup(teamA, teamB, model, {
    bestOf,
    sideAssumption: publicSideFor(side),
    blueSideRatingEdge: BLUE_SIDE_SCENARIO_EDGE,
    uncertaintyBands: true,
  })
  const teamAUncertainty = finiteRating(teamA.uncertainty, 100)
  const teamBUncertainty = finiteRating(teamB.uncertainty, 100)
  const combinedUncertainty = Math.sqrt(teamAUncertainty ** 2 + teamBUncertainty ** 2)
  const band = coreEstimate.uncertaintyBand?.homeSeriesWinProbability

  return {
    teamA,
    teamB,
    bestOf,
    side,
    ratingEdge: coreEstimate.ratingEdge,
    sideEdge: coreEstimate.sideRatingEdge,
    gameProbability: coreEstimate.homeGameWinProbability,
    seriesProbability: coreEstimate.homeSeriesWinProbability,
    teamBSeriesProbability: coreEstimate.awaySeriesWinProbability,
    uncertaintyBand: {
      low: band?.lower ?? coreEstimate.homeSeriesWinProbability,
      high: band?.upper ?? coreEstimate.homeSeriesWinProbability,
    },
    uncertaintyPenalty: coreEstimate.uncertaintyPenalty,
    combinedUncertainty,
    favorite: coreEstimate.homeSeriesWinProbability >= 0.5 ? teamA : teamB,
    modelVersion: coreEstimate.modelVersion,
    modelConfigHash: coreEstimate.modelConfigHash,
  }
}

function ArenaTeam({
  team,
  label,
  probability,
  align = 'left',
}: {
  team: RankingSummaryStanding
  label: string
  probability: number
  align?: 'left' | 'right'
}) {
  const total = team.wins + team.losses
  return (
    <article className={`arena-team${align === 'right' ? ' is-away' : ''}`}>
      <div className="arena-team__identity">
        <span className="arena-team__mark">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
        <div>
          <small>{label}</small>
          <b>{team.team}</b>
          <em>{team.league ?? team.region}</em>
        </div>
      </div>
      <strong className="arena-team__probability">{formatProbability(probability)}</strong>
      <dl className="arena-team__stats">
        <div>
          <dt>Rank</dt>
          <dd>{team.rank ? `#${team.rank}` : 'N/A'}</dd>
        </div>
        <div>
          <dt>Power</dt>
          <dd>{formatRating(team.rating)}</dd>
        </div>
        <div>
          <dt>Match W/L</dt>
          <dd>{formatRecord(team.wins, team.losses)} {formatRatio(total > 0 ? team.wins / total : undefined)}</dd>
        </div>
        <div>
          <dt>Uncertainty</dt>
          <dd>+/-{formatRating(team.uncertainty)}</dd>
        </div>
      </dl>
    </article>
  )
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="arena-metric">
      <span className="arena-metric__icon" aria-hidden="true">{icon}</span>
      <span>
        <small>{label}</small>
        <b>{value}</b>
        <em>{detail}</em>
      </span>
    </div>
  )
}

function headToHeadForTeams(
  home: RankingSummaryStanding,
  away: RankingSummaryStanding,
  history?: Record<string, TeamHistorySeries>,
): HeadToHeadSummary | undefined {
  const fromHome = headToHeadFromSeries(home, away, history?.[teamKey(home)], false)
  if (fromHome) return fromHome
  return headToHeadFromSeries(home, away, history?.[teamKey(away)], true)
}

function headToHeadFromSeries(
  home: RankingSummaryStanding,
  away: RankingSummaryStanding,
  series: TeamHistorySeries | undefined,
  reverse: boolean,
): HeadToHeadSummary | undefined {
  const points = (series?.points ?? [])
    .filter((point) => {
      const context = point[3]
      return context?.opponent && sameTeamIdentity(context.opponent, reverse ? home : away)
    })
    .sort((left, right) => left[0].localeCompare(right[0]))
  if (points.length === 0) return undefined

  const summary: HeadToHeadSummary = {
    home,
    away,
    homeSeriesWins: 0,
    awaySeriesWins: 0,
    homeGameWins: 0,
    awayGameWins: 0,
    meetings: 0,
  }

  for (const point of points) {
    const context = point[3]
    if (!context) continue
    const sourceWins = typeof context.wins === 'number' ? context.wins : context.result === 'W' ? 1 : 0
    const sourceLosses = typeof context.losses === 'number' ? context.losses : context.result === 'L' ? 1 : 0
    const homeWins = reverse ? sourceLosses : sourceWins
    const awayWins = reverse ? sourceWins : sourceLosses
    summary.homeGameWins += homeWins
    summary.awayGameWins += awayWins
    if (homeWins === awayWins) continue
    summary.meetings += 1
    if (homeWins > awayWins) summary.homeSeriesWins += 1
    else summary.awaySeriesWins += 1
    summary.latest = {
      date: point[0],
      event: context.event,
      homeWins,
      awayWins,
    }
  }

  return summary.meetings > 0 ? summary : undefined
}

function seriesSwingStates(gameProbability: number, bestOf: 1 | 3 | 5, baseline: number) {
  if (bestOf === 1) {
    return [{
      key: '0-0',
      label: 'Only game',
      score: '0-0',
      probability: gameProbability,
      delta: gameProbability - baseline,
    }]
  }

  return coreSeriesSwingStates(bestOf, gameProbability)
    .filter((state) => state.gamesPlayed > 0 && !state.terminal)
    .map((state) => {
      const probability = state.teamASeriesWinProbability
      const score = `${state.teamAWins}-${state.teamBWins}`
      return {
        key: score,
        label: swingStateLabel(state.teamAWins, state.teamBWins, bestOf),
        score,
        probability,
        delta: probability - baseline,
      }
    })
}

function swingStateLabel(teamAWins: number, teamBWins: number, bestOf: 3 | 5) {
  if (teamAWins === teamBWins) return bestOf === 5 && teamAWins === 2 ? 'Game five' : 'Tied series'
  if (teamAWins > teamBWins) {
    return teamAWins === Math.floor(bestOf / 2) ? 'Team A match point' : 'Team A leads'
  }
  return teamBWins === Math.floor(bestOf / 2) ? 'Team B match point' : 'Team B leads'
}

function publicSideFor(side: SideSetting) {
  if (side === 'team-a-blue') return 'home-blue'
  if (side === 'team-b-blue') return 'home-red'
  return 'neutral'
}

function sameTeamIdentity(value: string, team: RankingSummaryStanding) {
  const normalized = normalizeTeamIdentity(value)
  return normalized === normalizeTeamIdentity(team.team) || normalized === normalizeTeamIdentity(team.code)
}

function normalizeTeamIdentity(value?: string) {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function optionLabel(team: RankingSummaryStanding) {
  return `${team.rank ? `#${team.rank} ` : ''}${team.team}`
}

function formatHeadToHeadRecord(summary: HeadToHeadSummary) {
  const homeLabel = summary.home.code ?? summary.home.team
  const awayLabel = summary.away.code ?? summary.away.team
  return `${homeLabel} ${summary.homeSeriesWins}-${summary.awaySeriesWins} ${awayLabel}`
}

function formatHeadToHeadDetail(summary: HeadToHeadSummary) {
  const gameRecord = `${summary.homeGameWins}-${summary.awayGameWins} games`
  const latest = summary.latest
    ? `latest ${formatDate(summary.latest.date)} ${summary.latest.homeWins}-${summary.latest.awayWins}${summary.latest.event ? ` at ${summary.latest.event}` : ''}`
    : undefined
  return [`${formatNumber(summary.meetings)} series`, gameRecord, latest].filter(Boolean).join(' | ')
}

function sideLabel(side: SideSetting) {
  if (side === 'team-a-blue') return 'A blue'
  if (side === 'team-b-blue') return 'B blue'
  return 'neutral'
}

function sideDetail(sideEdge: number) {
  if (sideEdge === 0) return 'neutral side'
  return `${formatSigned(sideEdge)} side scenario`
}

function finiteRating(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function formatProbability(value: number) {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`
}

function probabilityValue(value: number) {
  return Math.round(clamp(value, 0, 1) * 100)
}

function formatBand(band: ArenaForecast['uncertaintyBand']) {
  return `${formatProbability(band.low)} to ${formatProbability(band.high)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
