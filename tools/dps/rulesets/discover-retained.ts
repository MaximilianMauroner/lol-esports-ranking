import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../../src/domains/dps/contracts/index.ts";
import { discoverDataDragonIndex } from "../../../src/domains/dps/rulesets/ddragon-discovery.ts";
import {
  loadVerifiedRetainedSourceFiles,
  readRetainedManifest,
  type RetainedFileLimits,
} from "./verify-retained.ts";

/** Discover explicitly selected indices only after every retained source passes verification. */
export async function discoverRetainedIndices(
  manifest: unknown,
  directory: string,
  artifactIds: readonly string[],
  limits?: RetainedFileLimits,
) {
  const selected = [...artifactIds].sort();
  if (selected.length === 0 || new Set(selected).size !== selected.length)
    throw new TypeError("select at least one unique index artifact ID");
  const { sourceSet, totalBytes, retained } = await loadVerifiedRetainedSourceFiles(
    manifest,
    directory,
    limits,
  );
  const indices = [];
  for (const artifactId of selected) {
    const entry = sourceSet.sourceArtifacts.find(
      (entry) => entry.artifact.artifactId === artifactId,
    );
    const source = retained.find((entry) => entry.artifactId === artifactId);
    if (!entry || !source) throw new TypeError(`unknown index artifact ID: ${artifactId}`);
    indices.push(await discoverDataDragonIndex(entry.artifact, source.bytes));
  }
  return {
    scope: "source-discovery-only" as const,
    sourceSetId: sourceSet.sourceSetId,
    sourceSetHash: sourceSet.sourceSetHash,
    verifiedArtifactCount: sourceSet.sourceArtifacts.length,
    totalBytes,
    indices,
    undiscoveredArtifactIds: sourceSet.sourceArtifacts
      .map((entry) => entry.artifact.artifactId)
      .filter((id) => !selected.includes(id)),
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [manifestPath, directory, ...artifactIds] = process.argv.slice(2);
  if (!manifestPath || !directory || artifactIds.length === 0) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/discover-retained.ts <source-set.json> <retained-directory> <index-artifact-id>...",
    );
    process.exitCode = 2;
  } else {
    try {
      const report = await discoverRetainedIndices(
        await readRetainedManifest(manifestPath),
        directory,
        artifactIds,
      );
      console.log(canonicalJson(report));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "retained discovery failed");
      process.exitCode = 1;
    }
  }
}
