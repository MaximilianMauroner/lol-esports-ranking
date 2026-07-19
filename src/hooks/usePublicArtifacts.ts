import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PublicPlayerDirectory,
  PublicRankingManifest,
  PublicRegionHistoryDirectory,
  PublicRegionHistoryScope,
  PublicTeamHistoryDirectory,
  PublicTeamHistoryIndex,
  PublicTeamHistoryShard,
  PublicTournamentMovementIndex,
  PublicTournamentMovementIndexEntry,
  PublicTournamentMovementShard,
  PublicMatchHistoryCatalog,
  PublicMatchHistoryIndex,
  PublicMatchHistoryPage,
  SnapshotCheckpointOption,
  SnapshotFilter,
} from '../lib/publicArtifacts/schema'
import {
  parsePublicPlayerDirectory,
  parsePublicRegionHistory,
  parsePublicTeamHistory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  parsePublicMatchHistoryCatalog,
  parsePublicMatchHistoryIndex,
  parsePublicMatchHistoryPage,
  snapshotKey,
} from '../lib/publicArtifacts/schema'
import {
  fetchPublicSnapshotShard,
  resolvePublicSnapshotState,
  validatePublicTeamHistoryShard,
  validatePublicTournamentMovementIndex,
  validatePublicTournamentMovementShard,
  type PublicSnapshotCacheEntry,
} from '../lib/publicArtifacts/resolver'
import { tournamentEntriesForScope, type TournamentInstanceId } from '../lib/internationalTournaments'
import { createPublicRankingManifestLoader } from '../lib/publicArtifacts/manifestLoader'
import { normalizeExternalRankingManifestUrl, resolvePublicArtifactUrl } from '../lib/publicArtifacts/url'

export type PublicArtifactState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

export type TeamHistoryArtifact = PublicTeamHistoryDirectory | PublicTeamHistoryShard
export type TeamHistoryArtifactState = PublicArtifactState<TeamHistoryArtifact>
export type PlayerDirectoryState = PublicArtifactState<PublicPlayerDirectory>
export type RegionHistoryScopeState = PublicArtifactState<PublicRegionHistoryScope>
export type TournamentMovementIndexState = PublicArtifactState<PublicTournamentMovementIndex>
export type TournamentMovementState = PublicArtifactState<PublicTournamentMovementShard>
export type MatchHistoryPageState = PublicArtifactState<PublicMatchHistoryPage>
export type MatchHistoryState = PublicArtifactState<{
  catalog: PublicMatchHistoryCatalog
  pages: Record<number, MatchHistoryPageState>
}>

type TeamHistoryRoot = PublicTeamHistoryDirectory | PublicTeamHistoryIndex
type PublicArtifactLoadOptions = {
  initialManifest?: PublicRankingManifest
  initialManifestError?: string
  loadPlayers?: boolean
  loadTeamHistory?: boolean
  loadRegionHistory?: boolean
  loadTournamentMovements?: boolean
  loadMatchHistory?: boolean
  tournamentId?: TournamentInstanceId
}

type TeamHistoryCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; shard: PublicTeamHistoryShard }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

type TournamentMovementCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; shard: PublicTournamentMovementShard }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

const DATA_URL = normalizeExternalRankingManifestUrl(import.meta.env.VITE_RANKING_DATA_URL)
const PLAYERS_URL = import.meta.env.VITE_PLAYER_DATA_URL || '/data/entities/players.json'
const TEAM_HISTORY_INDEX_URL = import.meta.env.VITE_TEAM_HISTORY_INDEX_URL || import.meta.env.VITE_TEAM_HISTORY_URL || '/data/history/team-series/index.json'
const REGION_HISTORY_URL = import.meta.env.VITE_REGION_HISTORY_URL || '/data/history/region-series.json'
const TOURNAMENT_MOVEMENT_INDEX_URL = import.meta.env.VITE_TOURNAMENT_MOVEMENT_INDEX_URL || '/data/history/tournament-moves/index.json'
const MATCH_HISTORY_INDEX_URL = import.meta.env.VITE_MATCH_HISTORY_INDEX_URL || '/data/matches/index.json'

export const loadPublicRankingManifest = createPublicRankingManifestLoader(DATA_URL)

