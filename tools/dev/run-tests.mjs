import { globSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { ensureReferencePublicData } from '../../scripts/reference-public-data.mjs'

await ensureReferencePublicData()

const browserJourneys = [...globSync('tests/**/*Browser.test.ts')].sort()
const browserSet = new Set(browserJourneys)
const isolatedTests = ['tests/ciAffectedPaths.test.mjs']
const otherTests = [...globSync('tests/**/*.test.ts'), ...globSync('tests/**/*.test.mjs')].filter((path) => !browserSet.has(path) && !isolatedTests.includes(path)).sort()

async function run(files) {
  const child = spawn('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.app.json', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
  if (code !== 0) process.exit(code)
}

await run(isolatedTests)
await run(otherTests)
for (const journey of browserJourneys) await run([journey])
