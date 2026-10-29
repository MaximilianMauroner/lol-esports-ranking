import { createHash } from "node:crypto";
import { deriveBonusHealthEstimate } from "../../../src/domains/dps/health.ts";
import { applyInventoryEvent } from "./inventory.ts";
import { findThirdItemAnchor, type StaticItemShape, nearestFrameWithin } from "../../../src/domains/dps/observed-items.ts";
import type { RiotItemEvent, RiotTimeline } from "../../../src/domains/dps/observation-types.ts";

type RecordValue = Record<string, any>;

export interface CompactState {
  timestampMs: number;
  minute: number;
  level: number;
  totalGold: number;
  currentGold: number;
  healthMax: number;
  armor: number;
  magicResist: number;
  attackDamage: number | null;
  attackSpeed: number | null;
  abilityPower: number | null;
  bonusHealthEstimate: number | null;
  bonusHealthStatus: string;
  itemIds: number[];
}

export interface CompactLevelObservation extends CompactState {
  participantId: number;
}

export interface CompactLevelTarget extends CompactState {
  observationParticipantId: number;
  observationLevel: number;
  targetParticipantId: number;
}

export interface CompactScenarioSample {
  phase: string;
  fallbackLevel: number;
  anchorParticipantId: number;
  anchorTimestampMs: number;
  anchorEventTimestampMs: number | null;
  anchorFrameDistanceMs: number | null;
  anchorLevel: number;
  anchorItemIds: number[];
  targetParticipantId: number;
  target: CompactState;
}

export interface CompactProjection {
  levelObservations: CompactLevelObservation[];
  levelTargets: CompactLevelTarget[];
  scenarioSamples: CompactScenarioSample[];
}

interface FrameState extends CompactState {
  participantId: number;
}

export interface CompactProjectionInput {
  participants: RecordValue[];
  timeline: RiotTimeline;
  championStats: Map<number, RecordValue>;
  staticItems: Map<number, StaticItemShape>;
  scenarioMinute: number;
  scenarioMinuteTolerance: number;
}

