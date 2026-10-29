import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, hashCanonical } from "../../../src/domains/dps/contracts/index.ts";
import { discoverDataDragonItemStructure } from "../../../src/domains/dps/rulesets/ddragon-item-structure.ts";
import {
  loadVerifiedRetainedSourceFiles,
  readRetainedManifest,
  type RetainedFileLimits,
} from "./verify-retained.ts";

/** Verify the full source set, then inventory one retained Data Dragon item index. */
export async function compileRetainedDataDragonItemStructure(
  manifest: unknown,
  directory: string,
  itemArtifactId: string,
  limits?: RetainedFileLimits,
) {
  if (!itemArtifactId) throw new TypeError("item structure requires an artifact ID");
  const { sourceSet, retained } = await loadVerifiedRetainedSourceFiles(
    manifest,
    directory,
    limits,
  );
  const entry = sourceSet.sourceArtifacts.find(
    ({ artifact }) => artifact.artifactId === itemArtifactId,
  );
  const bytes = retained.find(({ artifactId }) => artifactId === itemArtifactId)?.bytes;
  if (!entry || !bytes) throw new TypeError(`item source artifact ${itemArtifactId} is missing`);
  if (entry.artifact.version !== sourceSet.dataDragonVersion)
    throw new TypeError("item source conflicts with the pinned Data Dragon version");
  const structure = await discoverDataDragonItemStructure(entry.artifact, bytes);
  const body = {
    schemaVersion: 1 as const,
    scope: "retained-data-dragon-item-structure-only" as const,
    sourceSetId: sourceSet.sourceSetId,
    sourceSetHash: sourceSet.sourceSetHash,
    selectedRetainedPath: entry.retainedPath,
    structure,
    undiscoveredArtifactIds: sourceSet.sourceArtifacts
      .map(({ artifact }) => artifact.artifactId)
      .filter((id) => id !== itemArtifactId),
  };
  return { ...body, reportHash: await hashCanonical(body) };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [manifestPath, directory, itemArtifactId] = process.argv.slice(2);
  if (!manifestPath || !directory || !itemArtifactId || process.argv.length !== 5) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/compile-retained-ddragon-item-structure.ts <source-set.json> <retained-directory> <item-index-id>",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(
        canonicalJson(
          await compileRetainedDataDragonItemStructure(
            await readRetainedManifest(manifestPath),
            directory,
            itemArtifactId,
          ),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "item structure inventory failed");
      process.exitCode = 1;
    }
  }
}
