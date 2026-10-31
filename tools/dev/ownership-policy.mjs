const retainedRankings = new Set([
  'src/lib/incremental/artifactDependencies.ts',
  'src/lib/incremental/semanticParity.ts',
  'src/lib/incremental/changeClassifier.ts',
  'src/lib/ratingSeriesEngine.ts',
  'src/lib/rankingExplanations.ts',
])
const runtimeOwners = [
  { name: 'shared', paths: ['src/shared/', 'src/data/'], imports: ['shared'] },
  { name: 'browser', paths: ['src/browser/', 'src/hooks/', 'src/components/', 'src/views/', 'src/styles/', 'src/App.tsx', 'src/main.tsx'], imports: ['shared', 'browser'] },
  { name: 'tools', paths: ['tools/', 'scripts/benchmark-incremental-ranking.ts'], imports: ['shared', 'production', 'tools'] },
  { name: 'production', paths: ['scripts/', 'vite.config.ts'], imports: ['shared', 'production'] },
  { name: 'tests', paths: ['tests/'], imports: ['shared', 'browser', 'production', 'tools', 'tests'] },
]
export const browserGlobals = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'self', 'indexedDB', 'Worker', 'SharedWorker', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'fetch', 'process', 'Buffer',
])
const codecAdapters = [
  'src/browser/rankings/', 'scripts/rankings/',
  'scripts/public-artifact-materialization.mjs', 'scripts/public-artifact-storage.mjs',
  'scripts/railway-bucket.mjs', 'scripts/ranking-bucket-gc.mjs',
  'scripts/incremental-ranking-orchestrator.ts',
  'tools/calibration/compare-riot-gpr.ts',
  'tools/calibration/lib/rankingEvaluationData.ts',
  'tools/calibration/lib/rankingEvaluation.ts',
  'tools/calibration/lib/replayEvidenceFiles.ts',
]
const matches = (path, prefixes) => prefixes.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix)
const sourcePath = /\.[cm]?[jt]sx?$/

const domainDefinitions = {
  dps: {
    entries: {
      'observed-items.ts': { browserRuntime: true },
      'observation-types.ts': { browserRuntime: true },
      'rulesets/cdragon-directory-roster.ts': {},
      'rulesets/ddragon-source-catalog.ts': {},
      'rulesets/ddragon-auxiliary-inventory.ts': {},
      'rulesets/ddragon-ability-slots.ts': {},
      'rulesets/cdragon-champion-graph.ts': {},
      'rulesets/ddragon-item-structure.ts': {},
      'rulesets/source-mapping.ts': {},
      'rulesets/source-validation.ts': {},
      'rulesets/ddragon-discovery.ts': {},

      'datasets.ts': { browserRuntime: true },
      'simulator.ts': { browserRuntime: true },
      'optimizer-engine.ts': { browserRuntime: true },
      'types.ts': { browserRuntime: true },
      'math.ts': { browserRuntime: true },
      'optimizer.ts': { browserRuntime: true },
      'items.ts': { browserRuntime: true },
      'health.ts': { browserRuntime: true },
      'compare-view.ts': { browserRuntime: true },
      'build-state.ts': { browserRuntime: true },
      'fixtures.ts': { browserRuntime: true },
      'skills.ts': { browserRuntime: true },
      'level-cohort.ts': { browserRuntime: true },
      'progression.ts': { browserRuntime: true },
      'cohort-cache.ts': { browserRuntime: true },
      'contracts/index.ts': { browserRuntime: true },
    },
  },
  style: {
    dependencies: ['rankings'],
    entries: {
      'profile.ts': { browserRuntime: true },
      'build.ts': {},
    },
    producers: ['build.ts'],
  },
  rankings: {
    entries: {
      'types.ts': { browserRuntime: true },
      'read.ts': { browserRuntime: true },
      'policy.ts': { browserRuntime: true },
      'evidence.ts': { browserRuntime: true },
      'build.ts': {},
      'forecast.ts': {},
      'artifact-write.ts': {},
      'published-read.ts': { browserRuntime: true, adapters: codecAdapters },
    },
    producers: [
      'build.ts', 'artifact-write.ts',
      'internal/replay/model.ts',
      'internal/replay/ratingRunState.ts',
      'internal/replay/ratingCheckpoint.ts',
      'internal/replay/ratingCheckpointInventory.ts',
      'internal/replay/incremental/',
      'internal/players/playerModel.ts',
      'internal/players/playerStatsPower.ts',
      'internal/players/playerResumeLedger.ts',
      'internal/projections/snapshot.ts',
      'internal/projections/predictionModel.ts',
      'internal/projections/replayEvidence.ts',
      'internal/published/replayEvidence.ts',
      'internal/projections/predictionVariants.ts',
      'internal/projections/deservedStandingModel.ts',
      'internal/scenarios/conditionalPower*',
      'internal/published/writePlan.ts',
    ],
  },
  tournaments: {
    dependencies: ['rankings'],
    entries: {
      'read.ts': { browserRuntime: true },
      'forecast.ts': { browserRuntime: true },
      'simulation.ts': { browserRuntime: true },
    },
  },
}

