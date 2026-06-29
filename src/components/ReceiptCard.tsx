import { useMemo, useState } from 'react'
import { Check, Clipboard, Link2 } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { cn } from '../lib/utils'
import { formatDate, formatPercentValue, formatRating, formatSigned } from '../lib/display'

export type ReceiptComponent = {
  key?: string
  label?: string
  value: string | number
  delta?: number
  note?: string
}

export type ReceiptMovement = {
  label?: string
  fromRank?: number
  toRank?: number
  previousRank?: number
  rank?: number
  movement?: number
  ratingDelta?: number
  note?: string
}

export type ReceiptPlayer = {
  id?: string
  name: string
  role?: string
  team?: string
  impact?: string | number
  delta?: number
  note?: string
}

export type ReceiptEvent = {
  id?: string
  date?: string
  event?: string
  opponent?: string
  result?: string
  score?: string
  delta?: number
  note?: string
  source?: string
}

export type ReceiptConfidence = number | {
  label?: string
  value?: number
  level?: string
  interval?: string
  uncertainty?: number
  sample?: number
  description?: string
}

export type ReceiptSource = string | {
  provider?: string
  fileName?: string
  url?: string
  matchCount?: number
  coverage?: string
  generatedAt?: string
}

export type ReceiptModel = string | {
  name?: string
  version?: string
  configHash?: string
}

export type ReceiptConfig = string | {
  id?: string
  label?: string
  hash?: string
  notes?: readonly string[]
}

export type RankingReceipt = {
  id?: string
  title?: string
  subject?: string
  team?: string
  code?: string
  rank?: number
  rating?: number
  summary?: string
  components?: readonly ReceiptComponent[] | Record<string, string | number | ReceiptComponent>
  movement?: ReceiptMovement
  players?: readonly ReceiptPlayer[]
  events?: readonly ReceiptEvent[]
  confidence?: ReceiptConfidence
  source?: ReceiptSource
  model?: ReceiptModel
  config?: ReceiptConfig
  shareText?: string
  shareUrl?: string
  url?: string
}

export type ReceiptCardProps = {
  receipt: RankingReceipt
  className?: string
  copyLabel?: string
  linkLabel?: string
}

type CopyState = 'text' | 'link' | 'failed' | null

