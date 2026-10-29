import { describe, expect, test } from "vitest";
import {
  buildMatchArchive,
  compressArchive,
  inspectCompressedBytes,
  paginateArchivePages,
} from "../../scripts/dps/storage/archive.ts";
import { runArchiveFirst } from "../../scripts/dps/storage/archive-workflow.ts";
import {
  buildCompactProjection,
  compactProjectionChecksum,
} from "../../scripts/dps/ingestion/compact-projection.ts";
import { nextBatchBoundary } from "../../scripts/dps/ingestion/limits.ts";
import { compareRebuiltProjection } from "../../scripts/dps/storage/rebuild.ts";
import type { RiotTimeline } from "../../src/domains/dps/observation-types.ts";

describe("storage safety workflow", () => {
  test("archive failure fails closed before any accepted or derived rows", async () => {
    const state = {
      pending: 0,
      failed: 0,
      accepted: 0,
      participants: 0,
      snapshots: 0,
      sourceRaw: 0,
    };
    await expect(
      runArchiveFirst({
        createPendingIntent: async () => {
          state.pending += 1;
          return "intent";
        },
        markUploadAttempt: async () => undefined,
        uploadAndVerify: async () => {
          throw new Error("bucket unavailable");
        },
        markUploadFailed: async () => {
          state.failed += 1;
        },
        finalizeTransactionally: async () => {
          state.accepted += 1;
          state.participants += 10;
          state.snapshots += 1;
          state.sourceRaw += 1;
        },
      }),
    ).rejects.toThrow("bucket unavailable");
    expect(state).toEqual({
      pending: 1,
      failed: 1,
      accepted: 0,
      participants: 0,
      snapshots: 0,
      sourceRaw: 0,
    });
  });

  test("pending intent reaches verified only after the transactional finalizer", async () => {
    const events: string[] = [];
    await runArchiveFirst({
      createPendingIntent: async () => {
        events.push("pending");
        return { status: "pending" };
      },
      markUploadAttempt: async (intent) => {
        expect(intent.status).toBe("pending");
        events.push("attempt");
      },
      uploadAndVerify: async () => {
        events.push("uploaded-and-downloaded-verified");
        return { bytes: 12 };
      },
      markUploadFailed: async () => {
        events.push("failed");
      },
      finalizeTransactionally: async (intent, object) => {
        expect(intent.status).toBe("pending");
        expect(object.bytes).toBe(12);
        events.push("db-transaction-committed");
      },
    });
    expect(events).toEqual([
      "pending",
      "attempt",
      "uploaded-and-downloaded-verified",
      "db-transaction-committed",
    ]);
  });

  test("an upload followed by a DB failure leaves a recoverable pending intent", async () => {
    let failedMarkerCalled = false;
    let uploaded = false;
    await expect(
      runArchiveFirst({
        createPendingIntent: async () => ({ status: "pending" }),
        markUploadAttempt: async () => undefined,
        uploadAndVerify: async () => {
          uploaded = true;
          return "immutable-object";
        },
        markUploadFailed: async () => {
          failedMarkerCalled = true;
        },
        finalizeTransactionally: async () => {
          throw new Error("transaction rolled back");
        },
      }),
    ).rejects.toThrow("transaction rolled back");
    expect(uploaded).toBe(true);
    expect(failedMarkerCalled).toBe(false);
  });

  test("retrying the same content-addressed publication does not duplicate acceptance", async () => {
    const acceptedKeys = new Set<string>();
    const publish = () =>
      runArchiveFirst({
        createPendingIntent: async () => "same-identity",
        markUploadAttempt: async () => undefined,
        uploadAndVerify: async () => "same-key-and-bytes",
        markUploadFailed: async () => undefined,
        finalizeTransactionally: async (_intent, object) => {
          acceptedKeys.add(object);
        },
      });
    await publish();
    await publish();
    expect(acceptedKeys.size).toBe(1);
  });
});

