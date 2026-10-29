import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowLeftRight, ArrowRight } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Panel, PanelHeader } from '../../components/ui/panel'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import type { StyleMeasure } from '../../domains/style/profile'
import { formatStyleValue, measureStatus } from './presentation'

export function StyleMeasuresTable({ measures, compare, name, compareName, selected, onSelect, peerLabel }: {
  measures: StyleMeasure[]; compare?: StyleMeasure[]; name: string; compareName?: string; selected: string; onSelect: (key: string) => void; peerLabel: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollHintId = useId()
  const [scrollDirections, setScrollDirections] = useState({ left: false, right: false })
  const hasOverflow = scrollDirections.left || scrollDirections.right
  const ScrollIcon = scrollDirections.left ? scrollDirections.right ? ArrowLeftRight : ArrowLeft : ArrowRight

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateScrollDirections = () => {
      const left = container.scrollLeft > 1
      const right = container.scrollWidth - container.clientWidth - container.scrollLeft > 1
      setScrollDirections(current => current.left === left && current.right === right ? current : { left, right })
    }
    updateScrollDirections()
    const observer = new ResizeObserver(updateScrollDirections)
    observer.observe(container)
    if (container.firstElementChild) observer.observe(container.firstElementChild)
    container.addEventListener('scroll', updateScrollDirections, { passive: true })
    return () => {
      observer.disconnect()
      container.removeEventListener('scroll', updateScrollDirections)
    }
  }, [measures, compare, name, compareName])

  return <Panel className="style-table-panel">
    <PanelHeader title="All measures" description={`Per-game averages in this scope. Percentiles compare with ${peerLabel}. Each needs 20 games with the value.`} />
    {hasOverflow ? <p className="style-table-scroll-hint" id={scrollHintId}><ScrollIcon size={14} aria-hidden="true" />Scroll horizontally to see more columns.</p> : null}
    <Table aria-label="Style profile measures" className="style-table" data-comparison={Boolean(compare)} containerRef={containerRef} containerClassName="style-table-scroll"
      containerProps={{ role: 'region', 'aria-label': 'All measures', 'aria-describedby': hasOverflow ? scrollHintId : undefined, tabIndex: hasOverflow ? 0 : undefined }}>
      <TableHeader><TableRow><TableHead className="style-col-measure">Measure</TableHead><TableHead className="style-num style-col-value">{name}</TableHead><TableHead className="style-num style-col-percentile">Percentile</TableHead>
        <TableHead className="style-num style-col-games">Coverage</TableHead>{compare ? <><TableHead className="style-num style-col-value">{compareName}</TableHead><TableHead className="style-num style-col-percentile">Percentile</TableHead><TableHead className="style-num style-col-games">Coverage</TableHead></> : null}</TableRow></TableHeader>
      <TableBody>{measures.map((m, i) => <TableRow key={m.metric.key} data-selected={m.metric.key === selected}>
        <TableHead scope="row" className="style-row-name style-col-measure"><Button variant="link" className="style-row-axis" onClick={() => onSelect(m.metric.key)}
          aria-pressed={m.metric.key === selected} aria-controls="style-inspector">{m.metric.label}</Button>{!m.metric.axis ? <Badge>Table only</Badge> : null}</TableHead>
        <TableCell className="style-num style-col-value">{formatStyleValue(m.metric, m.value)}</TableCell><TableCell className="style-num style-col-percentile style-status style-muted">{measureStatus(m)}</TableCell>
        <TableCell className="style-num style-col-games">{m.games}</TableCell>
        {compare ? <><TableCell className="style-num style-col-value">{formatStyleValue(compare[i].metric, compare[i].value)}</TableCell><TableCell className="style-num style-col-percentile style-status style-muted">{measureStatus(compare[i])}</TableCell><TableCell className="style-num style-col-games">{compare[i].games}</TableCell></> : null}
      </TableRow>)}</TableBody>
    </Table>
  </Panel>
}