export function ReceiptCard({
  receipt,
  className,
  copyLabel = 'Copy text',
  linkLabel = 'Copy link',
}: ReceiptCardProps) {
  const [copyState, setCopyState] = useState<CopyState>(null)
  const components = normalizeComponents(receipt.components)
  const shareText = useMemo(() => receipt.shareText?.trim() || buildReceiptText(receipt, components), [components, receipt])
  const shareUrl = receipt.shareUrl ?? receipt.url
  const confidence = normalizeConfidence(receipt.confidence)

  async function handleCopy(target: 'text' | 'link', value?: string) {
    if (!value) return
    const copied = await copyToClipboard(value)
    setCopyState(copied ? target : 'failed')
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setCopyState(null), 1800)
    }
  }

  return (
    <Card className={cn('receipt-card', className)} aria-label={receipt.title ?? 'Ranking receipt'}>
      <CardHeader className="receipt-card__header">
        <div>
          <p className="receipt-eyebrow">Why ranked here</p>
          <CardTitle>{receipt.title ?? receipt.subject ?? receipt.team ?? 'Ranking receipt'}</CardTitle>
          <p>{receipt.summary ?? 'Transparent model receipt for the current ranking claim.'}</p>
        </div>
        <div className="receipt-card__actions">
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy('text', shareText)}>
            {copyState === 'text' ? <Check data-icon="inline-start" aria-hidden="true" /> : <Clipboard data-icon="inline-start" aria-hidden="true" />}
            {copyState === 'text' ? 'Copied' : copyLabel}
          </Button>
          {shareUrl ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy('link', shareUrl)}>
              {copyState === 'link' ? <Check data-icon="inline-start" aria-hidden="true" /> : <Link2 data-icon="inline-start" aria-hidden="true" />}
              {copyState === 'link' ? 'Copied' : linkLabel}
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="receipt-card__body">
        <div className="receipt-card__summary">
          <span className="receipt-card__rank">{receipt.rank ? `#${receipt.rank}` : 'Rank'}</span>
          <div>
            <b>{receipt.team ?? receipt.subject ?? 'Unknown team'}</b>
            <small>{[receipt.code, formatRating(receipt.rating)].filter((part) => part && part !== '—').join(' / ') || 'Rating pending'}</small>
          </div>
          {confidence ? <Badge>{confidence.label}</Badge> : null}
        </div>

        {components.length > 0 ? (
          <section className="receipt-card__section" aria-label="Rating components">
            <div className="receipt-section-head">
              <h3>Components</h3>
            </div>
            <div className="receipt-component-grid">
              {components.map((component) => (
                <div className="receipt-component" key={component.key ?? component.label}>
                  <span>{component.label ?? component.key}</span>
                  <b className="num">{formatComponentValue(component.value)}</b>
                  {typeof component.delta === 'number' ? <small>{formatSigned(component.delta)}</small> : null}
                  {component.note ? <p>{component.note}</p> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {receipt.movement ? (
          <section className="receipt-card__section" aria-label="Ranking movement">
            <div className="receipt-section-head">
              <h3>Movement</h3>
            </div>
            <div className="receipt-ledger-row">
              <span>{receipt.movement.label ?? 'Rank movement'}</span>
              <b>{formatReceiptMovement(receipt.movement)}</b>
              {receipt.movement.note ? <small>{receipt.movement.note}</small> : null}
            </div>
          </section>
        ) : null}

        {receipt.players?.length ? (
          <section className="receipt-card__section" aria-label="Player signals">
            <div className="receipt-section-head">
              <h3>Players</h3>
            </div>
            <div className="receipt-list">
              {receipt.players.map((player) => (
                <div className="receipt-list__row" key={player.id ?? `${player.name}-${player.role ?? ''}`}>
                  <div>
                    <b>{player.name}</b>
                    <small>{[player.role, player.team].filter(Boolean).join(' / ') || 'Player signal'}</small>
                  </div>
                  <span>{player.impact ?? (typeof player.delta === 'number' ? formatSigned(player.delta) : player.note ?? 'tracked')}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {receipt.events?.length ? (
          <section className="receipt-card__section" aria-label="Event evidence">
            <div className="receipt-section-head">
              <h3>Events</h3>
            </div>
            <div className="receipt-list">
              {receipt.events.map((event, index) => (
                <div className="receipt-list__row" key={event.id ?? `${event.event ?? 'event'}-${index}`}>
                  <div>
                    <b>{event.event ?? event.opponent ?? 'Event evidence'}</b>
                    <small>{eventSubtitle(event)}</small>
                  </div>
                  <span>{typeof event.delta === 'number' ? formatSigned(event.delta) : event.result ?? event.score ?? 'noted'}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {confidence ? (
          <section className="receipt-card__section" aria-label="Receipt confidence">
            <div className="receipt-section-head">
              <h3>Confidence</h3>
              <span>{confidence.label}</span>
            </div>
            <div className="receipt-band">
              <span style={{ width: `${confidence.percent}%` }} />
            </div>
            <p className="receipt-muted">{confidence.description}</p>
          </section>
        ) : null}

        <footer className="receipt-card__provenance" aria-label="Receipt provenance">
          <ProvenanceItem label="Source" value={formatSource(receipt.source)} />
          <ProvenanceItem label="Model" value={formatModel(receipt.model)} />
          <ProvenanceItem label="Config" value={formatConfig(receipt.config, receipt.model)} />
        </footer>

        {copyState === 'failed' ? <p className="receipt-card__copy-failed">Clipboard unavailable. Select and copy manually.</p> : null}
      </CardContent>
    </Card>
  )
}

function ProvenanceItem({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <small>{label}</small>
      <b>{value}</b>
    </span>
  )
}

function normalizeComponents(components: RankingReceipt['components']) {
  if (!components) return []
  if (Array.isArray(components)) return components
  return Object.entries(components).map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      return {
        key,
        ...value,
        label: value.label ?? labelFromKey(key),
      }
    }
    return {
      key,
      label: labelFromKey(key),
      value,
    }
  })
}

function normalizeConfidence(confidence: ReceiptConfidence | undefined) {
  if (confidence === undefined) return undefined
  if (typeof confidence === 'number') {
    const percent = clampPercent(confidence <= 1 ? confidence * 100 : confidence)
    return {
      percent,
      label: formatPercentValue(percent),
      description: 'Confidence reflects evidence quality and uncertainty, not a guarantee.',
    }
  }
  const raw = confidence.value ?? confidence.uncertainty
  const percent = typeof raw === 'number' ? clampPercent(raw <= 1 ? raw * 100 : raw) : 0
  const label = confidence.label ?? confidence.level ?? formatPercentValue(percent)
  const details = [
    confidence.description,
    confidence.interval ? `Interval ${confidence.interval}` : undefined,
    typeof confidence.sample === 'number' ? `${confidence.sample} samples` : undefined,
  ].filter(Boolean)
  return {
    percent,
    label,
    description: details.join(' / ') || 'Confidence reflects evidence quality and uncertainty, not a guarantee.',
  }
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function formatComponentValue(value: string | number) {
  return typeof value === 'number' ? formatRating(value) : value
}

function formatReceiptMovement(movement: ReceiptMovement) {
  if (typeof movement.fromRank === 'number' && typeof movement.toRank === 'number') {
    return `#${movement.fromRank} -> #${movement.toRank}`
  }
  if (typeof movement.previousRank === 'number' && typeof movement.rank === 'number') {
    return `#${movement.previousRank} -> #${movement.rank}`
  }
  if (typeof movement.movement === 'number') return `${formatSigned(movement.movement)} ranks`
  if (typeof movement.ratingDelta === 'number') return `${formatSigned(movement.ratingDelta)} rating`
  return 'No movement'
}

function eventSubtitle(event: ReceiptEvent) {
  const parts = [
    event.date ? formatDate(event.date) : undefined,
    event.opponent ? `vs ${event.opponent}` : undefined,
    event.score,
    event.source,
    event.note,
  ].filter(Boolean)
  return parts.join(' / ') || 'Source event'
}

function formatSource(source?: ReceiptSource) {
  if (!source) return 'unknown'
  if (typeof source === 'string') return source
  const parts = [
    source.provider,
    source.fileName,
    typeof source.matchCount === 'number' ? `${source.matchCount} matches` : undefined,
    source.coverage,
    source.generatedAt ? formatDate(source.generatedAt) : undefined,
  ].filter(Boolean)
  return parts.join(' / ') || source.url || 'unknown'
}

function formatModel(model?: ReceiptModel) {
  if (!model) return 'unknown'
  if (typeof model === 'string') return model
  return [model.name, model.version].filter(Boolean).join(' / ') || model.configHash || 'unknown'
}

function formatConfig(config?: ReceiptConfig, model?: ReceiptModel) {
  if (config) {
    if (typeof config === 'string') return config
    return config.hash ?? config.id ?? config.label ?? 'unknown'
  }
  if (model && typeof model !== 'string' && model.configHash) return model.configHash
  return 'unknown'
}

function buildReceiptText(receipt: RankingReceipt, components: readonly ReceiptComponent[]) {
  const lines = [
    receipt.title ?? receipt.subject ?? receipt.team ?? 'Ranking receipt',
    receipt.summary,
    receipt.rank ? `Rank: #${receipt.rank}` : undefined,
    receipt.rating ? `Rating: ${formatRating(receipt.rating)}` : undefined,
    components.length ? `Components: ${components.map((component) => `${component.label ?? component.key}: ${formatComponentValue(component.value)}`).join(', ')}` : undefined,
    receipt.movement ? `Movement: ${formatReceiptMovement(receipt.movement)}` : undefined,
    receipt.players?.length ? `Players: ${receipt.players.map((player) => player.name).join(', ')}` : undefined,
    receipt.events?.length ? `Events: ${receipt.events.map((event) => event.event ?? event.opponent ?? event.result).filter(Boolean).join(', ')}` : undefined,
    `Source: ${formatSource(receipt.source)}`,
    `Model: ${formatModel(receipt.model)}`,
    `Config: ${formatConfig(receipt.config, receipt.model)}`,
    receipt.shareUrl ?? receipt.url,
  ].filter(Boolean)
  return lines.join('\n')
}

function labelFromKey(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

async function copyToClipboard(value: string) {
  if (!value) return false
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Fall through to the textarea path for browsers that expose but reject the Clipboard API.
    }
  }
  if (typeof document === 'undefined' || !document.body) return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
