import type { ActionKind } from "../../domains/dps/types.ts";

export const COMBO_PRESETS: Array<{
  id: string;
  label: string;
  actions: ActionKind[];
  continueAutos: boolean;
}> = [
  { id: "autos", label: "Autos", actions: ["AA"], continueAutos: true },
  { id: "q-autos", label: "Q first", actions: ["Q"], continueAutos: true },
  { id: "r-q-w", label: "R Q W", actions: ["R", "Q", "W"], continueAutos: true },
];

export function actionAvailable(action: ActionKind, level: number): boolean {
  return action === "R" ? level >= 6 : level >= 1;
}
