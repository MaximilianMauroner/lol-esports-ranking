import { useMemo, useState, type ReactNode } from 'react'
import { FileText, Link2, ShieldCheck, Users } from 'lucide-react'
import type {
  CompactPlayer,
  PublicRankingManifest,
  PublicRankingShard,
  PublicTeamStanding as RankingSummaryStanding,
} from '../lib/publicArtifacts/schema'
import { buildTeamReceipt, type TeamReceipt } from '../lib/receipts'
import { CountBadge, DataState, Field, RegionBadge } from '../components/ui'
import { Card, CardHeader } from '../components/ui/card'
import { ReceiptCard, type RankingReceipt, type ReceiptComponent } from '../components/ReceiptCard'
import { formatDate, formatNumber, formatRating, formatRecord, formatSigned, teamKey } from '../lib/display'

export type ReceiptsViewProps = {
  standings: RankingSummaryStanding[]
  players: CompactPlayer[]
  manifest: PublicRankingManifest
  snapshot?: PublicRankingShard
  pickedTeams: RankingSummaryStanding[]
}

const RECEIPT_TEAM_LIMIT = 240

export function ReceiptsView({
  standings,
  players,
  manifest,
  snapshot,
  pickedTeams,
}: ReceiptsViewProps) {
  const [selectedKey, setSelectedKey] = useState('')
  const options = useMemo(() => standings.slice(0, RECEIPT_TEAM_LIMIT), [standings])
  const optionKeys = useMemo(() => new Set(options.map(teamKey)), [options])
  const hashTeamKey = useMemo(() => readReceiptTeamKeyFromHash(), [])
  const seedKey = pickedTeams.map(teamKey).find((key) => optionKeys.has(key))
    ?? (optionKeys.has(hashTeamKey) ? hashTeamKey : undefined)
    ?? (options[0] ? teamKey(options[0]) : '')
  const effectiveKey = optionKeys.has(selectedKey) ? selectedKey : seedKey
  const selected = options.find((team) => teamKey(team) === effectiveKey)
  const receipt = useMemo(
    () => selected
      ? buildTeamReceipt({
          standing: selected,
          standings,
          players,
          manifest,
          shard: snapshot,
          generatedAt: manifest.generatedAt,
          asOf: manifest.generatedAt,
        })
      : undefined,
    [manifest, players, selected, snapshot, standings],
  )
  const receiptCard = useMemo(
    () => receipt ? toRankingReceipt(receipt, shareUrlFor(selected)) : undefined,
    [receipt, selected],
  )

  if (standings.length === 0 || !selected || !receiptCard || !receipt) {
    return (
      <div className="view receipts-view">
        <Card className="panel receipts-panel">
          <DataState icon={<FileText size={26} aria-hidden="true" />} title="No ranking receipts available">
            Load a ranking snapshot before generating a shareable receipt.
          </DataState>
        </Card>
      </div>
    )
  }

  return (
    <div className="view receipts-view">
      <Card className="panel receipts-panel receipts-panel--intro">
        <CardHeader className="panel__head receipts-panel__head">
          <div className="panel__title">
            <p className="eyebrow">Receipts</p>
            <h2>Why is this team ranked here?</h2>
            <p className="panel__hint">
              Shareable model receipt with rating components, movement, players, event evidence, confidence, source, model, and config.
            </p>
          </div>
          <div className="receipts-toolbar">
            <Field
              label="Team"
              value={effectiveKey}
              options={options.map((team) => ({ value: teamKey(team), label: optionLabel(team) }))}
              onChange={setSelectedKey}
            />
          </div>
        </CardHeader>

        <div className="receipts-summary">
          <ReceiptFact
            icon={<ShieldCheck size={17} aria-hidden="true" />}
            label="Confidence"
            value={receipt.confidence.label}
            detail={`${formatNumber(receipt.confidence.score)} score / +/-${formatRating(receipt.confidence.uncertainty)}`}
          />
          <ReceiptFact
            icon={<Users size={17} aria-hidden="true" />}
            label="Player signals"
            value={formatNumber(receipt.players.length)}
            detail={receipt.players.slice(0, 3).map((player) => player.name).join(' / ') || 'No sourced players'}
          />
          <ReceiptFact
            icon={<Link2 size={17} aria-hidden="true" />}
            label="Share hash"
            value={receipt.share.hash}
            detail={`Generated ${formatDate(receipt.generatedAt)}`}
          />
        </div>
      </Card>

      <div className="receipts-grid">
        <ReceiptCard receipt={receiptCard} />

        <aside className="receipts-evidence" aria-label="Receipt evidence">
          <Card className="panel receipts-panel">
            <CardHeader className="panel__head">
              <div className="panel__title">
                <p className="eyebrow">Team context</p>
                <h2>{receipt.team.code}</h2>
              </div>
              <RegionBadge region={receipt.team.league || receipt.team.region} size="sm" />
            </CardHeader>
            <dl className="receipts-dl">
              <div>
                <dt>Record</dt>
                <dd>{formatRecord(receipt.team.record.wins, receipt.team.record.losses)}</dd>
              </div>
              <div>
                <dt>Tier</dt>
                <dd>{receipt.team.tier}</dd>
              </div>
              <div>
                <dt>Rank movement</dt>
                <dd>{formatSigned(receipt.movement.rankDelta)}</dd>
              </div>
              <div>
                <dt>Rating move</dt>
                <dd>{formatSigned(receipt.movement.ratingDelta)}</dd>
              </div>
            </dl>
          </Card>

          <Card className="panel receipts-panel">
            <CardHeader className="panel__head">
              <div className="panel__title">
                <p className="eyebrow">Recent evidence</p>
                <h2>Events and matches</h2>
              </div>
              <CountBadge>{formatNumber(receipt.recent.matches.length)} matches</CountBadge>
            </CardHeader>
            <div className="receipts-event-list">
              {receipt.recent.matches.slice(0, 5).map((match, index) => (
                <article className="receipts-event" key={`${match.date}-${match.opponent}-${index}`}>
                  <div>
                    <b>{match.event}</b>
                    <small>{formatDate(match.date)} / vs {match.opponent}</small>
                  </div>
                  <span className={match.result === 'W' ? 'up' : 'down'}>{match.result} {formatSigned(match.delta)}</span>
                </article>
              ))}
              {receipt.recent.matches.length === 0 ? <p className="receipt-muted">No recent match evidence in this snapshot.</p> : null}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  )
}

