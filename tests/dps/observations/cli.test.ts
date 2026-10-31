import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sampleTrace } from "../contracts/fixtures.ts";
import { validateMechanicFiles } from "../../../tools/dps/validate-mechanics.ts";

test("CLI binds a trace, rejects unresolved discrepancies, and checks observed target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dps-validation-"));
  const recordPath = join(directory, "record.json");
  const tracePath = join(directory, "trace.json");
  const otherTracePath = join(directory, "other.json");
  const assertionsPath = join(directory, "assertions.json");
  const capturePath = join(directory, "retained-capture.bin");
  const captureBytes = Buffer.from("sanitized controlled capture bytes\n");
  const record = {
    fixtureId: "fixture-1",
    mechanicId: "attack",
    expectedTracePath: "trace.json",
    discrepancy: "none",
    evidenceKind: "synthetic",
    purpose: "contract assertion",
  };
  try {
    await writeFile(tracePath, JSON.stringify(sampleTrace));
    await writeFile(otherTracePath, JSON.stringify(sampleTrace));
    await writeFile(assertionsPath, JSON.stringify({ eventOrder: ["event-001", "event-002"] }));
    await writeFile(recordPath, JSON.stringify(record));
    await writeFile(capturePath, captureBytes);
    expect(await validateMechanicFiles(recordPath, tracePath, assertionsPath)).toContain(
      "synthetic fixture passed",
    );
    await expect(validateMechanicFiles(recordPath, otherTracePath, assertionsPath)).rejects.toThrow(
      "does not match",
    );
    await writeFile(recordPath, JSON.stringify({ ...record, discrepancy: "implementation" }));
    await expect(validateMechanicFiles(recordPath, tracePath, assertionsPath)).rejects.toThrow(
      "unresolved implementation",
    );

    const observed = {
      ...record,
      discrepancy: "none",
      evidenceKind: "observed",
      observationId: "observation-1",
      source: {
        sourceId: "capture-1",
        contentHash: `sha256:${createHash("sha256").update(captureBytes).digest("hex")}`,
        locator: "frame-1",
        category: "client-capture",
      },
      protocol: {
        patch: "26.18",
        clientVersion: "26.18.1",
        hotfixId: "cutoff-1",
        modeId: "sr",
        championId: "yunara",
        itemIds: [],
        initialState: { health: 100 },
        actionTimelineMs: [0],
        targetStats: { armor: 0 },
        repetitions: 1,
      },
      observedPatch: "26.18",
      reviewerId: "reviewer",
      mechanicAuthorId: "author",
      disputed: false,
    };
    delete (observed as Partial<typeof observed>).purpose;
    await writeFile(recordPath, JSON.stringify(observed));
    await expect(validateMechanicFiles(recordPath, tracePath, assertionsPath)).rejects.toThrow(
      "require target",
    );
    await expect(
      validateMechanicFiles(
        recordPath,
        tracePath,
        assertionsPath,
        {
          patch: "26.18",
          clientVersion: "26.19.1",
          hotfixId: "cutoff-1",
        },
        capturePath,
      ),
    ).rejects.toThrow("does not match");
    await expect(
      validateMechanicFiles(recordPath, tracePath, assertionsPath, {
        patch: "26.18",
        clientVersion: "26.18.1",
        hotfixId: "cutoff-1",
      }),
    ).rejects.toThrow("require retained capture bytes");
    await writeFile(capturePath, "different capture");
    await expect(
      validateMechanicFiles(
        recordPath,
        tracePath,
        assertionsPath,
        {
          patch: "26.18",
          clientVersion: "26.18.1",
          hotfixId: "cutoff-1",
        },
        capturePath,
      ),
    ).rejects.toThrow("SHA-256 does not match");
    await writeFile(capturePath, captureBytes);
    expect(
      await validateMechanicFiles(
        recordPath,
        tracePath,
        assertionsPath,
        {
          patch: "26.18",
          clientVersion: "26.18.1",
          hotfixId: "cutoff-1",
        },
        capturePath,
      ),
    ).toContain("capture sha256 verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
