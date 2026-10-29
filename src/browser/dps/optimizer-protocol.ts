import {
  DEFAULT_OPTIMIZER_TOP_N,
  evaluateOptimizerBuild,
  optimizerContextHash,
  rankOptimizerEvaluations,
} from "../../domains/dps/optimizer-engine.ts";
import { generateCandidateBuilds } from "../../domains/dps/optimizer.ts";
import type {
  OptimizerBuildEvaluation,
  OptimizerEvaluationContext,
  OptimizerRankedBuild,
  OptimizerSearchResult,
} from "../../domains/dps/types.ts";

export const OPTIMIZER_REQUEST = "optimizer/optimize" as const;
export const OPTIMIZER_CANCEL = "optimizer/cancel" as const;
export const OPTIMIZER_PROGRESS = "optimizer/progress" as const;
export const OPTIMIZER_RESULT = "optimizer/result" as const;
export const OPTIMIZER_CANCELLED = "optimizer/cancelled" as const;
export const OPTIMIZER_ERROR = "optimizer/error" as const;
export const DEFAULT_OPTIMIZER_CHUNK_SIZE = 32;

export interface OptimizerWorkerRequest {
  type: typeof OPTIMIZER_REQUEST;
  searchToken: string;
  context: OptimizerEvaluationContext;
  topN?: number;
  chunkSize?: number;
}

export interface OptimizerWorkerCancelRequest {
  type: typeof OPTIMIZER_CANCEL;
  searchToken: string;
}

export type OptimizerWorkerCommand = OptimizerWorkerRequest | OptimizerWorkerCancelRequest;

export interface OptimizerWorkerProgress {
  type: typeof OPTIMIZER_PROGRESS;
  searchToken: string;
  contextHash: string;
  candidateCount: number;
  evaluatedCount: number;
  progress: number;
  rankings: OptimizerRankedBuild[];
  cached: boolean;
}

export interface OptimizerWorkerResult {
  type: typeof OPTIMIZER_RESULT;
  searchToken: string;
  contextHash: string;
  result: OptimizerSearchResult;
  cached: boolean;
}

export interface OptimizerWorkerCancelled {
  type: typeof OPTIMIZER_CANCELLED;
  searchToken: string;
  contextHash: string;
  candidateCount: number;
  evaluatedCount: number;
}

export interface OptimizerWorkerError {
  type: typeof OPTIMIZER_ERROR;
  searchToken: string;
  message: string;
}

export type OptimizerWorkerResponse =
  OptimizerWorkerProgress | OptimizerWorkerResult | OptimizerWorkerCancelled | OptimizerWorkerError;

export class OptimizerMemoCache {
  private readonly values = new Map<string, OptimizerSearchResult>();

  get(contextHash: string): OptimizerSearchResult | undefined {
    return this.values.get(contextHash);
  }

