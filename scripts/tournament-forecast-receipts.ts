import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendForecastReceipt, createPreMatchReceipt, emptyForecastLedger, isForecastLedger, pinPreMatchReceipt,
  type ForecastLedger, type ForecastReceipt, type ForecastUnavailable, type TournamentForecast,
} from '../src/lib/tournamentForecast'
import type { TournamentSeries } from '../src/lib/tournamentFeed'

/** Offline-only receipt store. Nothing calls this from the collector or production worker. */
export async function publishPreMatchReceiptOffline(root: string, input: {
  series: TournamentSeries; forecast: TournamentForecast; forecastRevision: string; generatedAt: string; observedAt: string
}, now = new Date()): Promise<ForecastReceipt | ForecastUnavailable> {
  const result = createPreMatchReceipt({ ...input, publishedAt: now.toISOString() })
  if (result.status === 'unavailable') return result
  if (!isForecastLedger({ version: 1, receipts: { [result.receiptKey]: result }, pinned: {} })) {
    throw new Error('Invalid offline pre-match forecast receipt')
  }
  const directory = join(root, 'receipts')
  await mkdir(directory, { recursive: true })
  await writeOnce(join(directory, `${digest(result.receiptKey)}.json`), result)
  return result
}

export async function pinPreMatchReceiptOffline(root: string, series: TournamentSeries, firstStartedObservedAt: string): Promise<ForecastLedger> {
  const prior = await readForecastLedgerOffline(root)
  const next = pinPreMatchReceipt(prior, series, firstStartedObservedAt)
  const key = next.pinned[series.id]
  if (key && key !== prior.pinned[series.id]) {
    const directory = join(root, 'pins')
    await mkdir(directory, { recursive: true })
    await writeOnce(join(directory, `${digest(series.id)}.json`), { matchId: series.id, receiptKey: key })
  }
  return readForecastLedgerOffline(root)
}

export async function readForecastLedgerOffline(root: string): Promise<ForecastLedger> {
  let ledger = emptyForecastLedger
  for (const file of await files(join(root, 'receipts'))) {
    const receipt = JSON.parse(await readFile(join(root, 'receipts', file), 'utf8')) as ForecastReceipt
    if (file !== `${digest(receipt.receiptKey)}.json` || !isForecastLedger({ version: 1, receipts: { [receipt.receiptKey]: receipt }, pinned: {} })) {
      throw new Error(`Invalid offline forecast receipt: ${file}`)
    }
    ledger = appendForecastReceipt(ledger, receipt)
  }
  const pinned: Record<string, string> = {}
  for (const file of await files(join(root, 'pins'))) {
    const pin = JSON.parse(await readFile(join(root, 'pins', file), 'utf8')) as { matchId: string; receiptKey: string }
    if (file !== `${digest(pin.matchId)}.json` || !ledger.receipts[pin.receiptKey] || ledger.receipts[pin.receiptKey].matchId !== pin.matchId) {
      throw new Error(`Invalid offline forecast pin: ${file}`)
    }
    pinned[pin.matchId] = pin.receiptKey
  }
  ledger = { ...ledger, pinned }
  return ledger
}

async function writeOnce(path: string, value: unknown) {
  const body = `${JSON.stringify(value)}\n`
  try {
    await writeFile(path, body, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== body) throw new Error(`Immutable forecast artifact already exists with different content: ${path}`, { cause: error })
  }
}
async function files(path: string) {
  try { return (await readdir(path)).filter((file) => file.endsWith('.json')).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
function digest(value: string) { return createHash('sha256').update(value).digest('hex') }
