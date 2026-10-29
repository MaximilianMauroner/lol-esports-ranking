import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, hashCanonical } from "../../../src/domains/dps/contracts/index.ts";
import { discoverCommunityDragonDirectoryRoster } from "../../../src/domains/dps/rulesets/cdragon-directory-roster.ts";
import {
  loadVerifiedRetainedSourceFiles,
  readRetainedManifest,
  type RetainedFileLimits,
} from "./verify-retained.ts";

/** Verify every retained file before matching two selected source artifacts. */
export async function compileRetainedCommunityDragonDirectoryRoster(
  manifest: unknown,
  directory: string,
  championIndexArtifactId: string,
  characterDirectoryArtifactId: string,
  limits?: RetainedFileLimits,
) {
  if (
    !championIndexArtifactId ||
    !characterDirectoryArtifactId ||
    championIndexArtifactId === characterDirectoryArtifactId
  )
    throw new TypeError("directory roster requires two distinct artifact IDs");
  const { sourceSet, retained } = await loadVerifiedRetainedSourceFiles(
    manifest,
    directory,
    limits,
  );
  const selected = [championIndexArtifactId, characterDirectoryArtifactId].map((id) => {
    const entry = sourceSet.sourceArtifacts.find(({ artifact }) => artifact.artifactId === id);
    const bytes = retained.find((source) => source.artifactId === id)?.bytes;
    if (!entry || !bytes) throw new TypeError(`directory roster source artifact ${id} is missing`);
    return { ...entry, bytes };
  });
  const [index, listing] = selected as [(typeof selected)[number], (typeof selected)[number]];
  if (
    index.artifact.version !== sourceSet.dataDragonVersion ||
    listing.artifact.version !== sourceSet.communityDragonRevision
  )
    throw new TypeError("directory roster source versions conflict with the pinned set");
  const roster = await discoverCommunityDragonDirectoryRoster(
    index.artifact,
    index.bytes,
    listing.artifact,
    listing.bytes,
  );
  const body = {
    schemaVersion: 1 as const,
    scope: "retained-community-dragon-directory-roster-only" as const,
    sourceSetId: sourceSet.sourceSetId,
    sourceSetHash: sourceSet.sourceSetHash,
    selectedRetainedPaths: {
      championIndex: index.retainedPath,
      characterDirectory: listing.retainedPath,
    },
    roster,
    undiscoveredArtifactIds: sourceSet.sourceArtifacts
      .map((source) => source.artifact.artifactId)
      .filter((id) => id !== championIndexArtifactId && id !== characterDirectoryArtifactId),
  };
  return { ...body, reportHash: await hashCanonical(body) };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [manifestPath, directory, championIndexArtifactId, characterDirectoryArtifactId] =
    process.argv.slice(2);
  if (
    !manifestPath ||
    !directory ||
    !championIndexArtifactId ||
    !characterDirectoryArtifactId ||
    process.argv.length !== 6
  ) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/compile-retained-cdragon-roster.ts <source-set.json> <retained-directory> <champion-index-id> <character-directory-id>",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(
        canonicalJson(
          await compileRetainedCommunityDragonDirectoryRoster(
            await readRetainedManifest(manifestPath),
            directory,
            championIndexArtifactId,
            characterDirectoryArtifactId,
          ),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "retained directory roster failed");
      process.exitCode = 1;
    }
  }
}
