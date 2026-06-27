import { useMemo, useState } from 'react'
import { UserRound } from 'lucide-react'
import type { CompactPlayer } from '../lib/snapshot'
import type { Role } from '../types'
import { extent, formatDecimal, formatNumber, formatRating } from '../lib/display'
import { ConfBar, DataState, Delta, FormDots, HeatChip, PickButton, Segmented, SortHeader } from '../components/ui'

type SortKey = 'rank' | 'rating' | 'games'
type RoleFilter = Role | 'All'

const PLAYER_ROW_LIMIT = 80

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
  const visible = sorted.slice(0, PLAYER_ROW_LIMIT)
  const [ratingMin, ratingMax] = useMemo(() => extent(filtered.map((player) => player.rating)), [filtered])

  const roleOptions = useMemo(
    () => [{ value: 'All' as RoleFilter, label: 'All' }, ...roles.map((entry) => ({ value: entry as RoleFilter, label: entry }))],
    [roles],
  )

  function onSort(key: string) {
    setSortKey(key as SortKey)
  }

  return (
    <div className="view">
      <p className="view__intro">
        Role-conditioned player ratings from observed game stats, ranked across every region. Filter by role or region,
        then add players to compare their rating, workload, and impact drivers side by side.
      </p>

      <section className="panel">
        <div className="panel__head">
          <div>
            <p className="eyebrow">Player ratings</p>
            <h2>Player Index</h2>
          </div>
          <div className="toolbar spacer">
            <Segmented value={role} options={roleOptions} onChange={setRole} />
            <label className="field" style={{ gridAutoFlow: 'column', alignItems: 'center', gap: 8 }}>
              <span>Region</span>
              <select value={region} onChange={(event) => setRegion(event.target.value)}>
                {regionOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <span className="count">
              {visible.length} of {filtered.length}
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
                  <tr key={player.id} className={pickedIds.has(player.id) ? 'is-picked' : ''}>
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
                        <small>{player.region ?? '—'}</small>
                      </div>
                    </td>
                    <td className="right">
                      <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />{' '}
                      <Delta value={player.delta} />
                    </td>
                    <td className="right num">{formatNumber(player.games)}</td>
                    <td>
                      <FormDots form={player.form} />
                    </td>
                    <td>
                      <ConfBar value={Math.round((player.availability ?? 0) * 100)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
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