function ReceiptFact({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <article className="receipts-fact">
      <span aria-hidden="true">{icon}</span>
      <div>
        <small>{label}</small>
        <b>{value}</b>
        <em>{detail}</em>
      </div>
    </article>
  )
}

function toRankingReceipt(receipt: TeamReceipt, shareUrl?: string): RankingReceipt {
  const components = receiptComponents(receipt)
  return {
    id: receipt.share.hash,
    title: `${receipt.team.code} ranking receipt`,
    subject: receipt.team.name,
    team: receipt.team.name,
    code: receipt.team.code,
    rank: receipt.team.rank,
    rating: receipt.rating.current,
    summary: `#${receipt.team.rank} ${receipt.team.tier}-tier team with ${formatSigned(receipt.movement.rankDelta)} rank movement and ${receipt.confidence.label.toLowerCase()} confidence.`,
    components,
    movement: {
      label: 'Recent movement',
      fromRank: receipt.movement.previousRank,
      toRank: receipt.movement.rank,
      movement: receipt.movement.rankDelta,
      ratingDelta: receipt.movement.ratingDelta,
      note: `${formatSigned(receipt.movement.ratingDelta)} rating since the previous snapshot`,
    },
    players: receipt.players.slice(0, 5).map((player) => ({
      id: player.id,
      name: player.name,
      role: player.role,
      team: player.teamCode ?? player.team,
      impact: formatRating(player.rating),
      delta: player.delta,
      note: `${formatNumber(player.games)} games`,
    })),
    events: receipt.recent.matches.slice(0, 5).map((match, index) => ({
      id: `${match.date}-${match.opponent}-${index}`,
      date: match.date,
      event: match.event,
      opponent: match.opponent,
      result: match.result,
      score: scoreForMatch(match),
      delta: match.delta,
      source: receipt.source.label,
    })),
    confidence: {
      label: receipt.confidence.label,
      value: receipt.confidence.score,
      uncertainty: receipt.confidence.uncertainty,
      sample: receipt.confidence.recentMatchCount,
      description: `${receipt.confidence.recentMatchCount} recent matches, +/-${formatRating(receipt.confidence.uncertainty)} uncertainty, ${receipt.team.eligibility.eligible ? 'eligible' : 'eligibility warning'}.`,
    },
    source: {
      provider: receipt.source.label,
      matchCount: receipt.config.matchCount,
      coverage: coverageLabel(receipt),
      generatedAt: receipt.generatedAt,
    },
    model: {
      name: receipt.model.name,
      version: receipt.model.version,
      configHash: receipt.model.configHash,
    },
    config: {
      label: receipt.config.schemaVersion ? `schema ${receipt.config.schemaVersion}` : undefined,
      hash: receipt.config.modelConfigHash,
      notes: receipt.staleness.isStale ? [`Stale by ${receipt.staleness.ageDays ?? 0} days`] : undefined,
    },
    shareUrl,
    shareText: shareTextFor(receipt),
  }
}

