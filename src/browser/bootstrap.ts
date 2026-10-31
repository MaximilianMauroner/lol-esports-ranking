export type AppMode = 'rankings' | 'players' | 'regions' | 'matches' | 'tournaments' | 'profiles'

export function initialModeFromLocation(hash: string, pathname: string): AppMode {
  return modeFromSegment(hash.slice(1).split(/[/?]/, 1)[0])
    ?? modeFromSegment(pathname.split('/').filter(Boolean)[0] ?? '')
    ?? 'rankings'
}

export function showsManifestErrorInAppShell(mode: AppMode) {
  return mode !== 'rankings'
}

function modeFromSegment(segment: string): AppMode | undefined {
  if (segment === 'teams') return 'rankings'
  if (segment === 'rankings' || segment === 'players' || segment === 'regions' || segment === 'matches' || segment === 'tournaments' || segment === 'profiles') return segment
  return undefined
}
