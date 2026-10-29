import {
  OPTIMIZER_CANCEL,
  OPTIMIZER_ERROR,
  OPTIMIZER_REQUEST,
  OptimizerMemoCache,
  runOptimizerInChunks,
  type OptimizerWorkerCommand,
} from "./optimizer-protocol.ts";

const cache = new OptimizerMemoCache();
let activeRun: { searchToken: string; cancelled: boolean } | null = null;

self.onmessage = (event: MessageEvent<OptimizerWorkerCommand>) => {
  const command = event.data;
  if (command.type === OPTIMIZER_CANCEL) {
    if (!activeRun || activeRun.searchToken === command.searchToken) {
      if (activeRun) activeRun.cancelled = true;
    }
    return;
  }
  if (command.type !== OPTIMIZER_REQUEST) return;

  if (activeRun) activeRun.cancelled = true;
  const run = { searchToken: command.searchToken, cancelled: false };
  activeRun = run;
  void runOptimizerInChunks(command, cache, {
    isActive: () => activeRun === run && !run.cancelled,
    onProgress: (message) => {
      if (activeRun === run && !run.cancelled) self.postMessage(message);
    },
    onResult: (message) => {
      if (activeRun === run && !run.cancelled) self.postMessage(message);
    },
    onCancelled: (message) => {
      if (activeRun === run) self.postMessage(message);
    },
  }).catch((caught: unknown) => {
    if (activeRun !== run || run.cancelled) return;
    self.postMessage({
      type: OPTIMIZER_ERROR,
      searchToken: command.searchToken,
      message: caught instanceof Error ? caught.message : "Optimizer worker failed.",
    });
  });
};
