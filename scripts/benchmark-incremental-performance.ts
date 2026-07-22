import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { runDurableFixturePerformanceBenchmark, runProductionPerformanceBenchmark } from './benchmark-incremental-durable.ts'

function valueAfter(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const rawSamples = valueAfter('--samples')
  const samples = rawSamples === undefined ? 5 : Number(rawSamples)
  const options = { samples, assertPerformance: !process.argv.includes('--report-only') }
  const writeReport = console.log
  console.log = () => undefined
  try {
    const report = process.argv.includes('--micro')
      ? await runDurableFixturePerformanceBenchmark(options)
      : await runProductionPerformanceBenchmark({ ...options, corpusMode: process.argv.includes('--full-corpus') ? 'full' : 'representative' })
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    const output = valueAfter('--output')
    if (output) await writeFile(output, serialized)
    else writeReport(serialized)
  } finally {
    console.log = writeReport
  }
}