export function usePublicArtifacts(scope: string, options: PublicArtifactLoadOptions = {}) {
  const {
    initialManifest,
    initialManifestError,
    loadPlayers = false,
    loadTeamHistory = false,
    loadRegionHistory = false,
    loadTournamentMovements = false,
    loadMatchHistory = false,
    tournamentId,
  } = options
  const [manifestState, setManifestState] = useState<PublicArtifactState<PublicRankingManifest>>(
    initialManifest
      ? { status: 'ready', data: initialManifest }
      : initialManifestError
        ? { status: 'error', message: initialManifestError }
        : { status: 'loading' },
  )
  const [playersState, setPlayersState] = useState<PlayerDirectoryState>({ status: 'idle' })
  const [teamHistoryRootState, setTeamHistoryRootState] = useState<PublicArtifactState<TeamHistoryRoot>>({ status: 'idle' })
  const [teamHistoryCache, setTeamHistoryCache] = useState<Record<string, TeamHistoryCacheEntry>>({})
  const teamHistoryCacheRef = useRef(teamHistoryCache)
  const [regionHistoryState, setRegionHistoryState] = useState<PublicArtifactState<PublicRegionHistoryDirectory>>({ status: 'idle' })
  const [tournamentMovementIndexState, setTournamentMovementIndexState] = useState<TournamentMovementIndexState>({ status: 'idle' })
  const [tournamentMovementIndexAttempt, setTournamentMovementIndexAttempt] = useState(0)
  const [tournamentMovementCache, setTournamentMovementCache] = useState<Record<string, TournamentMovementCacheEntry>>({})
  const tournamentMovementCacheRef = useRef(tournamentMovementCache)
  const [snapshotCache, setSnapshotCache] = useState<Record<string, PublicSnapshotCacheEntry>>({})
  const [matchHistoryIndexState, setMatchHistoryIndexState] = useState<PublicArtifactState<PublicMatchHistoryIndex>>({ status: 'idle' })
  const [matchHistoryCatalogState, setMatchHistoryCatalogState] = useState<PublicArtifactState<PublicMatchHistoryCatalog>>({ status: 'idle' })
  const [matchHistoryPages, setMatchHistoryPages] = useState<Record<number, MatchHistoryPageState>>({})
  const matchHistoryCatalogRef = useRef<PublicMatchHistoryCatalog | undefined>(undefined)
  const matchHistoryPagesRef = useRef(matchHistoryPages)
  const snapshotCacheRef = useRef(snapshotCache)

  const data = manifestState.status === 'ready' ? manifestState.data : undefined
  const effectiveScope = useMemo(() => (data ? normalizeScopeForData(scope, data) : scope), [data, scope])
  const filter = useMemo(() => scopeToFilter(effectiveScope), [effectiveScope])
  const snapshotState = useMemo(
    () => resolvePublicSnapshotState(data, filter, snapshotCache),
    [data, filter, snapshotCache],
  )
  const teamHistoryState = useMemo(
    () => requestedState(loadTeamHistory, resolveTeamHistoryState(teamHistoryRootState, teamHistoryCache, filter, effectiveScope)),
    [effectiveScope, filter, loadTeamHistory, teamHistoryCache, teamHistoryRootState],
  )
  const scopedRegionHistoryState = useMemo(
    () => requestedState(loadRegionHistory, resolveRegionHistoryState(regionHistoryState, filter, effectiveScope)),
    [effectiveScope, filter, loadRegionHistory, regionHistoryState],
  )
  const seasonYears = useMemo(() => (data ? orderedSeasonYears(data) : []), [data])
  const tournamentMovementEntries = useMemo(
    () => tournamentMovementIndexState.status === 'ready' && data
      ? compatibleTournamentMovementEntries(tournamentMovementIndexState.data.tournaments, filter, data)
      : [],
    [data, filter, tournamentMovementIndexState],
  )
  const tournamentMovementState = useMemo<TournamentMovementState>(
    () => resolveTournamentMovementState(tournamentMovementIndexState, tournamentMovementCache, tournamentId),
    [tournamentId, tournamentMovementCache, tournamentMovementIndexState],
  )
  const matchHistoryState = useMemo<MatchHistoryState>(() => (
    matchHistoryCatalogState.status === 'ready'
      ? { status: 'ready', data: { catalog: matchHistoryCatalogState.data, pages: matchHistoryPages } }
      : requestedState(loadMatchHistory, matchHistoryCatalogState)
  ), [loadMatchHistory, matchHistoryCatalogState, matchHistoryPages])

  useEffect(() => {
    if (initialManifest || initialManifestError) return
    let active = true
    async function load() {
      try {
        const next = await loadPublicRankingManifest()
        if (!active) return
        setManifestState({ status: 'ready', data: next })
      } catch (error) {
        if (!active) return
        setManifestState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load snapshot' })
      }
    }
    void load()
    return () => { active = false }
  }, [initialManifest, initialManifestError])

  useEffect(() => {
    if (!data || !loadPlayers) return
    const controller = new AbortController()
    const url = resolveArtifactUrl(data.playerDirectoryUrl ?? PLAYERS_URL, DATA_URL)
    setPlayersState({ status: 'loading' })
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) {
          setPlayersState({ status: response.status === 404 ? 'missing' : 'error', message: `Player artifact failed with ${response.status}` })
          return
        }
        setPlayersState({ status: 'ready', data: parsePublicPlayerDirectory(await response.json()) })
      } catch (error) {
        if (isAbortError(error)) return
        setPlayersState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load players' })
      }
    }
    void load()
    return () => controller.abort()
  }, [data, loadPlayers])

  useEffect(() => {
    if (!data || !loadTeamHistory) return
    const controller = new AbortController()
    const url = resolveArtifactUrl(data.teamHistoryIndexUrl ?? data.teamHistoryUrl ?? TEAM_HISTORY_INDEX_URL, DATA_URL)
    setTeamHistoryRootState({ status: 'loading' })
    setTeamHistoryCache({})
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) {
          setTeamHistoryRootState({ status: response.status === 404 ? 'missing' : 'error', message: `Team history artifact failed with ${response.status}` })
          return
        }
        const artifact = await response.json()
        if (artifact?.artifactKind === 'team-history') {
          setTeamHistoryRootState({ status: 'ready', data: parsePublicTeamHistory(artifact) })
          return
        }
        setTeamHistoryRootState({ status: 'ready', data: parsePublicTeamHistoryIndex(artifact) })
      } catch (error) {
        if (isAbortError(error)) return
        setTeamHistoryRootState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load team history' })
      }
    }
    void load()
    return () => controller.abort()
  }, [data, loadTeamHistory])

  useEffect(() => {
    if (!data || !loadRegionHistory) return
    const controller = new AbortController()
    const url = resolveArtifactUrl(data.regionHistoryUrl ?? REGION_HISTORY_URL, DATA_URL)
    setRegionHistoryState({ status: 'loading' })
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) {
          setRegionHistoryState({ status: response.status === 404 ? 'missing' : 'error', message: `Region history artifact failed with ${response.status}` })
          return
        }
        setRegionHistoryState({ status: 'ready', data: parsePublicRegionHistory(await response.json()) })
      } catch (error) {
        if (isAbortError(error)) return
        setRegionHistoryState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load region history' })
      }
    }
    void load()
    return () => controller.abort()
  }, [data, loadRegionHistory])

  useEffect(() => {
    if (!data || !loadTournamentMovements) return
    const manifest = data
    const controller = new AbortController()
    const url = resolveArtifactUrl(manifest.tournamentMovementIndexUrl ?? TOURNAMENT_MOVEMENT_INDEX_URL, DATA_URL)
    setTournamentMovementIndexState({ status: 'loading' })
    setTournamentMovementCache({})
    tournamentMovementCacheRef.current = {}
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-cache', headers: { Accept: 'application/json' } })
        if (!response.ok) {
          setTournamentMovementIndexState({
            status: response.status === 404 ? 'missing' : 'error',
            message: `Tournament movement index failed with ${response.status}`,
          })
          return
        }
        const next = parsePublicTournamentMovementIndex(await response.json())
        validatePublicTournamentMovementIndex(next, manifest)
        setTournamentMovementIndexState({ status: 'ready', data: next })
      } catch (error) {
        if (isAbortError(error)) return
        setTournamentMovementIndexState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load tournament movement index' })
      }
    }
    void load()
    return () => controller.abort()
  }, [data, loadTournamentMovements, tournamentMovementIndexAttempt])

  useEffect(() => {
    if (!data || !loadMatchHistory) return
    const manifest = data
    const controller = new AbortController()
    setMatchHistoryIndexState({ status: 'loading' })
    async function load() {
      try {
        const response = await fetch(resolveArtifactUrl(manifest.matchHistoryIndexUrl ?? MATCH_HISTORY_INDEX_URL, DATA_URL), {
          signal: controller.signal,
          cache: 'no-cache',
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) {
          setMatchHistoryIndexState({ status: response.status === 404 ? 'missing' : 'error', message: `Match history index failed with ${response.status}` })
          return
        }
        const index = parsePublicMatchHistoryIndex(await response.json())
        validateMatchHistoryRun(index, manifest)
        setMatchHistoryIndexState({ status: 'ready', data: index })
      } catch (error) {
        if (isAbortError(error)) return
        setMatchHistoryIndexState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load match history index' })
      }
    }
    void load()
    return () => controller.abort()
  }, [data, loadMatchHistory])

  useEffect(() => {
    if (!loadMatchHistory) return
    if (matchHistoryIndexState.status !== 'ready') {
      setMatchHistoryCatalogState(matchHistoryIndexState.status === 'idle' ? { status: 'idle' } : matchHistoryIndexState.status === 'loading' ? { status: 'loading' } : { status: matchHistoryIndexState.status, message: matchHistoryIndexState.message })
      return
    }
    const index = matchHistoryIndexState.data
    const key = snapshotKey(filter)
    const expected = index.scopeIndex[key]
    if (!expected) {
      setMatchHistoryCatalogState({ status: 'missing', message: `No generated match history exists for ${scopeLabel(effectiveScope)}.` })
      return
    }
    const controller = new AbortController()
    setMatchHistoryCatalogState({ status: 'loading' })
    setMatchHistoryPages({})
    matchHistoryPagesRef.current = {}
    matchHistoryCatalogRef.current = undefined
    async function load() {
      try {
        const response = await fetch(resolveArtifactUrl(expected.url, DATA_URL), { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Match history failed with ${response.status}`)
        const catalog = parsePublicMatchHistoryCatalog(await response.json())
        validateMatchHistoryCatalog(key, expected, catalog, index)
        matchHistoryCatalogRef.current = catalog
        setMatchHistoryCatalogState({ status: 'ready', data: catalog })
      } catch (error) {
        if (isAbortError(error)) return
        setMatchHistoryCatalogState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load match history' })
      }
    }
    void load()
    return () => controller.abort()
  }, [effectiveScope, filter, loadMatchHistory, matchHistoryIndexState])

  useEffect(() => {
    matchHistoryPagesRef.current = matchHistoryPages
  }, [matchHistoryPages])

  const requestMatchHistoryPages = useCallback((pageNumbers: number[]) => {
    const catalog = matchHistoryCatalogRef.current
    if (!catalog) return
    for (const pageNumber of [...new Set(pageNumbers)]) {
      const expected = catalog.pages.find((page) => page.page === pageNumber)
      if (!expected || matchHistoryPagesRef.current[pageNumber]?.status === 'ready' || matchHistoryPagesRef.current[pageNumber]?.status === 'loading') continue
      const loading: MatchHistoryPageState = { status: 'loading' }
      matchHistoryPagesRef.current = { ...matchHistoryPagesRef.current, [pageNumber]: loading }
      setMatchHistoryPages((current) => ({ ...current, [pageNumber]: loading }))
      void loadMatchHistoryPage(catalog, expected, pageNumber).then((state) => {
        const activeCatalog = matchHistoryCatalogRef.current
        if (!activeCatalog || snapshotKey(activeCatalog.filter) !== snapshotKey(catalog.filter) || activeCatalog.artifactMeta.runId !== catalog.artifactMeta.runId) return
        matchHistoryPagesRef.current = { ...matchHistoryPagesRef.current, [pageNumber]: state }
        setMatchHistoryPages((current) => ({ ...current, [pageNumber]: state }))
      })
    }
  }, [])

  useEffect(() => {
    snapshotCacheRef.current = snapshotCache
  }, [snapshotCache])

  useEffect(() => {
    teamHistoryCacheRef.current = teamHistoryCache
  }, [teamHistoryCache])

  useEffect(() => {
    tournamentMovementCacheRef.current = tournamentMovementCache
  }, [tournamentMovementCache])

  useEffect(() => {
    if (!tournamentId || tournamentMovementIndexState.status !== 'ready') return
    const selectedTournamentId = tournamentId
    const index = tournamentMovementIndexState.data
    const expected = index.tournaments.find((entry) => entry.id === selectedTournamentId)
    const cached = tournamentMovementCacheRef.current[selectedTournamentId]
    if (cached?.status === 'ready' || cached?.status === 'loading') return
    if (!expected) {
      setTournamentMovementCache((current) => ({
        ...current,
        [selectedTournamentId]: { status: 'missing', message: `No generated tournament movement exists for ${selectedTournamentId}.` },
      }))
      return
    }
    const expectedEntry = expected
    const controller = new AbortController()
    const loadingEntry: TournamentMovementCacheEntry = { status: 'loading' }
    tournamentMovementCacheRef.current = { ...tournamentMovementCacheRef.current, [selectedTournamentId]: loadingEntry }
    setTournamentMovementCache((current) => ({ ...current, [selectedTournamentId]: loadingEntry }))
    async function load() {
      try {
        const response = await fetch(resolveArtifactUrl(expectedEntry.url, DATA_URL), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`Tournament movement failed with ${response.status}`)
        const shard = parsePublicTournamentMovementShard(await response.json())
        validatePublicTournamentMovementShard(expectedEntry, shard, index)
        const readyEntry: TournamentMovementCacheEntry = { status: 'ready', shard }
        tournamentMovementCacheRef.current = { ...tournamentMovementCacheRef.current, [selectedTournamentId]: readyEntry }
        setTournamentMovementCache((current) => ({ ...current, [selectedTournamentId]: readyEntry }))
      } catch (error) {
        if (isAbortError(error)) {
          if (tournamentMovementCacheRef.current[selectedTournamentId]?.status === 'loading') {
            tournamentMovementCacheRef.current = omitCacheEntry(tournamentMovementCacheRef.current, selectedTournamentId)
            setTournamentMovementCache((current) => current[selectedTournamentId]?.status === 'loading'
              ? omitCacheEntry(current, selectedTournamentId)
              : current)
          }
          return
        }
        const errorEntry: TournamentMovementCacheEntry = { status: 'error', message: error instanceof Error ? error.message : 'Unable to load tournament movement' }
        tournamentMovementCacheRef.current = { ...tournamentMovementCacheRef.current, [selectedTournamentId]: errorEntry }
        setTournamentMovementCache((current) => ({ ...current, [selectedTournamentId]: errorEntry }))
      }
    }
    void load()
    return () => controller.abort()
  }, [tournamentId, tournamentMovementIndexState])

  const prefetchScope = useCallback((nextScope: string) => {
    if (!data) return
    const manifest = data
    const prefetchFilter = scopeToFilter(normalizeScopeForData(nextScope, manifest))
    const snapshotCacheKey = snapshotKey(prefetchFilter)
    const snapshotEntry = snapshotCacheRef.current[snapshotCacheKey]
    if (!snapshotEntry || (snapshotEntry.status !== 'ready' && snapshotEntry.status !== 'loading')) {
      const expected = manifest.snapshotIndex?.[snapshotCacheKey]
      if (expected) {
        const loadingEntry: PublicSnapshotCacheEntry = { status: 'loading' }
        snapshotCacheRef.current = { ...snapshotCacheRef.current, [snapshotCacheKey]: loadingEntry }
        setSnapshotCache((current) => ({ ...current, [snapshotCacheKey]: loadingEntry }))
        const url = resolveArtifactUrl(expected.url, DATA_URL)
        void fetchPublicSnapshotShard(url, snapshotCacheKey, expected, manifest)
          .then((next) => {
            const readyEntry: PublicSnapshotCacheEntry = { status: 'ready', snapshot: next }
            snapshotCacheRef.current = { ...snapshotCacheRef.current, [snapshotCacheKey]: readyEntry }
            setSnapshotCache((current) => ({ ...current, [snapshotCacheKey]: readyEntry }))
          })
          .catch((error: unknown) => {
            const errorEntry: PublicSnapshotCacheEntry = { status: 'error', message: error instanceof Error ? error.message : 'Unable to load filtered snapshot' }
            snapshotCacheRef.current = { ...snapshotCacheRef.current, [snapshotCacheKey]: errorEntry }
            setSnapshotCache((current) => ({ ...current, [snapshotCacheKey]: errorEntry }))
          })
      }
    }

  }, [data])

  const prefetchTournament = useCallback((id: TournamentInstanceId) => {
    if (tournamentMovementIndexState.status !== 'ready') return
    const index = tournamentMovementIndexState.data
    const expected = index.tournaments.find((entry) => entry.id === id)
    const cached = tournamentMovementCacheRef.current[id]
    if (!expected || cached?.status === 'ready' || cached?.status === 'loading') return
    const loadingEntry: TournamentMovementCacheEntry = { status: 'loading' }
    tournamentMovementCacheRef.current = { ...tournamentMovementCacheRef.current, [id]: loadingEntry }
    setTournamentMovementCache((current) => ({ ...current, [id]: loadingEntry }))
    void fetch(resolveArtifactUrl(expected.url, DATA_URL), { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Tournament movement failed with ${response.status}`)
        const shard = parsePublicTournamentMovementShard(await response.json())
        validatePublicTournamentMovementShard(expected, shard, index)
        const readyEntry: TournamentMovementCacheEntry = { status: 'ready', shard }
        tournamentMovementCacheRef.current = { ...tournamentMovementCacheRef.current, [id]: readyEntry }
        setTournamentMovementCache((current) => ({ ...current, [id]: readyEntry }))
      })
      .catch((error: unknown) => {
        const errorEntry: TournamentMovementCacheEntry = { status: 'error', message: error instanceof Error ? error.message : 'Unable to load tournament movement' }
        tournamentMovementCacheRef.current = { ...tournamentMovementCacheRef.current, [id]: errorEntry }
        setTournamentMovementCache((current) => ({ ...current, [id]: errorEntry }))
      })
  }, [tournamentMovementIndexState])

  const retryTournamentMovements = useCallback(() => {
    setTournamentMovementIndexState({ status: 'loading' })
    setTournamentMovementCache({})
    tournamentMovementCacheRef.current = {}
    setTournamentMovementIndexAttempt((attempt) => attempt + 1)
  }, [])

  useEffect(() => {
    if (!data) return
    const manifest = data
    const key = snapshotKey(filter)
    const cacheEntry = snapshotCacheRef.current[key]
    if (cacheEntry?.status === 'ready' || cacheEntry?.status === 'loading') return
    const expected = manifest.snapshotIndex?.[key]
    if (!expected) {
      setSnapshotCache((current) => ({
        ...current,
        [key]: { status: 'missing', message: `No generated snapshot exists for ${scopeLabel(effectiveScope)}.` },
      }))
      return
    }
    const url = resolveArtifactUrl(expected.url, DATA_URL)
    const controller = new AbortController()
    setSnapshotCache((current) => ({ ...current, [key]: { status: 'loading' } }))
    async function load() {
      try {
        const next = await fetchPublicSnapshotShard(url, key, expected, manifest, { signal: controller.signal })
        setSnapshotCache((current) => ({ ...current, [key]: { status: 'ready', snapshot: next } }))
      } catch (error) {
        if (isAbortError(error)) return
        setSnapshotCache((current) => ({
          ...current,
          [key]: { status: 'error', message: error instanceof Error ? error.message : 'Unable to load filtered snapshot' },
        }))
      }
    }
    void load()
    return () => controller.abort()
  }, [data, effectiveScope, filter])

  useEffect(() => {
    if (!loadTeamHistory || teamHistoryRootState.status !== 'ready' || teamHistoryRootState.data.artifactKind !== 'team-history-index') return
    const index = teamHistoryRootState.data
    const key = snapshotKey(filter)
    const cacheEntry = teamHistoryCacheRef.current[key]
    if (cacheEntry?.status === 'ready' || cacheEntry?.status === 'loading') return
    const expected = index.scopeIndex[key]
    if (!expected) {
      setTeamHistoryCache((current) => ({
        ...current,
        [key]: { status: 'missing', message: `No generated team history exists for ${scopeLabel(effectiveScope)}.` },
      }))
      return
    }
    const url = resolveArtifactUrl(expected.url, DATA_URL)
    const controller = new AbortController()
    setTeamHistoryCache((current) => ({ ...current, [key]: { status: 'loading' } }))
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Team history failed with ${response.status}`)
        const next = parsePublicTeamHistoryShard(await response.json())
        validatePublicTeamHistoryShard(key, expected, next, index)
        setTeamHistoryCache((current) => ({ ...current, [key]: { status: 'ready', shard: next } }))
      } catch (error) {
        if (isAbortError(error)) return
        setTeamHistoryCache((current) => ({
          ...current,
          [key]: { status: 'error', message: error instanceof Error ? error.message : 'Unable to load team history' },
        }))
      }
    }
    void load()
    return () => controller.abort()
  }, [effectiveScope, filter, loadTeamHistory, teamHistoryRootState])

  return {
    data,
    manifestState,
    effectiveScope,
    filter,
    seasonYears,
    snapshotState,
    snapshot: snapshotState.status === 'ready' ? snapshotState.snapshot : undefined,
    playersState: requestedState(loadPlayers, playersState),
    teamHistoryState,
    regionHistoryState: scopedRegionHistoryState,
    tournamentMovementIndexState: requestedState(loadTournamentMovements, tournamentMovementIndexState),
    tournamentMovementEntries,
    tournamentMovementState,
    matchHistoryState,
    requestMatchHistoryPages,
    retryTournamentMovements,
    prefetchScope,
    prefetchTournament,
  }
}

function requestedState<T>(requested: boolean, state: PublicArtifactState<T>): PublicArtifactState<T> {
  return requested && state.status === 'idle' ? { status: 'loading' } : state
}

function validateMatchHistoryRun(index: PublicMatchHistoryIndex, manifest: PublicRankingManifest) {
  if (index.modelVersion !== manifest.model.version || index.modelConfigHash !== manifest.model.configHash || index.generatedAt !== manifest.generatedAt) {
    throw new Error('Match history index does not match the active ranking run')
  }
  if (manifest.artifactMeta && index.artifactMeta.runId !== manifest.artifactMeta.runId) throw new Error('Match history index runId mismatch')
}

function validateMatchHistoryCatalog(key: string, expected: PublicMatchHistoryIndex['scopeIndex'][string], catalog: PublicMatchHistoryCatalog, index: PublicMatchHistoryIndex) {
  if (snapshotKey(catalog.filter) !== key) throw new Error(`Match history catalog key mismatch for ${key}`)
  if (catalog.gameCount !== expected.gameCount || catalog.seriesCount !== expected.seriesCount || catalog.pages.length !== expected.pageCount) throw new Error(`Match history catalog counts mismatch for ${key}`)
  if (catalog.modelVersion !== index.modelVersion || catalog.modelConfigHash !== index.modelConfigHash || catalog.generatedAt !== index.generatedAt || catalog.artifactMeta.runId !== index.artifactMeta.runId) {
    throw new Error(`Match history catalog run mismatch for ${key}`)
  }
}

async function loadMatchHistoryPage(
  catalog: PublicMatchHistoryCatalog,
  expected: PublicMatchHistoryCatalog['pages'][number],
  pageNumber: number,
): Promise<MatchHistoryPageState> {
  try {
    const response = await fetch(resolveArtifactUrl(expected.url, DATA_URL), { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Match history page ${pageNumber} failed with ${response.status}`)
    const page = parsePublicMatchHistoryPage(await response.json())
    if (snapshotKey(page.filter) !== snapshotKey(catalog.filter) || page.page !== pageNumber) throw new Error(`Match history page ${pageNumber} scope mismatch`)
    if (page.seriesCount !== expected.seriesCount || page.gameCount !== expected.gameCount) throw new Error(`Match history page ${pageNumber} counts mismatch`)
    if (page.modelVersion !== catalog.modelVersion || page.modelConfigHash !== catalog.modelConfigHash || page.generatedAt !== catalog.generatedAt || page.artifactMeta.runId !== catalog.artifactMeta.runId) throw new Error(`Match history page ${pageNumber} run mismatch`)
    return { status: 'ready', data: page }
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : `Unable to load match history page ${pageNumber}` }
  }
}

