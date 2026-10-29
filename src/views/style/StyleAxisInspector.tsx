import { Panel } from '../../components/ui/panel'
import type { StyleEntity, StyleMeasure, StylePeer } from '../../domains/style/profile'
import { formatStyleValue, measureStatus } from './presentation'

function CohortStrip({ peers, measure, compare, name, compareName }: {
  peers: StylePeer[]; measure: StyleMeasure; compare?: StyleMeasure; name: string; compareName?: string
}) {
  if (peers.length < 2) return <p className="style-muted">The peer strip needs at least 2 eligible members.</p>
  const values = peers.map(peer => peer.value).sort((a, b) => a - b)
  const low = values[0], high = values.at(-1)!
  const median = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
  const fraction = (value: number) => {
    const share = high === low ? 0.5 : Math.max(0, Math.min(1, (value - low) / (high - low)))
    return measure.metric.direction === 1 ? share : 1 - share
  }
  const position = (value: number) => `${100 * fraction(value)}%`
  const anchor = (value: number) => fraction(value) < 0.15 ? 'start' : fraction(value) > 0.85 ? 'end' : 'center'
  return <figure className="style-strip-wrap">
    <div className="style-strip" data-compare={compare?.value != null || undefined} aria-hidden="true">
      {peers.map((peer, i) => <span key={peer.key} className="style-dot" style={{ left: position(peer.value), top: 6 + (i % 5) * 8 }} title={`${peer.name}, ${formatStyleValue(measure.metric, peer.value)}`} />)}
      <span className="style-median" style={{ left: position(median) }} />
      {measure.value !== null ? <span className={`style-mark style-mark-a style-anchor-${anchor(measure.value)}`} style={{ left: position(measure.value) }}><span>{name}</span></span> : null}
      {compare?.value != null ? <span className={`style-mark style-mark-b style-anchor-${anchor(compare.value)}`} style={{ left: position(compare.value) }}><span>{compareName}</span></span> : null}
    </div>
    <div className="style-strip-ends"><span>{formatStyleValue(measure.metric, measure.metric.direction === 1 ? low : high)}</span>
      <span>Median {formatStyleValue(measure.metric, median)}</span><span>{formatStyleValue(measure.metric, measure.metric.direction === 1 ? high : low)}</span></div>
    <figcaption>Each dot is one of {peers.length} eligible peers. Right is further out on the radar.</figcaption>
  </figure>
}

function ValueCard({ entity, measure, series }: { entity: StyleEntity; measure: StyleMeasure; series: 'a' | 'b' }) {
  return <div className={`style-value-card style-series-${series}`}>
    <p className="style-entity-name"><span className="style-swatch" aria-hidden="true" />{entity.name}</p>
    <p className="style-value">{formatStyleValue(measure.metric, measure.value)} {!['points', 'minutes'].includes(measure.metric.format) ? <span>{measure.metric.unit}</span> : null}</p>
    <p>{measureStatus(measure)}{measure.percentile === null ? '. No percentile is shown.' : ` among ${measure.cohortSize} eligible peers.`}</p>
    <p className="style-muted">{measure.games} of {entity.games} games have this value.</p>
  </div>
}

export function StyleAxisInspector({ entity, measure, compareEntity, compare, peers, peerLabel }: {
  entity: StyleEntity; measure: StyleMeasure; compareEntity?: StyleEntity; compare?: StyleMeasure; peers: StylePeer[]; peerLabel: string
}) {
  return <Panel className="style-inspector" id="style-inspector" aria-live="polite" aria-atomic="true" aria-labelledby="style-inspector-title">
    <h2 id="style-inspector-title">{measure.metric.label}</h2>
    <p>{measure.metric.definition}</p>
    <p className="style-muted">Peers are {peerLabel} in this scope, with at least 20 games overall and 20 with this value.</p>
    <ValueCard entity={entity} measure={measure} series="a" />
    {compareEntity && compare ? <ValueCard entity={compareEntity} measure={compare} series="b" /> : null}
    <CohortStrip peers={peers} measure={measure} compare={compare} name={entity.name} compareName={compareEntity?.name} />
    <p className="style-limit"><strong>Limit.</strong> {measure.metric.limit}</p>
  </Panel>
}
