export interface IngestionUsage {
  acceptedMatches: number;
  requests: number;
  bucketBytes: number;
  projectedPgBytes: number;
}

export interface IngestionCeilings {
  acceptedMatches: number;
  requests: number;
  bucketBytes: number;
  projectedPgBytes: number;
}

export function nextBatchBoundary(
  usage: IngestionUsage,
  next: IngestionUsage,
  ceilings: IngestionCeilings,
): string | null {
  if (next.acceptedMatches > ceilings.acceptedMatches) return "accepted-match-ceiling";
  if (next.requests > ceilings.requests) return "request-ceiling";
  if (next.bucketBytes > ceilings.bucketBytes) return "bucket-byte-ceiling";
  if (next.projectedPgBytes > ceilings.projectedPgBytes) return "projected-pg-byte-ceiling";
  void usage;
  return null;
}
