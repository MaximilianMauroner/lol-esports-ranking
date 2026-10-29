import { AlertTriangle, MoveHorizontal, Search, Users } from 'lucide-react'
import { useMemo, useState, type RefObject } from 'react'
import { currentHashQuery, hashEnum, hashParam, useHashSync } from '../../browser/navigation'
import type { PlayerDirectoryState } from '../../browser/rankings/usePublicArtifacts'
import { DataState } from '../../components/ui'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { LoadingState } from '../../components/ui/loading'
import { Select } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { teamBrandingFor } from '../../data/teamBranding'
import { playerLeaderboardForScope } from '../../domains/rankings/read'
import type { Role, SnapshotFilter } from '../../domains/rankings/types'
import { formatDecimal, formatNumber, formatRating } from '../../shared/display'

const ROLES: readonly Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
const ROLE_FILTERS = ['All', ...ROLES] as const
function readFilters(query: URLSearchParams) {
  return {
    search: hashParam('player', query) ?? '',
    role: hashEnum('role', ROLE_FILTERS, 'All', query),
  }
}

export function PlayersView({ state, filter, scopeLabel, hashQuery, searchRef }: {
  state: PlayerDirectoryState
  filter: SnapshotFilter
  scopeLabel: string
  hashQuery: URLSearchParams
  searchRef?: RefObject<HTMLInputElement | null>
}) {
  const [filters, setFilters] = useState(() => readFilters(currentHashQuery()))
  const [appliedQuery, setAppliedQuery] = useState(hashQuery)
  if (hashQuery !== appliedQuery) {
    setAppliedQuery(hashQuery)
    setFilters(readFilters(hashQuery))
  }
  useHashSync('players', { player: filters.search, role: filters.role === 'All' ? '' : filters.role })
  const directory = state.status === 'ready' ? state.data : undefined
  const players = useMemo(() => playerLeaderboardForScope(directory, filter), [directory, filter])
  const scoreRange = useMemo(() => {
    const values = players.map((player) => player.leaderboardScore.value)
    return values.length ? { min: Math.min(...values), max: Math.max(...values) } : undefined
  }, [players])
  const statsPowerVersion = players.find((player) => player.statsPower)?.statsPower?.version
  const scoreLabel = statsPowerVersion ? 'Stats Power' : 'Role Power'
  const search = filters.search.trim().toLowerCase()
  const visible = players.filter((player) =>
    (filters.role === 'All' || player.role === filters.role)
    && (!search || [player.name, player.team, player.teamCode ?? ''].some((value) => value.toLowerCase().includes(search))),
  )

  const methodDisclosure = (
    <details className="players-method">
      <summary>Method</summary>
      <div className="grid gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <p>Newer games get more weight, with a 90-day half-life. Inactivity alone does not lower the score. Rows without a stat score show Role Power, which also uses results.</p>
      </div>
    </details>
  )

  return (
    <section className="players-view flex min-w-0 flex-col gap-4 px-[var(--page-x)] pt-5" aria-label="Player leaderboard">
      <div className="players-filters flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5 text-xs text-muted-foreground">
          Find a player or team
          <span className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--faint)]" aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              className="pl-9"
              value={filters.search}
              placeholder="Player or team name"
              aria-keyshortcuts="/"
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            />
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Role
          <Select aria-label="Role" value={filters.role} onChange={(event) => setFilters({ ...filters, role: event.target.value as typeof filters.role })}>
            {ROLE_FILTERS.map((role) => <option key={role} value={role}>{role === 'All' ? 'All roles' : role}</option>)}
          </Select>
        </label>
      </div>

      {visible.length > 0 ? (
        <div className="players-reading-tools">
          {methodDisclosure}
          <p className="players-scroll-cue"><MoveHorizontal size={16} aria-hidden="true" /><span>Scroll for more stats</span></p>
        </div>
      ) : null}

      {state.status === 'idle' || state.status === 'loading' ? (
        <LoadingState label="Loading player rankings" presentation="rows" rowCount={6} />
      ) : state.status === 'error' || state.status === 'missing' ? (
        <Card role="alert">
          <DataState icon={<AlertTriangle size={26} aria-hidden="true" />} title="Player rankings unavailable" action={<Button onClick={() => window.location.reload()}>Retry</Button>}>
            {state.message}
          </DataState>
        </Card>
      ) : players.length === 0 ? (
        <Card role="status">
          <DataState icon={<Users size={26} aria-hidden="true" />} title="No ranked players in this scope">
            No player rankings are published for {scopeLabel}. Select another season or period.
          </DataState>
        </Card>
      ) : (
        <>
          <p className="players-count flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground" role="status">
            <span>{formatNumber(visible.length)} of {formatNumber(players.length)} players in {scopeLabel}. Ranks stay tied to this scope when filtered.</span>
            {scoreRange && visible.length > 0 ? (
              <span className="player-score-key" title="Markers show position in the full scope's score range. Filters keep the same scale.">
                Scope range {formatDecimal(scoreRange.min)} to {formatDecimal(scoreRange.max)}
              </span>
            ) : null}
          </p>
          {visible.length === 0 ? (
            <Card role="status" className="players-empty-result">
              <DataState icon={<Search size={26} aria-hidden="true" />} title="No players match these filters" action={<Button variant="outline" onClick={() => setFilters({ ...filters, search: '', role: 'All' })}>Clear filters</Button>}>
                Try another player or team name, or select all roles.
              </DataState>
            </Card>
          ) : (
            <Card className="players-board min-w-0 overflow-hidden p-0">
              <Table role="table" data-stat-games={Boolean(statsPowerVersion)} aria-label="Player rankings" tabIndex={0} className="players-table focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]">
                <caption className="sr-only">Player rankings for {scopeLabel}, ordered by {scoreLabel}, highest first. Equal scores share a rank.{statsPowerVersion ? ' Stat games count games with usable role stats in this scope, including previous teams.' : ''} Games count games credited to the displayed team where available, otherwise all rated games.</caption>
                <TableHeader role="rowgroup">
                  <TableRow role="row">
                    <TableHead role="columnheader" scope="col" className="player-col-rank pl-4">Rank</TableHead>
                    <TableHead role="columnheader" scope="col" className="player-col-name">Player</TableHead>
                    <TableHead role="columnheader" scope="col" className="player-col-team">Team</TableHead>
                    <TableHead role="columnheader" scope="col" className="player-col-role">Role</TableHead>
                    <TableHead role="columnheader" scope="col" className="player-col-score text-right" aria-sort="descending">{scoreLabel}</TableHead>
                    {statsPowerVersion ? (
                      <>
                        <TableHead role="columnheader" scope="col" className="player-col-stat-games text-right">Stat games</TableHead>
                        <TableHead role="columnheader" scope="col" className="player-col-role-power text-right">Role Power</TableHead>
                      </>
                    ) : null}
                    <TableHead role="columnheader" scope="col" className="player-col-games pr-4 text-right">Games</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody role="rowgroup">
                  {visible.map((player) => {
                    const branding = teamBrandingFor(player.team)
                    const logo = branding?.logo && branding.logoTreatment !== 'code' ? branding.logo : undefined
                    const scoreText = player.leaderboardScore.kind === 'stats-power' ? formatDecimal(player.leaderboardScore.value) : formatRating(player.leaderboardScore.value)
                    const decimalIndex = scoreText.lastIndexOf('.')
                    const scorePosition = scoreRange && scoreRange.max !== scoreRange.min
                      ? 100 * (player.leaderboardScore.value - scoreRange.min) / (scoreRange.max - scoreRange.min)
                      : 50
                    return (
                      <TableRow role="row" key={player.id}>
                        <TableCell role="cell" className="player-col-rank pl-4 font-mono text-muted-foreground tabular-nums">{player.leaderboardRank}</TableCell>
                        <TableCell role="cell" className="player-col-name text-md font-semibold text-[var(--text-strong)]"><span className="player-identity">
                          {logo ? <img src={`${logo}?v=icon-128`} className={branding?.logoTreatment === 'invert' ? 'player-identity-mark invert' : 'player-identity-mark'} alt="" aria-hidden="true" width={20} height={20} loading="lazy" decoding="async" /> : null}
                          <span>{player.name}</span>
                        </span></TableCell>
                        <TableCell role="cell" className="player-col-team max-w-44 whitespace-normal"><span className="player-team">
                          {logo ? <img src={`${logo}?v=icon-128`} className={branding?.logoTreatment === 'invert' ? 'invert' : undefined} alt="" aria-hidden="true" width={24} height={24} loading="lazy" decoding="async" /> : null}
                          <span>{player.team}</span>
                        </span></TableCell>
                        <TableCell role="cell" className="player-col-role text-muted-foreground"><span className="player-role">{player.role}</span></TableCell>
                        <TableCell role="cell" className="player-col-score text-right font-mono font-semibold text-[var(--text-strong)] tabular-nums">
                          <span className="player-score-position" aria-hidden="true"><i style={{ left: `${scorePosition}%` }} /></span>
                          <span className="player-score-figure"><span>{decimalIndex < 0 ? scoreText : scoreText.slice(0, decimalIndex)}</span><span>{decimalIndex < 0 ? '' : scoreText.slice(decimalIndex)}</span></span>
                          {statsPowerVersion && player.leaderboardScore.kind === 'role-power' ? <span className="block text-2xs font-normal text-muted-foreground">Role Power</span> : null}
                          {player.statsPower?.priorOnly ? <span className="block text-2xs font-normal text-muted-foreground">League anchor</span> : null}
                        </TableCell>
                        {statsPowerVersion ? (
                          <>
                            <TableCell role="cell" className="player-col-stat-games text-right font-mono text-muted-foreground tabular-nums">{formatNumber(player.statsPower?.sampleGames)}</TableCell>
                            <TableCell role="cell" className="player-col-role-power text-right font-mono text-muted-foreground tabular-nums">{formatRating(player.rating)}</TableCell>
                          </>
                        ) : null}
                        <TableCell role="cell" className="player-col-games pr-4 text-right font-mono text-muted-foreground tabular-nums">{formatNumber(player.teamGames ?? player.games)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
      {visible.length === 0 ? methodDisclosure : null}
      {directory ? (
        <p className="players-source break-words text-xs leading-relaxed text-muted-foreground">
          Source {directory.sourceProvider}.{' '}
          {statsPowerVersion
            ? `Stats Power ${statsPowerVersion} scores lane leads at 15 minutes, kill participation and ward activity against each role's average. It weights each game by event and home-league strength, then gives a game half the weight of a game 90 days later in the supplied history. It pulls small samples to the league anchor and excludes wins, KDA and gold share. For each player, newer games get more weight than older games. Inactivity alone does not lower the score. Stat games count raw games with usable role stats in this scope, including previous teams. `
            : ''}
          Role Power uses model {directory.modelVersion}, configuration {directory.modelConfigHash}, and includes individual stats, results, opponent strength and event context. Its history and deltas still track Role Power. Games count games credited to the displayed team where available, otherwise all rated games. Game counts do not measure certainty.
        </p>
      ) : null}
    </section>
  )
}
