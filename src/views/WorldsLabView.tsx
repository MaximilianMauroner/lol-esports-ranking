import { useMemo, useState } from 'react'
import { Activity, Swords, Trophy, Users } from 'lucide-react'
import type { ModelInfo, RankingSummaryStanding } from '../lib/snapshot'
import { simulateWorldsStyleTournament, type WorldsSimTeamInput } from '../lib/worldsSim'
import { extent, formatNumber, formatRating, formatRatio, teamKey } from '../lib/display'
import { CountBadge, DataState, Field, HeatChip, RegionBadge, Segmented } from '../components/ui'
import { Card, CardHeader } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

type WorldsLabViewProps = {
  standings: RankingSummaryStanding[]
  pickedTeams: RankingSummaryStanding[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
}

type SeedMode = 'picked' | 'ranked'

type WorldsSimulationInput = {
  field: RankingSummaryStanding[]
  runs: number
  model?: Pick<ModelInfo, 'version' | 'configHash'>
  seedOffset: number
}

type WorldsTeamProjection = {
  team: RankingSummaryStanding
  seed: number
  swissAdvanceProbability: number
  bracketProbability: number
  finalProbability: number
  titleProbability: number
  averageSwissWins: number
  averageSwissLosses: number
}

type WorldsSimulationSummary = {
  runs: number
  fieldSize: number
  bracketSize: number
  teams: WorldsTeamProjection[]
}

const FIELD_SIZE_OPTIONS = ['8', '16', '24', '32'] as const
const RUN_OPTIONS = ['500', '1000', '2500', '5000'] as const
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']

export function WorldsLabView({ standings, pickedTeams, model }: WorldsLabViewProps) {
  const [fieldSize, setFieldSize] = useState<(typeof FIELD_SIZE_OPTIONS)[number]>('16')
  const [runs, setRuns] = useState<(typeof RUN_OPTIONS)[number]>('1000')
  const [seedMode, setSeedMode] = useState<SeedMode>('picked')

  const fieldSizeOptions = useMemo(() => {
    const available = FIELD_SIZE_OPTIONS.filter((option) => Number(option) <= standings.length)
    return available.length > 0 ? available : standings.length > 0 ? [String(Math.min(standings.length, 8))] : []
  }, [standings.length])
  const selectedFieldSize = fieldSizeOptions.includes(fieldSize) ? fieldSize : fieldSizeOptions.at(-1) ?? '0'
  const effectiveSeedMode: SeedMode = seedMode === 'picked' && pickedTeams.length > 0 ? 'picked' : 'ranked'
  const field = useMemo(
    () => seedWorldsField(standings, pickedTeams, Number(selectedFieldSize), effectiveSeedMode),
    [effectiveSeedMode, pickedTeams, selectedFieldSize, standings],
  )
  const summary = useMemo(
    () => simulateWorldsField({ field, runs: Number(runs), model, seedOffset: 0 }),
    [field, model, runs],
  )
  const [ratingMin, ratingMax] = useMemo(() => extent(field.map((team) => team.rating)), [field])
  const titleRows = useMemo(
    () => summary.teams.toSorted((left, right) => right.titleProbability - left.titleProbability || left.seed - right.seed),
    [summary.teams],
  )
  const favorite = titleRows[0]
  const swissFavorite = useMemo(
    () => summary.teams.toSorted((left, right) => right.swissAdvanceProbability - left.swissAdvanceProbability || left.seed - right.seed)[0],
    [summary.teams],
  )
  const pickedKeys = useMemo(() => new Set(pickedTeams.map(teamKey)), [pickedTeams])
  const regionMix = useMemo(() => regionSummary(field), [field])

  if (standings.length === 0) {
    return (
      <div className="view lab-view">
        <Card className="panel lab-panel">
          <DataState icon={<Trophy size={26} aria-hidden="true" />} title="No team standings loaded">
            Worlds Lab needs the current rankings snapshot before it can build a field.
          </DataState>
        </Card>
      </div>
    )
  }

  return (
    <div className="view lab-view worlds-lab">
      <Card className="panel lab-panel lab-hero">
        <CardHeader className="panel__head lab-hero__head">
          <div className="panel__title">
            <p className="eyebrow">Scenario lab</p>
            <h2>Worlds Lab</h2>
            <p className="panel__hint">
              Model-only Swiss and bracket odds from current power scores. Slot rules and official pools are not applied in this standalone view.
            </p>
          </div>
          <div className="lab-toolbar">
            <Segmented
              value={effectiveSeedMode}
              options={[
                { value: 'picked', label: 'Picks first' },
                { value: 'ranked', label: 'Ranked board' },
              ]}
              onChange={setSeedMode}
              ariaLabel="Worlds field seed source"
            />
            <Field
              label="Field"
              value={selectedFieldSize}
              options={fieldSizeOptions.map((option) => ({ value: option, label: `${option} teams` }))}
              onChange={(value) => setFieldSize(value as (typeof FIELD_SIZE_OPTIONS)[number])}
            />
            <Field
              label="Runs"
              value={runs}
              options={RUN_OPTIONS.map((option) => ({ value: option, label: formatNumber(Number(option)) }))}
              onChange={(value) => setRuns(value as (typeof RUN_OPTIONS)[number])}
            />
          </div>
        </CardHeader>

        <div className="lab-hero__grid">
          <SummaryTile
            icon={<Trophy size={18} aria-hidden="true" />}
            label="Title favorite"
            value={favorite ? favorite.team.code ?? favorite.team.team : 'None'}
            detail={favorite ? formatRatio(favorite.titleProbability) : 'No bracket'}
          />
          <SummaryTile
            icon={<Swords size={18} aria-hidden="true" />}
            label="Swiss leader"
            value={swissFavorite ? swissFavorite.team.code ?? swissFavorite.team.team : 'None'}
            detail={swissFavorite ? `${formatRatio(swissFavorite.swissAdvanceProbability)} advance` : 'No Swiss'}
          />
          <SummaryTile
            icon={<Users size={18} aria-hidden="true" />}
            label="Field mix"
            value={`${formatNumber(field.length)} teams`}
            detail={regionMix}
          />
          <SummaryTile
            icon={<Activity size={18} aria-hidden="true" />}
            label="Model"
            value={model?.version ?? 'unknown'}
            detail={model?.configHash ?? 'unknown config'}
          />
        </div>
      </Card>

      <div className="lab-grid">
        <Card className="panel lab-panel lab-table-panel">
          <CardHeader className="panel__head">
            <div className="panel__title">
              <p className="eyebrow">Probability table</p>
              <h2>Swiss, bracket, title</h2>
            </div>
            <CountBadge>{formatNumber(summary.runs)} runs</CountBadge>
          </CardHeader>
          <div className="tablewrap">
            <Table className="ranking-table lab-prob-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Seed</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead className="right">Power</TableHead>
                  <TableHead className="right">Swiss</TableHead>
                  <TableHead className="right">Top 4</TableHead>
                  <TableHead className="right">Final</TableHead>
                  <TableHead className="right">Title</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {titleRows.map((row, index) => (
                  <TableRow key={teamKey(row.team)} className={pickedKeys.has(teamKey(row.team)) ? 'is-picked' : undefined}>
                    <TableCell className="rank-cell">#{row.seed}</TableCell>
                    <TableCell>
                      <TeamIdentity team={row.team} detail={pickedKeys.has(teamKey(row.team)) ? 'Picked seed' : row.team.league} />
                    </TableCell>
                    <TableCell className="right">
                      <HeatChip value={row.team.rating} min={ratingMin} max={ratingMax} label={formatRating(row.team.rating)} />
                    </TableCell>
                    <ProbabilityCell value={row.swissAdvanceProbability} color={SERIES_COLORS[index % SERIES_COLORS.length]} />
                    <ProbabilityCell value={row.bracketProbability} color={SERIES_COLORS[index % SERIES_COLORS.length]} />
                    <ProbabilityCell value={row.finalProbability} color={SERIES_COLORS[index % SERIES_COLORS.length]} />
                    <ProbabilityCell value={row.titleProbability} color={SERIES_COLORS[index % SERIES_COLORS.length]} strong />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        <aside className="lab-side">
          <Card className="panel lab-panel">
            <CardHeader className="panel__head">
              <div className="panel__title">
                <p className="eyebrow">Seed board</p>
                <h2>Initial field</h2>
              </div>
              <CountBadge>{effectiveSeedMode === 'picked' ? 'Picks first' : 'Ranked board'}</CountBadge>
            </CardHeader>
            <div className="lab-seed-list">
              {field.map((team, index) => (
                <div className="lab-seed-row" key={teamKey(team)}>
                  <span className="rank-cell">#{index + 1}</span>
                  <TeamIdentity team={team} detail={team.league} compact />
                  <b>{formatRating(team.rating)}</b>
                </div>
              ))}
            </div>
          </Card>

          <Card className="panel lab-panel">
            <CardHeader className="panel__head">
              <div className="panel__title">
                <p className="eyebrow">Simulation source</p>
                <h2>Simulation source</h2>
              </div>
            </CardHeader>
            <div className="lab-note">
              <p>
                Odds are generated by <span className="mono">src/lib/worldsSim.ts</span> using the same matchup probability core as Arena.
              </p>
              <p>
                Slot rules and official pools are still intentionally excluded; this is a model-only stress test of current power scores.
              </p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  )
}

function SummaryTile({
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
    <article className="lab-summary">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <b>{value}</b>
        <em>{detail}</em>
      </div>
    </article>
  )
}

function TeamIdentity({
  team,
  detail,
  compact = false,
}: {
  team: RankingSummaryStanding
  detail: string
  compact?: boolean
}) {
  return (
    <div className={`lab-team${compact ? ' lab-team--compact' : ''}`}>
      <RegionBadge region={team.league || team.region} size="sm" />
      <div className="ent">
        <b>{team.team}</b>
        <small>{team.code ? `${team.code} / ${detail}` : detail}</small>
      </div>
    </div>
  )
}

function ProbabilityCell({ value, color, strong = false }: { value: number; color: string; strong?: boolean }) {
  return (
    <TableCell className={`right lab-prob-cell${strong ? ' is-strong' : ''}`}>
      <span>{formatRatio(value)}</span>
      <i style={{ '--probability': `${Math.round(value * 100)}%`, '--probability-color': color } as React.CSSProperties} aria-hidden="true" />
    </TableCell>
  )
}

function seedWorldsField(
  standings: RankingSummaryStanding[],
  pickedTeams: RankingSummaryStanding[],
  fieldSize: number,
  seedMode: SeedMode,
) {
  const standingByKey = new Map(standings.map((team) => [teamKey(team), team]))
  const ranked = standings
    .filter((team) => team.eligibility?.eligible ?? true)
    .toSorted((left, right) => left.rank - right.rank || right.rating - left.rating || left.team.localeCompare(right.team))
  const picked = pickedTeams
    .map((team) => standingByKey.get(teamKey(team)))
    .filter((team): team is RankingSummaryStanding => Boolean(team))
  const source = seedMode === 'picked' ? [...picked, ...ranked] : ranked
  const seen = new Set<string>()
  const field: RankingSummaryStanding[] = []
  for (const team of source) {
    const key = teamKey(team)
    if (seen.has(key)) continue
    seen.add(key)
    field.push(team)
    if (field.length >= fieldSize) break
  }
  return field
}

function simulateWorldsField({ field, runs, model, seedOffset }: WorldsSimulationInput): WorldsSimulationSummary {
  if (field.length < 4 || field.length % 2 !== 0 || runs <= 0) {
    return { runs: 0, fieldSize: field.length, bracketSize: 0, teams: [] }
  }

  const inputTeams: WorldsSimTeamInput[] = field.map((team, index) => ({
    team: team.team,
    rating: team.rating,
    uncertainty: team.uncertainty,
    seed: index + 1,
    region: team.region,
    league: team.league,
  }))
  const seed = hashString(`${field.map(teamKey).join('|')}|${model?.version ?? ''}|${model?.configHash ?? ''}|${runs}|${seedOffset}`)
  const result = simulateWorldsStyleTournament(inputTeams, { iterations: runs, seed })
  const standingByName = new Map(field.map((team) => [team.team, team]))

  return {
    runs: result.iterations,
    fieldSize: field.length,
    bracketSize: result.format.bracketSize,
    teams: result.teams
      .map((row): WorldsTeamProjection | null => {
        const team = standingByName.get(row.team)
        if (!team) return null
        return {
          team,
          seed: row.seed,
          swissAdvanceProbability: row.swissAdvanceProbability,
          bracketProbability: row.semifinalProbability,
          finalProbability: row.finalProbability,
          titleProbability: row.championshipProbability,
          averageSwissWins: row.averageSwissWins,
          averageSwissLosses: row.averageSwissLosses,
        }
      })
      .filter((row): row is WorldsTeamProjection => row !== null),
  }
}

function regionSummary(field: RankingSummaryStanding[]) {
  const counts = new Map<string, number>()
  for (const team of field) {
    counts.set(team.region, (counts.get(team.region) ?? 0) + 1)
  }
  return [...counts.entries()]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([region, count]) => `${region} ${count}`)
    .join(' / ') || 'No regions'
}

function hashString(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
