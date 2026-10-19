import { useEffect, useId, useMemo, useState } from 'react'
import { Panel, PanelFooter, PanelHeader } from '../../components/ui/panel'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { canonicalTeamNameFor, teamCodeFor } from '../../domains/rankings/evidence'
import { estimatePublicMatchup } from '../../domains/rankings/read'
import { cn } from '../../shared/utils'
import type { RankingSummaryStanding } from '../../domains/rankings/types'
import { simulateSwissOdds, type SeriesWinChance, type SwissOdds } from '../../domains/tournaments/simulation'
import type { PreviewTeam, ResolvedScenario } from '../../domains/tournaments/simulation'
import { WORLDS_2026_SWISS_RULES } from '../../domains/tournaments/simulation'
import { loadCurrentRatingSnapshot } from '../../browser/tournaments/tournamentForecastArtifacts'

const TRIALS = 4000
const SEED = 20261023
const SETTLE_MS = 250
const WEST = ['LEC', 'LCS']

type Ratings = Awaited<ReturnType<typeof loadCurrentRatingSnapshot>>
type RatingsState = { status: 'loading' } | { status: 'ready'; ratings: Ratings } | { status: 'error'; detail: string }
type Group = { label: string; teamIds: string[] }
type Field = ReturnType<typeof ratedField>

/** Chance that each region gets at least one team through the Swiss stage, from the shown scenario. */
export function SwissRegionOdds({ teams, scenario, label }: { teams: readonly PreviewTeam[]; scenario: ResolvedScenario; label: string }) {
  const titleId = useId()
  const ratings = useCurrentRatings()
  const field = useMemo(() => ratings.status === 'ready' ? ratedField(teams, ratings.ratings) : null, [teams, ratings])
  const [result, setResult] = useState<{ field: Field; scenario: ResolvedScenario; odds: SwissOdds } | null>(null)
  // Odds from another field name other teams, so only odds for this field are shown, even while they update.
  const odds = result && result.field === field ? result : null
  useEffect(() => {
    if (!field || field.missing.length) return
    // A run blocks the page for a few hundred milliseconds, so it waits until the picks pause. Each pick shows at once.
    const timer = window.setTimeout(() => setResult({ field, scenario, odds: simulateSwissOdds(teams, scenario, field.winChance, field.groups.map((group) => group.teamIds), { trials: TRIALS, seed: SEED }) }), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [field, teams, scenario])

  let body
  if (ratings.status === 'loading') body = <p className="px-4 py-3 text-sm text-muted-foreground">Loading Power ratings.</p>
  else if (ratings.status === 'error') body = <p className="px-4 py-3 text-sm text-muted-foreground">Odds are unavailable: {ratings.detail}</p>
  else if (field?.missing.length) {
    const playIn = field.missing.find((team) => team.seed === 'PLAYIN' && team.label === 'Play-In winner')
    body = <p className="px-4 py-3 text-sm text-muted-foreground">
      {!playIn ? `No Power rating for ${field.missing.map((team) => team.label).join(', ')}.`
        : playIn.region ? `The ${playIn.region} Play-In team is not in the schedule yet, so the odds are unavailable.` : 'Choose the Play-In winner to see the odds.'}
    </p>
  } else if (!odds) body = <p className="px-4 py-3 text-sm text-muted-foreground">Simulating the Swiss stage.</p>
  else {
    const rows = field!.groups.map((group, index) => ({ ...group, any: odds.odds.anyAdvance[index] }))
      .sort((left, right) => right.any - left.any || left.label.localeCompare(right.label))
    body = (
      <Table containerClassName={cn('max-h-none transition-opacity', odds.scenario !== scenario && 'opacity-60')} aria-busy={odds.scenario !== scenario}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Region</TableHead>
            <TableHead scope="col" className="text-right">At least one out</TableHead>
            <TableHead scope="col" className="text-right">Teams out, on average</TableHead>
            <TableHead scope="col">Each team</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <th scope="row" className="p-2 text-left align-middle text-sm font-medium whitespace-nowrap text-[var(--text-strong)]">{row.label}</th>
              <TableCell className="text-right font-mono font-semibold tabular-nums">{percent(row.any)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{row.teamIds.reduce((sum, id) => sum + odds.odds.advance.get(id)!, 0).toFixed(1)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.teamIds.map((id) => ({ id, share: odds.odds.advance.get(id)! })).sort((left, right) => right.share - left.share)
                  .map(({ id, share }) => `${teamCodeFor(field!.labels.get(id)!)} ${percent(share)}`).join(' · ')}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <Panel role="region" aria-labelledby={titleId} className="min-w-0 max-w-4xl">
      <PanelHeader titleId={titleId} title="Region odds"
        description={`Chance a region gets at least one team out of the Swiss stage in scenario ${label}.`} />
      {body}
      <PanelFooter className="grid gap-1 text-xs text-muted-foreground">
        <p>
          {TRIALS.toLocaleString()} simulations from Power{ratings.status === 'ready' ? ` through ${ratings.ratings.manifest.coverage.latestMatchDate ?? 'the latest snapshot'}` : ''}, with
          draws per <a className="underline" href={WORLDS_2026_SWISS_RULES.source} target="_blank" rel="noreferrer">Riot’s rules 4.3.2 and 4.3.3</a>. Estimates, not official odds.
        </p>
        {ratings.status === 'ready' && ratings.ratings.manifest.dataMode !== 'scheduled-public-data' ? <p className="text-[var(--warn)]">The ratings are sample data, not the published Power Index.</p> : null}
      </PanelFooter>
    </Panel>
  )
}

function useCurrentRatings() {
  const [state, setState] = useState<RatingsState>({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
    loadCurrentRatingSnapshot(fetcher).then(
      (ratings) => setState({ status: 'ready', ratings }),
      (error: unknown) => { if (!controller.signal.aborted) setState({ status: 'error', detail: error instanceof Error ? error.message : String(error) }) },
    )
    return () => controller.abort()
  }, [])
  return state
}

/** Joins the preview teams to their Power ratings by team name, and groups them by region. */
function ratedField(teams: readonly PreviewTeam[], ratings: Ratings) {
  const byName = new Map(ratings.snapshot.standings.map((standing) => [canonicalTeamNameFor(standing.team), standing]))
  const rated = new Map<string, RankingSummaryStanding>()
  const missing: PreviewTeam[] = []
  for (const team of teams) {
    const standing = byName.get(canonicalTeamNameFor(team.label))
    if (standing) rated.set(team.id, standing)
    else missing.push(team)
  }
  const regions = new Map<string, string[]>()
  for (const [id, standing] of rated) regions.set(standing.region, [...regions.get(standing.region) ?? [], id])
  const groups: Group[] = [...regions].map(([region, teamIds]) => ({ label: region, teamIds }))
  const west = WEST.flatMap((region) => regions.get(region) ?? [])
  if (west.length) groups.push({ label: `West (${WEST.join(' + ')})`, teamIds: west })
  const cache = new Map<string, number>()
  const winChance: SeriesWinChance = (a, b, bestOf) => {
    const key = `${a}\n${b}\n${bestOf}`
    let chance = cache.get(key)
    if (chance === undefined) {
      chance = estimatePublicMatchup(rated.get(a)!, rated.get(b)!, ratings.manifest.model, { bestOf, sideAssumption: 'neutral' }).homeSeriesWinProbability
      cache.set(key, chance)
    }
    return chance
  }
  return { missing, groups, winChance, labels: new Map(teams.map((team) => [team.id, team.label])) }
}

function percent(value: number) {
  return `${Math.round(100 * value)}%`
}