describe("archive verification and pagination", () => {
  test("checks compressed checksum, gzip bytes, and uncompressed length", () => {
    const archive = compressArchive(buildMatchArchive({ source: "match" }, { source: "timeline" }));
    expect(
      inspectCompressedBytes(archive.compressed, {
        sha256: archive.sha256,
        compressedBytes: archive.compressedBytes,
        uncompressedBytes: archive.uncompressedBytes,
      }),
    ).toMatchObject({
      gzipMatch: true,
      checksumMatch: true,
      bytesMatch: true,
      uncompressedBytesMatch: true,
    });
    const corrupted = Uint8Array.from(archive.compressed);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! + 1) % 255;
    expect(inspectCompressedBytes(corrupted, { sha256: archive.sha256 }).checksumMatch).toBe(false);
  });

  test("follows continuation tokens past the first 1,000 objects", async () => {
    const calls: Array<string | undefined> = [];
    const objects = await paginateArchivePages(async (token) => {
      calls.push(token);
      if (!token) {
        return {
          objects: Array.from({ length: 1000 }, (_, index) => ({ key: `raw/${index}`, bytes: 1 })),
          nextContinuationToken: "page-2",
        };
      }
      return { objects: [{ key: "raw/1000", bytes: 2 }] };
    });
    expect(objects).toHaveLength(1001);
    expect(objects.at(-1)?.bytes).toBe(2);
    expect(calls).toEqual([undefined, "page-2"]);
  });
});

describe("compact hot projection", () => {
  test("keeps one latest observation per Yunara level and exact same-frame enemy vectors", () => {
    const participants = [
      { participantId: 1, championId: 804, championName: "Yunara", teamId: 100 },
      { participantId: 2, championId: 1, championName: "Target", teamId: 200 },
    ];
    const frame = (timestamp: number, level: number, targetArmor: number) => ({
      timestamp,
      participantFrames: {
        "1": {
          level,
          totalGold: timestamp,
          currentGold: 10,
          participantId: 1,
          championStats: { healthMax: 1800, armor: 60, magicResist: 40 },
        },
        "2": {
          level,
          totalGold: timestamp,
          currentGold: 10,
          participantId: 2,
          championStats: { healthMax: 2500, armor: targetArmor, magicResist: 80 },
        },
      },
      events: [],
    });
    const timeline: RiotTimeline = {
      metadata: { matchId: "fixture" },
      info: {
        frameInterval: 60_000,
        frames: [frame(60_000, 1, 100), frame(120_000, 2, 140), frame(180_000, 2, 180)],
      },
    };
    const projection = buildCompactProjection({
      participants,
      timeline,
      championStats: new Map([[804, { hp: 600, hpperlevel: 100 }]]),
      staticItems: new Map(),
      scenarioMinute: 25,
      scenarioMinuteTolerance: 2,
    });
    expect(projection.levelObservations).toHaveLength(2);
    expect(projection.levelObservations.map((row) => row.timestampMs)).toEqual([60_000, 180_000]);
    expect(projection.levelTargets).toHaveLength(2);
    expect(projection.levelTargets.find((row) => row.observationLevel === 2)).toMatchObject({
      timestampMs: 180_000,
      armor: 180,
      targetParticipantId: 2,
    });
    expect(projection.levelObservations.length).toBeLessThan(3 * participants.length);
    expect(compactProjectionChecksum(projection)).toHaveLength(64);
  });

  test("stops cleanly at storage ceilings and compares rebuild counts/checksums", () => {
    expect(
      nextBatchBoundary(
        { acceptedMatches: 1, requests: 2, bucketBytes: 10, projectedPgBytes: 20 },
        { acceptedMatches: 2, requests: 3, bucketBytes: 30, projectedPgBytes: 40 },
        { acceptedMatches: 2, requests: 3, bucketBytes: 30, projectedPgBytes: 40 },
      ),
    ).toBeNull();
    expect(
      nextBatchBoundary(
        { acceptedMatches: 1, requests: 2, bucketBytes: 10, projectedPgBytes: 20 },
        { acceptedMatches: 2, requests: 3, bucketBytes: 31, projectedPgBytes: 40 },
        { acceptedMatches: 2, requests: 3, bucketBytes: 30, projectedPgBytes: 40 },
      ),
    ).toBe("bucket-byte-ceiling");
    expect(
      compareRebuiltProjection(
        { levels: 1, targets: 2, scenarios: 3 },
        { levels: 1, targets: 2, scenarios: 3 },
        "a".repeat(64),
        "a".repeat(64),
      ),
    ).toEqual({ countMismatch: false, checksumMissing: false, checksumMismatch: false });
  });
});
