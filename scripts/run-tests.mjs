import { globSync } from 'node:fs'
import { spawn } from 'node:child_process'

const browserJourneys = [
  'tests/rankingArchiveBrowser.test.ts',
  'tests/tournamentBrowser.test.ts',
  'tests/tournamentForecastBrowser.test.ts',
]
const browserSet = new Set(browserJourneys)
const otherTests = globSync('tests/**/*.test.ts').filter((path) => !browserSet.has(path)).sort()

async function run(files) {
  const child = spawn('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.app.json', '--test', ...files], { stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
  if (code !== 0) process.exit(code)
}

await run(otherTests)
for (const journey of browserJourneys) await run([journey])
