import { importLeaguepediaSnapshot, type LeaguepediaSnapshot } from '../importers/leaguepedia'
import { importLolEsportsScheduleSnapshot, type LolEsportsScheduleSnapshot } from '../importers/lolEsports'
import { stableHash } from './hash'
import {
  PROVIDER_LEDGER_SCHEMA_VERSION,
  matchObservation,
  scheduleObservation,
  type ProviderFileFingerprint,
  type ProviderFileLedger,
  type ProviderObservation,
  type ProviderScanMetrics,
} from './providerLedger'

export function scanLeaguepediaJson({
  contents,
  fingerprint,
  previous,
  sourceUrl,
  retrievedAt,
}: {
  contents: string
  fingerprint: ProviderFileFingerprint & { provider: 'leaguepedia-cargo' }
  previous?: ProviderFileLedger
  sourceUrl?: string
  retrievedAt?: string
}): { ledger: ProviderFileLedger; metrics: ProviderScanMetrics } {
  const snapshot = JSON.parse(contents) as LeaguepediaSnapshot
  const imported = importLeaguepediaSnapshot(snapshot, { sourceFileName: fingerprint.fileId, sourceUrl, retrievedAt })
  const previousById = new Map(previous?.observations.map((observation) => [observation.id, observation]) ?? [])
  const observations: ProviderObservation[] = []
  let reused = 0
  for (const match of imported.matches) {
    const groupHash = stableHash(match)
    const id = `leaguepedia-cargo:game:${match.sourceGameId ?? match.id}`
    const old = previousById.get(id)
    if (old?.kind === 'match' && old.groupHash === groupHash) {
      observations.push(old)
      reused += 1
    } else {
      observations.push(matchObservation({ provider: 'leaguepedia-cargo', fileId: fingerprint.fileId, groupHash, match }))
    }
  }
  return {
    ledger: { schemaVersion: PROVIDER_LEDGER_SCHEMA_VERSION, fingerprint, observations, teams: imported.teams, source: imported.source },
    metrics: {
      bytesScanned: new TextEncoder().encode(contents).length,
      rowsParsed: Array.isArray(snapshot.matches) ? snapshot.matches.length : 0,
      observationsNormalized: imported.matches.length,
      observationsReused: reused,
    },
  }
}

export function scanLolEsportsJson({
  contents,
  fingerprint,
  previous,
  sourceUrl,
  retrievedAt,
}: {
  contents: string
  fingerprint: ProviderFileFingerprint & { provider: 'lol-esports-api' }
  previous?: ProviderFileLedger
  sourceUrl?: string
  retrievedAt?: string
}): { ledger: ProviderFileLedger; metrics: ProviderScanMetrics } {
  const snapshot = JSON.parse(contents) as LolEsportsScheduleSnapshot
  const imported = importLolEsportsScheduleSnapshot(snapshot, { sourceFileName: fingerprint.fileId, sourceUrl, retrievedAt })
  const previousById = new Map(previous?.observations.map((observation) => [observation.id, observation]) ?? [])
  const observations: ProviderObservation[] = []
  let reused = 0
  for (const event of imported.events) {
    const next = scheduleObservation(fingerprint.fileId, event)
    const old = previousById.get(next.id)
    if (old?.kind === 'schedule' && old.groupHash === next.groupHash) {
      observations.push(old)
      reused += 1
    } else {
      observations.push(next)
    }
  }
  return {
    ledger: { schemaVersion: PROVIDER_LEDGER_SCHEMA_VERSION, fingerprint, observations, teams: {}, source: imported.source },
    metrics: {
      bytesScanned: new TextEncoder().encode(contents).length,
      rowsParsed: imported.events.length,
      observationsNormalized: imported.events.length,
      observationsReused: reused,
    },
  }
}
