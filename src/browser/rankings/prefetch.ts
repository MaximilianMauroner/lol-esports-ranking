type NavigatorWithConnection = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string; downlink?: number }
}

export function canUseBackgroundPrefetch() {
  if (typeof navigator === 'undefined' || typeof document === 'undefined' || document.visibilityState === 'hidden') return false
  const connection = (navigator as NavigatorWithConnection).connection
  if (!connection) return true
  if (connection.saveData) return false
  if (connection.effectiveType && /(^|-)2g$/i.test(connection.effectiveType)) return false
  if (typeof connection.downlink === 'number' && connection.downlink > 0 && connection.downlink < 1.5) return false
  return true
}

export function scheduleIdleWork(callback: () => void) {
  if (typeof window === 'undefined') return () => undefined
  if (window.requestIdleCallback) {
    const handle = window.requestIdleCallback(() => {
      if (canUseBackgroundPrefetch()) callback()
    }, { timeout: 2500 })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(() => {
    if (canUseBackgroundPrefetch()) callback()
  }, 900)
  return () => window.clearTimeout(handle)
}
