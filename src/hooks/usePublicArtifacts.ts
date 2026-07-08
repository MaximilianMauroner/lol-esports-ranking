import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PublicPlayerDirectory,
  PublicRankingManifest,
  PublicRegionHistoryDirectory,
  PublicRegionHistoryScope,
  PublicTeamHistoryDirectory,
  PublicTeamHistoryIndex,
  PublicTeamHistoryShard,
  SnapshotCheckpointOption,
  SnapshotFilter,
} from '../lib/publicArtifacts/schema'
import {
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicRegionHistory,
  parsePublicTeamHistory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  snapshotKey,
} from '../lib/publicArtifacts/schema'
import {
  resolvePublicSnapshotState,
  validatePublicSnapshotShard,
  validatePublicTeamHistoryShard,
  type PublicSnapshotCacheEntry,
} from '../lib/publicArtifacts/resolver'

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

type TeamHistoryRoot = PublicTeamHistoryDirectory | PublicTeamHistoryIndex
type PublicArtifactLoadOptions = {
  loadPlayers?: boolean
  loadTeamHistory?: boolean
  loadRegionHistory?: boolean
}

type TeamHistoryCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; shard: PublicTeamHistoryShard }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

const DATA_URL = import.meta.env.VITE_RANKING_DATA_URL || '/data/ranking-summary.json'
const PLAYERS_URL = import.meta.env.VITE_PLAYER_DATA_URL || '/data/entities/players.json'
const TEAM_HISTORY_INDEX_URL = import.meta.env.VITE_TEAM_HISTORY_INDEX_URL || import.meta.env.VITE_TEAM_HISTORY_URL || '/data/history/team-series/index.json'
const REGION_HISTORY_URL = import.meta.env.VITE_REGION_HISTORY_URL || '/data/history/region-series.json'

export function usePublicArtifacts(scope: string, options: PublicArtifactLoadOptions = {}) {
  const { loadPlayers = false, loadTeamHistory = false, loadRegionHistory = false } = options
  const [manifestState, setManifestState] = useState<PublicArtifactState<PublicRankingManifest>>({ status: 'loading' })
  const [playersState, setPlayersState] = useState<PlayerDirectoryState>({ status: 'idle' })
  const [teamHistoryRootState, setTeamHistoryRootState] = useState<PublicArtifactState<TeamHistoryRoot>>({ status: 'idle' })
  const [teamHistoryCache, setTeamHistoryCache] = useState<Record<string, TeamHistoryCacheEntry>>({})
  const teamHistoryCacheRef = useRef(teamHistoryCache)
  const [regionHistoryState, setRegionHistoryState] = useState<PublicArtifactState<PublicRegionHistoryDirectory>>({ status: 'idle' })
  const [snapshotCache, setSnapshotCache] = useState<Record<string, PublicSnapshotCacheEntry>>({})
  const snapshotCacheRef = useRef(snapshotCache)

  const data = manifestState.status === 'ready' ? manifestState.data : undefined
  const effectiveScope = useMemo(() => (data ? normalizeScopeForData(scope, data) : scope), [data, scope])
  const filter = useMemo(() => scopeToFilter(effectiveScope), [effectiveScope])
  const snapshotState = useMemo(
    () => resolvePublicSnapshotState(data, filter, snapshotCache),
    [data, filter, snapshotCache],
  )
  const teamHistoryState = useMemo(
    () => resolveTeamHistoryState(teamHistoryRootState, teamHistoryCache, filter, effectiveScope),
    [effectiveScope, filter, teamHistoryCache, teamHistoryRootState],
  )
  const scopedRegionHistoryState = useMemo(
    () => resolveRegionHistoryState(regionHistoryState, filter, effectiveScope),
    [effectiveScope, filter, regionHistoryState],
  )
  const seasonYears = useMemo(() => (data ? orderedSeasonYears(data) : []), [data])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(DATA_URL, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}`)
        const next = parsePublicRankingManifest(await response.json())
        setManifestState({ status: 'ready', data: next })
      } catch (error) {
        if (isAbortError(error)) return
        setManifestState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load snapshot' })
      }
    }
    void load()
    return () => controller.abort()
  }, [])

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
    snapshotCacheRef.current = snapshotCache
  }, [snapshotCache])

  useEffect(() => {
    teamHistoryCacheRef.current = teamHistoryCache
  }, [teamHistoryCache])

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
        void fetch(url, { headers: { Accept: 'application/json' } })
          .then(async (response) => {
            if (!response.ok) throw new Error(`Filter snapshot failed with ${response.status}`)
            const next = parsePublicRankingShard(await response.json())
            validatePublicSnapshotShard(snapshotCacheKey, expected, next, manifest)
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
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Filter snapshot failed with ${response.status}`)
        const next = parsePublicRankingShard(await response.json())
        validatePublicSnapshotShard(key, expected, next, manifest)
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
    playersState,
    teamHistoryState,
    regionHistoryState: scopedRegionHistoryState,
    prefetchScope,
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

function isSeasonYear(value: string) {
  return /^\d{4}$/.test(value)
}

function resolveArtifactUrl(url: string, baseUrl: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('/')) return url
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const resolvedBase = /^[a-z][a-z\d+.-]*:/i.test(baseUrl)
    ? baseUrl
    : new URL(baseUrl, origin).toString()
  return new URL(url, resolvedBase).toString()
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
