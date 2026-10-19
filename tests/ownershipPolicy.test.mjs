import assert from 'node:assert/strict'
import test from 'node:test'
import * as ownership from '../tools/dev/ownership-policy.mjs'

test('one domain registration grants ownership, purity and consumer access', () => {
  const policy = ownership.createOwnershipPolicy({ builds: { entries: { 'read.ts': { browserRuntime: true } } } })
  assert.equal(policy.ownerOf('src/domains/builds/read.ts')?.name, 'builds')
  assert.equal(policy.pureOwners.has('builds'), true)
  for (const file of ['src/browser/page.ts', 'scripts/server.ts', 'tools/audit/check.ts', 'tests/builds.test.ts']) {
    assert.ok(policy.ownerOf(file).imports.includes('builds'), file)
    assert.equal(policy.domainImportError(file, 'src/domains/builds/read.ts'), undefined, file)
  }
  assert.equal(policy.ownerOf('src/domains/profiles/read.ts'), undefined)
})

test('registration defaults to no dependencies, private entries and denied browser runtime', () => {
  const policy = ownership.createOwnershipPolicy({ builds: { entries: { 'read.ts': {} } }, profiles: {} })
  const builds = policy.ownerOf('src/domains/builds/helper.ts')
  assert.ok(builds.imports.includes('builds'))
  assert.ok(builds.imports.includes('shared'))
  assert.ok(!builds.imports.includes('profiles'))
  assert.ok(!policy.ownerOf('src/shared/value.ts').imports.includes('builds'))
  assert.match(policy.domainImportError('scripts/server.ts', 'src/domains/profiles/read.ts'), /private/)
  assert.match(policy.domainImportError('scripts/server.ts', 'src/domains/builds/helper.ts'), /private/)
  assert.match(policy.domainImportError('src/browser/page.ts', 'src/domains/builds/read.ts'), /Browser runtime/)
  assert.equal(policy.domainImportError('src/browser/page.ts', 'src/domains/builds/read.ts', true), undefined)
  assert.equal(policy.domainImportError('src/domains/builds/read.ts', 'src/domains/builds/helper.ts'), undefined)
  assert.equal(policy.domainImportError('tests/value.test.ts', 'src/domains/builds/helper.ts'), undefined)
})

test('declared dependencies grant one direction without changing consumer rules', () => {
  const policy = ownership.createOwnershipPolicy({ builds: { dependencies: ['profiles'] }, profiles: {} })
  assert.ok(policy.ownerOf('src/domains/builds/read.ts').imports.includes('profiles'))
  assert.ok(!policy.ownerOf('src/domains/profiles/read.ts').imports.includes('builds'))
})

test('domain definitions reject runtime owner collisions and malformed contracts', () => {
  for (const name of ['shared', 'browser', 'production', 'tools', 'tests', '../escape', 'Two', 'two/parts', '']) {
    assert.throws(() => ownership.createOwnershipPolicy({ [name]: {} }), /Invalid domain name/, name)
  }
  for (const definitions of [[], null, new Map([['builds', {}]])]) {
    assert.throws(() => ownership.createOwnershipPolicy(definitions), /definitions must be a record/)
  }
  for (const definition of [null, [], { paths: ['src/browser/'] }, { dependencies: ['unknown'] }, { dependencies: ['builds'] }, { dependencies: ['profiles', 'profiles'] }, { dependencies: 'profiles' }]) {
    assert.throws(() => ownership.createOwnershipPolicy({ builds: definition, profiles: {} }), /Invalid domain/)
  }
})

test('entry and producer paths cannot escape or conceal a different source path', () => {
  for (const path of ['../escape.ts', '/absolute.ts', './read.ts', 'nested/../../read.ts', 'nested//read.ts', 'nested\\read.ts', 'read.ts?raw', 'read.ts#hash', 'read%2ets', '']) {
    assert.throws(() => ownership.createOwnershipPolicy({ builds: { entries: { [path]: {} } } }), /Invalid domain entry/, path)
    assert.throws(() => ownership.createOwnershipPolicy({ builds: { producers: [path] } }), /Invalid domain producers/, path)
  }
  for (const entry of [null, [], { browserRuntime: 'yes' }, { browser: true }, { adapters: '../adapter.ts' }, { adapters: ['../adapter.ts'] }]) {
    assert.throws(() => ownership.createOwnershipPolicy({ builds: { entries: { 'read.ts': entry } } }), /Invalid domain entry/)
  }
  assert.throws(() => ownership.createOwnershipPolicy({ builds: { entries: { 'read.json': {} } } }), /Invalid domain entry/)
  assert.throws(() => ownership.createOwnershipPolicy({ builds: { entries: { 'read.ts/': {} } } }), /Invalid domain entry/)
  assert.throws(() => ownership.createOwnershipPolicy({ builds: { entries: [] } }), /Invalid domain entries/)
  assert.throws(() => ownership.createOwnershipPolicy({ builds: { producers: 'read.ts' } }), /Invalid domain producers/)
  assert.throws(() => ownership.createOwnershipPolicy({ builds: { producers: ['read.json'] } }), /Invalid domain producers/)
})

