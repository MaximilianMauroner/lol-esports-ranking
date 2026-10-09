import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  appendForecastReceipt, createPreMatchReceipt, emptyForecastLedger, isForecastLedger, pinPreMatchReceipt,
  type ForecastBasis, type ForecastLedger, type ForecastReceipt, type ForecastUnavailable,
} from '../src/lib/tournamentForecast'
import type { TournamentSeries } from '../src/lib/tournamentFeed'
import { createConditionalPowerResultReceipt } from '../src/lib/conditionalPowerResultReceiptBuilder'
import { isConditionalPowerResultLedger, type ConditionalPowerResultLedger } from '../src/lib/conditionalPowerResultReceipts'
import { observeForecastDelivery } from './tournament-forecast-delivery'

/** Offline-only receipt store. Nothing calls this from the collector or production worker. */
export async function publishPreMatchReceiptOffline(root: string, input: {
  series: TournamentSeries; basis: ForecastBasis; forecastRevision: string; generatedAt: string; observedAt: string
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
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(body); await handle.sync() }
    finally { await handle.close() }
    try {
      // Same-directory hard-link install is atomic and cannot overwrite an earlier revision.
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await readFile(path, 'utf8') !== body) throw new Error(`Immutable forecast artifact already exists with different content: ${path}`, { cause: error })
    }
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() }
    finally { await directory.close() }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}
async function files(path: string) {
  try { return (await readdir(path)).filter((file) => file.endsWith('.json')).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
function digest(value: string) { return createHash('sha256').update(value).digest('hex') }

/** Explicit offline companion to the forecast producer. It never activates a production writer. */
export async function publishConditionalPowerResultOffline(root: string, input: Parameters<typeof createConditionalPowerResultReceipt>[0]) {
  const result = createConditionalPowerResultReceipt(input)
  if (result.status !== 'ready') return result
  const receipt = result.receipt
  const directory = join(root, 'power-preview-receipts')
  await mkdir(directory, { recursive: true })
  const key = JSON.stringify([receipt.matchId, receipt.snapshotId, receipt.eventStateVersion, receipt.preStateId])
  await writeOnce(join(directory, `${digest(key)}.json`), receipt)
  return result
}

export async function readConditionalPowerResultsOffline(root: string): Promise<ConditionalPowerResultLedger> {
  const receipts: ConditionalPowerResultLedger['receipts'] = []
  for (const file of await files(join(root, 'power-preview-receipts'))) {
    const value: unknown = JSON.parse(await readFile(join(root, 'power-preview-receipts', file), 'utf8'))
    const candidate = { version: 1, receipts: [value] }
    if (!isConditionalPowerResultLedger(candidate)) throw new Error(`Invalid offline Power component receipt: ${file}`)
    const receipt = candidate.receipts[0]!
    const key = JSON.stringify([receipt.matchId, receipt.snapshotId, receipt.eventStateVersion, receipt.preStateId])
    if (file !== `${digest(key)}.json`) throw new Error(`Power component receipt identity mismatch: ${file}`)
    receipts.push(receipt)
  }
  const ledger: ConditionalPowerResultLedger = { version: 1, receipts }
  if (!isConditionalPowerResultLedger(ledger)) throw new Error('Ambiguous offline Power component receipts')
  return ledger
}

/** Assemble the optional static companion. The caller owns delivery; this does not publish it. */
export function conditionalPowerResultArtifact(ledger: ConditionalPowerResultLedger) {
  if (!isConditionalPowerResultLedger(ledger)) throw new Error('Invalid Power component ledger')
  return { relativePath: 'forecasts/power-previews.json', contents: JSON.stringify(ledger) + '\n' }
}

/** Keep independently fetched public bytes as immutable local audit evidence. */
export async function recordForecastDeliveryOffline(root: string, input: Parameters<typeof observeForecastDelivery>[0]) {
  const observation = await observeForecastDelivery(input)
  const directory = join(root, 'deliveries')
  await mkdir(directory, { recursive: true })
  const key = JSON.stringify([observation.receiptKey, observation.bodySha256, observation.observedAt])
  await writeOnce(join(directory, `${digest(key)}.json`), observation)
  return observation
}
