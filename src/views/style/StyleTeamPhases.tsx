import { Badge } from '../../components/ui/badge'
import { Panel, PanelHeader } from '../../components/ui/panel'
import { DURATION_BINS, type StyleMeasure, type TeamStyleRow } from '../../domains/style/profile'
import { formatStyleValue } from './presentation'

export function StyleTeamPhases({ teams, measures }: { teams: TeamStyleRow[]; measures: StyleMeasure[][] }) {
  return <Panel>
    <PanelHeader title="By game phase" description="Measured early gold and recorded results by game length." />
    <div className="style-phase-grid">
      <section className="style-phase"><h3>First 15 minutes</h3><Badge>Gold lead at 15</Badge>
        {teams.map((team, i) => {
          const earlyGold = measures[i].find(measure => measure.metric.key === 'fullTeamGoldDiffAt15')
          return <p key={team.id}><strong>{team.name}</strong> {earlyGold
            ? <>{formatStyleValue(earlyGold.metric, earlyGold.value)} gold. {earlyGold.games} of {team.games} games.</>
            : 'Gold lead at 15 not recorded.'}</p>
        })}
      </section>
      <section className="style-phase"><h3>After 15 minutes</h3><Badge variant="warning">Not in these records</Badge>
        <p>Kills and objectives are whole-game totals. There are no later gold timelines or objective times to split them by phase.</p>
      </section>
      <section className="style-phase style-phase-wide"><h3>Results by game length</h3>
        {teams.map(team => <div key={team.id} className="style-duration-team"><h4>{team.name}</h4>
          {DURATION_BINS.map(bin => {
            const result = team.durationWins[bin.key]
            return <div key={bin.key} className="style-duration-row"><span>{bin.label}</span>
              <span className="style-duration-bar" aria-hidden="true">{result ? <span style={{ width: `${100 * result[0] / result[1]}%` }} /> : null}</span>
              <span>{result ? `${result[0]} won, ${result[1] - result[0]} lost, ${Math.round(100 * result[0] / result[1])}%` : 'No games'} {result && result[1] < 10 ? <Badge variant="warning">Small sample</Badge> : null}</span></div>
          })}
        </div>)}
        <p className="style-muted">These are results in games that ended in each length band. Wins in long games do not prove late-game strength. Game length depends on both teams.</p>
      </section>
    </div>
  </Panel>
}