  set(contextHash: string, result: OptimizerSearchResult): void {
    this.values.set(contextHash, result);
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}

export interface OptimizerRunCallbacks {
  isActive: () => boolean;
  onProgress: (message: OptimizerWorkerProgress) => void;
  onResult: (message: OptimizerWorkerResult) => void;
  onCancelled: (message: OptimizerWorkerCancelled) => void;
  yieldControl?: () => Promise<void>;
}

export type OptimizerRunOutcome =
  | { status: "complete" | "cached"; result: OptimizerSearchResult }
  | { status: "cancelled"; contextHash: string; candidateCount: number; evaluatedCount: number };

/**
 * Runs exhaustive evaluation in bounded chunks. The active-token callback is
 * checked before and after every chunk; callers can therefore invalidate a
 * search without waiting for the whole candidate set to finish.
 */
export async function runOptimizerInChunks(
  request: OptimizerWorkerRequest,
  cache: OptimizerMemoCache,
  callbacks: OptimizerRunCallbacks,
): Promise<OptimizerRunOutcome> {
  const candidates = generateCandidateBuilds(request.context.candidateOptions);
  const topN = normalizeTopN(request.topN);
  const contextHash = optimizerContextHash(request.context, {
    topN,
    candidateIdentities: candidates.map((candidate) => candidate.identity),
  });
  const cached = cache.get(contextHash);
  if (cached) {
    const progress = progressMessage(
      request,
      contextHash,
      cached.candidateCount,
      cached.evaluatedCount,
      cached.rankings,
      true,
    );
    callbacks.onProgress(progress);
    const resultMessage: OptimizerWorkerResult = {
      type: OPTIMIZER_RESULT,
      searchToken: request.searchToken,
      contextHash,
      result: cached,
      cached: true,
    };
    callbacks.onResult(resultMessage);
    return { status: "cached", result: cached };
  }

  const evaluations: OptimizerBuildEvaluation[] = [];
  const chunkSize = normalizeChunkSize(request.chunkSize);
  callbacks.onProgress(progressMessage(request, contextHash, candidates.length, 0, [], false));

  for (let start = 0; start < candidates.length; start += chunkSize) {
    if (!callbacks.isActive()) {
      return cancelRun(request, contextHash, candidates.length, evaluations.length, callbacks);
    }
    const end = Math.min(candidates.length, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      if (!callbacks.isActive()) {
        return cancelRun(request, contextHash, candidates.length, evaluations.length, callbacks);
      }
      evaluations.push(evaluateOptimizerBuild(request.context, candidates[index]!));
    }
    callbacks.onProgress(
      progressMessage(
        request,
        contextHash,
        candidates.length,
        evaluations.length,
        rankOptimizerEvaluations(evaluations, topN),
        false,
      ),
    );
    if (end < candidates.length) {
      await (callbacks.yieldControl ?? yieldToEventLoop)();
    }
  }

  if (!callbacks.isActive()) {
    return cancelRun(request, contextHash, candidates.length, evaluations.length, callbacks);
  }
  const result: OptimizerSearchResult = {
    objective: request.context.objective,
    contextHash,
    candidateCount: candidates.length,
    evaluatedCount: evaluations.length,
    rankings: rankOptimizerEvaluations(evaluations, topN),
  };
  // Only complete searches are cached. A partial ranking is never reusable.
  cache.set(contextHash, result);
  callbacks.onResult({
    type: OPTIMIZER_RESULT,
    searchToken: request.searchToken,
    contextHash,
    result,
    cached: false,
  });
  return { status: "complete", result };
}

export function acceptsOptimizerResponse(
  message: OptimizerWorkerResponse,
  current: { searchToken: string; contextHash?: string },
): boolean {
  if (message.searchToken !== current.searchToken) return false;
  return (
    !current.contextHash ||
    message.type === OPTIMIZER_ERROR ||
    message.contextHash === current.contextHash
  );
}

function progressMessage(
  request: OptimizerWorkerRequest,
  contextHash: string,
  candidateCount: number,
  evaluatedCount: number,
  rankings: OptimizerRankedBuild[],
  cached: boolean,
): OptimizerWorkerProgress {
  return {
    type: OPTIMIZER_PROGRESS,
    searchToken: request.searchToken,
    contextHash,
    candidateCount,
    evaluatedCount,
    progress: candidateCount ? evaluatedCount / candidateCount : 1,
    rankings,
    cached,
  };
}

function cancelRun(
  request: OptimizerWorkerRequest,
  contextHash: string,
  candidateCount: number,
  evaluatedCount: number,
  callbacks: OptimizerRunCallbacks,
): OptimizerRunOutcome {
  callbacks.onCancelled({
    type: OPTIMIZER_CANCELLED,
    searchToken: request.searchToken,
    contextHash,
    candidateCount,
    evaluatedCount,
  });
  return { status: "cancelled", contextHash, candidateCount, evaluatedCount };
}

function normalizeTopN(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_OPTIMIZER_TOP_N;
  return Math.max(1, Math.floor(value!));
}

function normalizeChunkSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_OPTIMIZER_CHUNK_SIZE;
  return Math.max(1, Math.min(256, Math.floor(value!)));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
