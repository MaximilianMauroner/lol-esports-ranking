import { useCallback, useEffect, useState } from 'react'
import { parseStyleProfileArtifact, type StyleProfileArtifact } from '../../domains/style/profile'

type StyleArtifactState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: StyleProfileArtifact }

export function useStyleProfiles() {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<StyleArtifactState>({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/data/style-profiles.json', { signal: controller.signal })
        if (!response.ok) throw new Error(`Style profiles are unavailable. HTTP ${response.status}.`)
        const data = parseStyleProfileArtifact(await response.json())
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : 'Style profiles could not be loaded.' })
      }
    }
    void load()
    return () => controller.abort()
  }, [attempt])
  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt(value => value + 1)
  }, [])
  return { state, retry }
}
