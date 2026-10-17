import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { checkDependencies } from '../tools/dev/check-dependencies.mjs'
import { checkLayout } from '../tools/dev/check-layout.mjs'

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'repository-layout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  write('tsconfig.app.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] }, module: 'esnext' } }))
  for (const [path, contents] of Object.entries(files)) write(path, contents)
  return { root, write }
}

test('resolved aliases and parent escapes cannot cross source ownership', (t) => {
  const { root } = fixture(t, {
    'src/shared/reader.ts': "import '@/browser/state'; export * from './nested/../../browser/state'",
    'src/browser/state.ts': 'export const state = 1',
    'src/shared/nested/placeholder.ts': 'export {}',
    'scripts/server.ts': "import '../tools/dev/helper'",
    'tools/dev/helper.ts': 'export {}',
  })
  const errors = checkDependencies(root).join('\n')
  assert.match(errors, /shared cannot import browser/)
  assert.match(errors, /production cannot import tools/)
  assert.equal(errors.match(/shared cannot import browser/g)?.length, 2)
})

test('browser runtime traversal follows re-exports, literal dynamic imports and worker URLs', (t) => {
  const { root } = fixture(t, {
    'src/browser/page.ts': "import('@/domains/rankings/read'); import('/src/domains/rankings/internal/projections/snapshot.ts'); new Worker(new URL('../domains/rankings/internal/worker.ts', import.meta.url))",
    'src/domains/rankings/read.ts': "export { replay } from './internal/projections/snapshot'",
    'src/domains/rankings/internal/projections/snapshot.ts': 'export const replay = 1',
    'src/domains/rankings/internal/worker.ts': "import '../../../../scripts/rankings/providers/provider'",
    'scripts/rankings/providers/provider.ts': 'export {}',
  })
  const errors = checkDependencies(root).join('\n')
  assert.match(errors, /Browser runtime reaches producer .*snapshot\.ts/)
  assert.match(errors, /Browser runtime reaches producer .*providers\/provider\.ts/)
})

test('runtime traversal follows mjs implementations even when declarations exist', (t) => {
  const { root } = fixture(t, {
    'src/browser/page.ts': "import '../domains/rankings/read.mjs'",
    'src/domains/rankings/read.mjs': "export { replay } from './internal/projections/snapshot.ts'",
    'src/domains/rankings/read.d.mts': 'export declare const replay: number',
    'src/domains/rankings/internal/projections/snapshot.ts': 'export const replay = 1',
  })
  assert.match(checkDependencies(root).join('\n'), /Browser runtime reaches producer .*snapshot\.ts/)
})

test('browser configuration values do not authorize indirect player replay', (t) => {
  const { root, write } = fixture(t, {
    'src/browser/page.ts': "import { parameters } from '../domains/rankings/policy'; console.log(parameters)",
    'src/domains/rankings/policy.ts': "export { parameters } from './internal/policy/playerPolicy'",
    'src/domains/rankings/internal/policy/playerPolicy.ts': 'export const parameters = { rating: 100 }',
    'src/domains/rankings/internal/players/playerModel.ts': 'export const replay = 1',
  })
  assert.deepEqual(checkDependencies(root), [])
  write('src/domains/rankings/internal/policy/playerPolicy.ts', "export { replay as parameters } from '../players/playerModel'")
  assert.match(checkDependencies(root).join('\n'), /Browser runtime reaches producer .*playerModel\.ts/)
})

test('shared producer types remain available without adding producer runtime edges', (t) => {
  const { root, write } = fixture(t, {
    'src/browser/page.ts': "import type { Snapshot } from '../domains/rankings/types'; export type { Snapshot as Result } from '../domains/rankings/types'; type Deferred = import('../domains/rankings/types').Snapshot; export type { Deferred }",
    'src/domains/rankings/types.ts': 'export type Snapshot = { value: number }',
    'src/domains/rankings/internal/projections/snapshot.ts': 'export type Snapshot = { value: number }; export const replay = 1',
  })
  assert.deepEqual(checkDependencies(root), [])
  write('src/browser/page.ts', "import { type Snapshot, replay } from '../domains/rankings/internal/projections/snapshot'; console.log(replay)")
  assert.match(checkDependencies(root).join('\n'), /Browser runtime reaches producer/)
})

