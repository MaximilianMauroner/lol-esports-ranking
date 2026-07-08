import type { ChartAttributionEntry } from './chartPoints'

export type PowerComponentKey = Extract<ChartAttributionEntry['key'], 'league' | 'stable' | 'roster' | 'form' | 'context'>

export const POWER_COMPONENT_LABELS: Record<PowerComponentKey, string> = {
  league: 'League strength',
  stable: 'Team strength',
  roster: 'Roster strength',
  form: 'Recent form',
  context: 'Context edge',
}
