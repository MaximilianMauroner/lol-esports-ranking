import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const SOURCE_SCHEMA_VERSION = "riot-match-timeline-v1";
export const STATIC_SOURCE_SCHEMA_VERSION = "ddragon-static-v1";
export const EXTRACTOR_VERSION = "timeline-extractor-v2";
export const DATASET_VERSION = "26.18-euw-ranked-solo-v1";
export const ENGINE_VERSION = "yunara-engine-v1";

export interface MatchArchiveSource {
  schemaVersion: string;
  match: unknown;
  timeline: unknown;
}

export interface CompressedArchive {
  source: MatchArchiveSource;
  uncompressed: Uint8Array;
  compressed: Uint8Array;
  sha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface CompressedStaticArchive {
  sourceType: "champions" | "items";
  patch: string;
  ddragonVersion: string;
  uncompressed: Uint8Array;
  compressed: Uint8Array;
  sha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface ListedArchiveObject {
  key: string;
  bytes: number;
}

export interface ArchiveListPage {
  objects: ListedArchiveObject[];
  nextContinuationToken?: string;
}

export interface ArchiveVerification {
  key: string;
  exists: boolean;
  readable: boolean;
  headBytesMatch: boolean;
  bytesMatch: boolean;
  metadataChecksumMatch: boolean;
  checksumMatch: boolean;
  metadataUncompressedBytesMatch: boolean;
  uncompressedBytesMatch: boolean;
  gzipMatch: boolean;
  contentEncodingMatch: boolean;
  sourceSchemaMatch: boolean;
  metadataUncompressedBytes: number | null;
  metadataSha256: string | null;
  actualCompressedBytes: number | null;
  actualUncompressedBytes: number | null;
  actualSha256: string | null;
}

export interface ArchiveVerificationExpected {
  sha256?: string;
  compressedBytes?: number;
  uncompressedBytes?: number;
  sourceSchemaVersion?: string;
}

export function buildMatchArchive(match: unknown, timeline: unknown): MatchArchiveSource {
  return { schemaVersion: SOURCE_SCHEMA_VERSION, match, timeline };
}

export function compressArchive(source: MatchArchiveSource): CompressedArchive {
  const uncompressed = Buffer.from(JSON.stringify(source));
  const compressed = gzipSync(uncompressed, { level: 9 });
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  return {
    source,
    uncompressed,
    compressed,
    sha256,
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

export function compressStaticArchive(
  sourceType: "champions" | "items",
  patch: string,
  ddragonVersion: string,
  sourceBytes: Uint8Array,
): CompressedStaticArchive {
  const uncompressed = Uint8Array.from(sourceBytes);
  const compressed = gzipSync(uncompressed, { level: 9 });
  return {
    sourceType,
    patch,
    ddragonVersion,
    uncompressed,
    compressed,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

export function archiveObjectKey(patch: string, region: string, sha256: string): string {
  return `raw/patch=${patch}/region=${region}/sha256=${sha256}/match-source.json.gz`;
}

export function staticArchiveObjectKey(
  patch: string,
  ddragonVersion: string,
  sourceType: "champions" | "items",
  sha256: string,
): string {
  return `static/patch=${patch}/version=${ddragonVersion}/source=${sourceType}/sha256=${sha256}/static-source.json.gz`;
}

export function matchSourceIdentity(matchId: string): string {
  return `match:${matchId}`;
}

export function staticSourceIdentity(
  patch: string,
  ddragonVersion: string,
  sourceType: "champions" | "items",
): string {
  return `static:${patch}:${ddragonVersion}:${sourceType}`;
}

export function parseRawArchiveKey(
  key: string,
): { patch: string; region: string; sha256: string } | null {
  const match =
    /^raw\/patch=([^/]+)\/region=([^/]+)\/sha256=([a-f0-9]{64})\/match-source\.json\.gz$/.exec(key);
  return match ? { patch: match[1]!, region: match[2]!, sha256: match[3]! } : null;
}

export function archiveConfig() {
  const bucket = process.env.BUCKET ?? process.env.RAILWAY_BUCKET ?? process.env.S3_BUCKET;
  const endpoint = process.env.ENDPOINT ?? process.env.S3_ENDPOINT;
  const accessKeyId = process.env.ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY;
  const region = process.env.REGION ?? process.env.S3_REGION ?? "auto";
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, accessKeyId, secretAccessKey, region };
}

function client() {
  const config = archiveConfig();
  if (!config) throw new Error("Railway bucket S3 variables are not configured");
  return {
    config,
    s3: new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: false,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }),
  };
}

function isNotFound(error: unknown): boolean {
  const typed = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
  };
  return (
    typed.$metadata?.httpStatusCode === 404 ||
    typed.name === "NotFound" ||
    typed.name === "NoSuchKey" ||
    typed.name === "NotFoundException"
  );
}

async function headObject(key: string) {
  const { config, s3 } = client();
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function downloadBytes(key: string): Promise<Uint8Array> {
  const { config, s3 } = client();
  const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  if (!result.Body) throw new Error("Archive object has no body");
  return result.Body.transformToByteArray();
}

export async function readArchiveBytes(key: string): Promise<Uint8Array> {
  return downloadBytes(key);
}

/**
 * Verify the actual stored compressed bytes, rather than trusting only HEAD metadata.
 * This function is pure so the checksum/length contract is also covered without a bucket.
 */
export function inspectCompressedBytes(
  bytes: Uint8Array,
  expected: Pick<
    ArchiveVerificationExpected,
    "sha256" | "compressedBytes" | "uncompressedBytes"
  > = {},
) {
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  let actualUncompressedBytes: number | null = null;
  let gzipMatch = false;
  try {
    actualUncompressedBytes = gunzipSync(bytes).byteLength;
    gzipMatch = true;
  } catch {
    // The caller receives a failed verification result; no source is accepted.
  }
  return {
    actualSha256,
    actualCompressedBytes: bytes.byteLength,
    actualUncompressedBytes,
    gzipMatch,
    checksumMatch: expected.sha256 === undefined || expected.sha256 === actualSha256,
    bytesMatch:
      expected.compressedBytes === undefined || expected.compressedBytes === bytes.byteLength,
    uncompressedBytesMatch:
      expected.uncompressedBytes === undefined ||
      expected.uncompressedBytes === actualUncompressedBytes,
  };
}

export async function listArchiveObjects(prefix = ""): Promise<ListedArchiveObject[]> {
  const { config, s3 } = client();
  return paginateArchivePages(async (continuationToken) => {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );
    return {
      objects: (result.Contents ?? [])
        .filter((entry): entry is typeof entry & { Key: string } => Boolean(entry.Key))
        .map((entry) => ({ key: entry.Key, bytes: Number(entry.Size ?? 0) })),
      nextContinuationToken: result.NextContinuationToken,
    };
  });
}

export async function paginateArchivePages(
  fetchPage: (continuationToken?: string) => Promise<ArchiveListPage>,
): Promise<ListedArchiveObject[]> {
  const objects: ListedArchiveObject[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await fetchPage(continuationToken);
    objects.push(...page.objects);
    const next = page.nextContinuationToken;
    continuationToken = next && next !== continuationToken ? next : undefined;
  } while (continuationToken);
  return objects;
}

export async function listArchiveKeys(prefix = "raw/"): Promise<string[]> {
  return (await listArchiveObjects(prefix)).map((entry) => entry.key);
}

export async function verifyArchiveKey(
  key: string,
  expected: ArchiveVerificationExpected = {},
): Promise<ArchiveVerification> {
  const head = await headObject(key);
  if (!head) {
    return {
      key,
      exists: false,
      readable: false,
      headBytesMatch: false,
      bytesMatch: false,
      metadataChecksumMatch: false,
      checksumMatch: false,
      metadataUncompressedBytesMatch: false,
      uncompressedBytesMatch: false,
      gzipMatch: false,
      contentEncodingMatch: false,
      sourceSchemaMatch: false,
      metadataUncompressedBytes: null,
      metadataSha256: null,
      actualCompressedBytes: null,
      actualUncompressedBytes: null,
      actualSha256: null,
    };
  }

  const metadata = head.Metadata ?? {};
  const metadataSha256 = metadata.sha256;
  const metadataUncompressedBytes = Number(metadata.uncompressed_bytes ?? NaN);
  const headBytesMatch =
    expected.compressedBytes === undefined ||
    Number(head.ContentLength ?? -1) === expected.compressedBytes;
  const expectedMetadataChecksumMatch =
    typeof metadataSha256 === "string" &&
    (expected.sha256 === undefined || metadataSha256 === expected.sha256);
  const expectedMetadataUncompressedBytesMatch =
    Number.isFinite(metadataUncompressedBytes) &&
    (expected.uncompressedBytes === undefined ||
      metadataUncompressedBytes === expected.uncompressedBytes);
  let actual;
  let readable = true;
  try {
    actual = inspectCompressedBytes(await downloadBytes(key), expected);
  } catch {
    readable = false;
    actual = {
      actualSha256: null,
      actualCompressedBytes: null,
      actualUncompressedBytes: null,
      gzipMatch: false,
      checksumMatch: false,
      bytesMatch: false,
      uncompressedBytesMatch: false,
    };
  }
  return {
    key,
    exists: true,
    readable,
    headBytesMatch,
    bytesMatch: headBytesMatch && actual.bytesMatch,
    metadataChecksumMatch:
      expectedMetadataChecksumMatch &&
      (actual.actualSha256 === null || actual.actualSha256 === metadataSha256),
    checksumMatch: actual.checksumMatch,
    metadataUncompressedBytesMatch:
      expectedMetadataUncompressedBytesMatch &&
      (actual.actualUncompressedBytes === null ||
        actual.actualUncompressedBytes === metadataUncompressedBytes),
    uncompressedBytesMatch: actual.uncompressedBytesMatch,
    gzipMatch: actual.gzipMatch,
    contentEncodingMatch: String(head.ContentEncoding ?? "").toLowerCase() === "gzip",
    sourceSchemaMatch:
      expected.sourceSchemaVersion === undefined ||
      metadata.source_schema_version === expected.sourceSchemaVersion,
    actualCompressedBytes: actual.actualCompressedBytes,
    actualUncompressedBytes: actual.actualUncompressedBytes,
    actualSha256: actual.actualSha256,
    metadataUncompressedBytes: Number.isFinite(metadataUncompressedBytes)
      ? metadataUncompressedBytes
      : null,
    metadataSha256: typeof metadataSha256 === "string" ? metadataSha256 : null,
  };
}

function verificationPassed(result: ArchiveVerification): boolean {
  return (
    result.exists &&
    result.readable &&
    result.headBytesMatch &&
    result.bytesMatch &&
    result.metadataChecksumMatch &&
    result.checksumMatch &&
    result.metadataUncompressedBytesMatch &&
    result.uncompressedBytesMatch &&
    result.gzipMatch &&
    result.contentEncodingMatch &&
    result.sourceSchemaMatch
  );
}

async function putImmutableAndVerify(
  key: string,
  compressed: Uint8Array,
  metadata: Record<string, string>,
  expected: ArchiveVerificationExpected,
): Promise<void> {
  const { config, s3 } = client();
  const existing = await headObject(key);
  if (!existing) {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: compressed,
        ContentType: "application/octet-stream",
        ContentEncoding: "gzip",
        Metadata: metadata,
      }),
    );
  }
  const verified = await verifyArchiveKey(key, expected);
  if (!verificationPassed(verified)) throw new Error("Archive verification failed");
}

