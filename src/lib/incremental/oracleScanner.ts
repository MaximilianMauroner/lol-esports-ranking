import { parseOraclesElixirCsvRecords, normalizeOracleGame, oracleTeamProfilesForMatches, type OracleCsvRecord } from '../importers/oraclesElixir'
import { stableHash } from './hash'
import {
  PROVIDER_LEDGER_SCHEMA_VERSION,
  matchObservation,
  type ProviderFileFingerprint,
  type ProviderFileLedger,
  type ProviderObservation,
  type ProviderScanMetrics,
} from './providerLedger'

export function scanOracleCsv({
  contents,
  fingerprint,
  previous,
  sourceUrl,
  retrievedAt,
}: {
  contents: string
  fingerprint: ProviderFileFingerprint & { provider: 'oracles-elixir' }
  previous?: ProviderFileLedger
  sourceUrl?: string
  retrievedAt: string
}): { ledger: ProviderFileLedger; metrics: ProviderScanMetrics } {
  const records = parseOraclesElixirCsvRecords(contents)
  const groups = groupOracleRecords(records)
  const previousById = new Map(previous?.observations.map((observation) => [observation.id, observation]) ?? [])
  const observations: ProviderObservation[] = []
  let observationsNormalized = 0
  let observationsReused = 0

  for (const [gameId, rows] of groups) {
    const groupHash = stableHash(rows)
    const observationId = `oracles-elixir:game:${gameId}`
    const previousObservation = previousById.get(observationId)
    if (previousObservation?.kind === 'match' && previousObservation.groupHash === groupHash) {
      observations.push(previousObservation)
      observationsReused += 1
      continue
    }
    const match = normalizeOracleGame(gameId, rows, { sourceFileName: fingerprint.fileId, sourceUrl })
    if (!match) continue
    observations.push(matchObservation({ provider: 'oracles-elixir', fileId: fingerprint.fileId, groupHash, match }))
    observationsNormalized += 1
  }
  const matches = observations.flatMap((observation) => observation.kind === 'match' ? [observation.payload] : [])
  return {
    ledger: {
      schemaVersion: PROVIDER_LEDGER_SCHEMA_VERSION,
      fingerprint,
      observations,
      teams: oracleTeamProfilesForMatches(matches),
      source: {
        name: "Oracle's Elixir CSV",
        url: sourceUrl,
        fileName: fingerprint.fileId,
        retrievedAt,
        gameCount: matches.length,
        attribution: "Aggregated by Oracle's Elixir / Tim Sevenhuysen. Subject to Riot game-data policies.",
      },
    },
    metrics: {
      bytesScanned: new TextEncoder().encode(contents).length,
      rowsParsed: records.length,
      observationsNormalized,
      observationsReused,
    },
  }
}

function groupOracleRecords(records: OracleCsvRecord[]): Map<string, OracleCsvRecord[]> {
  const groups = new Map<string, OracleCsvRecord[]>()
  for (const record of records) {
    const gameId = record.gameid?.trim()
    if (!gameId) continue
    groups.set(gameId, [...(groups.get(gameId) ?? []), record])
  }
  return groups
}
