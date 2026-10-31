CREATE TABLE IF NOT EXISTS lol_dps.archive_objects (
  archive_object_id bigserial PRIMARY KEY,
  object_kind text NOT NULL CHECK (object_kind IN ('match-source', 'static-source', 'cohort-pack')),
  source_match_id text,
  patch text NOT NULL,
  platform_region text,
  object_key text NOT NULL UNIQUE,
  sha256 char(64) NOT NULL UNIQUE,
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes >= 0),
  uncompressed_bytes bigint NOT NULL CHECK (uncompressed_bytes >= 0),
  source_schema_version text NOT NULL,
  extractor_version text NOT NULL,
  dataset_version text NOT NULL,
  engine_version text,
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'failed', 'legacy')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE (object_kind, source_match_id)
);

CREATE INDEX IF NOT EXISTS archive_objects_patch_status_idx
  ON lol_dps.archive_objects(patch, status, object_kind);
CREATE INDEX IF NOT EXISTS archive_objects_source_match_idx
  ON lol_dps.archive_objects(source_match_id);

ALTER TABLE lol_dps.matches
  ADD COLUMN IF NOT EXISTS archive_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS source_schema_version text,
  ADD COLUMN IF NOT EXISTS extractor_version text,
  ADD COLUMN IF NOT EXISTS dataset_version text;

CREATE TABLE IF NOT EXISTS lol_dps.cohort_manifests (
  cohort_manifest_id bigserial PRIMARY KEY,
  patch text NOT NULL,
  platform_region text NOT NULL,
  phase text NOT NULL,
  filter_hash char(64) NOT NULL,
  cohort_version text NOT NULL,
  object_key text,
  sha256 char(64),
  compressed_bytes bigint CHECK (compressed_bytes IS NULL OR compressed_bytes >= 0),
  target_count integer NOT NULL CHECK (target_count >= 0),
  distinct_match_count integer NOT NULL CHECK (distinct_match_count >= 0),
  source_schema_version text NOT NULL,
  extractor_version text NOT NULL,
  dataset_version text NOT NULL,
  engine_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('building', 'verified', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE (patch, platform_region, phase, filter_hash, cohort_version)
);

CREATE INDEX IF NOT EXISTS cohort_manifests_lookup_idx
  ON lol_dps.cohort_manifests(patch, platform_region, phase, status);
