import { transaction } from "../db/client.ts";
import { compactProjectionChecksum } from "./compact-projection.ts";
import { DATASET_VERSION, EXTRACTOR_VERSION, SOURCE_SCHEMA_VERSION } from "../storage/archive.ts";
import { markArchiveVerified } from "../storage/manifest.ts";
import type { CompactProjection } from "./compact-projection.ts";

type RecordValue = Record<string, any>;

export interface PersistArchiveObject {
  key: string;
  sha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface PersistMatchInput {
  matchId: string;
  match: RecordValue;
  patch: string;
  platformRegion: string;
  routingRegion: string;
  gameVersion: string;
  tierByPuuid: Map<string, string>;
  archiveObjectId: string;
  archiveObject: PersistArchiveObject;
  projection: CompactProjection;
}

function participantRole(participant: RecordValue): string | null {
  return participant.teamPosition || participant.individualPosition || null;
}

/**
 * Publish the verified manifest, accepted match metadata, participants, and compact hot rows in
 * one transaction. It never writes the old all-frame tables or a full source JSON value.
 */
export async function persistArchivedMatch(input: PersistMatchInput): Promise<void> {
  const info = input.match.info as RecordValue;
  const participants = (info.participants ?? []) as RecordValue[];
  const projectionChecksum = compactProjectionChecksum(input.projection);
  await transaction(async (client) => {
    const existing = await client.query<{ archive_status: string }>(
      `SELECT archive_status FROM lol_dps.matches WHERE match_id=$1 FOR UPDATE`,
      [input.matchId],
    );
    if (existing.rows[0]?.archive_status === "legacy") {
      throw new Error("Refusing to replace a legacy match source row");
    }

    await markArchiveVerified(client, input.archiveObjectId, {
      objectKey: input.archiveObject.key,
      sha256: input.archiveObject.sha256,
      compressedBytes: input.archiveObject.compressedBytes,
      uncompressedBytes: input.archiveObject.uncompressedBytes,
    });

    const pointer = {
      archiveObjectKey: input.archiveObject.key,
      archiveSha256: input.archiveObject.sha256,
      archiveCompressedBytes: input.archiveObject.compressedBytes,
      archiveUncompressedBytes: input.archiveObject.uncompressedBytes,
    };
    await client.query(
      `INSERT INTO lol_dps.matches
        (match_id,patch,game_version,platform_region,routing_region,queue_id,game_start,duration_seconds,raw,
         raw_storage_kind,hot_projection_checksum,archive_status,source_schema_version,extractor_version,dataset_version)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8,$9,'archive-pointer',$10,'verified',$11,$12,$13)
       ON CONFLICT (match_id) DO UPDATE SET
         patch=EXCLUDED.patch,game_version=EXCLUDED.game_version,platform_region=EXCLUDED.platform_region,
         routing_region=EXCLUDED.routing_region,queue_id=EXCLUDED.queue_id,game_start=EXCLUDED.game_start,
         duration_seconds=EXCLUDED.duration_seconds,raw=EXCLUDED.raw,raw_storage_kind='archive-pointer',
         hot_projection_checksum=EXCLUDED.hot_projection_checksum,archive_status='verified',source_schema_version=EXCLUDED.source_schema_version,
         extractor_version=EXCLUDED.extractor_version,dataset_version=EXCLUDED.dataset_version`,
      [
        input.matchId,
        input.patch,
        input.gameVersion,
        input.platformRegion,
        input.routingRegion,
        Number(info.queueId ?? 420),
        info.gameStartTimestamp ?? null,
        Number(info.gameDuration ?? 0),
        pointer,
        projectionChecksum,
        SOURCE_SCHEMA_VERSION,
        EXTRACTOR_VERSION,
        DATASET_VERSION,
      ],
    );

    for (const participant of participants) {
      const participantId = Number(participant.participantId);
      await client.query(
        `INSERT INTO lol_dps.participants
          (match_id,participant_id,puuid,champion_id,champion_name,team_id,role,lane,tier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (match_id,participant_id) DO UPDATE SET
           puuid=EXCLUDED.puuid,champion_id=EXCLUDED.champion_id,champion_name=EXCLUDED.champion_name,
           team_id=EXCLUDED.team_id,role=EXCLUDED.role,lane=EXCLUDED.lane,
           tier=COALESCE(EXCLUDED.tier,lol_dps.participants.tier)`,
        [
          input.matchId,
          participantId,
          participant.puuid ?? null,
          Number(participant.championId),
          String(participant.championName ?? ""),
          Number(participant.teamId),
          participantRole(participant),
          participant.lane || null,
          input.tierByPuuid.get(participant.puuid) ?? null,
        ],
      );
    }

    const observationIds = new Map<string, string>();
    for (const observation of input.projection.levelObservations) {
      const result = await client.query<{ level_observation_id: string }>(
        `INSERT INTO lol_dps.level_observations
          (match_id,participant_id,level,timestamp_ms,minute,total_gold,current_gold,health_max,armor,
           magic_resist,attack_damage,attack_speed,ability_power,bonus_health_estimate,bonus_health_status,item_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (match_id,participant_id,level) DO UPDATE SET
           timestamp_ms=EXCLUDED.timestamp_ms,minute=EXCLUDED.minute,total_gold=EXCLUDED.total_gold,
           current_gold=EXCLUDED.current_gold,health_max=EXCLUDED.health_max,armor=EXCLUDED.armor,
           magic_resist=EXCLUDED.magic_resist,attack_damage=EXCLUDED.attack_damage,
           attack_speed=EXCLUDED.attack_speed,ability_power=EXCLUDED.ability_power,
           bonus_health_estimate=EXCLUDED.bonus_health_estimate,bonus_health_status=EXCLUDED.bonus_health_status,
           item_ids=EXCLUDED.item_ids
         RETURNING level_observation_id`,
        [
          input.matchId,
          observation.participantId,
          observation.level,
          observation.timestampMs,
          observation.minute,
          observation.totalGold,
          observation.currentGold,
          observation.healthMax,
          observation.armor,
          observation.magicResist,
          observation.attackDamage,
          observation.attackSpeed,
          observation.abilityPower,
          observation.bonusHealthEstimate,
          observation.bonusHealthStatus,
          observation.itemIds,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Level observation upsert returned no identity");
      observationIds.set(
        `${observation.participantId}:${observation.level}`,
        row.level_observation_id,
      );
    }

    for (const target of input.projection.levelTargets) {
      const observationId = observationIds.get(
        `${target.observationParticipantId}:${target.observationLevel}`,
      );
      if (!observationId) continue;
      await client.query(
        `INSERT INTO lol_dps.level_targets
          (level_observation_id,target_participant_id,target_level,health_max,armor,magic_resist,
           attack_damage,attack_speed,ability_power,bonus_health_estimate,bonus_health_status,minute,item_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (level_observation_id,target_participant_id) DO UPDATE SET
           target_level=EXCLUDED.target_level,health_max=EXCLUDED.health_max,armor=EXCLUDED.armor,
           magic_resist=EXCLUDED.magic_resist,attack_damage=EXCLUDED.attack_damage,
           attack_speed=EXCLUDED.attack_speed,ability_power=EXCLUDED.ability_power,
           bonus_health_estimate=EXCLUDED.bonus_health_estimate,
           bonus_health_status=EXCLUDED.bonus_health_status,minute=EXCLUDED.minute,item_ids=EXCLUDED.item_ids`,
        [
          observationId,
          target.targetParticipantId,
          target.level,
          target.healthMax,
          target.armor,
          target.magicResist,
          target.attackDamage,
          target.attackSpeed,
          target.abilityPower,
          target.bonusHealthEstimate,
          target.bonusHealthStatus,
          target.minute,
          target.itemIds,
        ],
      );
    }

    for (const sample of input.projection.scenarioSamples) {
      await client.query(
        `INSERT INTO lol_dps.hot_scenario_samples
          (patch,platform_region,phase,fallback_level,anchor_match_id,anchor_participant_id,
           anchor_timestamp_ms,anchor_event_timestamp_ms,anchor_frame_distance_ms,anchor_level,anchor_item_ids,
           target_participant_id,target_timestamp_ms,target_level,target_health_max,target_armor,target_magic_resist,
           target_attack_damage,target_attack_speed,target_ability_power,target_bonus_health_estimate,
           target_bonus_health_status,target_minute,target_item_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$7,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (phase,anchor_match_id,anchor_participant_id,anchor_timestamp_ms,target_participant_id)
         DO UPDATE SET
           fallback_level=EXCLUDED.fallback_level,anchor_event_timestamp_ms=EXCLUDED.anchor_event_timestamp_ms,
           anchor_frame_distance_ms=EXCLUDED.anchor_frame_distance_ms,anchor_level=EXCLUDED.anchor_level,
           anchor_item_ids=EXCLUDED.anchor_item_ids,target_timestamp_ms=EXCLUDED.target_timestamp_ms,
           target_level=EXCLUDED.target_level,target_health_max=EXCLUDED.target_health_max,
           target_armor=EXCLUDED.target_armor,target_magic_resist=EXCLUDED.target_magic_resist,
           target_attack_damage=EXCLUDED.target_attack_damage,target_attack_speed=EXCLUDED.target_attack_speed,
           target_ability_power=EXCLUDED.target_ability_power,
           target_bonus_health_estimate=EXCLUDED.target_bonus_health_estimate,
           target_bonus_health_status=EXCLUDED.target_bonus_health_status,target_minute=EXCLUDED.target_minute,
           target_item_ids=EXCLUDED.target_item_ids`,
        [
          input.patch,
          input.platformRegion,
          sample.phase,
          sample.fallbackLevel,
          input.matchId,
          sample.anchorParticipantId,
          sample.anchorTimestampMs,
          sample.anchorEventTimestampMs,
          sample.anchorFrameDistanceMs,
          sample.anchorLevel,
          sample.anchorItemIds,
          sample.targetParticipantId,
          sample.target.level,
          sample.target.healthMax,
          sample.target.armor,
          sample.target.magicResist,
          sample.target.attackDamage,
          sample.target.attackSpeed,
          sample.target.abilityPower,
          sample.target.bonusHealthEstimate,
          sample.target.bonusHealthStatus,
          sample.target.minute,
          sample.target.itemIds,
        ],
      );
    }
  });
}
