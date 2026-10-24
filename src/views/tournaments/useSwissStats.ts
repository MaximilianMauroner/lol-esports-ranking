import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { startSwissStats, type SwissStatsState } from '../../browser/tournaments/swissStatsClient'
import type { TournamentEvent } from '../../domains/tournaments/read'
import { swissStatsConditioning, type PreviewTeam, type ResolvedScenario } from '../../domains/tournaments/simulation'

export type SwissStats = {
  blocked: string | null
  conditioned: number
  state: SwissStatsState
  label: string
  start: () => void
  cancel: () => void
}

export function useSwissStats(teams: PreviewTeam[], scenario: ResolvedScenario, event: TournamentEvent, label: string, active: boolean): SwissStats {
  const { blocked, conditioned } = useMemo(() => swissStatsConditioning(event, teams, scenario), [event, teams, scenario])
  const inputKey = JSON.stringify([teams, scenario.rounds.map((round) => [round.round, round.matches]), label, blocked, conditioned])
  const stop = useRef<(() => void) | null>(null)
  const [request, setRequest] = useState({ enabled: false, attempt: 0 })
  const [saved, setSaved] = useState<{ key: string; state: SwissStatsState }>({ key: inputKey, state: { status: 'idle' } })
  const state: SwissStatsState = saved.key === inputKey ? saved.state : request.enabled ? { status: 'loading' } : { status: 'idle' }
  const beginRun = useEffectEvent((key: string) => startSwissStats(teams, scenario, (state) => setSaved({ key, state })))
  useEffect(() => {
    if (!request.enabled || !active || blocked) return
    stop.current = beginRun(inputKey)
    return () => { stop.current?.(); stop.current = null }
  }, [request, inputKey, blocked, active])
  return {
    blocked, conditioned, state, label,
    start: () => setRequest((previous) => ({ enabled: true, attempt: previous.attempt + 1 })),
    cancel: () => {
      stop.current?.()
      setRequest((previous) => ({ ...previous, enabled: false }))
      setSaved({ key: inputKey, state: { status: 'cancelled' } })
    },
  }
}
