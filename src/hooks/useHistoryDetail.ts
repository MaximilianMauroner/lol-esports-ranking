import { useCallback, useEffect, useRef, useState } from 'react'
import { currentHashQuery, hashParam } from '../lib/urlState'

/**
 * An open detail view (team drawer, region sheet) kept as a hash query param.
 *
 * It used to live only in `history.state`, so a reload or a shared link lost
 * it. Opening pushes a history entry, so the browser back button still closes
 * the detail. Closing a detail that arrived with the URL replaces the entry
 * instead, because there is no earlier entry of ours to go back to.
 */
export function useHistoryDetail(key: string) {
  const [value, setValue] = useState<string | null>(() => hashParam(key) ?? null)
  const pushedRef = useRef(false)

  useEffect(() => {
    const sync = () => {
      const next = hashParam(key) ?? null
      if (next === null) pushedRef.current = false
      setValue(next)
    }
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [key])

  const open = useCallback((nextValue: string) => {
    window.history.pushState(null, '', hashWithParam(key, nextValue))
    pushedRef.current = true
    setValue(nextValue)
  }, [key])

  const close = useCallback(() => {
    if (value === null) return
    if (pushedRef.current) {
      window.history.back()
      return
    }
    window.history.replaceState(null, '', hashWithParam(key, null))
    setValue(null)
  }, [key, value])

  return { value, open, close }
}

function hashWithParam(key: string, value: string | null) {
  const [route] = window.location.hash.slice(1).split('?', 2)
  const query = currentHashQuery()
  if (value === null) query.delete(key)
  else query.set(key, value)
  const queryString = query.toString()
  return `#${route}${queryString ? `?${queryString}` : ''}`
}