export function orderedSeasonYears(data: PublicRankingManifest) {
  return [...new Set((data.filterOptions?.seasons ?? []).filter(isSeasonYear))].sort((left, right) => Number(right) - Number(left))
}

export function normalizeScopeForData(scope: string, data: PublicRankingManifest) {
  const seasonScope = parseSeasonScope(scope)
  if (!seasonScope) return scope
  const years = orderedSeasonYears(data)
  const fallback = years[0] ? `season:${years[0]}` : 'all'
  if (!years.includes(seasonScope.season)) return fallback
  if (!seasonScope.checkpoint) return `season:${seasonScope.season}`
  const checkpointExists = checkpointOptionsForSeason(data, seasonScope.season).some((checkpoint) => checkpoint.id === seasonScope.checkpoint)
  if (!checkpointExists) return `season:${seasonScope.season}`
  return checkpointScope(seasonScope.season, seasonScope.checkpoint)
}

export function scopeToFilter(scope: string): SnapshotFilter {
  const seasonScope = parseSeasonScope(scope)
  if (seasonScope) {
    return {
      season: seasonScope.season,
      event: 'All',
      region: 'All',
      ...(seasonScope.checkpoint ? { checkpoint: seasonScope.checkpoint } : {}),
    }
  }
  if (scope.startsWith('event:')) return { season: 'All', event: scope.slice(6), region: 'All' }
  return { season: 'All', event: 'All', region: 'All' }
}

