ALTER TABLE lol_dps.timeline_snapshots
  ADD COLUMN IF NOT EXISTS bonus_health_status text NOT NULL DEFAULT 'derived';

ALTER TABLE lol_dps.scenario_samples
  ADD COLUMN IF NOT EXISTS anchor_event_timestamp_ms integer,
  ADD COLUMN IF NOT EXISTS anchor_frame_distance_ms integer;

CREATE INDEX IF NOT EXISTS scenario_anchor_event_idx
  ON lol_dps.scenario_samples(patch, platform_region, phase, anchor_event_timestamp_ms);
