import { createHash } from 'node:crypto'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { isForecastLedger, type ForecastReceipt } from '../src/lib/tournamentForecast'

/** Read-only delivery observation. It cannot certify actual play time or enable evaluation. */
export async function observeForecastDelivery(input: {
  ledgerUrl: string
  receipt: ForecastReceipt
  fetcher?: typeof fetch
  now?: () => Date
}) {
  const url = new URL(input.ledgerUrl)
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Delivery observation requires a public HTTPS URL or isolated loopback fixture')
  }
  const now = input.now ?? (() => new Date())
  const requestedAt = now().toISOString()
  const response = await (input.fetcher ?? fetch)(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Forecast delivery returned HTTP ${response.status}`)
  const body = await boundedBody(response, 8 * 1024 * 1024)
  // Local completion time, never the origin Date header, establishes this observation.
  const observedAt = now().toISOString()
  const value: unknown = JSON.parse(body.toString('utf8'))
  if (!isForecastLedger(value)) throw new Error('Published forecast ledger is invalid')
  const delivered = value.receipts[input.receipt.receiptKey]
  if (!delivered || canonicalJsonFor(delivered) !== canonicalJsonFor(input.receipt)) throw new Error('Expected immutable forecast receipt was not publicly delivered')
  if (Date.parse(observedAt) < Date.parse(requestedAt) || Date.parse(delivered.publishedAt) > Date.parse(observedAt)
    || Date.parse(observedAt) >= Date.parse(delivered.scheduledStartAt)) throw new Error('Delivery was not observed before the scheduled start')
  return {
    version: 1, kind: 'forecast-public-delivery-observation', ledgerUrl: url.toString(), requestedAt, observedAt,
    responseDate: response.headers.get('date'), etag: response.headers.get('etag'), status: response.status,
    bodySha256: digest(body), bodyBytes: body.length, receiptKey: delivered.receiptKey,
    receiptSha256: digest(Buffer.from(canonicalJsonFor(delivered))), matchId: delivered.matchId,
    snapshotId: delivered.snapshotId, modelVersion: delivered.modelVersion, modelConfigHash: delivered.modelConfigHash,
    scheduledStartAt: delivered.scheduledStartAt, evaluationEligible: false as const,
    certification: 'pending-source-approval-and-actual-play-evidence' as const,
  }
}

async function boundedBody(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error('Forecast delivery body is unavailable')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return Buffer.concat(chunks)
      bytes += result.value.length
      if (bytes > maximumBytes) throw new Error('Forecast delivery ledger exceeds observation budget')
      chunks.push(Buffer.from(result.value))
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
