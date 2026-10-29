import { describe, expect, test } from "vitest";
import { fixtureTargets } from "../../src/domains/dps/fixtures.ts";
import { defaultSkillRanks } from "../../src/domains/dps/skills.ts";
import type { OptimizerEvaluationContext } from "../../src/domains/dps/types.ts";
import {
  acceptsOptimizerResponse,
  OPTIMIZER_PROGRESS,
  OPTIMIZER_RESULT,
  OptimizerMemoCache,
  runOptimizerInChunks,
  type OptimizerWorkerProgress,
  type OptimizerWorkerRequest,
  type OptimizerWorkerResult,
} from "../../src/browser/dps/optimizer-protocol.ts";

const context: OptimizerEvaluationContext = {
  base: {
    level: 13,
    ranks: defaultSkillRanks(13),
    durationSeconds: 1,
    actions: [],
    continueAutos: false,
    yunTalStacks: 0,
    targetMode: "mortal",
  },
  targets: [fixtureTargets[0]!],
  objective: "fixed-window-damage",
  candidateOptions: {
    eligibleItemIds: [3006, 3008, 3031, 3032, 3036, 3085],
    allowPartialItems: true,
    constraints: { slotCount: 3, bootRule: "required" },
  },
};

function request(searchToken: string): OptimizerWorkerRequest {
  return {
    type: "optimizer/optimize",
    searchToken,
    context,
    topN: 3,
    chunkSize: 2,
  };
}

function callbacksFor(
  active: () => boolean,
  progress: OptimizerWorkerProgress[],
  results: OptimizerWorkerResult[],
  cancelled: string[],
) {
  return {
    isActive: active,
    onProgress: (message: OptimizerWorkerProgress): void => {
      progress.push(message);
    },
    onResult: (message: OptimizerWorkerResult): void => {
      results.push(message);
    },
    onCancelled: (message: { searchToken: string }): void => {
      cancelled.push(message.searchToken);
    },
    yieldControl: async () => {},
  };
}

describe("optimizer Worker protocol", () => {
  test("reports chunk progress and evaluates every candidate before returning", async () => {
    const cache = new OptimizerMemoCache();
    const progress: OptimizerWorkerProgress[] = [];
    const results: OptimizerWorkerResult[] = [];
    const cancelled: string[] = [];
    let yields = 0;
    const callbacks = callbacksFor(() => true, progress, results, cancelled);
    callbacks.yieldControl = async () => {
      yields += 1;
    };
    const outcome = await runOptimizerInChunks(request("search-1"), cache, callbacks);

    expect(outcome.status).toBe("complete");
    expect(results).toHaveLength(1);
    expect(results[0]!.result.candidateCount).toBe(12); // 2 boots × C(4 non-boots, 2)
    expect(results[0]!.result.evaluatedCount).toBe(12);
    expect(progress.map((message) => message.evaluatedCount)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(progress.every((message) => message.searchToken === "search-1")).toBe(true);
    expect(yields).toBe(5);
    expect(cancelled).toEqual([]);
    expect(cache.size).toBe(1);
  });

  test("memoizes only complete context results and is independent of search token", async () => {
    const cache = new OptimizerMemoCache();
    const firstProgress: OptimizerWorkerProgress[] = [];
    const firstResults: OptimizerWorkerResult[] = [];
    const firstCancelled: string[] = [];
    await runOptimizerInChunks(
      request("first-token"),
      cache,
      callbacksFor(() => true, firstProgress, firstResults, firstCancelled),
    );

    const secondProgress: OptimizerWorkerProgress[] = [];
    const secondResults: OptimizerWorkerResult[] = [];
    const secondCancelled: string[] = [];
    const second = await runOptimizerInChunks(
      request("new-token"),
      cache,
      callbacksFor(() => true, secondProgress, secondResults, secondCancelled),
    );

    expect(second.status).toBe("cached");
    expect(secondResults[0]!.cached).toBe(true);
    expect(secondProgress).toHaveLength(1);
    expect(secondProgress[0]!.cached).toBe(true);
    expect(secondResults[0]!.contextHash).toBe(firstResults[0]!.contextHash);
  });

  test("rejects stale token/context messages on the receiving side", () => {
    const message: OptimizerWorkerResult = {
      type: OPTIMIZER_RESULT,
      searchToken: "old",
      contextHash: "old-context",
      cached: false,
      result: {
        objective: "fixed-window-damage",
        contextHash: "old-context",
        candidateCount: 0,
        evaluatedCount: 0,
        rankings: [],
      },
    };
    expect(
      acceptsOptimizerResponse(message, { searchToken: "new", contextHash: "new-context" }),
    ).toBe(false);
    expect(
      acceptsOptimizerResponse(message, { searchToken: "old", contextHash: "new-context" }),
    ).toBe(false);
    expect(
      acceptsOptimizerResponse(message, { searchToken: "old", contextHash: "old-context" }),
    ).toBe(true);
    const progress: OptimizerWorkerProgress = {
      type: OPTIMIZER_PROGRESS,
      searchToken: "old",
      contextHash: "old-context",
      candidateCount: 1,
      evaluatedCount: 0,
      progress: 0,
      rankings: [],
      cached: false,
    };
    expect(acceptsOptimizerResponse(progress, { searchToken: "old" })).toBe(true);
  });

  test("replacement search cancels the old token before a result can be accepted", async () => {
    const cache = new OptimizerMemoCache();
    let activeToken = "old-token";
    const oldProgress: OptimizerWorkerProgress[] = [];
    const oldResults: OptimizerWorkerResult[] = [];
    const oldCancelled: string[] = [];
    const oldCallbacks = callbacksFor(
      () => activeToken === "old-token",
      oldProgress,
      oldResults,
      oldCancelled,
    );
    oldCallbacks.onProgress = (message) => {
      oldProgress.push(message);
      if (message.evaluatedCount === 2) activeToken = "new-token";
    };

    const oldOutcome = await runOptimizerInChunks(request("old-token"), cache, oldCallbacks);
    expect(oldOutcome.status).toBe("cancelled");
    expect(oldResults).toHaveLength(0);
    expect(oldCancelled).toEqual(["old-token"]);
    expect(oldProgress.map((message) => message.evaluatedCount)).toEqual([0, 2]);
    expect(cache.size).toBe(0);

    const newProgress: OptimizerWorkerProgress[] = [];
    const newResults: OptimizerWorkerResult[] = [];
    const newCancelled: string[] = [];
    const newOutcome = await runOptimizerInChunks(
      request("new-token"),
      cache,
      callbacksFor(() => activeToken === "new-token", newProgress, newResults, newCancelled),
    );
    expect(newOutcome.status).toBe("complete");
    expect(newResults).toHaveLength(1);
    expect(newResults[0]!.searchToken).toBe("new-token");
    expect(newCancelled).toEqual([]);
    expect(
      acceptsOptimizerResponse(newResults[0]!, {
        searchToken: "new-token",
        contextHash: newResults[0]!.contextHash,
      }),
    ).toBe(true);
    expect(
      acceptsOptimizerResponse(
        {
          ...newResults[0]!,
          searchToken: "old-token",
        },
        { searchToken: "new-token", contextHash: newResults[0]!.contextHash },
      ),
    ).toBe(false);
  });
});