function record(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function validPath(path, directory = false) {
  if (typeof path !== 'string') return false
  const parts = (directory && path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  return parts.every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
}

export function createOwnershipPolicy(definitions = domainDefinitions) {
  if (!record(definitions)) throw new Error('Domain definitions must be a record')
  const names = Object.keys(definitions)
  const domains = new Map()
  for (const [name, definition] of Object.entries(definitions)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || runtimeOwners.some(owner => owner.name === name)) {
      throw new Error(`Invalid domain name: ${name}`)
    }
    if (!record(definition) || Object.keys(definition).some(key => !['dependencies', 'entries', 'producers'].includes(key))) {
      throw new Error(`Invalid domain definition: ${name}`)
    }
    const { dependencies = [], entries = {}, producers = [] } = definition
    if (!Array.isArray(dependencies)
      || dependencies.some(dependency => !names.includes(dependency) || dependency === name)
      || new Set(dependencies).size !== dependencies.length) {
      throw new Error(`Invalid domain dependencies: ${name}`)
    }
    if (!record(entries)) throw new Error(`Invalid domain entries: ${name}`)
    const root = `src/domains/${name}/`
    const publicEntries = new Map()
    for (const [path, entry] of Object.entries(entries)) {
      if (!validPath(path) || !sourcePath.test(path) || !record(entry)
        || Object.keys(entry).some(key => !['browserRuntime', 'adapters'].includes(key))
        || (entry.browserRuntime !== undefined && typeof entry.browserRuntime !== 'boolean')
        || (entry.adapters !== undefined && (!Array.isArray(entry.adapters) || entry.adapters.some(adapter => !validPath(adapter, true))))) {
        throw new Error(`Invalid domain entry: ${name}/${path}`)
      }
      publicEntries.set(`${root}${path}`, { browserRuntime: entry.browserRuntime === true, adapters: entry.adapters?.slice() })
    }
    if (!Array.isArray(producers) || producers.some(path => typeof path !== 'string'
      || !validPath(path.endsWith('*') ? path.slice(0, -1) : path, true)
      || (!path.endsWith('/') && !path.endsWith('*') && !sourcePath.test(path)))) {
      throw new Error(`Invalid domain producers: ${name}`)
    }
    domains.set(name, { entries: publicEntries, producers: producers.map(path => `${root}${path}`) })
  }
  const owners = [
    ...names.map(name => ({ name, paths: [`src/domains/${name}/`], imports: [name, 'shared', ...(definitions[name].dependencies ?? [])] })),
    ...runtimeOwners.map(owner => ({ ...owner, imports: [...owner.imports, ...(owner.name === 'shared' ? [] : names)] })),
  ]
  const ownerOf = path => retainedRankings.has(path) ? owners.find(owner => owner.name === 'rankings') : owners.find(owner => matches(path, owner.paths))
  const entryFor = path => {
    const entries = domains.get(ownerOf(path)?.name)?.entries
    const implementation = path.replace(/\.d\.mts$/, '.mjs').replace(/\.d\.cts$/, '.cjs').replace(/\.d\.ts$/, '.js')
    return entries?.get(path) ?? entries?.get(implementation)
  }
  const isProducer = path => matches(path, ['scripts/rankings/providers/', 'src/lib/ratingSeriesEngine.ts', 'src/lib/incremental/'])
    || [...domains.values()].some(domain => domain.producers.some(prefix => prefix.endsWith('*') ? path.startsWith(prefix.slice(0, -1)) : matches(path, [prefix])))
  const browserRuntimeError = path => {
    const entry = entryFor(path)
    if (entry && !entry.browserRuntime) return `Browser runtime cannot enter domain entry ${path}`
  }
  const domainImportError = (file, target, typeOnly = false) => {
    const caller = ownerOf(file)?.name
    const owner = ownerOf(target)?.name
    if (target.startsWith('src/browser/rankings/published/') && caller !== 'tests' && !file.startsWith('src/browser/')) return `Browser resource implementation is private: ${target}`
    if (caller === owner || caller === 'tests') return
    if (retainedRankings.has(target) && (caller === 'production' || caller === 'tools')) return
    const entry = entryFor(target)
    if (entry?.adapters || target.startsWith('src/domains/rankings/internal/published/')) {
      if (matches(file, entry?.adapters ?? codecAdapters)) return
      return `Published codecs are private to ranking adapters: ${target}`
    }
    if ((domains.has(owner) && !entry) || target.includes('/internal/') || retainedRankings.has(target)) return `Domain implementation is private: ${target}`
    if (caller === 'browser' && !typeOnly) return browserRuntimeError(target)
  }
  return { ownerOf, pureOwners: new Set(['shared', ...names]), domainImportError, isProducer, browserRuntimeError }
}

export const defaultPolicy = createOwnershipPolicy()
