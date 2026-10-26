import { readFile, writeFile } from 'node:fs/promises'
import { fitSeriesForecast } from './lib/fit-series-forecast.ts'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: fit-series-forecast <fit-request.json> <fit-result.json>')
const request = JSON.parse(await readFile(input, 'utf8'))
const fitted = fitSeriesForecast(request.rows, request.fitBefore, request.grid, request.withheldEventIds)
await writeFile(output, JSON.stringify(fitted, null, 2) + '\n', { flag: 'wx' })
