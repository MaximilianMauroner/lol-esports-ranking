import { useCallback, useEffect, useState } from 'react'

export function useHistoryDetail(key: string) {
  const [value, setValue] = useState<string | null>(() => detailFromHistory(key))

  useEffect(() => {
    const sync = () => setValue(detailFromHistory(key))
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [key])

  const open = useCallback((nextValue: string) => {
    const state = history.state && typeof history.state === 'object' ? history.state : {}
    history.pushState({ ...state, [key]: nextValue }, '')
    setValue(nextValue)
  }, [key])

  const close = useCallback(() => {
    if (value !== null) history.back()
  }, [value])

  return { value, open, close }
}

function detailFromHistory(key: string) {
  const value: unknown = history.state?.[key]
  return typeof value === 'string' ? value : null
}
