const owners = [
  { name: 'shared', paths: ['src/lib/', 'src/data/', 'src/types.ts'], imports: ['shared'] },
  { name: 'browser', paths: ['src/browser/', 'src/hooks/', 'src/components/', 'src/views/', 'src/styles/', 'src/App.tsx', 'src/main.tsx'], imports: ['shared', 'browser'] },
  { name: 'tools', paths: ['tools/', 'scripts/benchmark-incremental-ranking.ts'], imports: ['shared', 'production', 'tools'] },
  { name: 'production', paths: ['scripts/', 'vite.config.ts'], imports: ['shared', 'production'] },
  { name: 'tests', paths: ['tests/'], imports: ['shared', 'browser', 'production', 'tools', 'tests'] },
]

export function ownerOf(path) {
  return owners.find(owner => owner.paths.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))
}

export const browserGlobals = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'self', 'indexedDB', 'Worker', 'SharedWorker', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
])

const producers = [
  'model.ts', 'snapshot.ts', 'ratingRunState.ts', 'ratingSeriesEngine.ts',
  'ratingCheckpoint.ts', 'ratingCheckpointInventory.ts', 'incremental/', 'importers/',
  'publicArtifacts/writePlan.ts', 'conditionalPowerReplay.ts', 'conditionalPowerReplayBasis.ts',
  'conditionalPowerResultComponent.ts', 'conditionalPowerResultReceiptBuilder.ts',
]

export function isProducer(path) {
  return producers.some(suffix => suffix.endsWith('/') ? path.startsWith(`src/lib/${suffix}`) : path === `src/lib/${suffix}`)
}
