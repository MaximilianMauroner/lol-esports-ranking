import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const classifier = fileURLToPath(new URL('../scripts/ci-affected-paths.mjs', import.meta.url))

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-paths-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const classify = (...refs) => execFileSync(process.execPath, [classifier, ...refs], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git('init', '-q')
  write('src/lib/ratingContext.ts', 'runtime')
  const base = commit()
  return { cwd, write, commit, classify, base }
}

test('presentation and Markdown edits avoid unrelated heavy validation', (t) => {
  const f = fixture(t)
  f.write('src/views/MatchesView.tsx', 'presentation')
  f.write('src/components/ui/button.tsx', 'button')
  f.write('src/styles/base.css', 'styles')
  f.write('docs/guide.md', 'prose')
  assert.equal(f.classify(f.base, f.commit()), 'full-validation=false')
})

test('shared, model, import, worker, dependency, benchmark, and unknown paths fail open', (t) => {
  const f = fixture(t)
  for (const path of [
    'src/lib/ratingContext.ts', 'src/data/rankingConfig.ts', 'scripts/download-local-data.mjs',
    'worker/ranking-refresh/src/main.rs', 'pnpm-lock.yaml', 'scripts/benchmark-incremental-ranking.ts',
    'public/data/ranking-summary.json', 'docs/plans/ranking-accuracy/protocol.json',
    'src/future/runtime.ts', 'src/components/futureWorker.ts', 'Dockerfile.refresh', '.github/workflows/checks.yml',
  ]) {
    f.write(path, 'changed')
    const head = f.commit()
    assert.equal(f.classify(f.base, head), 'full-validation=true', path)
    // Each classification must prove this path independently.
    f.base = head
  }
})

test('a later UI push cannot hide an earlier runtime edit in the PR', (t) => {
  const f = fixture(t)
  f.write('src/lib/ratingContext.ts', 'changed runtime')
  f.commit()
  f.write('src/views/MatchesView.tsx', 'later presentation')
  assert.equal(f.classify(f.base, f.commit()), 'full-validation=true')
})

test('renames and deletions retain the runtime side of the diff', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.cwd, 'src/views'), { recursive: true })
  renameSync(join(f.cwd, 'src/lib/ratingContext.ts'), join(f.cwd, 'src/views/Runtime.tsx'))
  const moved = f.commit()
  assert.equal(f.classify(f.base, moved), 'full-validation=true')
  rmSync(join(f.cwd, 'src/views/Runtime.tsx'))
  assert.equal(f.classify(f.base, f.commit()), 'full-validation=true')
})

test('manual runs, missing refs, unavailable diffs, and empty diffs require full validation', (t) => {
  const f = fixture(t)
  for (const refs of [[], [f.base], ['missing-base', f.base], [f.base, f.base]]) {
    assert.equal(f.classify(...refs), 'full-validation=true')
  }
})
