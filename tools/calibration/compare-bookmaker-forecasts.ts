import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { compareBookmakerForecasts, parseBookmakerComparison } from './lib/bookmaker-comparison.ts'

const [configPath, forecastsPath, resultsPath, quotesPath, outputPath, ...extra] = process.argv.slice(2)
if (!configPath || !forecastsPath || !resultsPath || !quotesPath || !outputPath || extra.length) {
  throw new Error('Usage: compare-bookmaker-forecasts <frozen-config.json> <forecasts.jsonl> <results.json> <quotes.json> <output.json>')
}
const paths = { config: configPath, forecasts: forecastsPath, results: resultsPath, quotes: quotesPath }
const bytes = await Promise.all(Object.values(paths).map(path => readFile(path)))
const [config, forecasts, results, quotes] = bytes.map(buffer => buffer.toString('utf8'))
const inputs = parseBookmakerComparison(JSON.parse(config), forecasts.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)), JSON.parse(results), JSON.parse(quotes))
const comparison = compareBookmakerForecasts(inputs)
const hash = (buffer: Buffer | string) => createHash('sha256').update(buffer).digest('hex')
const inputHashes = Object.fromEntries(Object.keys(paths).map((key, index) => [key, { sha256: hash(bytes[index]), bytes: bytes[index].length }]))
const receipt = { ...comparison, generatedAt: Date.now(), inputs: inputHashes, comparisonHash: hash(JSON.stringify({ inputHashes, comparison })) }
await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
console.log(`Compared ${comparison.counts.paired}/${comparison.counts.universe} series (${comparison.evidenceMode}). Predictive reference only.`)