test('type-only imports do not permit cross-owner dependencies', (t) => {
  const { root } = fixture(t, {
    'src/shared/shared.ts': "import type { State } from '../browser/state'",
    'src/browser/state.ts': 'export type State = number',
  })
  assert.match(checkDependencies(root).join('\n'), /shared cannot import browser/)
})

for (const [syntax, runtime] of [
  ["import { type Snapshot } from './internal/projections/snapshot'", true],
  ["export { type Snapshot } from './internal/projections/snapshot'", true],
  ["import type { Snapshot } from './internal/projections/snapshot'", false],
  ["export type { Snapshot } from './internal/projections/snapshot'", false],
  ["type Snapshot = import('./internal/projections/snapshot').Snapshot", false],
]) {
  test(`browser traversal preserves emitted module evaluation for ${syntax}`, (t) => {
    const { root } = fixture(t, {
      'src/browser/page.ts': "import { read } from '../domains/rankings/read'; console.log(read)",
      'src/domains/rankings/read.ts': `${syntax}; export const read = 1`,
      'src/domains/rankings/internal/projections/snapshot.ts': 'export type Snapshot = { value: number }; export const replay = 1',
    })
    const errors = checkDependencies(root)
    if (runtime) assert.match(errors.join('\n'), /Browser runtime reaches producer .*read\.ts -> .*snapshot\.ts/)
    else assert.deepEqual(errors, [])
  })
}

test('domain internals and codec adapters cannot be entered through aliases or parent paths', (t) => {
  const { root } = fixture(t, {
    'src/views/page.ts': "export * from '@/domains/rankings/internal/queries/detail'; import '../domains/rankings/published-read'",
    'src/domains/rankings/internal/queries/detail.ts': 'export const detail = 1',
    'src/domains/rankings/published-read.ts': 'export const parse = 1',
    'src/domains/rankings/read.ts': "import '../tournaments/read'",
    'src/domains/tournaments/read.ts': 'export const schedule = 1',
  })
  const errors = checkDependencies(root).join('\n')
  assert.match(errors, /Domain implementation is private/)
  assert.match(errors, /Published codecs are private/)
  assert.match(errors, /rankings cannot import tournaments/)
})

test('runtime dynamic imports require a finite literal graph', (t) => {
  const { root } = fixture(t, { 'src/browser/worker.ts': 'const target = location.hash; import(target)' })
  assert.match(checkDependencies(root).join('\n'), /Dynamic source imports require a literal target/)
})

