export type AppMode = 'rankings' | 'regions' | 'matches'

export function initialModeFromLocation(hash: string, pathname: string): AppMode {
  return modeFromSegment(hash.slice(1).split(/[/?]/, 1)[0])
    ?? modeFromSegment(pathname.split('/').filter(Boolean)[0] ?? '')
    ?? 'rankings'
}

export function shouldHoldPrerenderForManifest(hash: string, pathname: string, legalPage: boolean) {
  return !legalPage && initialModeFromLocation(hash, pathname) === 'rankings'
}

function modeFromSegment(segment: string): AppMode | undefined {
  if (segment === 'teams') return 'rankings'
  if (segment === 'rankings' || segment === 'regions' || segment === 'matches') return segment
  return undefined
}