export function scopeLabel(scope: string) {
  const seasonScope = parseSeasonScope(scope)
  if (seasonScope) {
    return seasonScope.checkpoint
      ? `${seasonScope.season} ${checkpointLabelFromId(seasonScope.checkpoint)} checkpoint`
      : `${seasonScope.season} source season`
  }
  if (scope.startsWith('event:')) return scope.slice(6)
  return 'All seasons & events'
}

export function checkpointOptionsForSeason(data: PublicRankingManifest, season: string | undefined): SnapshotCheckpointOption[] {
  if (!season || !isSeasonYear(season)) return []
  return data.filterOptions.checkpoints?.[season] ?? []
}

export function checkpointScope(season: string, checkpoint: string) {
  return `season:${season}:checkpoint:${checkpoint}`
}

export function seasonFromScope(scope: string) {
  const seasonScope = parseSeasonScope(scope)
  if (seasonScope) return seasonScope.season
  return scope === 'all' ? 'All' : undefined
}

export function checkpointFromScope(scope: string) {
  return parseSeasonScope(scope)?.checkpoint
}

function parseSeasonScope(scope: string) {
  const match = /^season:(\d{4})(?::(?:checkpoint:)?([A-Za-z0-9_-]+))?$/.exec(scope)
  if (!match) return undefined
  return { season: match[1], checkpoint: match[2] }
}

