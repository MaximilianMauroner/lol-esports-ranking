import { useState } from 'react'
import type { CompactPlayer } from '../lib/publicArtifacts/schema'
import { playerPerformanceMetricKeys, playerPerformanceMetrics } from '../lib/playerPerformance'
import type { PlayerPerformanceMetric } from '../types'
import { Panel, PanelBody, PanelFooter, PanelHeader } from './ui/panel'
import { Select } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

export function PlayerPerformancePanel({ players, scopeLabel }: { players: CompactPlayer[]; scopeLabel: string }) {
  const [selectedId, setSelectedId] = useState('')
  const player = players.find((entry) => entry.id === selectedId) ?? players[0]
  if (!player) return null
  const diagnostics = player.diagnostics
  const performance = diagnostics?.performance

  return (
    <Panel className="mt-5" aria-label="Observed player stats">
      <PanelHeader title="Observed player stats" description="Context for the player ratings. These additional stats do not change scores."
        actions={
          <Select aria-label="Player stats" value={player.id} onChange={(event) => setSelectedId(event.target.value)}>
            {players.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </Select>
        }
      />
      {performance && diagnostics ? (
        <>
          <PanelBody className="text-xs leading-relaxed text-muted-foreground">
            Oracle’s Elixir · {diagnostics.sampleGames} rated games in {scopeLabel} with complete role matchups.
            Averages can include previous teams and roles. They are unweighted and are not adjusted for champion, opponent, or league strength.
          </PanelBody>
          <Table aria-label={`${player.name} observed stats`}>
            <TableHeader><TableRow><TableHead>Stat</TableHead><TableHead className="text-right">Average</TableHead><TableHead className="text-right">Coverage</TableHead></TableRow></TableHeader>
            <TableBody>
              {playerPerformanceMetricKeys.map((key) => {
                const metric = performance.metrics[key]
                return (
                  <TableRow key={key}>
                    <TableCell className="whitespace-normal" title={playerPerformanceMetrics[key].description}>{playerPerformanceMetrics[key].label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMetric(key, metric.value)}</TableCell>
                    <TableCell className="text-right tabular-nums" title={`${metric.missing} games unavailable`}>
                      {metric.games}/{diagnostics.sampleGames} games
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <PanelFooter className="text-xs leading-relaxed text-muted-foreground">
            Each average uses games where that stat is available. Missing stats are unknown, never zero.
            Damage–gold gap is measured in percentage points; a higher value is not automatically better.
          </PanelFooter>
        </>
      ) : <PanelBody className="text-sm text-muted-foreground">These stats are unavailable in this player’s source snapshot.</PanelBody>}
    </Panel>
  )
}

function formatMetric(key: PlayerPerformanceMetric, value: number | null) {
  if (value === null) return 'Unavailable'
  const format = playerPerformanceMetrics[key].format
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`
  if (format === 'points') return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`
  return `${format === 'signed' && value > 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}
