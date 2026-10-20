import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConditionalPowerResultLedger } from '../../domains/tournaments/forecast'
import { emptyForecastLedger, type ForecastBasis, type ForecastLedger } from '../../domains/tournaments/forecast'
import { isTournamentFeed, type TournamentFeed } from '../../domains/tournaments/read'
import { hashParam } from '../navigation'
import { resolveEventLink } from './eventAddress'
import { cacheTournamentFeed, readCachedTournamentFeed } from './tournamentFeedCache'
import { loadTournamentForecastArtifacts, loadTournamentForecastLedger } from './tournamentForecastArtifacts'


type FeedHealth = { checkedAt: string; complete: boolean; warnings: string[] }
type FeedState = { status: 'loading' } | { status: 'ready'; feed: TournamentFeed; health: FeedHealth | null; healthPending: boolean; error?: string } | { status: 'error'; message: string }
export const REFRESH_MS = 60_000
export const FORECASTS_ENABLED = import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED === '1'
export type ForecastArtifacts = { basis: ForecastBasis | null; ledger: ForecastLedger; powerPreviews?: ConditionalPowerResultLedger | null; reason?: string; ledgerWarning?: string }


export function useTournamentResources() {
  const [state, setState] = useState<FeedState>(() => {
    const cached = readCachedTournamentFeed()
    const requestedEvent = hashParam('event')
    const link = resolveEventLink(cached?.events ?? [], requestedEvent)
    return cached && (link.kind === 'absent' || link.kind === 'resolved')
      ? { status: 'ready', feed: cached, health: null, healthPending: true }
      : { status: 'loading' }
  })
  const [now, setNow] = useState(() => Date.now())
  const [forecastArtifacts, setForecastArtifacts] = useState<ForecastArtifacts>({ basis: null, ledger: emptyForecastLedger, reason: 'Forecast inputs are loading.' })
  const refreshSequence = useRef(0)
  const refreshController = useRef<AbortController | null>(null)
  const basisLoading = useRef(false)
  const basisNextRefreshAt = useRef(0)
  const basisGeneration = useRef(0)

  useEffect(() => {
    const generationRef = basisGeneration
    return () => { ++generationRef.current }
  }, [])

  const refreshBasisIfDue = useCallback(() => {
    if (!FORECASTS_ENABLED || basisLoading.current || Date.now() < basisNextRefreshAt.current) return
    basisLoading.current = true
    const generation = basisGeneration.current
    void loadTournamentForecastArtifacts().then((loaded) => {
      basisLoading.current = false
      if (generation !== basisGeneration.current) {
        basisNextRefreshAt.current = 0
        return
      }
      basisNextRefreshAt.current = Date.now() + (loaded.basis ? 10 * REFRESH_MS : REFRESH_MS)
      setForecastArtifacts((previous) => ({ ...previous, ...loaded }))
    })
  }, [])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    // Requests in this visible lifetime share cancellation; sequence guards
    // still prevent an older manual refresh from replacing a newer result.
    const controller = refreshController.current?.signal.aborted === false ? refreshController.current : new AbortController()
    refreshController.current = controller
    setNow(Date.now())
    refreshBasisIfDue()
    try {
      const response = await fetch('/tournament-data/feed.json', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      if (!response.ok) throw new Error(`Tournament feed returned HTTP ${response.status}`)
      const body: unknown = await response.json()
      if (!isTournamentFeed(body)) throw new Error('Tournament feed schema is unsupported or incomplete')
      if (sequence !== refreshSequence.current) return
      cacheTournamentFeed(body)
      setState((previous) => ({ status: 'ready', feed: body, health: previous.status === 'ready' ? previous.health : null, healthPending: true }))
      const healthResponse = await fetch('/tournament-data/feed.json.health.json', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) }).catch(() => null)
      const healthBody: unknown = healthResponse?.ok ? await healthResponse.json().catch(() => null) : null
      const health = isHealth(healthBody) ? healthBody : null
      if (sequence !== refreshSequence.current) return
      setState((previous) => previous.status === 'ready' && previous.feed === body ? { ...previous, health, healthPending: false } : previous)
      if (FORECASTS_ENABLED) {
        try {
          const ledger = await loadTournamentForecastLedger()
          if (sequence !== refreshSequence.current) return
          setForecastArtifacts((previous) => ({ ...previous, ledger, ledgerWarning: undefined }))
        } catch {
          if (sequence !== refreshSequence.current) return
          setForecastArtifacts((previous) => ({ ...previous, ledgerWarning: 'Forecast receipt check failed; showing the last valid ledger.' }))
        }
      }
    } catch (error) {
      if (sequence !== refreshSequence.current) return
      const message = error instanceof Error ? error.message : String(error)
      setState((previous) => previous.status === 'ready' ? { ...previous, healthPending: false, error: message } : { status: 'error', message })
    }
  }, [refreshBasisIfDue])
  useEffect(() => {
    const sequenceRef = refreshSequence
    const controllerRef = refreshController
    let refreshTimer: number | undefined
    function updateVisibility() {
      window.clearInterval(refreshTimer)
      if (document.visibilityState === 'hidden') {
        ++sequenceRef.current
        controllerRef.current?.abort()
        return
      }
      void refresh()
      refreshTimer = window.setInterval(() => { void refresh() }, REFRESH_MS)
    }
    const initialTimer = window.setTimeout(updateVisibility, 0)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      ++sequenceRef.current
      controllerRef.current?.abort()
      window.clearTimeout(initialTimer)
      window.clearInterval(refreshTimer)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [refresh])

  return { state, now, forecastArtifacts, refresh }
}

function isHealth(value: unknown): value is FeedHealth {
  if (!value || typeof value !== 'object') return false
  const health = value as Partial<FeedHealth>
  return typeof health.checkedAt === 'string' && typeof health.complete === 'boolean' && Array.isArray(health.warnings)
}
