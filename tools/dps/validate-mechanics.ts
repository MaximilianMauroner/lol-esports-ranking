import { pathToFileURL } from "node:url";
import { readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { ValidationRecordSchema, assertObservationForPatch } from "./validation/records.ts";
import { assertMechanicTrace, TraceExpectationsSchema } from "./validation/harness.ts";

export async function validateMechanicFiles(
  recordPath: string,
  tracePath: string,
  expectationsPath: string,
  target?: { patch: string; clientVersion: string; hotfixId: string },
  capturePath?: string,
): Promise<string> {
  const [record, trace, expectations] = await Promise.all(
    [recordPath, tracePath, expectationsPath].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  const parsed = ValidationRecordSchema.parse(record);
  const linkedTrace = await realpath(resolve(dirname(recordPath), parsed.expectedTracePath));
  if (linkedTrace !== (await realpath(tracePath)))
    throw new Error("Supplied trace does not match the validation record's expectedTracePath");
  if (parsed.evidenceKind === "observed") {
    if (!target)
      throw new Error("Observed records require target patch, client version, and hotfix");
    assertObservationForPatch(parsed, target.patch, target.clientVersion, target.hotfixId);
    if (!capturePath) throw new Error("Observed records require retained capture bytes");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(capturePath)) hash.update(chunk);
    if (`sha256:${hash.digest("hex")}` !== parsed.source.contentHash)
      throw new Error("Retained capture SHA-256 does not match observation source");
  }
  assertMechanicTrace(trace, TraceExpectationsSchema.parse(expectations));
  if (parsed.discrepancy !== "none")
    throw new Error(`${parsed.fixtureId} has unresolved ${parsed.discrepancy} discrepancy`);
  return `${parsed.fixtureId}: ${parsed.evidenceKind} fixture passed; discrepancy=none${parsed.evidenceKind === "observed" ? "; capture sha256 verified" : ""}`;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3 && args.length !== 7) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/validate-mechanics.ts <record.json> <trace.json> <expectations.json> [<capture-file> <patch> <client-version> <hotfix-id>]",
    );
    process.exit(2);
  }
  try {
    console.log(
      await validateMechanicFiles(
        args[0]!,
        args[1]!,
        args[2]!,
        args.length === 7
          ? { patch: args[4]!, clientVersion: args[5]!, hotfixId: args[6]! }
          : undefined,
        args.length === 7 ? args[3]! : undefined,
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
