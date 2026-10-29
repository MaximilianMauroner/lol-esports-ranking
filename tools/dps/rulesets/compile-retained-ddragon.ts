import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../../src/domains/dps/contracts/index.ts";
import {
  compileDataDragonSourceCatalog,
  type DataDragonCatalogSelection,
} from "../../../src/domains/dps/rulesets/ddragon-source-catalog.ts";
import {
  loadVerifiedRetainedSourceFiles,
  readRetainedManifest,
  type RetainedFileLimits,
} from "./verify-retained.ts";

/** Offline source catalog; all retained artifacts are checked before output. */
export async function compileRetainedDataDragonCatalog(
  manifest: unknown,
  directory: string,
  selection: DataDragonCatalogSelection,
  limits?: RetainedFileLimits,
) {
  const { sourceSet, retained } = await loadVerifiedRetainedSourceFiles(
    manifest,
    directory,
    limits,
  );
  return compileDataDragonSourceCatalog(sourceSet, retained, selection);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [
    manifestPath,
    directory,
    championIndexArtifactId,
    championDetailArtifactId,
    itemIndexArtifactId,
  ] = process.argv.slice(2);
  if (
    !manifestPath ||
    !directory ||
    !championIndexArtifactId ||
    !championDetailArtifactId ||
    !itemIndexArtifactId ||
    process.argv.length !== 7
  ) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/compile-retained-ddragon.ts <source-set.json> <retained-directory> <champion-index-id> <champion-detail-id> <item-index-id>",
    );
    process.exitCode = 2;
  } else {
    try {
      const catalog = await compileRetainedDataDragonCatalog(
        await readRetainedManifest(manifestPath),
        directory,
        { championIndexArtifactId, championDetailArtifactId, itemIndexArtifactId },
      );
      console.log(canonicalJson(catalog));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "retained catalog compilation failed");
      process.exitCode = 1;
    }
  }
}