function receiptComponents(receipt: TeamReceipt): ReceiptComponent[] {
  return [
    { key: 'current', label: 'Current rating', value: receipt.rating.current, delta: receipt.rating.delta },
    { key: 'base', label: 'Base rating', value: receipt.rating.base },
    { key: 'leagueScore', label: 'League score', value: receipt.rating.leagueScore },
    { key: 'leagueAdjustment', label: 'League adjustment', value: receipt.rating.leagueAdjustment },
    { key: 'leagueAnchor', label: 'League anchor', value: receipt.rating.components.leagueAnchor },
    { key: 'teamStableOffset', label: 'Stable team offset', value: receipt.rating.components.teamStableOffset },
    { key: 'rosterPriorOffset', label: 'Roster prior', value: receipt.rating.components.rosterPriorOffset },
    { key: 'momentum', label: 'Momentum', value: receipt.rating.components.momentum },
    { key: 'contextAdjustment', label: 'Context adjustment', value: receipt.rating.components.contextAdjustment },
    { key: 'uncertainty', label: 'Uncertainty', value: receipt.rating.components.uncertainty },
  ]
}

function optionLabel(team: RankingSummaryStanding) {
  return `${team.rank ? `#${team.rank} ` : ''}${team.team}`
}

function scoreForMatch(match: TeamReceipt['recent']['matches'][number]) {
  if (typeof match.wins === 'number' && typeof match.losses === 'number') return `${match.wins}-${match.losses}`
  return match.result
}

function coverageLabel(receipt: TeamReceipt) {
  const coverage = receipt.source.coverage
  return [coverage?.coverageStart, coverage?.coverageEnd].filter(Boolean).join(' to ') || receipt.source.dataMode
}

function shareTextFor(receipt: TeamReceipt) {
  return [
    `${receipt.team.code} is #${receipt.team.rank} (${receipt.team.tier}-tier) at ${formatRating(receipt.rating.current)} GPR.`,
    `Movement: ${formatSigned(receipt.movement.rankDelta)} ranks, ${formatSigned(receipt.movement.ratingDelta)} rating.`,
    `Confidence: ${receipt.confidence.label} (${formatNumber(receipt.confidence.score)}).`,
    `Source: ${receipt.source.label}; model ${receipt.model.version}; config ${receipt.model.configHash}.`,
    `Receipt: ${receipt.share.hash}`,
  ].join('\n')
}

function shareUrlFor(standing: RankingSummaryStanding | undefined) {
  if (typeof window === 'undefined' || !standing) return undefined
  const url = new URL(window.location.href)
  const query = window.location.hash.slice(1).split('?', 2)[1]
  url.hash = `receipts/${encodeURIComponent(teamKey(standing))}${query ? `?${query}` : ''}`
  return url.toString()
}

function readReceiptTeamKeyFromHash() {
  if (typeof window === 'undefined') return ''
  const hash = window.location.hash.slice(1)
  if (!hash.startsWith('receipts/')) return ''
  try {
    return decodeURIComponent(hash.slice('receipts/'.length).split('?', 1)[0])
  } catch {
    return ''
  }
}
