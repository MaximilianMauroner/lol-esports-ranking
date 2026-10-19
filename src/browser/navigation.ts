import { initialModeFromLocation, type AppMode } from './bootstrap'
import type { TournamentFilterValue } from '../domains/rankings/evidence'
import { useEffect } from 'react'

/**
 * Shared hash-query state for every view.
 *
 * Scope lived in the hash and Match history wrote its own params, but the team
 * board's search, region, tournament, eligibility, sort and page state lived
 * only in React state. A user who filtered to LCK, sorted by Power score and
 * reloaded lost all of it, and could not share the view they were looking at.
 *
 * Every view now reads and writes through this module, so param naming and
 * reset behaviour are the same everywhere.
 */
export function currentHashQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams()
  return new URLSearchParams(window.location.hash.slice(1).split('?', 2)[1] ?? '')
}

/** Read a hash param from `query`, by default the current hash query. */
export function hashParam(key: string, query = currentHashQuery()): string | undefined {
  return query.get(key) ?? undefined
}

/** Read a hash param, falling back when it is absent or not one of `allowed`. */
export function hashEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, query = currentHashQuery()): T {
  const value = hashParam(key, query)
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Read a positive integer hash param, falling back when absent or invalid. */
export function hashInt(key: string, fallback: number, query = currentHashQuery()): number {
  const value = Number(hashParam(key, query))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Write a view's own params into the hash query while it is the active route.
 *
 * Keys mapping to `undefined` or the empty string are removed, so a default
 * value never shows up in the URL. Every key the view does not own is
 * preserved, which is what keeps `scope` intact while a view writes its
 * filters.
 */
export function useHashSync(route: string, params: Record<string, string | undefined>) {
  // JSON.stringify drops keys that map to undefined, so map them to '' first to keep them for removal.
  const serialized = JSON.stringify(Object.entries(params).map(([key, value]) => [key, value ?? '']))

  useEffect(() => {
    if (typeof window === 'undefined') return
    const [currentRoute] = window.location.hash.slice(1).split('?', 2)
    if (currentRoute !== route) return

    const query = currentHashQuery()
    for (const [key, value] of JSON.parse(serialized) as Array<[string, string]>) {
      if (value) query.set(key, value)
      else query.delete(key)
    }

    const queryString = query.toString()
    const next = queryString ? `#${route}?${queryString}` : `#${route}`
    if (window.location.hash !== next) writeNavigationHash(next, 'replace')
  }, [route, serialized])
}

export function readModeFromHash(): AppMode {
  return typeof window === 'undefined'
    ? 'rankings'
    : initialModeFromLocation(window.location.hash, window.location.pathname)
}

export function readScopeFromHash() {
  if (typeof window === 'undefined') return undefined
  const query = window.location.hash.slice(1).split('?', 2)[1] ?? window.location.search.slice(1)
  if (!query) return undefined
  const scope = new URLSearchParams(query).get('scope')
  return isKnownScope(scope) ? scope : undefined
}

export function readTournamentFilterFromHash(query = currentHashQuery()) {
  return (hashParam('tournament', query) as TournamentFilterValue | undefined) ?? 'All'
}

export function replaceHashForModeAndScope(mode: AppMode, scope: string) {
  if (typeof window === 'undefined') return
  const nextHash = hashForModeAndScope(mode, scope, window.location.hash.slice(1))
  if (window.location.hash === nextHash) return
  writeNavigationHash(nextHash, 'replace')
}

export function hashForModeAndScope(mode: AppMode, scope: string, currentHash = '') {
  const query = new URLSearchParams(currentHash.split('?', 2)[1] ?? '')
  query.set('scope', scope)
  const queryString = query.toString()
  return `#${mode}${queryString ? `?${queryString}` : ''}`
}

export function isKnownScope(value: string | null): value is string {
  return value === 'all' || Boolean(value?.startsWith('event:')) || /^season:\d{4}(?::(?:checkpoint:)?[A-Za-z0-9_-]+)?$/.test(value ?? '')
}


export function writeNavigationHash(hash: string, method: 'navigate' | 'push' | 'replace') {
  if (method === 'navigate') window.location.hash = hash
  else if (method === 'push') window.history.pushState(null, '', hash)
  else window.history.replaceState(null, '', hash)
}

export function hashWithParam(key: string, value: string | null) {
  const [route] = window.location.hash.slice(1).split('?', 2)
  const query = currentHashQuery()
  if (value === null) query.delete(key)
  else query.set(key, value)
  const queryString = query.toString()
  return `#${route}${queryString ? `?${queryString}` : ''}`
}
