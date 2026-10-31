export type StyleMetric = {
  key: string
  axis: boolean
  label: string
  short?: string
  unit: string
  format: 'gold' | 'cs' | 'share' | 'points' | 'rate2' | 'rate3' | 'int' | 'minutes' | 'count'
  direction: 1 | -1
  definition: string
  limit: string
}

export const PLAYER_METRICS = [
  { key: 'goldDiffAt15', axis: true, label: 'Lane gold lead at 15', short: 'Lane gold', unit: 'gold', format: 'gold', direction: 1,
    definition: 'Average gold difference against the opposing player in the same role at 15 minutes.',
    limit: 'Some leagues do not record 15-minute values. Those games are left out, so this sample can be smaller than total games.' },
  { key: 'csPerMinute', axis: true, label: 'CS per minute', short: 'CS/min', unit: 'CS per minute', format: 'rate2', direction: 1,
    definition: 'Average minions and monsters killed per minute of game time.',
    limit: 'Shows farming volume. It does not show whether the farm was the right use of time.' },
  { key: 'damagePerMinute', axis: true, label: 'Damage per minute', short: 'Damage', unit: 'damage to champions per minute', format: 'int', direction: 1,
    definition: 'Average damage dealt to enemy champions per minute.',
    limit: 'Champion choice and team plan change this a lot. Peers are the same role only.' },
  { key: 'damageGoldShareGap', axis: true, label: 'Damage for gold', short: 'Dmg for gold', unit: 'percentage points', format: 'points', direction: 1,
    definition: 'Share of team champion damage minus share of team earned gold. Positive means a larger share of damage than of gold.',
    limit: 'Does not adjust for tanks, engage champions or utility picks.' },
  { key: 'killParticipation', axis: true, label: 'Kill participation', short: 'Kill part.', unit: 'of team kills', format: 'share', direction: 1,
    definition: 'Share of team kills where the player got the kill or an assist.',
    limit: 'Presence in kills, not the quality of the fights.' },
  { key: 'deathsPerMinute', axis: true, label: 'Survival', short: 'Survival', unit: 'deaths per minute', format: 'rate3', direction: -1,
    definition: 'Deaths per minute of game time. Fewer deaths put the point further out.',
    limit: 'Some deaths trade well for objectives. This counts deaths only.' },
  { key: 'wardsPlacedPerMinute', axis: true, label: 'Wards placed per minute', short: 'Wards placed', unit: 'wards per minute', format: 'rate2', direction: 1,
    definition: 'Wards placed per minute of game time.',
    limit: 'Ward volume only. There are no ward positions, so this is not ward quality.' },
  { key: 'wardsClearedPerMinute', axis: true, label: 'Wards cleared per minute', short: 'Wards cleared', unit: 'wards per minute', format: 'rate2', direction: 1,
    definition: 'Enemy wards destroyed per minute of game time.',
    limit: 'Clearing volume only. There are no ward positions.' },
  { key: 'xpDiffAt15', axis: false, label: 'Lane XP lead at 15', unit: 'experience', format: 'gold', direction: 1,
    definition: 'Average experience difference against the opposing player in the same role at 15 minutes.',
    limit: 'Same 15-minute coverage limit as the gold lead.' },
  { key: 'csDiffAt15', axis: false, label: 'Lane CS lead at 15', unit: 'CS', format: 'cs', direction: 1,
    definition: 'Average CS difference against the opposing player in the same role at 15 minutes.',
    limit: 'Same 15-minute coverage limit as the gold lead.' },
  { key: 'vspm', axis: false, label: 'Vision score per minute', unit: 'vision score per minute', format: 'rate2', direction: 1,
    definition: "Riot's vision score per minute. It mixes wards placed, wards cleared and how long wards stayed alive.",
    limit: 'A composite. It is not ward placement quality.' },
] as const satisfies readonly StyleMetric[]

export const TEAM_METRICS = [
  { key: 'fullTeamGoldDiffAt15', axis: true, label: 'Gold lead at 15', short: 'Gold at 15', unit: 'team gold', format: 'gold', direction: 1,
    definition: "Sum of all five players' gold difference at 15 minutes. A game counts only when all five values exist.",
    limit: 'Some leagues do not record 15-minute values. No partial sum is used.' },
  { key: 'teamKillsPerMinute', axis: true, label: 'Kills per minute', short: 'Kills/min', unit: 'team kills per minute', format: 'rate2', direction: 1,
    definition: "The team's kills divided by game minutes.",
    limit: 'A high kill pace does not show better fighting. A low kill pace does not show better macro play.' },
  { key: 'combinedKillsPerMinute', axis: true, label: 'Kills in their games', short: 'Game kills', unit: 'kills by both teams per minute', format: 'rate2', direction: 1,
    definition: "Kills by both teams per minute in this team's games. It shows how often their games have kills.",
    limit: 'Describes the games, not which team caused the action.' },
  { key: 'towersPerGame', axis: true, label: 'Towers per game', short: 'Towers', unit: 'towers per game', format: 'count', direction: 1,
    definition: 'Towers this team destroyed, per game.',
    limit: 'A raw count. It is not adjusted for game length and does not show decision quality.' },
  { key: 'dragonsPerGame', axis: true, label: 'Dragons per game', short: 'Dragons', unit: 'dragons per game', format: 'count', direction: 1,
    definition: 'Dragons this team took, per game. Elder dragons are included when the source counts them.',
    limit: 'A raw count. There are no objective times, so it does not show when they were taken.' },
  { key: 'baronsPerGame', axis: true, label: 'Barons per game', short: 'Barons', unit: 'Barons per game', format: 'count', direction: 1,
    definition: 'Barons this team took, per game.',
    limit: 'Longer games give more chances to take Baron. A raw count, not decision quality.' },
  { key: 'gameMinutes', axis: true, label: 'Average game length', short: 'Game length', unit: 'minutes', format: 'minutes', direction: 1,
    definition: 'Mean game length. Further out means longer games.',
    limit: 'Longer games do not show late-game strength. Shorter games do not show early-game strength.' },
] as const satisfies readonly StyleMetric[]

export type PlayerMetricKey = typeof PLAYER_METRICS[number]['key']
export type TeamMetricKey = typeof TEAM_METRICS[number]['key']
export type StyleMetricKey = PlayerMetricKey | TeamMetricKey
