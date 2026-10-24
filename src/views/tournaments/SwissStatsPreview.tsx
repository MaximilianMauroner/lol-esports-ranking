import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { startSwissStats, type SwissStatsState } from '../../browser/tournaments/swissStatsClient'
import { Alert } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { LoadingState } from '../../components/ui/loading'
import { Panel, PanelBody, PanelFooter, PanelHeader } from '../../components/ui/panel'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import type { TournamentEvent } from '../../domains/tournaments/read'
import { swissStatsConditioning, worldsSamplingInterval, type PreviewTeam, type ResolvedScenario, type SwissStatsResult } from '../../domains/tournaments/simulation'

export function SwissStatsPreview({ teams, scenario, event, label }: { teams: PreviewTeam[]; scenario: ResolvedScenario; event: TournamentEvent; label: string }) {
  const titleId = useId()
  const conditioning = useMemo(() => swissStatsConditioning(event, teams, scenario), [event, teams, scenario])
  const inputKey = JSON.stringify([teams, scenario.rounds.map((round) => [round.round, round.matches]), label, conditioning])
  const stop = useRef<(() => void) | null>(null)
  const [request, setRequest] = useState({ enabled: false, attempt: 0 })
  const [saved, setSaved] = useState<{ key: string; state: SwissStatsState }>({ key: inputKey, state: { status: 'idle' } })
  const state: SwissStatsState = saved.key === inputKey ? saved.state : request.enabled ? { status: 'loading' } : { status: 'idle' }
  useEffect(() => {
    if (!request.enabled) return
    if (conditioning.blocked) return
    stop.current = startSwissStats(teams, scenario, (state) => setSaved({ key: inputKey, state }))
    return () => { stop.current?.(); stop.current = null }
  }, [request, inputKey, teams, scenario, conditioning.blocked])
  const pending = state.status === 'loading' || state.status === 'running'
  const start = () => setRequest((previous) => ({ enabled: true, attempt: previous.attempt + 1 }))
  const cancel = () => {
    stop.current?.()
    setRequest((previous) => ({ ...previous, enabled: false }))
    setSaved({ key: inputKey, state: { status: 'cancelled' } })
  }
  return (
    <Panel role="region" aria-labelledby={titleId} className="min-w-0 max-w-4xl">
      <PanelHeader titleId={titleId} title="Swiss stats" description={`Full-stage advancement estimates for scenario ${label}.`} />
      <PanelBody className="grid gap-3">
        <p className="text-sm text-muted-foreground">Estimates use a uniform legal draw model, not Riot’s official draw probabilities.</p>
        {conditioning.blocked ? <Alert variant="warning">{conditioning.blocked}</Alert> : <>
          {conditioning.conditioned ? <Alert variant="warning">{conditioning.conditioned} live or partly scored series {conditioning.conditioned === 1 ? 'is' : 'are'} fixed to your picked winner. These estimates do not use the live score.</Alert> : null}
          <div className="flex flex-wrap gap-2">
            {pending ? <Button variant="outline" onClick={cancel}>Cancel stats</Button>
              : <Button variant="outline" onClick={start}>{state.status === 'error' || state.status === 'cancelled' ? 'Retry stats' : 'Preview stats'}</Button>}
          </div>
          {state.status === 'idle' ? <p className="text-xs text-muted-foreground">Ratings load only after you request stats. You can keep editing the bracket during a run.</p> : null}
          {state.status === 'loading' ? <LoadingState label="Loading published Power ratings." presentation="rows" rowCount={3} delay={false} /> : null}
          {state.status === 'running' ? <div className="grid gap-2" role="status" aria-live="polite">
            <LoadingState label="Simulating the Swiss stage." presentation="inline" delay={false} />
            <progress aria-label="Swiss stats progress" className="h-2 w-full accent-[var(--primary)] motion-safe:transition-all motion-reduce:transition-none" value={state.completed} max={state.total} />
            <p className="font-mono text-xs text-muted-foreground tabular-nums">{state.completed.toLocaleString()} / {state.total.toLocaleString()} trials complete</p>
          </div> : null}
          {state.status === 'error' ? <Alert variant="warning" role="alert">Stats are unavailable. {state.detail}</Alert> : null}
          {state.status === 'cancelled' ? <p role="status" className="text-sm text-muted-foreground">Stats cancelled. No estimates are shown.</p> : null}
        </>}
      </PanelBody>
      {!conditioning.blocked && state.status === 'ready' ? <StatsResults result={state.result} /> : null}
    </Panel>
  )
}

