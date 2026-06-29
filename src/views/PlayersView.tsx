import { Fragment, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Info, UserRound } from 'lucide-react'
import type { CompactPlayer, PlayerMetricInfo } from '../lib/publicArtifacts/schema'
import type { Role } from '../types'
import { formatCompetitionRegionLabel } from '../data/regionTaxonomy'
import { extent, formatDate, formatDecimal, formatMultiplier, formatNumber, formatPercentValue, formatRating, formatRatio } from '../lib/display'
import { ConfBar, CountBadge, DataState, Delta, Field, FormDots, HeatChip, PickButton, SearchInput, Segmented, SortHeader } from '../components/ui'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import type { PlayerDirectoryState } from '../hooks/usePublicArtifacts'

type SortKey = 'rank' | 'rating' | 'individualResidual' | 'games'
type RoleFilter = Role | 'All'

const PLAYER_PAGE_SIZES = [25, 50, 80, 120] as const
const DEFAULT_PLAYER_PAGE_SIZE = 80

export function PlayersView({
  players,
  metric,
  roles,
  search,
  onSearchChange,
  pickedIds,
  artifactState,
  onToggle,
}: {
  players: CompactPlayer[]
  metric?: PlayerMetricInfo
  roles: Role[]
  search: string
  onSearchChange: (value: string) => void
  pickedIds: Set<string>
  artifactState?: PlayerDirectoryState
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
  const playerMetric: PlayerMetricInfo = metric ?? {
    id: 'role-power',
    label: 'Role Power',
    shortLabel: 'Role Power',
    description: 'Role-conditioned player rating from sourced game stats.',
    interpretation: 'This metric includes team-result signal and should not be read as independent best-in-role proof.',
    teamResultSignal: 'included',
    independentSkillClaim: false,
  }

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
        {playerMetric.label} ranks role-conditioned player performance from observed game stats. {playerMetric.interpretation} Team
        labels show how much of the sample was played for the displayed team.
      </p>

      <Card className="panel">
        <div className="panel__head player-panel__head">
          <div>
            <p className="eyebrow">Player ratings</p>
            <h2>{playerMetric.label}</h2>
            <p className="panel__hint">{playerMetric.description}</p>
          </div>
          <div className="toolbar spacer player-panel__controls">
            <SearchInput value={search} onChange={onSearchChange} placeholder="Search players" className="player-filter-search" />
            <Segmented
              value={role}
              options={roleOptions}
              onChange={updateRole}
              ariaLabel="Player role filter"
              className="player-filter-roles"
            />
            <Field
              label="Region"
              value={region}
              options={regionOptions.map((option) => ({ value: option, label: formatCompetitionRegionLabel(option) }))}
              onChange={updateRegion}
              className="grid-flow-col items-center gap-2 player-filter-field"
            />
            <CountBadge>
              {sorted.length === 0 ? 0 : pageStart + 1}-{pageStart + visible.length} of {filtered.length}
            </CountBadge>
          </div>
        </div>

        {artifactState?.status === 'loading' ? (
          <DataState icon={<UserRound size={26} aria-hidden="true" />} title="Loading player ratings">
            Fetching the player directory artifact for the current ranking scope.
          </DataState>
        ) : artifactState && artifactState.status !== 'ready' ? (
          <DataState icon={<UserRound size={26} aria-hidden="true" />} title="Player ratings unavailable">
            {artifactState.message}
          </DataState>
        ) : visible.length === 0 ? (
          <DataState icon={<UserRound size={26} aria-hidden="true" />} title="No players match">
            Adjust the search, role, or region filter to see ranked players.
          </DataState>
        ) : (
          <div className="tablewrap">
            <Table className="ranking-table player-grid">
              <TableHeader>
                <TableRow>
                  <TableHead className="center" aria-label="Add to comparison" />
                  <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={false} onSort={onSort} />
                  <TableHead className="player-col-player">Player</TableHead>
                  <TableHead className="player-col-role">Role</TableHead>
                  <TableHead className="player-col-team">Team</TableHead>
                  <SortHeader label="Rating" columnKey="rating" sortKey={sortKey} descending onSort={onSort} align="right" className="player-col-rating" />
                  <SortHeader label="Residual" columnKey="individualResidual" sortKey={sortKey} descending onSort={onSort} align="right" className="player-col-residual" />
                  <SortHeader label="Games" columnKey="games" sortKey={sortKey} descending onSort={onSort} align="right" className="player-col-games" />
                  <TableHead className="player-col-form">Form</TableHead>
                  <TableHead className="player-col-availability">Availability</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((player) => {
                  const isExpanded = expandedPlayerId === player.id
                  const detailId = `player-detail-${domSafeId(player.id)}`
                  const recentMatchesLabel = `${isExpanded ? 'Hide' : 'Show'} diagnostics and recent matches for ${player.name}`
                  return (
                    <Fragment key={player.id}>
                    <TableRow className={pickedIds.has(player.id) ? 'is-picked' : ''}>
                      <TableCell className="center">
                        <PickButton picked={pickedIds.has(player.id)} onToggle={() => onToggle(player)} label={player.name} />
                      </TableCell>
                      <TableCell className={`rank-cell${player.rank <= 3 ? ' podium' : ''}`}>{player.rank}</TableCell>
                      <TableCell className="player-col-player">
                        <div className="ent">
                          <b>{player.name}</b>
                          <small>
                            <span className="player-mobile-team">{player.teamCode ?? player.team} · </span>
                            <span className="player-mobile-context">{mobilePlayerContext(player)}</span>
                            <ImpactMultiplier value={player.impactMultiplier} />
                          </small>
                          <Button
                            type="button"
                            variant="ghost"
                            className="form-trigger player-form-inline"
                            aria-expanded={isExpanded}
                            aria-controls={detailId}
                            aria-label={recentMatchesLabel}
                            onClick={() => toggleRecentMatches(player.id)}
                            title={recentMatchesLabel}
                          >
                            <FormDots form={player.form} />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="player-col-role">
                        <span className="role-pill">{player.role}</span>
                      </TableCell>
                      <TableCell className="player-col-team">
                        <div className="ent">
                          <b>{player.teamCode ?? player.team}</b>
                          <small className="player-team-meta" title={appearanceTitle(player)} aria-label={teamAppearanceLabel(player)}>
                            <span className="player-team-meta__full">{teamAppearanceLabel(player)}</span>
                            <span className="player-team-meta__short" aria-hidden="true">{player.region ?? '—'}</span>
                          </small>
                        </div>
                      </TableCell>
                      <TableCell className="right player-col-rating">
                        <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />{' '}
                        <Delta value={player.delta} />
                      </TableCell>
                      <TableCell className="right player-col-residual">
                        <ResidualChip player={player} />
                      </TableCell>
                      <TableCell className="right num player-col-games">{formatNumber(player.games)}</TableCell>
                      <TableCell className="player-col-form">
                        <Button
                          type="button"
                          variant="ghost"
                          className="form-trigger"
                          aria-expanded={isExpanded}
                          aria-controls={detailId}
                          aria-label={recentMatchesLabel}
                          onClick={() => toggleRecentMatches(player.id)}
                          title={recentMatchesLabel}
                        >
                          <FormDots form={player.form} />
                        </Button>
                      </TableCell>
                      <TableCell className="player-col-availability">
                        <ConfBar value={Math.round((player.availability ?? 0) * 100)} />
                      </TableCell>
                    </TableRow>
                    {isExpanded ? (
                      <TableRow className="player-match-row" id={detailId}>
                        <TableCell colSpan={10}>
                          <PlayerRecentMatches player={player} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {sorted.length > 0 ? (
          <div className="pager" aria-label="Player table pagination">
            <div className="pager__size">
              <Field
                label="Rows"
                value={String(pageSize)}
                options={PLAYER_PAGE_SIZES.map((option) => String(option))}
                onChange={(value) => updatePageSize(Number(value))}
              />
            </div>
            <CountBadge>
              Page {currentPage} of {totalPages}
            </CountBadge>
            <div className="pager__buttons">
              <Button type="button" variant="secondary" size="icon" onClick={() => updatePage(1)} disabled={currentPage === 1} aria-label="First page">
                <ChevronsLeft size={16} aria-hidden="true" />
              </Button>
              <Button type="button" variant="secondary" size="icon" onClick={() => updatePage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous page">
                <ChevronLeft size={16} aria-hidden="true" />
              </Button>
              <Button type="button" variant="secondary" size="icon" onClick={() => updatePage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next page">
                <ChevronRight size={16} aria-hidden="true" />
              </Button>
              <Button type="button" variant="secondary" size="icon" onClick={() => updatePage(totalPages)} disabled={currentPage === totalPages} aria-label="Last page">
                <ChevronsRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

function domSafeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function ImpactMultiplier({ value }: { value: number }) {
  const label = `impact ×${formatMultiplier(value)}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="impact-note"
          aria-label={`${label}. Explain impact multiplier`}
        >
          <span>{label}</span>
          <Info size={12} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="impact-tooltip">
        <b>Impact multiplier</b>
        <span>
          Starts at 1.0 and adjusts the player's base role share with objective/stat impact, rating signal, award residuals,
          and recent form. A 1.1 value means roughly 10% more model weight before availability and roster normalization.
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function ResidualChip({ player }: { player: CompactPlayer }) {
  const residual = player.individualResidual
  if (!residual) return <span className="muted">—</span>
  const rankLabel = residual.rank ? `#${residual.rank}` : 'unranked'
  return (
    <span className="residual-chip" title={`Individual Residual ${formatRating(residual.score)} · ${rankLabel}`}>
      <b>{formatRating(residual.score)}</b>
      <small>{rankLabel}</small>
    </span>
  )
}

function PlayerRecentMatches({ player }: { player: CompactPlayer }) {
  const matches = player.recentMatches ?? []

  if (!player.diagnostics && !player.individualResidual && matches.length === 0) {
    return (
      <div className="player-match-detail">
        <p className="muted">This player artifact only has the W/L form letters. Diagnostics and recent match opponents are not available in this generated payload.</p>
      </div>
    )
  }

  return (
    <div className="player-match-detail">
      <div className="player-match-detail__head">
        <div className="player-match-detail__title">
          <b>{player.name} diagnostics and recent matches</b>
          <small>Oracle row diagnostics for context; rating remains the published Role Power metric.</small>
        </div>
        <CountBadge>{formatPlayerSourceBadge(player)}</CountBadge>
      </div>
      {player.diagnostics || player.individualResidual ? <PlayerDiagnosticsPanel player={player} /> : null}
      {matches.length > 0 ? (
        <div className="player-match-list" aria-label={`${player.name} recent match source proof`}>
          {matches.slice().reverse().map((match, index) => (
            <div className="player-match" key={`${match.date}-${match.sourceMatchId ?? match.sourceGameId ?? match.event}-${index}`}>
              <span className={`result-chip ${match.result === 'W' ? 'w' : 'l'}`} aria-label={match.result === 'W' ? 'Win' : 'Loss'}>{match.result}</span>
              <div className="player-match__main">
                <b>{formatMatchTitle(match, player)}</b>
                <small>{formatMatchMeta(match)}</small>
              </div>
              <span className="player-match__score">{formatMatchScore(match)}</span>
              <small className="player-match__source" title={formatMatchSource(match, true)}>
                {formatMatchSource(match)}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <p className="player-match-empty">Recent match opponents are not available in this generated payload.</p>
      )}
    </div>
  )
}

type CompactRecentPlayerMatch = NonNullable<CompactPlayer['recentMatches']>[number]
type CompactPlayerDiagnostics = NonNullable<CompactPlayer['diagnostics']>
type CompactPlayerDiagnosticMetric = NonNullable<CompactPlayerDiagnostics['damageShare']>
type CompactPlayerIndividualResidual = NonNullable<CompactPlayer['individualResidual']>

function PlayerDiagnosticsPanel({ player }: { player: CompactPlayer }) {
  const diagnostics = player.diagnostics
  const residual = player.individualResidual
  if (!diagnostics && !residual) return null
  const residualItems = residual ? [
    { label: 'Individual Residual', value: formatRating(residual.score), note: formatResidualRankNote(residual) },
    residual.adjustedSameRoleDiff ? { label: 'Adjusted diff', value: formatMetricSignedRatio(residual.adjustedSameRoleDiff), note: metricCoverageLabel(residual.adjustedSameRoleDiff) } : undefined,
    residual.expectedNoWinStatScore ? { label: 'Expected no-win', value: formatMetricRatio(residual.expectedNoWinStatScore), note: formatResidualControlNote(residual) } : undefined,
    residual.opponentStrengthProxy ? { label: 'Strength proxy', value: formatMetricSignedRatio(residual.opponentStrengthProxy), note: 'pre-game rating edge' } : undefined,
  ].filter((item): item is { label: string; value: string; note: string } => Boolean(item)) : []
  const diagnosticItems = diagnostics ? [
    { label: 'Win rate', value: diagnostics.winRate === null || diagnostics.winRate === undefined ? '—' : formatRatio(diagnostics.winRate), note: `${formatNumber(diagnostics.wins ?? 0)}-${formatNumber(diagnostics.losses ?? 0)}` },
    diagnostics.noWinStatScore ? { label: 'No-win stat', value: formatMetricRatio(diagnostics.noWinStatScore), note: metricCoverageLabel(diagnostics.noWinStatScore) } : undefined,
    diagnostics.sameRoleMatchupDiff ? { label: 'Same-role diff', value: formatMetricSignedRatio(diagnostics.sameRoleMatchupDiff), note: metricCoverageLabel(diagnostics.sameRoleMatchupDiff) } : undefined,
    diagnostics.damageShare ? { label: 'Damage share', value: formatMetricRatio(diagnostics.damageShare), note: metricCoverageLabel(diagnostics.damageShare) } : undefined,
    diagnostics.earnedGoldShare ? { label: 'Gold share', value: formatMetricRatio(diagnostics.earnedGoldShare), note: metricCoverageLabel(diagnostics.earnedGoldShare) } : undefined,
    diagnostics.kda ? { label: 'KDA', value: formatMetricDecimal(diagnostics.kda), note: metricCoverageLabel(diagnostics.kda) } : undefined,
    diagnostics.visionScore ? { label: 'Vision score', value: formatMetricDecimal(diagnostics.visionScore), note: metricCoverageLabel(diagnostics.visionScore) } : undefined,
    diagnostics.vspm ? { label: 'VSPM', value: formatMetricDecimal(diagnostics.vspm), note: metricCoverageLabel(diagnostics.vspm) } : undefined,
  ].filter((item): item is { label: string; value: string; note: string } => Boolean(item)) : []
  const items = [
    ...residualItems,
    ...diagnosticItems,
  ]
  const sourceSampleGames = diagnostics?.sampleGames ?? residual?.sampleGames ?? 0

  return (
    <div className="player-diagnostics" aria-label={`${player.name} Oracle row diagnostics`}>
      <div className="player-diagnostics__head">
        <span>{formatNumber(sourceSampleGames)} rated complete-role matchups</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="impact-note"
              aria-label="Explain Oracle row diagnostics"
            >
              <Info size={12} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="impact-tooltip">
            <b>Player diagnostics</b>
            <span>
              Individual Residual is a shadow comparison that reduces shared team-result and context effects. Oracle row
              diagnostics explain source stat context and missing coverage; Role Power remains the published rank.
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="player-diagnostic-grid">
        {items.map((item) => (
          <div className="player-diagnostic" key={item.label}>
            <span>{item.label}</span>
            <b>{item.value}</b>
            <small>{item.note}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

function metricCoverageLabel(metric: CompactPlayerDiagnosticMetric) {
  if (metric.missing > 0) return `${formatNumber(metric.games)} games · ${formatNumber(metric.missing)} missing`
  return `${formatNumber(metric.games)} games`
}

function formatMetricRatio(metric: CompactPlayerDiagnosticMetric) {
  return metric.value === null ? '—' : formatRatio(metric.value)
}

function formatMetricSignedRatio(metric: CompactPlayerDiagnosticMetric) {
  if (metric.value === null) return '—'
  if (metric.value === 0) return '0 pts'
  const value = Math.round(metric.value * 1000) / 10
  return `${value > 0 ? '+' : ''}${formatDecimal(value)} pts`
}

function formatMetricDecimal(metric: CompactPlayerDiagnosticMetric) {
  return metric.value === null ? '—' : formatDecimal(metric.value)
}

function formatResidualRankNote(residual: CompactPlayerIndividualResidual) {
  const parts = [
    residual.rank ? `#${residual.rank}` : 'unranked',
    typeof residual.rankDelta === 'number' ? formatResidualRankDelta(residual.rankDelta) : undefined,
    `${formatPercentValue(residual.confidence)} conf`,
  ]
  return parts.filter(Boolean).join(' · ')
}

function formatResidualRankDelta(delta: number) {
  if (delta === 0) return 'even vs Role Power'
  return delta > 0 ? `+${formatNumber(delta)} ranks vs Role Power` : `${formatNumber(delta)} ranks vs Role Power`
}

function formatResidualControlNote(residual: CompactPlayerIndividualResidual) {
  if (!residual.controls) return `${formatNumber(residual.sampleGames)} sampled games`
  return [
    residual.controls.primaryLeague,
    `${formatNumber(residual.controls.leagueGames)} league games`,
    `${formatNumber(residual.controls.patchCount)} patches`,
  ].join(' · ')
}

function formatPlayerSourceBadge(player: CompactPlayer) {
  return player.sourceProvider ? `${player.sourceProvider} source` : 'player artifact source'
}

function formatMatchTitle(match: CompactRecentPlayerMatch, player: CompactPlayer) {
  const team = match.playerTeamCode ?? match.playerTeam ?? player.teamCode ?? player.team
  const opponent = match.opponentTeamCode ?? match.opponent
  return `${team} vs ${opponent}`
}

function formatMatchMeta(match: CompactRecentPlayerMatch) {
  return [
    match.event,
    typeof match.bestOf === 'number' && match.bestOf > 1 ? `Bo${match.bestOf}` : undefined,
    formatDate(match.date),
  ].filter(Boolean).join(' · ')
}

function formatMatchScore(match: CompactRecentPlayerMatch) {
  if (typeof match.wins === 'number' && typeof match.losses === 'number') return `${match.wins}-${match.losses}`
  if (typeof match.teamKills === 'number' && typeof match.opponentKills === 'number') return `${match.teamKills}-${match.opponentKills}`
  return '—'
}

function formatMatchSource(match: CompactRecentPlayerMatch, full = false) {
  const sourceFileName = full ? match.sourceFileName : formatSourceFileName(match.sourceFileName)
  const sourceId = match.sourceMatchId
    ? `match ${match.sourceMatchId}`
    : typeof match.games === 'number' && match.games > 1
      ? `${formatNumber(match.games)} rows`
      : match.sourceGameId
  return [match.sourceProvider, sourceFileName, sourceId].filter(Boolean).join(' · ') || 'Source metadata unavailable'
}

function formatSourceFileName(fileName?: string) {
  if (!fileName) return undefined
  const year = fileName.match(/^(20\d{2})_/)?.[1]
  if (year && fileName.includes('OraclesElixir')) return `${year} Oracle CSV`
  return fileName
}

function mobilePlayerContext(player: CompactPlayer) {
  const residual = player.individualResidual ? `IR ${formatRating(player.individualResidual.score)}` : undefined
  return [
    player.role,
    teamAttributionShort(player),
    `${formatNumber(player.games)} games`,
    residual,
    `${formatRatio(player.availability)} avail`,
  ].filter(Boolean).join(' · ')
}

function teamAttributionShort(player: CompactPlayer) {
  const latestTeam = player.teamCode ?? player.team
  const appearance = player.appearance
  if (!appearance) return latestTeam
  const latestGames = player.teamGames ?? appearance.latestTeamGames
  const primaryDiffers = appearance.primaryTeam && appearance.primaryTeam !== player.team
  return primaryDiffers
    ? `${latestTeam} latest ${formatNumber(latestGames)}g`
    : `${latestTeam} ${formatNumber(latestGames)}g`
}

function teamAppearanceLabel(player: CompactPlayer) {
  const appearance = player.appearance
  if (!appearance) return player.region ?? '—'
  const teamGames = player.teamGames ?? appearance.latestTeamGames
  const latestSample = `Latest team: ${formatNumber(teamGames)} of ${formatNumber(player.games)} games`
  const primarySample = appearance.primaryTeam && appearance.primaryTeam !== player.team
    ? `primary ${appearance.primaryTeam} ${formatNumber(appearance.primaryTeamGames)} games`
    : `primary sample: ${formatNumber(appearance.primaryTeamGames)} of ${formatNumber(player.games)} games`
  const flags = appearance.flags.includes('multi-team-career')
    ? 'multi-team'
    : appearance.flags.includes('thin-latest-team-sample')
      ? 'thin team sample'
      : undefined
  return [latestSample, primarySample, formatCompetitionRegionLabel(player.region), flags].filter(Boolean).join(' · ')
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
    case 'individualResidual':
      return copy.sort((a, b) =>
        (b.individualResidual?.score ?? -Infinity) - (a.individualResidual?.score ?? -Infinity)
        || a.rank - b.rank,
      )
    case 'games':
      return copy.sort((a, b) => b.games - a.games)
    default:
      return copy.sort((a, b) => a.rank - b.rank)
  }
}
