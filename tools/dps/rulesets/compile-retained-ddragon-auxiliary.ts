import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, hashCanonical } from "../../../src/domains/dps/contracts/index.ts";
import { discoverDataDragonAuxiliaryInventory } from "../../../src/domains/dps/rulesets/ddragon-auxiliary-inventory.ts";
import {
  loadVerifiedRetainedSourceFiles,
  readRetainedManifest,
  type RetainedFileLimits,
} from "./verify-retained.ts";

export type AuxiliarySelection = Readonly<{
  runesArtifactId: string;
  summonerArtifactId: string;
  mapArtifactId: string;
}>;

/** Verify every retained file before inventorying three Data Dragon auxiliary sources. */
export async function compileRetainedDataDragonAuxiliaryInventory(
  manifest: unknown,
  directory: string,
  selection: AuxiliarySelection,
  limits?: RetainedFileLimits,
) {
  const selected = {
    runesArtifactId: selection.runesArtifactId,
    summonerArtifactId: selection.summonerArtifactId,
    mapArtifactId: selection.mapArtifactId,
  };
  const ids = [selected.runesArtifactId, selected.summonerArtifactId, selected.mapArtifactId];
  if (ids.some((id) => !id) || new Set(ids).size !== 3)
    throw new TypeError("auxiliary inventory requires three distinct artifact IDs");
  const { sourceSet, retained } = await loadVerifiedRetainedSourceFiles(
    manifest,
    directory,
    limits,
  );
  const select = (id: string) => {
    const entry = sourceSet.sourceArtifacts.find(({ artifact }) => artifact.artifactId === id);
    const bytes = retained.find((source) => source.artifactId === id)?.bytes;
    if (!entry || !bytes) throw new TypeError(`auxiliary source artifact ${id} is missing`);
    if (entry.artifact.version !== sourceSet.dataDragonVersion)
      throw new TypeError(`auxiliary source artifact ${id} conflicts with the pinned version`);
    return { artifact: entry.artifact, bytes, retainedPath: entry.retainedPath };
  };
  const runes = select(selected.runesArtifactId);
  const summoners = select(selected.summonerArtifactId);
  const maps = select(selected.mapArtifactId);
  const inventory = await discoverDataDragonAuxiliaryInventory({ runes, summoners, maps });
  const body = {
    schemaVersion: 1 as const,
    scope: "retained-data-dragon-auxiliary-id-inventory-only" as const,
    sourceSetId: sourceSet.sourceSetId,
    sourceSetHash: sourceSet.sourceSetHash,
    selectedRetainedPaths: {
      runes: runes.retainedPath,
      summoners: summoners.retainedPath,
      maps: maps.retainedPath,
    },
    inventory,
    undiscoveredArtifactIds: sourceSet.sourceArtifacts
      .map(({ artifact }) => artifact.artifactId)
      .filter((id) => !ids.includes(id)),
  };
  return { ...body, reportHash: await hashCanonical(body) };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [manifestPath, directory, runesArtifactId, summonerArtifactId, mapArtifactId] =
    process.argv.slice(2);
  if (
    !manifestPath ||
    !directory ||
    !runesArtifactId ||
    !summonerArtifactId ||
    !mapArtifactId ||
    process.argv.length !== 7
  ) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/compile-retained-ddragon-auxiliary.ts <source-set.json> <retained-directory> <runes-id> <summoner-id> <map-id>",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(
        canonicalJson(
          await compileRetainedDataDragonAuxiliaryInventory(
            await readRetainedManifest(manifestPath),
            directory,
            { runesArtifactId, summonerArtifactId, mapArtifactId },
          ),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "auxiliary source inventory failed");
      process.exitCode = 1;
    }
  }
}