function StatsResults({ result }: { result: SwissStatsResult }) {
  const teams = [...result.teams].sort((a, b) => b.advanceCount - a.advanceCount || a.label.localeCompare(b.label))
  return <div className="min-w-0 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300 motion-reduce:animate-none">
    {result.provenance.dataMode !== 'scheduled-public-data' ? <PanelBody><Alert variant="warning">The ratings are sample data, not the published Power Index. These estimates are not official LoL Esports data.</Alert></PanelBody> : null}
    <Table aria-label="Team advancement" className="table-fixed [&_th]:[overflow-wrap:anywhere]" containerClassName="max-h-none">
      <TableHeader><TableRow><TableHead className="w-2/5 whitespace-normal">Team</TableHead><TableHead className="whitespace-normal">Advance</TableHead><TableHead className="whitespace-normal">95% interval</TableHead></TableRow></TableHeader>
      <TableBody>{teams.map((team) => <TableRow key={team.id}>
        <th scope="row" className="break-words p-2 text-left font-medium">{team.label}<span className="block text-2xs text-muted-foreground">{team.region}</span></th>
        <TableCell className="whitespace-normal font-mono tabular-nums">{estimate(team.advanceCount, result.trials, team.fixed !== null)}{team.fixed ? <span className="block font-sans text-2xs text-muted-foreground">Fixed {team.fixed}</span> : null}</TableCell>
        <TableCell className="whitespace-normal font-mono text-2xs tabular-nums">{team.fixed ? 'Fixed' : interval(team.advanceCount, result.trials)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
    <Table aria-label="Region advancement" className="table-fixed [&_th]:[overflow-wrap:anywhere]" containerClassName="max-h-none">
      <TableHeader><TableRow><TableHead className="whitespace-normal">Region</TableHead><TableHead className="whitespace-normal">At least one advances</TableHead><TableHead className="whitespace-normal">Expected qualifiers</TableHead></TableRow></TableHeader>
      <TableBody>{result.regions.map((region) => {
        const fixed = result.teams.some((team) => region.teamIds.includes(team.id) && team.fixed === 'advanced')
          || result.teams.filter((team) => region.teamIds.includes(team.id)).every((team) => team.fixed === 'eliminated')
        return <TableRow key={region.region}>
          <th scope="row" className="p-2 text-left font-medium">{region.region}</th>
          <TableCell className="whitespace-normal font-mono tabular-nums">{estimate(region.anyAdvanceCount, result.trials, fixed)}<span className="block text-2xs text-muted-foreground">{fixed ? 'Fixed' : interval(region.anyAdvanceCount, result.trials)}</span></TableCell>
          <TableCell className="whitespace-normal font-mono tabular-nums">{(region.qualifierCount / result.trials).toFixed(2)}</TableCell>
        </TableRow>
      })}</TableBody>
    </Table>
    <PanelFooter className="grid gap-2 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <p>{result.trials.toLocaleString()} trials. Seed {result.seed}. Draw model {result.drawModel}. {result.fixedDraws} drawn rounds and {result.fixedResults} observed results or picks stay fixed. {result.modelledDraws} future draws use the hypothetical model.</p>
      <p>Neutral sides. Unplayed series use independent outcomes at the current Power estimate. Ratings stay fixed. The 95% Wilson intervals measure sampling error, not model confidence. “0 sampled” and “all sampled” are not certainty.</p>
      <p>Sources {result.provenance.sources.join(', ') || 'unspecified'}. Data mode {result.provenance.dataMode}. Ratings through {result.provenance.ratingDataAsOf}. Published {result.provenance.publishedAt}. Snapshot {result.provenance.snapshotId}. Model {result.provenance.modelVersion}. Config {result.provenance.modelConfigHash}.</p>
    </PanelFooter>
  </div>
}

function estimate(count: number, trials: number, fixed: boolean) {
  if (!fixed && count === 0) return '0 sampled'
  if (!fixed && count === trials) return 'All sampled'
  return `${(100 * count / trials).toFixed(1)}%`
}
function interval(count: number, trials: number) {
  return worldsSamplingInterval(count, trials).map((value) => `${(value * 100).toFixed(2)}%`).join(' to ')
}