function numberOr(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function stateFor(
  participant: RecordValue,
  frameParticipant: RecordValue,
  timestampMs: number,
  inventory: number[],
  championStats: Map<number, RecordValue>,
): CompactState | null {
  if (!frameParticipant?.championStats) return null;
  const stats = frameParticipant.championStats as RecordValue;
  const healthMax = numberOr(stats.healthMax, 0);
  const level = Math.max(1, Math.min(18, numberOr(frameParticipant.level, 1)));
  const staticStats = championStats.get(numberOr(participant.championId, 0));
  const estimate = deriveBonusHealthEstimate(
    healthMax,
    level,
    staticStats ? numberOr(staticStats.hp, 0) : undefined,
    staticStats ? numberOr(staticStats.hpperlevel, 0) : undefined,
  );
  return {
    timestampMs,
    minute: timestampMs / 60_000,
    level,
    totalGold: numberOr(frameParticipant.totalGold, 0),
    currentGold: numberOr(frameParticipant.currentGold, 0),
    healthMax,
    armor: numberOr(stats.armor, 0),
    magicResist: numberOr(stats.magicResist, 0),
    attackDamage: stats.attackDamage == null ? null : numberOr(stats.attackDamage, 0),
    attackSpeed: stats.attackSpeed == null ? null : numberOr(stats.attackSpeed, 0),
    abilityPower: stats.abilityPower == null ? null : numberOr(stats.abilityPower, 0),
    bonusHealthEstimate: estimate.value,
    bonusHealthStatus: estimate.status,
    itemIds: [...inventory],
  };
}

function participantIds(participants: RecordValue[]): number[] {
  return participants
    .map((participant) => numberOr(participant.participantId, 0))
    .filter((participantId) => participantId > 0);
}

function sameTeam(left: RecordValue, right: RecordValue): boolean {
  return numberOr(left.teamId, 0) === numberOr(right.teamId, 0);
}

function isBotCarry(participant: RecordValue): boolean {
  return ["BOTTOM", "CARRY", "BOT"].includes(
    participant.teamPosition || participant.individualPosition,
  );
}

/**
 * Build the bounded hot representation from the original timeline. It deliberately keeps
 * only the latest frame for each Yunara participant/level and exact same-frame enemy vectors.
 * Full frames and item events stay in the verified archive and can rebuild this projection.
 */
export function buildCompactProjection(input: CompactProjectionInput): CompactProjection {
  const participants = input.participants;
  const ids = participantIds(participants);
  const orderedFrames = [...(input.timeline.info?.frames ?? [])].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const eventsByParticipant = new Map<number, RiotItemEvent[]>();
  for (const frame of orderedFrames) {
    for (const event of frame.events ?? []) {
      if (!event.participantId) continue;
      const events = eventsByParticipant.get(event.participantId) ?? [];
      events.push(event);
      eventsByParticipant.set(event.participantId, events);
    }
  }
  for (const events of eventsByParticipant.values()) {
    events.sort((left, right) => left.timestamp - right.timestamp);
  }

  const inventories = new Map(ids.map((id) => [id, [] as number[]]));
  const eventIndexes = new Map(ids.map((id) => [id, 0]));
  const frameRows = new Map<number, Array<{ timestamp: number; inventory: number[] }>>();
  const statesByParticipantAndTimestamp = new Map<string, FrameState>();

  for (const frame of orderedFrames) {
    for (const participantId of ids) {
      const events = eventsByParticipant.get(participantId) ?? [];
      let index = eventIndexes.get(participantId) ?? 0;
      while (index < events.length && events[index]!.timestamp <= frame.timestamp) {
        inventories.set(
          participantId,
          applyInventoryEvent(inventories.get(participantId) ?? [], events[index]!),
        );
        index += 1;
      }
      eventIndexes.set(participantId, index);
    }
    for (const participant of participants) {
      const participantId = numberOr(participant.participantId, 0);
      const frameParticipant = frame.participantFrames[String(participantId)] as RecordValue;
      const inventory = inventories.get(participantId) ?? [];
      const state = stateFor(
        participant,
        frameParticipant,
        frame.timestamp,
        inventory,
        input.championStats,
      );
      if (!state) continue;
      const frameList = frameRows.get(participantId) ?? [];
      frameList.push({ timestamp: frame.timestamp, inventory: [...inventory] });
      frameRows.set(participantId, frameList);
      statesByParticipantAndTimestamp.set(`${participantId}:${frame.timestamp}`, {
        participantId,
        ...state,
      });
    }
  }

  const yunara = participants.filter((participant) => numberOr(participant.championId, 0) === 804);
  const levelByKey = new Map<string, CompactLevelObservation>();
  for (const participant of yunara) {
    const participantId = numberOr(participant.participantId, 0);
    for (const frame of orderedFrames) {
      const state = statesByParticipantAndTimestamp.get(`${participantId}:${frame.timestamp}`);
      if (!state) continue;
      const key = `${participantId}:${state.level}`;
      const observation: CompactLevelObservation = {
        ...state,
      };
      const previous = levelByKey.get(key);
      if (!previous || observation.timestampMs > previous.timestampMs)
        levelByKey.set(key, observation);
    }
  }

  const levelObservations = [...levelByKey.values()].sort(
    (left, right) => left.participantId - right.participantId || left.level - right.level,
  );
  const levelTargets: CompactLevelTarget[] = [];
  for (const observation of levelObservations) {
    const anchor = participants.find(
      (participant) => numberOr(participant.participantId, 0) === observation.participantId,
    );
    if (!anchor) continue;
    for (const target of participants) {
      const targetId = numberOr(target.participantId, 0);
      if (targetId === observation.participantId || sameTeam(anchor, target)) continue;
      const targetState = statesByParticipantAndTimestamp.get(
        `${targetId}:${observation.timestampMs}`,
      );
      if (!targetState) continue;
      levelTargets.push({
        observationParticipantId: observation.participantId,
        observationLevel: observation.level,
        targetParticipantId: targetId,
        ...targetState,
      });
    }
  }

  const scenarioSamples: CompactScenarioSample[] = [];
  const anchors = [
    ...yunara.map((participant) => ({ participant, phase: "yunara-third-item", fallbackLevel: 0 })),
    ...participants
      .filter(isBotCarry)
      .map((participant) => ({ participant, phase: "bot-carry-third-item", fallbackLevel: 1 })),
  ];
  const seenScenarioKeys = new Set<string>();
  for (const anchor of anchors) {
    const anchorId = numberOr(anchor.participant.participantId, 0);
    const frames = frameRows.get(anchorId) ?? [];
    const events = eventsByParticipant.get(anchorId) ?? [];
    const third = findThirdItemAnchor(frames, events, input.staticItems);
    if (!third) continue;
    const anchorState = statesByParticipantAndTimestamp.get(`${anchorId}:${third.frameTimestamp}`);
    if (!anchorState) continue;
    addScenarioTargets(
      scenarioSamples,
      seenScenarioKeys,
      anchor,
      third.frameTimestamp,
      third.eventTimestamp,
      third.frameDistanceMs,
      anchorState,
      participants,
      statesByParticipantAndTimestamp,
    );
  }

  const minuteAnchor = participants.find(isBotCarry) ?? participants[0];
  if (minuteAnchor) {
    const anchorId = numberOr(minuteAnchor.participantId, 0);
    const frame = nearestFrameWithin(
      frameRows.get(anchorId) ?? [],
      input.scenarioMinute * 60_000,
      input.scenarioMinuteTolerance * 60_000,
    );
    if (frame) {
      const anchorState = statesByParticipantAndTimestamp.get(`${anchorId}:${frame.timestamp}`);
      if (anchorState) {
        addScenarioTargets(
          scenarioSamples,
          seenScenarioKeys,
          { participant: minuteAnchor, phase: "minute-window", fallbackLevel: 2 },
          frame.timestamp,
          null,
          null,
          anchorState,
          participants,
          statesByParticipantAndTimestamp,
        );
      }
    }
  }

  return { levelObservations, levelTargets, scenarioSamples };
}

function addScenarioTargets(
  output: CompactScenarioSample[],
  seen: Set<string>,
  anchor: { participant: RecordValue; phase: string; fallbackLevel: number },
  timestampMs: number,
  eventTimestampMs: number | null,
  frameDistanceMs: number | null,
  anchorState: FrameState,
  participants: RecordValue[],
  states: Map<string, FrameState>,
): void {
  const anchorId = numberOr(anchor.participant.participantId, 0);
  for (const target of participants) {
    const targetId = numberOr(target.participantId, 0);
    if (targetId === anchorId || sameTeam(anchor.participant, target)) continue;
    const targetState = states.get(`${targetId}:${timestampMs}`);
    if (!targetState) continue;
    const key = `${anchor.phase}:${anchorId}:${timestampMs}:${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      phase: anchor.phase,
      fallbackLevel: anchor.fallbackLevel,
      anchorParticipantId: anchorId,
      anchorTimestampMs: timestampMs,
      anchorEventTimestampMs: eventTimestampMs,
      anchorFrameDistanceMs: frameDistanceMs,
      anchorLevel: anchorState.level,
      anchorItemIds: [...anchorState.itemIds],
      targetParticipantId: targetId,
      target: { ...targetState, itemIds: [...targetState.itemIds] },
    });
  }
}

/** A conservative estimate used only for a batch ceiling, never as a billing measurement. */
export function estimateCompactProjectionBytes(projection: CompactProjection): number {
  const serialized = Buffer.byteLength(JSON.stringify(projection), "utf8");
  return Math.ceil(serialized * 1.5);
}

export function compactProjectionChecksum(projection: CompactProjection): string {
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}
