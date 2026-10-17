const retainedRankings = new Set([
  'src/lib/incremental/artifactDependencies.ts',
  'src/lib/incremental/semanticParity.ts',
  'src/lib/incremental/changeClassifier.ts',
  'src/lib/ratingSeriesEngine.ts',
  'src/lib/rankingExplanations.ts',
])
const owners = [
  { name: 'rankings', paths: ['src/domains/rankings/'], imports: ['rankings', 'shared'] },
  { name: 'tournaments', paths: ['src/domains/tournaments/'], imports: ['tournaments', 'rankings', 'shared'] },
  { name: 'shared', paths: ['src/shared/', 'src/data/'], imports: ['shared'] },
  { name: 'browser', paths: ['src/browser/', 'src/hooks/', 'src/components/', 'src/views/', 'src/styles/', 'src/App.tsx', 'src/main.tsx'], imports: ['shared', 'rankings', 'tournaments', 'browser'] },
  { name: 'tools', paths: ['tools/', 'scripts/benchmark-incremental-ranking.ts'], imports: ['shared', 'rankings', 'tournaments', 'production', 'tools'] },
  { name: 'production', paths: ['scripts/', 'vite.config.ts'], imports: ['shared', 'rankings', 'tournaments', 'production'] },
  { name: 'tests', paths: ['tests/'], imports: ['shared', 'rankings', 'tournaments', 'browser', 'production', 'tools', 'tests'] },
]
export function ownerOf(path) {
  if (retainedRankings.has(path)) return owners[0]
  return owners.find(owner => owner.paths.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))
}
export const pureOwners = new Set(['shared', 'rankings', 'tournaments'])
export const browserGlobals = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'self', 'indexedDB', 'Worker', 'SharedWorker', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'fetch', 'process', 'Buffer',
])
const producerPaths = [
  'src/domains/rankings/build.ts', 'src/domains/rankings/artifact-write.ts',
  'src/domains/rankings/internal/replay/model.ts',
  'src/domains/rankings/internal/replay/ratingRunState.ts',
  'src/domains/rankings/internal/replay/ratingCheckpoint.ts',
  'src/domains/rankings/internal/replay/ratingCheckpointInventory.ts',
  'src/domains/rankings/internal/replay/incremental/',
  'src/domains/rankings/internal/players/playerModel.ts',
  'src/domains/rankings/internal/players/playerResumeLedger.ts',
  'src/domains/rankings/internal/projections/snapshot.ts',
  'src/domains/rankings/internal/projections/predictionModel.ts',
  'src/domains/rankings/internal/projections/predictionVariants.ts',
  'src/domains/rankings/internal/projections/deservedStandingModel.ts',
  'src/domains/rankings/internal/scenarios/conditionalPower',
  'src/domains/rankings/internal/published/writePlan.ts',
  'src/lib/ratingSeriesEngine.ts', 'src/lib/incremental/',
]
export function isProducer(path) {
  return path.startsWith('scripts/rankings/providers/') || producerPaths.some(prefix => path === prefix || ((prefix.endsWith('/') || prefix.endsWith('conditionalPower')) && path.startsWith(prefix)))
}
const codecAdapters = [
  'src/browser/rankings/', 'scripts/rankings/',
  'scripts/public-artifact-materialization.mjs', 'scripts/public-artifact-storage.mjs',
  'scripts/railway-bucket.mjs', 'scripts/ranking-bucket-gc.mjs',
  'scripts/incremental-ranking-orchestrator.ts',
  'tools/calibration/compare-riot-gpr.ts',
]
const matches = (path, prefixes) => prefixes.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix)
export function domainImportError(file, target) {
  const caller = ownerOf(file)?.name
  const owner = ownerOf(target)?.name
  if (target.startsWith('src/browser/rankings/published/') && caller !== 'tests' && !file.startsWith('src/browser/')) {
    return `Browser resource implementation is private: ${target}`
  }
  if (caller === owner || caller === 'tests') return
  if (retainedRankings.has(target) && (caller === 'production' || caller === 'tools')) return
  if (target === 'src/domains/rankings/published-read.ts' || target.startsWith('src/domains/rankings/internal/published/')) {
    if (matches(file, codecAdapters)) return
    return `Published codecs are private to ranking adapters: ${target}`
  }
  if (target.includes('/internal/') || retainedRankings.has(target)) return `Domain implementation is private: ${target}`
}