function checkpointLabelFromId(id: string) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function resolveTeamHistoryState(
  rootState: PublicArtifactState<TeamHistoryRoot>,
  cache: Record<string, TeamHistoryCacheEntry>,
  filter: SnapshotFilter,
  effectiveScope: string,
): TeamHistoryArtifactState {
  if (rootState.status === 'idle') return { status: 'idle' }
  if (rootState.status === 'loading') return { status: 'loading' }
  if (rootState.status === 'missing') return { status: 'missing', message: rootState.message }
  if (rootState.status === 'error') return { status: 'error', message: rootState.message }

  const key = snapshotKey(filter)
  const root = rootState.data
  if (root.artifactKind === 'team-history-index') {
    const cached = cache[key]
    if (cached?.status === 'ready') return { status: 'ready', data: cached.shard }
    if (cached) return cached.status === 'loading' ? { status: 'loading' } : { status: cached.status, message: cached.message }
    if (!root.scopeIndex[key]) {
      return { status: 'missing', message: `No generated team history exists for ${scopeLabel(effectiveScope)}.` }
    }
    return { status: 'loading' }
  }

  const scopedSeries = root.scopedSeries?.[key]
  const scopedIds = root.scopeIndex?.[key]
  if (!scopedSeries && !scopedIds && filter.season === 'All' && filter.event === 'All' && filter.region === 'All') {
    return { status: 'ready', data: root }
  }
  if (!scopedSeries && !scopedIds) {
    return {
      status: 'ready',
      data: {
        ...root,
        teamCount: 0,
        pointCount: 0,
        series: {},
      },
    }
  }
  if (scopedIds) {
    const scopedSeriesFromIndex = Object.fromEntries(
      scopedIds
        .map((id) => [id, root.series[id]] as const)
        .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => Boolean(entry[1])),
    )
    return {
      status: 'ready',
      data: {
        ...root,
        teamCount: Object.keys(scopedSeriesFromIndex).length,
        pointCount: Object.values(scopedSeriesFromIndex).reduce((total, series) => total + series.points.length, 0),
        series: scopedSeriesFromIndex,
      },
    }
  }
  const legacyScopedSeries = scopedSeries ?? {}
  return {
    status: 'ready',
    data: {
      ...root,
      teamCount: Object.keys(legacyScopedSeries).length,
      pointCount: Object.values(legacyScopedSeries).reduce((total, series) => total + series.points.length, 0),
      series: legacyScopedSeries,
    },
  }
}

