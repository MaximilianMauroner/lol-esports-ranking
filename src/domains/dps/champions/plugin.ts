import type { SimulationInput, SimulationResult } from "../types.ts";

export interface ChampionPlugin {
  id: number;
  slug: string;
  patch: string;
  simulate(input: SimulationInput): SimulationResult;
}
