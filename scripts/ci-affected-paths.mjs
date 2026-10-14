import { execFileSync } from 'node:child_process'

// Only known presentation and Markdown paths can avoid native/performance gates.
// Shared code, data, configuration, tests, and new paths must fail open.
const lightweightPaths = [
  /^(README|AGENTS)\.md$/,
  /^(docs\/.*|data\/README)\.md$/,
  /^src\/(components|views)\/.*\.(tsx|css)$/,
  /^src\/styles\/.*\.css$/,
  /^src\/(App\.tsx|main\.tsx|index\.css)$/,
]

const git = (...args) => execFileSync('git', args, {
  encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
})
let fullValidation = true
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  try {
    if (!/^refs\/pull\/[1-9]\d*\/merge$/.test(process.env.GITHUB_REF ?? '')) {
      throw new Error('Expected the synthetic PR merge ref')
    }
    const [head, parentLine = ''] = git('show', '--no-patch', '--format=%H%n%P', 'HEAD').trim().split('\n')
    const parents = parentLine.split(' ').filter(Boolean)
    if (head !== process.env.GITHUB_SHA || parents.length !== 2) {
      throw new Error('Expected the checked-out synthetic PR merge commit')
    }
    for (const parent of parents) git('cat-file', '-e', `${parent}^{commit}`)
    // The merged tree excludes base-only edits and includes every cumulative PR edit.
    // Disable rename detection so moving a runtime file into a UI path stays relevant.
    const diff = git('diff', '--no-renames', '--name-only', '-z', parents[0], head, '--')
    const paths = diff.split('\0').filter(Boolean)
    fullValidation = paths.length === 0 || paths.some((path) => !lightweightPaths.some((pattern) => pattern.test(path)))
  } catch {
    console.error('Synthetic PR merge diff unavailable; run full validation.')
  }
}
console.log(`full-validation=${fullValidation}`)
