import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const classifier = fileURLToPath(new URL('../tools/dev/ci-affected-paths.mjs', import.meta.url))
const gitAt = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
}).trim()

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-paths-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => gitAt(cwd, ...args)
  const identity = ['-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid']
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const commit = () => {
    git('add', '-A')
    git(...identity, 'commit', '--allow-empty', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const classify = (env = {}, checkout = cwd) => execFileSync(process.execPath, [classifier], {
    cwd: checkout, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/130/merge',
      GITHUB_SHA: git('rev-parse', 'HEAD'), ...env,
    },
  }).trim()
  const merge = (base) => {
    const head = git('rev-parse', 'HEAD')
    const tree = git('merge-tree', '--write-tree', base, head)
    const merged = git(...identity, 'commit-tree', tree, '-p', base, '-p', head, '-m', 'synthetic PR merge')
    git('reset', '--hard', merged)
    return merged
  }
  const shallowCheckout = (depth) => {
    const checkout = mkdtempSync(join(tmpdir(), 'ci-checkout-'))
    t.after(() => rmSync(checkout, { recursive: true, force: true }))
    git('clone', '-q', '--no-local', '--depth', String(depth), '--branch', git('branch', '--show-current'), cwd, checkout)
    return checkout
  }
  git('init', '-q', '-b', 'main')
  write('src/domains/rankings/internal/replay/ratingContext.ts', 'runtime')
  const base = commit()
  return { cwd, git, identity, write, commit, merge, shallowCheckout, classify, base }
}

test('presentation and Markdown edits avoid unrelated heavy validation', (t) => {
  const f = fixture(t)
  f.write('src/views/matches/MatchesView.tsx', 'presentation')
  f.write('src/components/ui/button.tsx', 'button')
  f.write('src/styles/base.css', 'styles')
  f.write('README.md', 'prose')
  f.commit()
  f.merge(f.base)
  assert.equal(f.classify(), 'full-validation=false')
})

test('shared, model, import, worker, dependency, benchmark, and unknown paths fail open', (t) => {
  const f = fixture(t)
  for (const path of [
    'src/domains/rankings/internal/replay/ratingContext.ts', 'src/domains/rankings/internal/policy/rankingConfig.ts', 'scripts/download-local-data.mjs',
    'worker/ranking-refresh/src/main.rs', 'pnpm-lock.yaml', 'scripts/benchmark-incremental-ranking.ts',
    'public/data/ranking-summary.json', 'tools/calibration/ranking-accuracy-protocol.json',
    'src/future/runtime.ts', 'src/components/futureWorker.ts', 'Dockerfile.refresh', '.github/workflows/checks.yml',
  ]) {
    f.write(path, 'changed')
    f.commit()
    const merged = f.merge(f.base)
    assert.equal(f.classify(), 'full-validation=true', path)
    // Each classification must prove this path independently.
    f.base = merged
  }
})

test('a later UI push cannot hide an earlier runtime edit in the PR', (t) => {
  const f = fixture(t)
  f.write('src/domains/rankings/internal/replay/ratingContext.ts', 'changed runtime')
  f.commit()
  f.write('src/views/matches/MatchesView.tsx', 'later presentation')
  f.commit()
  f.merge(f.base)
  assert.equal(f.classify(), 'full-validation=true')
})

test('a stale UI branch excludes advanced-base runtime edits at checkout depth two', (t) => {
  const f = fixture(t)
  f.git('checkout', '-qb', 'pull-request', f.base)
  f.write('src/views/matches/MatchesView.tsx', 'presentation')
  const prHead = f.commit()
  f.git('checkout', '-qb', 'advanced-main', f.base)
  f.write('src/domains/rankings/internal/replay/ratingContext.ts', 'base-only runtime edit')
  f.write('src/lib/mainOnlyRuntime.ts', 'base-only runtime addition')
  f.commit()
  f.write('README.md', 'later base documentation')
  const currentBase = f.commit()
  // The previous two-endpoint comparison falsely included main-only runtime edits.
  assert.match(f.git('diff', '--name-only', currentBase, prHead), /src\/lib\/mainOnlyRuntime\.ts/)
  f.git('checkout', '-q', 'pull-request')
  f.merge(currentBase)
  const checkout = f.shallowCheckout(2)
  assert.equal(gitAt(checkout, 'rev-parse', '--is-shallow-repository'), 'true')
  assert.equal(gitAt(checkout, 'rev-parse', 'HEAD^1'), currentBase)
  assert.equal(gitAt(checkout, 'rev-parse', 'HEAD^2'), prHead)
  assert.throws(() => gitAt(checkout, 'merge-base', currentBase, prHead))
  assert.equal(gitAt(checkout, 'show', 'HEAD:src/lib/mainOnlyRuntime.ts'), 'base-only runtime addition')
  assert.equal(f.classify(), 'full-validation=false')
  assert.equal(f.classify({}, checkout), 'full-validation=false')
})

