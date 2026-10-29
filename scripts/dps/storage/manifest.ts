import type { PoolClient } from "pg";
import { query, transaction } from "../db/client.ts";

export interface ArchiveIntentInput {
  objectKind: "match-source" | "static-source" | "cohort-pack";
  sourceMatchId?: string | null;
  sourceIdentity: string;
  patch: string;
  platformRegion?: string | null;
  objectKey: string;
  sha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sourceSchemaVersion: string;
  extractorVersion: string;
  datasetVersion: string;
  engineVersion?: string | null;
}

export interface ArchiveManifestRow {
  archive_object_id: string;
  object_kind: string;
  source_match_id: string | null;
  source_identity: string | null;
  patch: string;
  platform_region: string | null;
  object_key: string;
  sha256: string;
  compressed_bytes: string;
  uncompressed_bytes: string;
  source_schema_version: string;
  extractor_version: string;
  dataset_version: string;
  engine_version: string | null;
  status: "pending" | "verified" | "failed" | "legacy";
}

function descriptorMatches(row: ArchiveManifestRow, input: ArchiveIntentInput): boolean {
  return (
    row.object_key === input.objectKey &&
    row.sha256 === input.sha256 &&
    Number(row.compressed_bytes) === input.compressedBytes &&
    Number(row.uncompressed_bytes) === input.uncompressedBytes &&
    row.source_schema_version === input.sourceSchemaVersion
  );
}

/** Insert a small intent before any object upload. The row is safe to retry by identity. */
export async function ensurePendingArchiveIntent(
  client: PoolClient,
  input: ArchiveIntentInput,
): Promise<ArchiveManifestRow> {
  await client.query(
    `INSERT INTO lol_dps.archive_objects
      (object_kind,source_match_id,source_identity,patch,platform_region,object_key,sha256,
       compressed_bytes,uncompressed_bytes,source_schema_version,extractor_version,dataset_version,
       engine_version,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
     ON CONFLICT DO NOTHING`,
    [
      input.objectKind,
      input.sourceMatchId ?? null,
      input.sourceIdentity,
      input.patch,
      input.platformRegion ?? null,
      input.objectKey,
      input.sha256,
      input.compressedBytes,
      input.uncompressedBytes,
      input.sourceSchemaVersion,
      input.extractorVersion,
      input.datasetVersion,
      input.engineVersion ?? null,
    ],
  );
  const result = await client.query<ArchiveManifestRow>(
    `SELECT archive_object_id,object_kind,source_match_id,source_identity,patch,platform_region,
            object_key,sha256,compressed_bytes,uncompressed_bytes,source_schema_version,
            extractor_version,dataset_version,engine_version,status
       FROM lol_dps.archive_objects
      WHERE object_kind=$1
        AND (source_identity=$2 OR ($3::text IS NOT NULL AND source_match_id=$3))
      ORDER BY archive_object_id
      LIMIT 1
      FOR UPDATE`,
    [input.objectKind, input.sourceIdentity, input.sourceMatchId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Archive intent could not be read after insert");
  if (!descriptorMatches(row, input)) {
    throw new Error("Archive identity already points at different immutable bytes");
  }
  if (row.source_identity !== input.sourceIdentity) {
    await client.query(
      `UPDATE lol_dps.archive_objects SET source_identity=$2 WHERE archive_object_id=$1`,
      [row.archive_object_id, input.sourceIdentity],
    );
    row.source_identity = input.sourceIdentity;
  }
  if (row.status === "failed") {
    await client.query(
      `UPDATE lol_dps.archive_objects
          SET status='pending', error=NULL, next_retry_at=NULL
        WHERE archive_object_id=$1`,
      [row.archive_object_id],
    );
    row.status = "pending";
  }
  return row;
}

export async function createPendingArchiveIntent(
  input: ArchiveIntentInput,
): Promise<ArchiveManifestRow> {
  return transaction((client) => ensurePendingArchiveIntent(client, input));
}

export async function markArchiveUploadAttempt(archiveObjectId: string): Promise<void> {
  await query(
    `UPDATE lol_dps.archive_objects
        SET upload_attempts=upload_attempts+1,last_attempt_at=now(),next_retry_at=NULL,error=NULL
      WHERE archive_object_id=$1`,
    [archiveObjectId],
  );
}

export async function markArchiveFailed(archiveObjectId: string, error: unknown): Promise<void> {
  await query(
    `UPDATE lol_dps.archive_objects
        SET status='failed',error=$2,last_attempt_at=COALESCE(last_attempt_at,now()),
            next_retry_at=now()+interval '1 minute'
      WHERE archive_object_id=$1`,
    [archiveObjectId, String(error).slice(0, 1000)],
  );
}

export async function markArchiveVerified(
  client: PoolClient,
  archiveObjectId: string,
  input: Pick<ArchiveIntentInput, "objectKey" | "sha256" | "compressedBytes" | "uncompressedBytes">,
): Promise<void> {
  const result = await client.query(
    `UPDATE lol_dps.archive_objects
        SET status='verified',verified_at=COALESCE(verified_at,now()),error=NULL,next_retry_at=NULL,
            verification_method='downloaded-checksum',verification_checked_at=now()
      WHERE archive_object_id=$1 AND object_key=$2 AND sha256=$3
        AND compressed_bytes=$4 AND uncompressed_bytes=$5`,
    [
      archiveObjectId,
      input.objectKey,
      input.sha256,
      input.compressedBytes,
      input.uncompressedBytes,
    ],
  );
  if (result.rowCount !== 1) throw new Error("Archive manifest verification identity mismatch");
}

export async function markArchiveObjectFailed(
  archiveObjectId: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE lol_dps.archive_objects
        SET status='failed',error=$2,next_retry_at=now()+interval '1 minute'
      WHERE archive_object_id=$1`,
    [archiveObjectId, reason.slice(0, 1000)],
  );
}

export async function loadManifestById(
  archiveObjectId: string,
): Promise<ArchiveManifestRow | null> {
  const rows = await query<ArchiveManifestRow>(
    `SELECT archive_object_id,object_kind,source_match_id,source_identity,patch,platform_region,
            object_key,sha256,compressed_bytes,uncompressed_bytes,source_schema_version,
            extractor_version,dataset_version,engine_version,status
       FROM lol_dps.archive_objects WHERE archive_object_id=$1`,
    [archiveObjectId],
  );
  return rows[0] ?? null;
}
