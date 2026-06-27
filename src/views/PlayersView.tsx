import { Fragment, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, UserRound } from 'lucide-react'
import type { CompactPlayer } from '../lib/snapshot'
import type { Role } from '../types'
import { formatCompetitionRegionLabel } from '../data/regionTaxonomy'
import { extent, formatDate, formatDecimal, formatNumber, formatRating } from '../lib/display'
import { ConfBar, DataState, Delta, FormDots, HeatChip, PickButton, Segmented, SortHeader } from '../components/ui'

type SortKey = 'rank' | 'rating' | 'games'
type RoleFilter = Role | 'All'

const PLAYER_PAGE_SIZES = [25, 50, 80, 120] as const
const DEFAULT_PLAYER_PAGE_SIZE = 80

export function PlayersView({
  players,
  roles,
  search,
  pickedIds,
  onToggle,
}: {
  players: CompactPlayer[]
  roles: Role[]
  search: string
  pickedIds: Set<string>
  onToggle: (player: CompactPlayer) => void
}) {
  const [role, setRole] = useState<RoleFilter>('All')
  const [region, setRegion] = useState('All')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PLAYER_PAGE_SIZE)
  const [pageState, setPageState] = useState({ scopeKey: '', page: 1 })
  const [expandedState, setExpandedState] = useState<{ scopeKey: string; playerId?: string }>({ scopeKey: '' })

  const regionOptions = useMemo(
    () => ['All', ...Array.from(new Set(players.map((player) => player.region).filter((value): value is NonNullable<typeof value> => Boolean(value)))).sort()],
    [players],
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return players.filter((player) => {
      if (role !== 'All' && player.role !== role) return false
      if (region !== 'All' && player.region !== region) return false
      if (!query) return true
      return [player.name, player.team, player.teamCode, player.region, player.role].some((value) =>
        value?.toLowerCase().includes(query),
      )
    })
  }, [players, role, region, search])

  const sorted = useMemo(() => sortPlayers(filtered, sortKey), [filtered, sortKey])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageScopeKey = `${role}\u0000${region}\u0000${search}\u0000${sortKey}\u0000${pageSize}`
  const requestedPage = pageState.scopeKey === pageScopeKey ? pageState.page : 1
  const currentPage = Math.min(requestedPage, totalPages)
  const pageStart = (currentPage - 1) * pageSize
  const visible = sorted.slice(pageStart, pageStart + pageSize)
  const expandedPlayerId = expandedState.scopeKey === pageScopeKey ? expandedState.playerId : undefined
  const [ratingMin, ratingMax] = useMemo(() => extent(filtered.map((player) => player.rating)), [filtered])

  const roleOptions = useMemo(
    () => [{ value: 'All' as RoleFilter, label: 'All' }, ...roles.map((entry) => ({ value: entry as RoleFilter, label: entry }))],
    [roles],
  )

  function onSort(key: string) {
    setSortKey(key as SortKey)
    setExpandedState({ scopeKey: pageScopeKey })
  }

  function updateRole(value: RoleFilter) {
    setRole(value)
    setExpandedState({ scopeKey: pageScopeKey })
  }

  function updateRegion(value: string) {
    setRegion(value)
    setExpandedState({ scopeKey: pageScopeKey })
  }

  function updatePageSize(value: number) {
    setPageSize(value)
    setExpandedState({ scopeKey: pageScopeKey })
  }

  function updatePage(nextPage: number) {
    setPageState({ scopeKey: pageScopeKey, page: Math.min(Math.max(1, nextPage), totalPages) })
  }

  function toggleRecentMatches(playerId: string) {
    setExpandedState((value) => ({
      scopeKey: pageScopeKey,
      playerId: value.scopeKey === pageScopeKey && value.playerId === playerId ? undefined : playerId,
    }))
  }

  return (
    <div className="view">
      <p className="view__intro">
        Role-conditioned player ratings from observed game stats, ranked across every region. Team labels are backed by
        observed appearance history and show how much of the player sample was actually played for the displayed team.
      </p>

      <section className="panel">
        <div className="panel__head">
          <div>
            <p className="eyebrow">Player ratings</p>
            <h2>Player Index</h2>
          </div>
          <div className="toolbar spacer">
            <Segmented value={role} options={roleOptions} onChange={updateRole} />
            <label className="field" style={{ gridAutoFlow: 'column', alignItems: 'center', gap: 8 }}>
              <span>Region</span>
              <select value={region} onChange={(event) => updateRegion(event.target.value)}>
                {regionOptions.map((option) => (
                  <option key={option} value={option}>
                    {formatCompetitionRegionLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <span className="count">
              {sorted.length === 0 ? 0 : pageStart + 1}-{pageStart + visible.length} of {filtered.length}
            </span>
          </div>
        </div>

        {visible.length === 0 ? (
          <DataState icon={<UserRound size={26} aria-hidden="true" />} title="No players match">
            Adjust the search, role, or region filter to see ranked players.
          </DataState>
        ) : (
          <div className="tablewrap">
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col" className="center" aria-label="Add to comparison" />
                  <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={false} onSort={onSort} />
                  <th scope="col">Player</th>
                  <th scope="col">Role</th>
                  <th scope="col">Team</th>
                  <SortHeader label="Rating" columnKey="rating" sortKey={sortKey} descending onSort={onSort} align="right" />
                  <SortHeader label="Games" columnKey="games" sortKey={sortKey} descending onSort={onSort} align="right" />
                  <th scope="col">Form</th>
                  <th scope="col">Availability</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((player) => (
                  <Fragment key={player.id}>
                    <tr className={pickedIds.has(player.id) ? 'is-picked' : ''}>
                      <td className="center">
                        <PickButton picked={pickedIds.has(player.id)} onToggle={() => onToggle(player)} label={player.name} />
                      </td>
                      <td className={`rank-cell${player.rank <= 3 ? ' podium' : ''}`}>{player.rank}</td>
                      <td>
                        <div className="ent">
                          <b>{player.name}</b>
                          <small>impact ×{formatDecimal(player.impactMultiplier)}</small>
                        </div>
                      </td>
                      <td>
                        <span className="role-pill">{player.role}</span>
                      </td>
                      <td>
                        <div className="ent">
                          <b>{player.teamCode ?? player.team}</b>
                          <small title={appearanceTitle(player)}>{teamAppearanceLabel(player)}</small>
                        </div>
                      </td>
                      <td className="right">
                        <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />{' '}
                        <Delta value={player.delta} />
                      </td>
                      <td className="right num">{formatNumber(player.games)}</td>
                      <td>
                        <button
                          type="button"
                          className="form-trigger"
                          aria-expanded={expandedPlayerId === player.id}
                          onClick={() => toggleRecentMatches(player.id)}
                          title={`Show recent matches for ${player.name}`}
                        >
                          <FormDots form={player.form} />
                        </button>
                      </td>
                      <td>
                        <ConfBar value={Math.round((player.availability ?? 0) * 100)} />
                      </td>
                    </tr>
                    {expandedPlayerId === player.id ? (
                      <tr className="player-match-row">
                        <td colSpan={9}>
                          <PlayerRecentMatches player={player} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {sorted.length > 0 ? (
          <div className="pager" aria-label="Player table pagination">
            <div className="pager__size">
              <label className="field">
                <span>Rows</span>
                <select value={pageSize} onChange={(event) => updatePageSize(Number(event.target.value))}>
                  {PLAYER_PAGE_SIZES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <span className="count">
              Page {currentPage} of {totalPages}
            </span>
            <div className="pager__buttons">
              <button type="button" className="iconbtn" onClick={() => updatePage(1)} disabled={currentPage === 1} aria-label="First page">
                <ChevronsLeft size={16} aria-hidden="true" />
              </button>
              <button type="button" className="iconbtn" onClick={() => updatePage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous page">
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button type="button" className="iconbtn" onClick={() => updatePage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next page">
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              <button type="button" className="iconbtn" onClick={() => updatePage(totalPages)} disabled={currentPage === totalPages} aria-label="Last page">
                <ChevronsRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function PlayerRecentMatches({ player }: { player: CompactPlayer }) {
  const matches = player.recentMatches ?? []

  if (matches.length === 0) {
    return (
      <div className="player-match-detail">
        <p className="muted">This player artifact only has the W/L form letters. Recent match opponents are not available in this generated payload.</p>
      </div>
    )
  }

  return (
    <div className="player-match-detail">
      <div className="player-match-detail__head">
        <b>{player.name} recent matches</b>
        <span className="count">Source-backed from {player.sourceProvider ?? 'the player artifact'}</span>
      </div>
      <div className="player-match-list">
        {matches.slice().reverse().map((match, index) => (
          <div className="player-match" key={`${match.date}-${match.sourceGameId ?? match.event}-${index}`}>
            <span className={`result-chip ${match.result === 'W' ? 'w' : 'l'}`}>{match.result}</span>
            <div className="player-match__main">
              <b>
                {(match.playerTeam ?? player.teamCode ?? player.team)} vs {match.opponent}
              </b>
              <small>{match.event} · {formatDate(match.date)}</small>
            </div>
            <span className="player-match__score">{formatScore(match.teamKills, match.opponentKills)}</span>
            <small className="player-match__source">
              {[match.sourceProvider, match.sourceFileName, match.sourceGameId].filter(Boolean).join(' · ') || 'Source metadata unavailable'}
            </small>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatScore(teamKills?: number, opponentKills?: number) {
  if (typeof teamKills !== 'number' || typeof opponentKills !== 'number') return '—'
  return `${teamKills}-${opponentKills}`
}

function teamAppearanceLabel(player: CompactPlayer) {
  const appearance = player.appearance
  if (!appearance) return player.region ?? '—'
  const teamGames = player.teamGames ?? appearance.latestTeamGames
  const teamSample = teamGames === player.games
    ? `all ${formatNumber(player.games)} games`
    : `${formatNumber(teamGames)} of ${formatNumber(player.games)} games`
  const flags = appearance.flags.includes('multi-team-career')
    ? 'multi-team'
    : appearance.flags.includes('thin-latest-team-sample')
      ? 'thin team sample'
      : undefined
  return [formatCompetitionRegionLabel(player.region), teamSample, flags].filter(Boolean).join(' · ')
}

function appearanceTitle(player: CompactPlayer) {
  const appearance = player.appearance
  if (!appearance) return player.team
  const teams = appearance.teamHistory
    .slice(0, 4)
    .map((entry) => `${entry.team}: ${formatNumber(entry.games)} games`)
    .join(', ')
  return teams || player.team
}

function sortPlayers(rows: CompactPlayer[], key: SortKey) {
  const copy = [...rows]
  switch (key) {
    case 'rating':
      return copy.sort((a, b) => b.rating - a.rating)
    case 'games':
      return copy.sort((a, b) => b.games - a.games)
    default:
      return copy.sort((a, b) => a.rank - b.rank)
  }
}
