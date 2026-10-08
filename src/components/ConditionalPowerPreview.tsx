import { useId, useState } from 'react'
import { Select } from './ui/select'
import { conditionalOutcomeProblem, legalConditionalScores, publicConditionalPowerPreview, type ConditionalSeriesOutcome } from '../lib/conditionalPowerPreview'
import type { TournamentForecast } from '../lib/tournamentForecast'
import type { TournamentSeries } from '../lib/tournamentFeed'

export function ConditionalPowerPreview({ series, forecast, now }: { series: TournamentSeries; forecast: TournamentForecast | null; now: number }) {
  const id = useId()
  const [outcome, setOutcome] = useState<ConditionalSeriesOutcome>({ winner: 'home', loserWins: 0 })
  const scores = legalConditionalScores(series.bestOf)
  const preview = publicConditionalPowerPreview(series, outcome, forecast, now)
  const canChoose = conditionalOutcomeProblem(series, outcome, now) === null
  const winnerName = series.teams[outcome.winner === 'home' ? 0 : 1]?.name ?? 'TBD'
  return <details className="mt-2 min-w-0 border-t border-border pt-2">
    <summary className="cursor-pointer font-semibold text-foreground">Conditional Power preview</summary>
    <div className="mt-2 grid min-w-0 gap-2">
      <p>Hypothetical outcome. This does not change ratings or frozen-strength tournament simulations.</p>
      {forecast?.status === 'ready' ? <p>{series.status === 'upcoming' ? 'Current' : 'Pre-match'} Power (snapshot): {forecast.teams.map((team) => `${team.name} ${team.rating}`).join(' · ')}</p> : null}
      {canChoose ? <div className="grid grid-cols-2 gap-2">
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${id}-winner`}>Winner</label>
          <Select id={`${id}-winner`} value={outcome.winner} onChange={(event) => setOutcome({ ...outcome, winner: event.target.value === 'away' ? 'away' : 'home' })}>
            <option value="home">{series.teams[0]?.name ?? 'Home'}</option>
            <option value="away">{series.teams[1]?.name ?? 'Away'}</option>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${id}-score`}>Series score (winner first)</label>
          <Select id={`${id}-score`} value={outcome.loserWins} onChange={(event) => setOutcome({ ...outcome, loserWins: Number(event.target.value) })}>
            {scores.map((score) => <option key={score} value={score}>{(series.bestOf! + 1) / 2}–{score}</option>)}
          </Select>
        </div>
      </div> : null}
      <p role="status">{canChoose ? `${winnerName} wins ${(series.bestOf! + 1) / 2}–${outcome.loserWins}. ` : ''}Power delta unavailable: {preview.detail}</p>
      <p>No future inputs are held fixed in this public view. {forecast?.status === 'ready' ? 'Power and its model, snapshot and date are shown separately above.' : 'Current Power and its provenance need a valid rating snapshot.'}</p>
      <a href="#matches" className="underline">Power scope and actual rating impact</a>
    </div>
  </details>
}
