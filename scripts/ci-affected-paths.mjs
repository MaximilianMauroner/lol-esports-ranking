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

const [base, head] = process.argv.slice(2)
let fullValidation = true
if (base && head) {
  try {
    // Disable rename detection so moving a runtime file into a UI path stays relevant.
    const diff = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    })
    const paths = diff.split('\0').filter(Boolean)
    fullValidation = paths.length === 0 || paths.some((path) => !lightweightPaths.some((pattern) => pattern.test(path)))
  } catch {
    console.error('PR diff unavailable; run full validation.')
  }
}
console.log(`full-validation=${fullValidation}`)
