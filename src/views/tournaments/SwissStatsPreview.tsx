import { createContext, use, useId, useMemo, type ReactNode } from 'react'
import { Alert } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { LoadingState } from '../../components/ui/loading'
import { Panel, PanelBody, PanelFooter, PanelHeader } from '../../components/ui/panel'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { worldsSamplingInterval, type SwissStatsResult } from '../../domains/tournaments/simulation'
import { cn } from '../../shared/utils'
import type { SwissStats } from './useSwissStats'

const pending = (stats: SwissStats) => !stats.blocked && (stats.state.status === 'loading' || stats.state.status === 'running')
const ready = (stats: SwissStats) => !stats.blocked && stats.state.status === 'ready' ? stats.state.result : null

export function SwissStatsBar({ stats }: { stats: SwissStats }) {
  const titleId = useId()
  const { state } = stats
  const result = ready(stats)
  return (
    <section role="region" aria-labelledby={titleId} className="grid min-w-0 max-w-4xl gap-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={titleId} className="text-sm font-semibold text-[var(--text-strong)]">Swiss stats</h3>
        {stats.blocked ? null : pending(stats)
          ? <Button variant="outline" size="sm" className="min-w-28" onClick={stats.cancel}>Cancel stats</Button>
          : result ? <Button variant="outline" size="sm" className="min-w-28" onClick={stats.cancel}>Hide stats</Button>
          : <Button variant={state.status === 'idle' ? 'default' : 'outline'} size="sm" className="min-w-28" onClick={stats.start}>{state.status === 'error' || state.status === 'cancelled' ? 'Retry stats' : 'Preview stats'}</Button>}
        <div className="flex min-h-8 min-w-56 flex-1 items-center gap-2 text-xs text-muted-foreground">
          {stats.blocked ? null
            : state.status === 'idle' ? <p>Shows each team’s chance to advance. Ratings load on request.</p>
              : state.status === 'loading' ? <LoadingState label="Loading published Power ratings." presentation="inline" delay={false} />
                : state.status === 'running' ? <div role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="sr-only">Simulating the Swiss stage.</span>
                  <progress aria-label="Swiss stats progress" className="h-1.5 min-w-12 flex-1 max-w-48 accent-[var(--primary)]" value={state.completed} max={state.total} />
                  <span className="shrink-0 font-mono tabular-nums">{state.completed.toLocaleString()} / {state.total.toLocaleString()} trials</span>
                </div>
                  : state.status === 'cancelled' ? <p role="status">Stats cancelled. No estimates are shown.</p>
                    : result ? <p role="status" className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">Chance to advance in {result.trials.toLocaleString()} trials, shown in the bracket.</p>
                      : null}
        </div>
      </div>
      <p className="text-2xs text-muted-foreground">Estimates use a uniform legal draw model, not Riot’s official draw probabilities.</p>
      {stats.blocked ? <Alert variant="warning">{stats.blocked}</Alert> : null}
      {!stats.blocked && stats.conditioned ? <Alert variant="warning">{stats.conditioned} live or partly scored series {stats.conditioned === 1 ? 'is' : 'are'} fixed to your picked winner. These estimates do not use the live score.</Alert> : null}
      {!stats.blocked && state.status === 'error' ? <Alert variant="warning" role="alert">Stats are unavailable. {state.detail}</Alert> : null}
    </section>
  )
}

type BracketOdds = { status: 'off' } | { status: 'pending' } | { status: 'ready'; teams: Map<string, SwissStatsResult['teams'][number]>; trials: number }
const OddsContext = createContext<BracketOdds>({ status: 'off' })

export function SwissOddsProvider({ stats, children }: { stats: SwissStats; children: ReactNode }) {
  const result = ready(stats)
  const isPending = pending(stats)
  const value = useMemo<BracketOdds>(() => result ? { status: 'ready', teams: new Map(result.teams.map((team) => [team.id, team])), trials: result.trials }
    : isPending ? { status: 'pending' } : { status: 'off' }, [result, isPending])
  return <OddsContext value={value}>{children}</OddsContext>
}

export function AdvanceOdds({ id, className }: { id: string; className?: string }) {
  const odds = use(OddsContext)
  if (odds.status === 'pending') return <span data-slot="skeleton" aria-hidden="true" className={cn('loading-skeleton h-3 w-7 shrink-0 rounded-sm bg-border!', className)} />
  const team = odds.status === 'ready' ? odds.teams.get(id) : undefined
  if (odds.status !== 'ready' || !team || team.fixed) return null
  const [low, high] = worldsSamplingInterval(team.advanceCount, odds.trials)
  return (
    <span title={`Advances in ${team.advanceCount.toLocaleString()} of ${odds.trials.toLocaleString()} trials. 95% sampling interval ${percent(low)} to ${percent(high)}.`}
      className={cn('shrink-0 font-mono text-2xs font-normal text-[var(--text-strong)] tabular-nums motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300', className)}>
      <span className="sr-only">, </span>{chance(team.advanceCount, odds.trials)}<span className="sr-only"> to advance</span>
    </span>
  )
}

export function SwissStatsDetails({ stats }: { stats: SwissStats }) {
  const titleId = useId()
  const result = ready(stats)
  if (!result && !pending(stats)) return null
  return (
    <Panel role="region" aria-labelledby={titleId} className="min-w-0 max-w-4xl min-[1700px]:max-w-none">
      <PanelHeader titleId={titleId} title="Advancement estimates" description={`Full-stage estimates for scenario ${stats.label}.`} />
      {result ? <StatsResults result={result} />
        : <PanelBody><LoadingState label="Computing estimates." presentation="rows" rowCount={4} delay={false} announce={false} /></PanelBody>}
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
      <p>Neutral sides. Unplayed series use independent outcomes at the current Power estimate. Ratings stay fixed. The 95% Wilson intervals measure sampling error, not model confidence. “0 sampled” and “all sampled” are not certainty. In the bracket, “&lt;” and “&gt;” give the interval bound for those cases.</p>
      <p>Sources {result.provenance.sources.join(', ') || 'unspecified'}. Data mode {result.provenance.dataMode}. Ratings through {result.provenance.ratingDataAsOf}. Published {result.provenance.publishedAt}. Snapshot {result.provenance.snapshotId}. Model {result.provenance.modelVersion}. Config {result.provenance.modelConfigHash}.</p>
    </PanelFooter>
  </div>
}

function chance(count: number, trials: number) {
  const [low, high] = worldsSamplingInterval(count, trials)
  if (count === 0) return `<${(Math.ceil(high * 1000) / 10).toFixed(1)}%`
  if (count === trials) return `>${(Math.floor(low * 1000) / 10).toFixed(1)}%`
  const value = 100 * count / trials
  if (value < 0.1) return '<0.1%'
  if (value > 99.9) return '>99.9%'
  return value < 1 || value > 99 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`
}
function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}
function estimate(count: number, trials: number, fixed: boolean) {
  if (!fixed && count === 0) return '0 sampled'
  if (!fixed && count === trials) return 'All sampled'
  return `${(100 * count / trials).toFixed(1)}%`
}
function interval(count: number, trials: number) {
  return worldsSamplingInterval(count, trials).map((value) => `${(value * 100).toFixed(2)}%`).join(' to ')
}
