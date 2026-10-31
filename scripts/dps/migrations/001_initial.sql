CREATE SCHEMA IF NOT EXISTS lol_dps;

CREATE TABLE IF NOT EXISTS lol_dps.patches (
  patch text PRIMARY KEY,
  ddragon_version text NOT NULL,
  released_at date,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lol_dps.champions (
  patch text NOT NULL REFERENCES lol_dps.patches(patch),
  champion_id integer NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  stats jsonb NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (patch, champion_id)
);

CREATE TABLE IF NOT EXISTS lol_dps.items (
  patch text NOT NULL REFERENCES lol_dps.patches(patch),
  item_id integer NOT NULL,
  name text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  gold_total integer NOT NULL DEFAULT 0,
  purchasable boolean NOT NULL DEFAULT false,
  from_ids integer[] NOT NULL DEFAULT '{}',
  into_ids integer[] NOT NULL DEFAULT '{}',
  maps jsonb NOT NULL DEFAULT '{}',
  completed_legendary boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL,
  PRIMARY KEY (patch, item_id)
);

CREATE TABLE IF NOT EXISTS lol_dps.matches (
  match_id text PRIMARY KEY,
  patch text NOT NULL,
  game_version text NOT NULL,
  platform_region text NOT NULL,
  routing_region text NOT NULL,
  queue_id integer NOT NULL,
  game_start timestamptz,
  duration_seconds integer NOT NULL,
  raw jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lol_dps.participants (
  match_id text NOT NULL REFERENCES lol_dps.matches(match_id) ON DELETE CASCADE,
  participant_id integer NOT NULL,
  puuid text,
  champion_id integer NOT NULL,
  champion_name text NOT NULL,
  team_id integer NOT NULL,
  role text,
  lane text,
  tier text,
  PRIMARY KEY (match_id, participant_id)
);

CREATE TABLE IF NOT EXISTS lol_dps.timeline_snapshots (
  snapshot_id bigserial PRIMARY KEY,
  match_id text NOT NULL REFERENCES lol_dps.matches(match_id) ON DELETE CASCADE,
  participant_id integer NOT NULL,
  timestamp_ms integer NOT NULL,
  minute numeric(6,2) NOT NULL,
  level integer NOT NULL,
  total_gold integer NOT NULL,
  current_gold integer NOT NULL,
  health_max numeric NOT NULL,
  armor numeric NOT NULL,
  magic_resist numeric NOT NULL,
  attack_damage numeric,
  attack_speed numeric,
  ability_power numeric,
  bonus_health_estimate numeric,
  UNIQUE (match_id, participant_id, timestamp_ms),
  FOREIGN KEY (match_id, participant_id)
    REFERENCES lol_dps.participants(match_id, participant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lol_dps.snapshot_items (
  snapshot_id bigint NOT NULL REFERENCES lol_dps.timeline_snapshots(snapshot_id) ON DELETE CASCADE,
  slot integer NOT NULL,
  item_id integer NOT NULL,
  PRIMARY KEY (snapshot_id, slot)
);

CREATE TABLE IF NOT EXISTS lol_dps.ingestion_runs (
  run_id uuid PRIMARY KEY,
  patch text NOT NULL,
  platform_region text NOT NULL,
  routing_region text NOT NULL,
  tiers text[] NOT NULL,
  status text NOT NULL,
  players_seen integer NOT NULL DEFAULT 0,
  matches_seen integer NOT NULL DEFAULT 0,
  matches_ingested integer NOT NULL DEFAULT 0,
  cursor jsonb NOT NULL DEFAULT '{}',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS lol_dps.scenario_samples (
  scenario_sample_id bigserial PRIMARY KEY,
  patch text NOT NULL,
  platform_region text NOT NULL,
  phase text NOT NULL,
  fallback_level integer NOT NULL,
  anchor_match_id text NOT NULL REFERENCES lol_dps.matches(match_id) ON DELETE CASCADE,
  anchor_participant_id integer NOT NULL,
  anchor_timestamp_ms integer NOT NULL,
  target_snapshot_id bigint NOT NULL REFERENCES lol_dps.timeline_snapshots(snapshot_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phase, anchor_match_id, anchor_participant_id, target_snapshot_id)
);

CREATE INDEX IF NOT EXISTS snapshots_match_minute_idx
  ON lol_dps.timeline_snapshots(match_id, minute, participant_id);
CREATE INDEX IF NOT EXISTS participants_champion_role_idx
  ON lol_dps.participants(champion_id, role, tier);
CREATE INDEX IF NOT EXISTS matches_patch_region_queue_idx
  ON lol_dps.matches(patch, platform_region, queue_id);
CREATE INDEX IF NOT EXISTS scenario_patch_region_phase_idx
  ON lol_dps.scenario_samples(patch, platform_region, phase, fallback_level);