test('a runtime rename into a presentation path retains the runtime side of the diff', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.cwd, 'src/views'), { recursive: true })
  renameSync(join(f.cwd, 'src/domains/rankings/internal/replay/ratingContext.ts'), join(f.cwd, 'src/views/Runtime.tsx'))
  f.commit()
  f.merge(f.base)
  assert.equal(f.classify(), 'full-validation=true')
})

test('a runtime deletion requires full validation', (t) => {
  const f = fixture(t)
  rmSync(join(f.cwd, 'src/domains/rankings/internal/replay/ratingContext.ts'))
  f.commit()
  f.merge(f.base)
  assert.equal(f.classify(), 'full-validation=true')
})

test('manual and other non-PR events require full validation', (t) => {
  const f = fixture(t)
  f.write('src/views/matches/MatchesView.tsx', 'presentation')
  f.commit()
  f.merge(f.base)
  assert.equal(f.classify(), 'full-validation=false')
  for (const event of ['workflow_dispatch', 'push', 'pull_request_target', '']) {
    assert.equal(f.classify({ GITHUB_EVENT_NAME: event }), 'full-validation=true', event)
  }
})

test('missing or mismatched synthetic PR context requires full validation', (t) => {
  const f = fixture(t)
  f.write('src/domains/rankings/internal/replay/ratingContext.ts', 'earlier runtime edit')
  const runtimeHead = f.commit()
  f.write('src/views/matches/MatchesView.tsx', 'later presentation')
  f.commit()
  // An ordinary PR head can itself be a merge commit with a UI-only first-parent delta.
  f.merge(runtimeHead)
  assert.equal(f.classify(), 'full-validation=false')
  for (const env of [
    { GITHUB_REF: 'refs/pull/130/head' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: '' },
    { GITHUB_SHA: f.base }, { GITHUB_SHA: '' },
  ]) {
    assert.equal(f.classify(env), 'full-validation=true', JSON.stringify(env))
  }
})

test('root, ordinary, octopus, and depth-one checkouts require full validation', (t) => {
  const f = fixture(t)
  assert.equal(f.classify(), 'full-validation=true')
  f.write('src/views/matches/MatchesView.tsx', 'presentation')
  const prHead = f.commit()
  assert.equal(f.classify(), 'full-validation=true')
  f.merge(f.base)
  assert.equal(f.classify({}, f.shallowCheckout(1)), 'full-validation=true')
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  const octopus = f.git(...f.identity, 'commit-tree', tree, '-p', f.base, '-p', prHead, '-p', f.git('rev-parse', 'HEAD'), '-m', 'unexpected merge')
  f.git('reset', '--hard', octopus)
  assert.equal(f.classify(), 'full-validation=true')
})

for (const parent of [1, 2]) {
  test(`an unavailable synthetic merge parent ${parent} requires full validation`, (t) => {
    const f = fixture(t)
    f.write('src/views/matches/MatchesView.tsx', 'presentation')
    f.commit()
    f.merge(f.base)
    const sha = f.git('rev-parse', `HEAD^${parent}`)
    rmSync(join(f.cwd, '.git/objects', sha.slice(0, 2), sha.slice(2)))
    assert.equal(f.classify(), 'full-validation=true')
  })
}

test('an unavailable merge diff and an empty PR diff require full validation', (t) => {
  const f = fixture(t)
  f.commit()
  f.merge(f.base)
  assert.equal(f.classify(), 'full-validation=true')
  f.write('src/views/matches/MatchesView.tsx', 'presentation')
  f.commit()
  f.merge(f.base)
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  rmSync(join(f.cwd, '.git/objects', tree.slice(0, 2), tree.slice(2)))
  assert.equal(f.classify(), 'full-validation=true')
})