export async function putVerifiedArchive(
  archive: CompressedArchive,
  input: { patch: string; region: string },
): Promise<{ key: string; sha256: string; compressedBytes: number; uncompressedBytes: number }> {
  const key = archiveObjectKey(input.patch, input.region, archive.sha256);
  await putImmutableAndVerify(
    key,
    archive.compressed,
    {
      sha256: archive.sha256,
      uncompressed_bytes: String(archive.uncompressedBytes),
      source_schema_version: SOURCE_SCHEMA_VERSION,
    },
    {
      sha256: archive.sha256,
      compressedBytes: archive.compressedBytes,
      uncompressedBytes: archive.uncompressedBytes,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    },
  );
  return {
    key,
    sha256: archive.sha256,
    compressedBytes: archive.compressedBytes,
    uncompressedBytes: archive.uncompressedBytes,
  };
}

export async function putVerifiedStaticArchive(
  archive: CompressedStaticArchive,
): Promise<{ key: string; sha256: string; compressedBytes: number; uncompressedBytes: number }> {
  const key = staticArchiveObjectKey(
    archive.patch,
    archive.ddragonVersion,
    archive.sourceType,
    archive.sha256,
  );
  await putImmutableAndVerify(
    key,
    archive.compressed,
    {
      sha256: archive.sha256,
      uncompressed_bytes: String(archive.uncompressedBytes),
      source_schema_version: STATIC_SOURCE_SCHEMA_VERSION,
      source_type: archive.sourceType,
      ddragon_version: archive.ddragonVersion,
    },
    {
      sha256: archive.sha256,
      compressedBytes: archive.compressedBytes,
      uncompressedBytes: archive.uncompressedBytes,
      sourceSchemaVersion: STATIC_SOURCE_SCHEMA_VERSION,
    },
  );
  return {
    key,
    sha256: archive.sha256,
    compressedBytes: archive.compressedBytes,
    uncompressedBytes: archive.uncompressedBytes,
  };
}

export function archiveEnabled(): boolean {
  return Boolean(archiveConfig());
}

export async function readArchivedSource(key: string): Promise<MatchArchiveSource> {
  const bytes = await downloadBytes(key);
  const source = JSON.parse(gunzipSync(bytes).toString("utf8")) as MatchArchiveSource;
  if (source.schemaVersion !== SOURCE_SCHEMA_VERSION) {
    throw new Error("Archive source schema is not supported");
  }
  return source;
}

export function sourceMatchIdentity(source: MatchArchiveSource): string | null {
  const match = source.match as { metadata?: { matchId?: unknown } } | null;
  const timeline = source.timeline as { metadata?: { matchId?: unknown } } | null;
  const matchId = typeof match?.metadata?.matchId === "string" ? match.metadata.matchId : null;
  const timelineId =
    typeof timeline?.metadata?.matchId === "string" ? timeline.metadata.matchId : null;
  return matchId && matchId === timelineId ? matchId : null;
}

export function isVerifiedArchive(result: ArchiveVerification): boolean {
  return verificationPassed(result);
}