test('declared producers match exact files, directories and explicit prefixes', () => {
  const policy = ownership.createOwnershipPolicy({ builds: { producers: ['write.ts', 'internal/replay/', 'internal/checkpoint*'] } })
  for (const path of ['write.ts', 'internal/replay/run.ts', 'internal/checkpoint.ts', 'internal/checkpointState.ts']) {
    assert.equal(policy.isProducer(`src/domains/builds/${path}`), true, path)
  }
  for (const path of ['write.ts.extra', 'internal/replayOther.ts', 'internal/safe.ts']) {
    assert.equal(policy.isProducer(`src/domains/builds/${path}`), false, path)
  }
})

test('a public mjs entry also permits its paired erased declaration imports', () => {
  const policy = ownership.createOwnershipPolicy({ builds: { entries: { 'read.mjs': {} } } })
  assert.equal(policy.domainImportError('src/browser/page.ts', 'src/domains/builds/read.d.mts', true), undefined)
  assert.match(policy.domainImportError('src/browser/page.ts', 'src/domains/builds/private.d.mts', true), /private/)
  assert.match(policy.domainImportError('src/browser/page.ts', 'src/domains/builds/read.mjs'), /Browser runtime/)
})

test('retained safety ownership and exact adapter exceptions survive policy construction', () => {
  const { defaultPolicy: policy } = ownership
  for (const path of ['src/lib/incremental/artifactDependencies.ts', 'src/lib/incremental/semanticParity.ts', 'src/lib/incremental/changeClassifier.ts', 'src/lib/ratingSeriesEngine.ts', 'src/lib/rankingExplanations.ts']) {
    assert.equal(policy.ownerOf(path)?.name, 'rankings', path)
    assert.equal(policy.domainImportError('scripts/server.ts', path), undefined, path)
    assert.equal(policy.domainImportError('tools/audit/check.ts', path), undefined, path)
    assert.match(policy.domainImportError('src/browser/page.ts', path), /private/, path)
  }
  const reordered = ownership.createOwnershipPolicy({ tournaments: {}, rankings: {} })
  assert.equal(reordered.ownerOf('src/lib/rankingExplanations.ts').name, 'rankings')
  assert.equal(policy.ownerOf('scripts/benchmark-incremental-ranking.ts').name, 'tools')
  const codec = 'src/domains/rankings/published-read.ts'
  for (const path of ['src/browser/rankings/read.ts', 'scripts/rankings/load.ts', 'scripts/public-artifact-materialization.mjs', 'scripts/public-artifact-storage.mjs', 'scripts/railway-bucket.mjs', 'scripts/ranking-bucket-gc.mjs', 'scripts/incremental-ranking-orchestrator.ts', 'tools/calibration/compare-riot-gpr.ts']) {
    assert.equal(policy.domainImportError(path, codec), undefined, path)
  }
  for (const path of ['src/views/page.ts', 'scripts/server.ts', 'scripts/incremental-ranking-orchestrator-extra.ts', 'tools/calibration/other.ts']) {
    assert.match(policy.domainImportError(path, codec), /Published codecs are private/, path)
  }
  assert.ok(policy.ownerOf('src/domains/tournaments/read.ts').imports.includes('rankings'))
  assert.ok(!policy.ownerOf('src/domains/rankings/read.ts').imports.includes('tournaments'))
  assert.equal(policy.isProducer('src/domains/rankings/internal/scenarios/conditionalPowerResult.ts'), true)
  assert.equal(policy.isProducer('scripts/rankings/providers/provider.ts'), true)
})
