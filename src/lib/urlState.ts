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

export function hashParam(key: string): string | undefined {
  return currentHashQuery().get(key) ?? undefined
}

/** Read a hash param, falling back when it is absent or not one of `allowed`. */
export function hashEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = hashParam(key)
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Read a positive integer hash param, falling back when absent or invalid. */
export function hashInt(key: string, fallback: number): number {
  const value = Number(hashParam(key))
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
  const serialized = JSON.stringify(params)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const [currentRoute] = window.location.hash.slice(1).split('?', 2)
    if (currentRoute !== route) return

    const query = currentHashQuery()
    for (const [key, value] of Object.entries(JSON.parse(serialized) as Record<string, string | undefined>)) {
      if (value) query.set(key, value)
      else query.delete(key)
    }

    const queryString = query.toString()
    const next = queryString ? `#${route}?${queryString}` : `#${route}`
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [route, serialized])
}
