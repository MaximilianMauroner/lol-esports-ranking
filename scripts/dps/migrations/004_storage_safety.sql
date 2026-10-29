-- Storage-safety additions. Existing source and hot rows are intentionally preserved.

ALTER TABLE lol_dps.archive_objects
  ADD COLUMN IF NOT EXISTS source_identity text,
  ADD COLUMN IF NOT EXISTS upload_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_method text NOT NULL DEFAULT 'head-only',
  ADD COLUMN IF NOT EXISTS verification_checked_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS archive_objects_kind_identity_idx
  ON lol_dps.archive_objects(object_kind, source_identity)
  WHERE source_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS archive_objects_retry_idx
  ON lol_dps.archive_objects(status, next_retry_at, archive_object_id);

CREATE TABLE IF NOT EXISTS lol_dps.archive_orphans (
  orphan_object_id bigserial PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  sha256 char(64),
  compressed_bytes bigint CHECK (compressed_bytes IS NULL OR compressed_bytes >= 0),
  uncompressed_bytes bigint CHECK (uncompressed_bytes IS NULL OR uncompressed_bytes >= 0),
  source_schema_version text,
  state text NOT NULL CHECK (state IN ('unresolved', 'registered', 'tombstone')),
  reason text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS archive_orphans_state_idx
  ON lol_dps.archive_orphans(state, last_seen_at);

-- New ingestion stores one compact typed anchor per match/participant/level.
-- The original timeline remains the authoritative rebuild source in the bucket.
CREATE TABLE IF NOT EXISTS lol_dps.level_observations (
  level_observation_id bigserial PRIMARY KEY,
  match_id text NOT NULL REFERENCES lol_dps.matches(match_id) ON DELETE CASCADE,
  participant_id integer NOT NULL,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 18),
  timestamp_ms integer NOT NULL,
  minute numeric(6,2) NOT NULL,
  total_gold integer NOT NULL,
  current_gold integer NOT NULL,
  health_max numeric NOT NULL,
  armor numeric NOT NULL,
  magic_resist numeric NOT NULL,
  attack_damage numeric,
  attack_speed numeric,
  ability_power numeric,
  bonus_health_estimate numeric,
  bonus_health_status text NOT NULL,
  item_ids integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, participant_id, level)
);

CREATE INDEX IF NOT EXISTS level_observations_lookup_idx
  ON lol_dps.level_observations(match_id, level, participant_id);

CREATE TABLE IF NOT EXISTS lol_dps.level_targets (
  level_target_id bigserial PRIMARY KEY,
  level_observation_id bigint NOT NULL
    REFERENCES lol_dps.level_observations(level_observation_id) ON DELETE CASCADE,
  target_participant_id integer NOT NULL,
  target_level integer NOT NULL CHECK (target_level BETWEEN 1 AND 18),
  health_max numeric NOT NULL,
  armor numeric NOT NULL,
  magic_resist numeric NOT NULL,
  attack_damage numeric,
  attack_speed numeric,
  ability_power numeric,
  bonus_health_estimate numeric,
  bonus_health_status text NOT NULL,
  minute numeric(6,2) NOT NULL,
  item_ids integer[] NOT NULL DEFAULT '{}',
  UNIQUE (level_observation_id, target_participant_id)
);

CREATE INDEX IF NOT EXISTS level_targets_participant_idx
  ON lol_dps.level_targets(level_observation_id, target_participant_id);

-- Explicitly selected third-item/minute observations. This table is intentionally
-- denormalized at the vector boundary so no normalized item rows are needed for new data.
CREATE TABLE IF NOT EXISTS lol_dps.hot_scenario_samples (
  hot_scenario_sample_id bigserial PRIMARY KEY,
  patch text NOT NULL,
  platform_region text NOT NULL,
  phase text NOT NULL,
  fallback_level integer NOT NULL,
  anchor_match_id text NOT NULL REFERENCES lol_dps.matches(match_id) ON DELETE CASCADE,
  anchor_participant_id integer NOT NULL,
  anchor_timestamp_ms integer NOT NULL,
  anchor_event_timestamp_ms integer,
  anchor_frame_distance_ms integer,
  anchor_level integer NOT NULL CHECK (anchor_level BETWEEN 1 AND 18),
  anchor_item_ids integer[] NOT NULL DEFAULT '{}',
  target_participant_id integer NOT NULL,
  target_timestamp_ms integer NOT NULL,
  target_level integer NOT NULL CHECK (target_level BETWEEN 1 AND 18),
  target_health_max numeric NOT NULL,
  target_armor numeric NOT NULL,
  target_magic_resist numeric NOT NULL,
  target_attack_damage numeric,
  target_attack_speed numeric,
  target_ability_power numeric,
  target_bonus_health_estimate numeric,
  target_bonus_health_status text NOT NULL,
  target_minute numeric(6,2) NOT NULL,
  target_item_ids integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_timestamp_ms = anchor_timestamp_ms),
  UNIQUE (phase, anchor_match_id, anchor_participant_id, anchor_timestamp_ms, target_participant_id)
);

CREATE INDEX IF NOT EXISTS hot_scenario_lookup_idx
  ON lol_dps.hot_scenario_samples(patch, platform_region, phase, fallback_level);

COMMENT ON COLUMN lol_dps.champions.raw IS
  'Deprecated cold source copy; new static syncs archive the pinned payload and leave this NULL.';
COMMENT ON COLUMN lol_dps.items.raw IS
  'Deprecated cold source copy; new static syncs archive the pinned payload and leave this NULL.';

-- Existing raw static rows remain intact; only future inserts may omit them.
ALTER TABLE lol_dps.champions ALTER COLUMN raw DROP NOT NULL;
ALTER TABLE lol_dps.items ALTER COLUMN raw DROP NOT NULL;

-- A verified match must point at the immutable source archive. This marker keeps the
-- one pre-archive smoke row distinguishable without rewriting its raw JSONB value.
ALTER TABLE lol_dps.matches
  ADD COLUMN IF NOT EXISTS raw_storage_kind text,
  ADD COLUMN IF NOT EXISTS hot_projection_checksum char(64);

COMMENT ON COLUMN lol_dps.matches.raw IS
  'For new verified rows this is a compact archive pointer only; the one legacy full-source row remains untouched.';
COMMENT ON COLUMN lol_dps.matches.raw_storage_kind IS
  'archive-pointer for new verified rows; legacy-source/null is reserved for pre-archive data.';