function resolveRegionHistoryState(
  state: PublicArtifactState<PublicRegionHistoryDirectory>,
  filter: SnapshotFilter,
  effectiveScope: string,
): RegionHistoryScopeState {
  if (state.status === 'idle') return { status: 'idle' }
  if (state.status === 'loading') return { status: 'loading' }
  if (state.status === 'missing') return { status: 'missing', message: state.message }
  if (state.status === 'error') return { status: 'error', message: state.message }
  const key = snapshotKey(filter)
  const scoped = state.data.scopes[key]
  if (!scoped) return { status: 'missing', message: `No generated region history exists for ${scopeLabel(effectiveScope)}.` }
  return { status: 'ready', data: scoped }
}

function resolveTournamentMovementState(
  indexState: TournamentMovementIndexState,
  cache: Record<string, TournamentMovementCacheEntry>,
  tournamentId: TournamentInstanceId | undefined,
): TournamentMovementState {
  if (!tournamentId) return { status: 'idle' }
  if (indexState.status === 'idle') return { status: 'idle' }
  if (indexState.status === 'loading') return { status: 'loading' }
  if (indexState.status === 'missing' || indexState.status === 'error') return indexState
  if (!indexState.data.tournaments.some((entry) => entry.id === tournamentId)) {
    return { status: 'missing', message: `No generated tournament movement exists for ${tournamentId}.` }
  }
  const cached = cache[tournamentId]
  if (!cached) return { status: 'loading' }
  if (cached.status === 'ready') return { status: 'ready', data: cached.shard }
  return cached.status === 'loading' ? { status: 'loading' } : cached
}

function compatibleTournamentMovementEntries(
  entries: readonly PublicTournamentMovementIndexEntry[],
  filter: SnapshotFilter,
  data: PublicRankingManifest,
) {
  if (filter.season === 'All') return entries
  if (!filter.checkpoint) return tournamentEntriesForScope(entries, filter.season)
  const checkpoint = checkpointOptionsForSeason(data, filter.season).find((entry) => entry.id === filter.checkpoint)
  if (!checkpoint) return []
  return tournamentEntriesForScope(entries, filter.season, checkpoint)
}

function isSeasonYear(value: string) {
  return /^\d{4}$/.test(value)
}

function resolveArtifactUrl(url: string, baseUrl: string) {
  return resolvePublicArtifactUrl(url, baseUrl)
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function omitCacheEntry<T>(cache: Record<string, T>, key: string) {
  const next = { ...cache }
  delete next[key]
  return next
}
