import { AlertTriangle, Search, Users } from 'lucide-react'
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
  const statsPowerVersion = players.find((player) => player.statsPower)?.statsPower?.version
  const scoreLabel = statsPowerVersion ? 'Stats Power' : 'Role Power'
  const search = filters.search.trim().toLowerCase()
  const visible = players.filter((player) =>
    (filters.role === 'All' || player.role === filters.role)
    && (!search || [player.name, player.team, player.teamCode ?? ''].some((value) => value.toLowerCase().includes(search))),
  )

  return (
    <section className="flex min-w-0 flex-col gap-4 px-[var(--page-x)] pt-5" aria-label="Player leaderboard">
      <div className="flex flex-wrap items-end gap-3">
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
          <Select value={filters.role} onChange={(event) => setFilters({ ...filters, role: event.target.value as typeof filters.role })}>
            {ROLE_FILTERS.map((role) => <option key={role} value={role}>{role === 'All' ? 'All roles' : role}</option>)}
          </Select>
        </label>
      </div>

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
          <p className="text-xs text-muted-foreground" role="status">
            {formatNumber(visible.length)} of {formatNumber(players.length)} players in {scopeLabel}. Ranks stay tied to this scope when filtered.
          </p>
          {visible.length === 0 ? (
            <Card role="status">
              <DataState icon={<Search size={26} aria-hidden="true" />} title="No players match these filters" action={<Button variant="outline" onClick={() => setFilters({ search: '', role: 'All' })}>Clear filters</Button>}>
                Try another player or team name, or select all roles.
              </DataState>
            </Card>
          ) : (
            <Card className="min-w-0 overflow-hidden p-0">
              <Table aria-label="Player rankings" tabIndex={0} className="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]">
                <caption className="sr-only">Player rankings for {scopeLabel}, ordered by {scoreLabel}, highest first. Equal scores share a rank.{statsPowerVersion ? ' Stat games count games with usable role stats in this scope, including previous teams.' : ''} Games count games credited to the displayed team where available, otherwise all rated games.</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="pl-4">Rank</TableHead>
                    <TableHead scope="col">Player</TableHead>
                    <TableHead scope="col">Team</TableHead>
                    <TableHead scope="col">Role</TableHead>
                    <TableHead scope="col" className="text-right" aria-sort="descending">{scoreLabel}</TableHead>
                    {statsPowerVersion ? (
                      <>
                        <TableHead scope="col" className="text-right">Stat games</TableHead>
                        <TableHead scope="col" className="text-right">Role Power</TableHead>
                      </>
                    ) : null}
                    <TableHead scope="col" className="pr-4 text-right">Games</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((player) => (
                    <TableRow key={player.id}>
                      <TableCell className="pl-4 font-mono text-muted-foreground">{player.leaderboardRank}</TableCell>
                      <TableCell className="font-semibold text-[var(--text-strong)]">{player.name}</TableCell>
                      <TableCell className="max-w-44 whitespace-normal">{player.team}</TableCell>
                      <TableCell>{player.role}</TableCell>
                      <TableCell className="text-right font-mono font-semibold tabular-nums">
                        {player.leaderboardScore.kind === 'stats-power' ? formatDecimal(player.leaderboardScore.value) : formatRating(player.leaderboardScore.value)}
                        {statsPowerVersion && player.leaderboardScore.kind === 'role-power' ? <span className="block text-2xs font-normal text-muted-foreground">Role Power</span> : null}
                        {player.statsPower?.priorOnly ? <span className="block text-2xs font-normal text-muted-foreground">League anchor</span> : null}
                      </TableCell>
                      {statsPowerVersion ? (
                        <>
                          <TableCell className="text-right font-mono tabular-nums">{formatNumber(player.statsPower?.sampleGames)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{formatRating(player.rating)}</TableCell>
                        </>
                      ) : null}
                      <TableCell className="pr-4 text-right font-mono tabular-nums">{formatNumber(player.teamGames ?? player.games)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
      {directory ? (
        <p className="break-words text-xs leading-relaxed text-muted-foreground">
          Source {directory.sourceProvider}.{' '}
          {statsPowerVersion
            ? `Stats Power ${statsPowerVersion} scores lane leads at 15 minutes, kill participation and ward activity against each role's average. It weights each game by event and home-league strength, then halves its weight for every 90 days before the latest match date in the supplied history. It pulls small samples to the league anchor and excludes wins, KDA and gold share. It does not decay with wall-clock inactivity. Stat games count raw games with usable role stats in this scope, including previous teams. `
            : ''}
          Role Power uses model {directory.modelVersion}, configuration {directory.modelConfigHash}, and includes individual stats, results, opponent strength and event context. Its history and deltas still track Role Power. Games count games credited to the displayed team where available, otherwise all rated games. Game counts do not measure certainty.
        </p>
      ) : null}
    </section>
  )
}
