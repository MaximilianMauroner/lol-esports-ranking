import { pathToFileURL } from "node:url";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  PinnedSourceSetSchema,
  assertPinnedSourceSet,
  type RetainedSourceBytes,
} from "../../../src/domains/dps/rulesets/source-validation.ts";

export type RetainedFileLimits = Readonly<{
  maxArtifactBytes: number;
  maxTotalBytes: number;
}>;
const defaultLimits: RetainedFileLimits = {
  maxArtifactBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

async function readBoundedFile(path: string, limit: number): Promise<Uint8Array> {
  // NONBLOCK prevents a replaced path to a FIFO from hanging before the file check.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new TypeError("retained artifacts must be regular files");
    if (metadata.size > limit) throw new RangeError("retained source byte limit exceeded");
    const chunks: Uint8Array[] = [];
    let size = 0;
    // Check actual bytes as well as stat: a file can grow while it is read.
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      size += chunk.length;
      if (size > limit) throw new RangeError("retained source byte limit exceeded");
      chunks.push(chunk);
    }
    return Uint8Array.from(Buffer.concat(chunks, size));
  } finally {
    await file.close();
  }
}

/** Offline verification of declared raw artifact bytes; no decompression, fetch or publication. */
export async function loadVerifiedRetainedSourceFiles(
  value: unknown,
  directory: string,
  limits: RetainedFileLimits = defaultLimits,
) {
  for (const limit of [limits.maxArtifactBytes, limits.maxTotalBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("retained file limits must be positive safe integers");
  }
  const sourceSet = PinnedSourceSetSchema.parse(value);
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory())
    throw new TypeError("retained source root must be a directory");
  const retained: RetainedSourceBytes[] = [];
  let totalBytes = 0;
  for (const entry of sourceSet.sourceArtifacts) {
    const path = await realpath(resolve(root, entry.retainedPath));
    const fromRoot = relative(root, path);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
      throw new TypeError(
        `retained artifact ${entry.artifact.artifactId} resolves outside its root`,
      );
    const bytes = await readBoundedFile(
      path,
      Math.min(limits.maxArtifactBytes, limits.maxTotalBytes - totalBytes),
    );
    totalBytes += bytes.byteLength;
    retained.push({ artifactId: entry.artifact.artifactId, bytes });
  }
  return { sourceSet: await assertPinnedSourceSet(sourceSet, retained), totalBytes, retained };
}

export async function verifyRetainedSourceFiles(
  value: unknown,
  directory: string,
  limits: RetainedFileLimits = defaultLimits,
) {
  const { sourceSet, totalBytes } = await loadVerifiedRetainedSourceFiles(value, directory, limits);
  return { sourceSet, totalBytes };
}

export async function readRetainedManifest(manifestPath: string): Promise<unknown> {
  const bytes = await readBoundedFile(manifestPath, 1024 * 1024);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function verifyRetainedManifest(manifestPath: string, directory: string) {
  return verifyRetainedSourceFiles(await readRetainedManifest(manifestPath), directory);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error(
      "Usage: pnpm exec tsx tools/dps/rulesets/verify-retained.ts <source-set.json> <retained-directory>",
    );
    process.exitCode = 2;
  } else {
    try {
      const { sourceSet, totalBytes } = await verifyRetainedManifest(args[0]!, args[1]!);
      console.log(
        JSON.stringify({
          sourceSetId: sourceSet.sourceSetId,
          sourceSetHash: sourceSet.sourceSetHash,
          verifiedArtifactCount: sourceSet.sourceArtifacts.length,
          totalBytes,
          scope: "retained-bytes-only",
        }),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "retained source verification failed");
      process.exitCode = 1;
    }
  }
}
