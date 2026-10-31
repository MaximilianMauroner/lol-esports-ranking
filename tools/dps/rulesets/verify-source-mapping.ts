import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSourceMapping } from "../../../src/domains/dps/rulesets/source-mapping.ts";
import { readRetainedManifest, verifyRetainedSourceFiles } from "./verify-retained.ts";

/** No output is produced until retained bytes and all mapping references pass. */
export async function verifySourceMappingFiles(
  sourceSetPath: string,
  retainedDirectory: string,
  mappingPath: string,
) {
  const sourceSetManifest = await readRetainedManifest(sourceSetPath);
  const { sourceSet, totalBytes } = await verifyRetainedSourceFiles(
    sourceSetManifest,
    retainedDirectory,
  );
  const mapping = await assertSourceMapping(await readRetainedManifest(mappingPath), sourceSet);
  return {
    scope: mapping.scope,
    sourceSetHash: sourceSet.sourceSetHash,
    mappingHash: mapping.mappingHash,
    verifiedArtifactCount: sourceSet.sourceArtifacts.length,
    totalBytes,
    regionCount: mapping.regions.length,
    modeCount: mapping.modes.length,
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/verify-source-mapping.ts <source-set.json> <retained-directory> <source-mapping.json>",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await verifySourceMappingFiles(args[0]!, args[1]!, args[2]!)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "source mapping verification failed");
      process.exitCode = 1;
    }
  }
}
