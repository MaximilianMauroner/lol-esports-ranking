import { compareAcrossSamples, simulateYunara } from "../../domains/dps/simulator.ts";
import type { Build, SimulationInput, Target } from "../../domains/dps/types.ts";

export interface WorkerSimulationRequest {
  id: number;
  base: Omit<SimulationInput, "build" | "target">;
  buildA: Build;
  buildB: Build;
  targets: Target[];
  selectedTargetId?: string;
  metric?: "damage" | "ttk";
  /** Secondary runs (draft slices, other fight lengths) do not need the grid. */
  includeBreakpoints?: boolean;
}

export interface WorkerSimulationResponse {
  id: number;
  comparison: ReturnType<typeof compareAcrossSamples>;
  representative: {
    target: Target;
    a: ReturnType<typeof simulateYunara>;
    b: ReturnType<typeof simulateYunara>;
  };
  breakpoints: Array<{ armor: number; bonusHealth: number; a: number; b: number; delta: number }>;
}

self.onmessage = (event: MessageEvent<WorkerSimulationRequest>) => {
  const request = event.data;
  const target =
    request.targets.find((candidate) => candidate.id === request.selectedTargetId) ??
    [...request.targets].sort((left, right) => left.id.localeCompare(right.id))[
      Math.floor(request.targets.length / 2)
    ];
  if (!target) return;
  const response: WorkerSimulationResponse = {
    id: request.id,
    comparison: compareAcrossSamples(
      request.base,
      request.buildA,
      request.buildB,
      request.targets,
      {
        includeEvents: false,
        metric: request.metric,
      },
    ),
    representative: {
      target,
      a: simulateYunara({ ...request.base, build: request.buildA, target }),
      b: simulateYunara({ ...request.base, build: request.buildB, target }),
    },
    breakpoints:
      request.includeBreakpoints === false
        ? []
        : breakpointGrid(request.base, request.buildA, request.buildB, target),
  };
  self.postMessage(response);
};

function breakpointGrid(
  base: Omit<SimulationInput, "build" | "target">,
  buildA: Build,
  buildB: Build,
  target: Target,
) {
  const rows: Array<{ armor: number; bonusHealth: number; a: number; b: number; delta: number }> =
    [];
  for (const armor of [0, 50, 100, 150, 200, 250, 300]) {
    for (const bonusHealth of [0, 500, 1000, 1500, 2000]) {
      const point = { ...target, id: `breakpoint-${armor}-${bonusHealth}`, armor, bonusHealth };
      const a = simulateYunara({ ...base, build: buildA, target: point }).totalDamage;
      const b = simulateYunara({ ...base, build: buildB, target: point }).totalDamage;
      rows.push({ armor, bonusHealth, a, b, delta: a - b });
    }
  }
  return rows;
}