test('browser resource internals remain hidden and symlink imports cannot escape the source root', (t) => {
  const { root, write } = fixture(t, {
    'src/views/page.ts': "import '@/browser/rankings/published/resource'",
    'src/browser/rankings/published/resource.ts': 'export const value = 1',
    'src/browser/page.ts': "import './escape'",
  })
  const outside = mkdtempSync(join(tmpdir(), 'repository-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'outside.ts'), 'export const value = 1')
  write('src/browser/placeholder.ts', 'export {}')
  symlinkSync(join(outside, 'outside.ts'), join(root, 'src/browser/escape.ts'))
  const errors = checkDependencies(root).join('\n')
  assert.match(errors, /Browser resource implementation is private/)
  assert.match(errors, /Source import escapes the source root/)
})

test('shared browser globals include cast aliases and destructuring but exclude local names and gc', (t) => {
  const { root, write } = fixture(t, {
    'src/shared/shared.ts': "const runtime = globalThis as typeof globalThis; const alias = runtime; alias.location; runtime['localStorage']; const { document: doc } = alias; window.location",
  })
  const errors = checkDependencies(root).join('\n')
  for (const name of ['location', 'localStorage', 'document', 'window']) assert.match(errors, new RegExp(`browser global ${name}`))
  write('src/shared/shared.ts', "globalThis.gc?.(); export function local(window: { location: string }, history: string) { return window.location + history }; const location = 'local'; console.log(location)")
  assert.deepEqual(checkDependencies(root), [])
})

test('source ownership checking succeeds without Git metadata', (t) => {
  const { root } = fixture(t, { 'src/shared/shared.ts': 'export const value = 1' })
  const source = spawnSync(process.execPath, [resolve('tools/dev/check-dependencies.mjs'), root], { cwd: root, encoding: 'utf8' })
  assert.equal(source.status, 0, source.stderr)
  const tracking = checkLayout(root)
  assert.equal(tracking.blocked, true)
  assert.match(tracking.errors.join('\n'), /requires Git metadata/)
  execFileSync('git', ['init', '-q', root])
  const nested = join(root, 'archive')
  mkdirSync(nested)
  assert.equal(checkLayout(nested).blocked, true)
})

test('tracked-file hygiene accepts source fixtures and assets and rejects forced generated output', (t) => {
  const { root, write } = fixture(t, {
    'tests/fixtures/input.csv': 'team,score\nA,1\n',
    'tests/fixtures/page.html': '<p>Fixture</p>',
    'tests/fixtures/schema.json': '{"type":"object"}',
    'tests/fixtures/README.md': 'Fixture provenance',
    'tests/fixtures/provenance.md': 'Recorded input provenance',
    'public/logo.svg': '<svg/>',
    'public/legal/NOTICE.md': 'Asset license',
    'public/help.html': '<p>Help</p>',
    'public/team-colors.csv': 'team,color\nA,blue\n',
    'ops/safety/receipt.json': '{"schemaVersion":1}',
    'tools/audit/report-contract.json': '{"schemaVersion":1}',
    'src/shared/shared.ts': 'export {}',
  })
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'add', '.'])
  assert.deepEqual(checkLayout(root), { blocked: false, errors: [] })
  write('.gitignore', 'public/data/\n')
  write('public/data/ranking-summary.json', '{}')
  write('reports/result.csv', 'output')
  write('tools/audit/dist/result.json', '{}')
  write('src/browser/.cache/result.html', 'output')
  execFileSync('git', ['-C', root, 'add', '-f', 'public/data/ranking-summary.json', 'reports/result.csv', 'tools/audit/dist/result.json', 'src/browser/.cache/result.html'])
  const errors = checkLayout(root).errors.join('\n')
  assert.match(errors, /public\/data\/ranking-summary\.json/)
  assert.match(errors, /reports\/result\.csv/)
  assert.match(errors, /tools\/audit\/dist\/result\.json/)
  assert.match(errors, /src\/browser\/\.cache\/result\.html/)
})

test('tracked-file hygiene rejects narrative output inside source zones', (t) => {
  const files = {
    'tools/audit/report.md': '# Audit results',
    'src/views/rankings/migration-plan.md': '# Migration plan',
    'tools/reports/results.html': '<p>Audit results</p>',
    'tools/reviews/q1.md': '# Review results',
    'tools/audits/final.md': '# Audit results',
    'src/views/reviews/2024.html': '<p>Review results</p>',
    'tools/review/q1.md': '# Review results',
    'tools/audit/final.md': '# Audit results',
  }
  const { root } = fixture(t, files)
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'add', '.'])
  const errors = checkLayout(root).errors
  assert.equal(errors.length, Object.keys(files).length)
  for (const file of Object.keys(files)) assert.ok(errors.some(error => error.startsWith(`${file}:`)), file)
})

test('the pinned developer benchmark can use audit tools but production cannot import it', (t) => {
  const { root, write } = fixture(t, {
    'scripts/benchmark-incremental-ranking.ts': "import '../tools/audit/verify'",
    'tools/audit/verify.ts': 'export {}',
  })
  assert.deepEqual(checkDependencies(root), [])
  write('scripts/server.ts', "import './benchmark-incremental-ranking'")
  assert.match(checkDependencies(root).join('\n'), /production cannot import tools/)
})
