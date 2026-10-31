import { COMBO_PRESETS, actionAvailable } from "../../browser/dps/presets.ts";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ProgressionApiResponse } from "../../domains/dps/datasets.ts";
import {
  buildDiff,
  comparisonLabels,
  itemLabel,
  summarizeWindow,
  uniqueStrings,
  weightedShare,
  type WindowSummary,
} from "../../domains/dps/compare-view.ts";
import { cohortRequestKey, MAX_LEVEL_COHORT_TARGETS } from "../../domains/dps/cohort-cache.ts";
import { duplicateItemIds, ITEMS, itemWarnings } from "../../domains/dps/items.ts";
import { OPTIMIZER_ELIGIBLE_ITEM_IDS, optimizerContinuationForObjective } from "../../domains/dps/optimizer.ts";
import { progressionRarity } from "../../domains/dps/progression.ts";
import {
  clampSkillRanks,
  defaultSkillRanks,
  skillBounds,
  tryAdjustSkillRank,
} from "../../domains/dps/skills.ts";
import { weightedHeadlineWinner } from "../../domains/dps/simulator.ts";
import type {
  AbilityRanks,
  ActionKind,
  OptimizerCandidate,
  OptimizerEvaluationContext,
  OptimizerObjective,
  OptimizerSearchResult,
  SampleComparison,
  Target,
} from "../../domains/dps/types.ts";
import type {
  WorkerSimulationRequest,
  WorkerSimulationResponse,
} from "../../browser/dps/simulation.worker.ts";
import type {
  OptimizerWorkerCommand,
  OptimizerWorkerProgress,
  OptimizerWorkerResponse,
} from "../../browser/dps/optimizer-protocol.ts";
import { BreakpointHeat } from "../../components/dps/breakpoints.tsx";
import {
  AttackerCard,
  OpenerCard,
  TargetCard,
} from "../../components/dps/controls.tsx";
import { EnemySlices } from "../../components/dps/slices.tsx";
import { HeadToHead } from "../../components/dps/head-to-head.tsx";
import { OptimizerPanel } from "../../components/dps/optimizer.tsx";
import { EvidenceFold, LimitsFold, TraceFold } from "../../components/dps/panels.tsx";
import type { CohortPayload, DraftRow, LabDataset, LabResult } from "../../components/dps/types.ts";
import { IdenticalBuildsBand, VerdictBand } from "../../components/dps/verdict.tsx";

const PATCH = "26.18";
const DATA_VERSION = "16.18.1";
const INFINITY_EDGE = 3031;
const LORD_DOMINIKS = 3036;
const FALLBACK_CORE = [6672, 3085, 3006];
const WINDOWS = [2, 5, 10, 20] as const;
const SUPPORTED_BUILD_ITEMS = Object.keys(ITEMS)
  .map(Number)
  .sort((left, right) => left - right);

type BuildSlots = Array<number | 0>;

export default function Home() {
  const [level, setLevel] = useState(13);
  const [duration, setDuration] = useState(5);
  const [metric, setMetric] = useState<"damage" | "ttk">("damage");
  const [targetMode, setTargetMode] = useState<"realistic" | "manual">("realistic");
  const [region, setRegion] = useState("EUW1");
  const [rank, setRank] = useState("ALL");
  const [phase, setPhase] = useState("yunara-level");
  const [role, setRole] = useState("ALL");
  const [targetChampion, setTargetChampion] = useState("");
  const [targetChampionDraft, setTargetChampionDraft] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [continueAutos, setContinueAutos] = useState(true);
  const [yunTalStacks, setYunTalStacks] = useState(0);
  const [buildAItems, setBuildAItems] = useState<BuildSlots>([...FALLBACK_CORE, INFINITY_EDGE]);
  const [buildBItems, setBuildBItems] = useState<BuildSlots>([...FALLBACK_CORE, LORD_DOMINIKS]);
  const [buildsEdited, setBuildsEdited] = useState(false);
  const [progression, setProgression] = useState<ProgressionApiResponse | null>(null);
  const [progressionLoading, setProgressionLoading] = useState(true);
  const [progressionError, setProgressionError] = useState("");
  const [rankNotice, setRankNotice] = useState("");
  const [ranks, setRanks] = useState<AbilityRanks>(() => defaultSkillRanks(13));
  const [actions, setActions] = useState<ActionKind[]>(["R", "Q", "W", "AA", "AA"]);
  const [manual, setManual] = useState({
    health: 2200,
    armor: 100,
    magicResist: 60,
    bonusHealth: 500,
    level: 13,
  });
  const [result, setResult] = useState<LabResult | null>(null);
  const [windowSummaries, setWindowSummaries] = useState<WindowSummary[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showComparedTrace, setShowComparedTrace] = useState(false);
  const [optimizerObjective, setOptimizerObjective] = useState<OptimizerObjective>("sustained-dps");
  const [optimizerSlotCount, setOptimizerSlotCount] = useState(4);
  const [optimizerTopN, setOptimizerTopN] = useState(10);
  const [optimizerRunning, setOptimizerRunning] = useState(false);
  const [optimizerProgress, setOptimizerProgress] = useState<OptimizerWorkerProgress | null>(null);
  const [optimizerResult, setOptimizerResult] = useState<OptimizerSearchResult | null>(null);
  const [optimizerError, setOptimizerError] = useState("");
  const [optimizerCohortCount, setOptimizerCohortCount] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const optimizerWorkerRef = useRef<Worker | null>(null);
  const optimizerSearchRef = useRef<{ searchToken: string; contextHash?: string } | null>(null);
  const optimizerTokenRef = useRef(0);
  const optimizerSlotEditedRef = useRef(false);
  const optimizerInputKeyRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const autoRunTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cohortRef = useRef<{ key: string; payload: CohortPayload } | null>(null);
  const progressionCacheRef = useRef(new Map<number, ProgressionApiResponse>());
  const buildsEditedRef = useRef(false);
  const ranksEditedRef = useRef(false);
  const ranksRef = useRef(ranks);
  const comboEditedRef = useRef(false);
  useEffect(() => { ranksRef.current = ranks; }, [ranks]);

  const itemsA = useMemo(() => compact(buildAItems), [buildAItems]);
  const itemsB = useMemo(() => compact(buildBItems), [buildBItems]);
  const diff = useMemo(() => buildDiff(itemsA, itemsB), [itemsA, itemsB]);
  const identical = diff.onlyA.length === 0 && diff.onlyB.length === 0;
  const labels = useMemo(
    () =>
      comparisonLabels(diff, {
        a: describeBuild(itemsA, "Build A"),
        b: describeBuild(itemsB, "Build B"),
      }),
    [diff, itemsA, itemsB],
  );

  const optimizerInputKey = JSON.stringify({
    level,
    ranks,
    duration,
    actions,
    continueAutos,
    yunTalStacks,
    targetMode,
    region,
    rank,
    phase,
    role,
    targetChampion,
    manual,
    optimizerObjective,
    optimizerSlotCount,
    optimizerTopN,
  });

  useEffect(() => {
    const worker = new Worker(new URL("../../browser/dps/simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("../../browser/dps/optimizer.worker.ts", import.meta.url), {
      type: "module",
    });
    optimizerWorkerRef.current = worker;

    const onMessage = (event: MessageEvent<OptimizerWorkerResponse>) => {
      const message = event.data;
      const current = optimizerSearchRef.current;
      if (!current || !acceptsOptimizerUiResponse(message, current)) return;

      if (message.type === "optimizer/progress") {
        current.contextHash ??= message.contextHash;
        setOptimizerProgress(message);
        return;
      }
      if (message.type === "optimizer/result") {
        setOptimizerResult(message.result);
        setOptimizerProgress(null);
        setOptimizerRunning(false);
        setOptimizerError("");
        optimizerSearchRef.current = null;
        return;
      }
      if (message.type === "optimizer/cancelled") {
        setOptimizerRunning(false);
        setOptimizerProgress(null);
        setOptimizerError("Search cancelled.");
        optimizerSearchRef.current = null;
        return;
      }
      setOptimizerRunning(false);
      setOptimizerProgress(null);
      setOptimizerError(message.message);
      optimizerSearchRef.current = null;
    };

    const onError = () => {
      if (!optimizerSearchRef.current) return;
      setOptimizerRunning(false);
      setOptimizerProgress(null);
      setOptimizerError("Optimizer worker failed.");
      optimizerSearchRef.current = null;
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    return () => {
      const current = optimizerSearchRef.current;
      if (current) {
        worker.postMessage({
          type: "optimizer/cancel",
          searchToken: current.searchToken,
        } satisfies OptimizerWorkerCommand);
      }
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
      optimizerWorkerRef.current = null;
      optimizerSearchRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function loadProgression() {
      setProgressionLoading(true);
      setProgressionError("");
      try {
        const next = await loadProgressionLevel(level, progressionCacheRef.current);
        if (!active) return;
        setProgression(next);
        if (!ranksEditedRef.current) {
          const observed = next.skill?.ranks;
          setRanks(
            observed && isLegalRankShape(observed, level) ? observed : defaultSkillRanks(level),
          );
          setRankNotice("");
        }
        if (!comboEditedRef.current) {
          setActions(defaultActionsForLevel(level));
          setContinueAutos(true);
        }
        if (!buildsEditedRef.current) {
          const seeded = progressionComparison(next);
          setBuildAItems(seeded.a);
          setBuildBItems(seeded.b);
        }
      } catch (caught) {
        if (active)
          setProgressionError(caught instanceof Error ? caught.message : "Progression unavailable");
      } finally {
        if (active) setProgressionLoading(false);
      }
    }
    void loadProgression();
    return () => {
      active = false;
    };
  }, [level]);

  useEffect(() => {
    if (optimizerSlotEditedRef.current) return;
    setOptimizerSlotCount(defaultOptimizerSlotCount(progression, level));
  }, [level, progression]);

  useEffect(() => {
    if (!ranksEditedRef.current || isLegalRankShape(ranksRef.current, level)) return;
    const corrected = clampSkillRanks(ranksRef.current, level);
    setRanks(corrected);
    setRankNotice(
      `Your manual ranks were not legal at level ${level}; they were clamped to Q${corrected.q} W${corrected.w} E${corrected.e} R${corrected.r}.`,
    );
  }, [level]);

  const runWorker = useCallback((request: WorkerSimulationRequest) => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("Simulation worker is unavailable."));
    return new Promise<WorkerSimulationResponse>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerSimulationResponse>) => {
        if (event.data.id !== request.id) return;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        resolve(event.data);
      };
      const onError = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        reject(new Error("Simulation worker failed."));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(request);
    });
  }, []);

  const cancelOptimizer = useCallback((message = "Search cancelled.") => {
    const current = optimizerSearchRef.current;
    if (current) {
      optimizerWorkerRef.current?.postMessage({
        type: "optimizer/cancel",
        searchToken: current.searchToken,
      } satisfies OptimizerWorkerCommand);
    }
    optimizerSearchRef.current = null;
    setOptimizerRunning(false);
    setOptimizerProgress(null);
    setOptimizerError(message);
  }, []);

  useEffect(() => {
    const previous = optimizerInputKeyRef.current;
    optimizerInputKeyRef.current = optimizerInputKey;
    if (previous === null || previous === optimizerInputKey) return;
    cancelOptimizer("");
    setOptimizerResult(null);
    setOptimizerCohortCount(null);
  }, [cancelOptimizer, optimizerInputKey]);

  const loadCohort = useCallback(
    async (overrides: { targetChampion?: string } = {}): Promise<CohortPayload> => {
      const committedChampion = overrides.targetChampion ?? targetChampion;
      const key = cohortRequestKey({
        targetMode,
        region,
        rank,
        phase,
        role,
        targetChampion: committedChampion,
        level,
        manual,
      });
      if (cohortRef.current?.key === key) return cohortRef.current.payload;
      let payload: CohortPayload;
      if (targetMode === "manual") {
        payload = { dataset: manualDataset(manual) };
      } else {
        const response = await fetch("/api/dps/cohort", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            region,
            rank,
            phase,
            role,
            champion: committedChampion,
            level,
            limit: MAX_LEVEL_COHORT_TARGETS,
          }),
        });
        const body = (await response.json()) as CohortPayload & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Cohort retrieval failed");
        payload = body;
      }
      const targets = payload.dataset.targets;
      if (targets.length && !targets.some((target) => target.id === selectedTargetId)) {
        setSelectedTargetId(targets[Math.floor(targets.length / 2)]!.id);
      }
      cohortRef.current = { key, payload };
      return payload;
    },
    [level, manual, phase, rank, region, role, selectedTargetId, targetChampion, targetMode],
  );

  const runOptimizer = useCallback(async () => {
    if (optimizerSearchRef.current) return;
    if (!isLegalRankShape(ranks, level)) {
      const corrected = clampSkillRanks(ranks, level);
      setRanks(corrected);
      setRankNotice(
        `Ranks were invalid at level ${level}; the optimizer is paused until the legal ranks Q${corrected.q} W${corrected.w} E${corrected.e} R${corrected.r} are applied.`,
      );
      return;
    }
    const worker = optimizerWorkerRef.current;
    if (!worker) {
      setOptimizerError("Optimizer worker is unavailable.");
      return;
    }

    const searchToken = `optimizer-${++optimizerTokenRef.current}`;
    optimizerSearchRef.current = { searchToken };
    setOptimizerRunning(true);
    setOptimizerProgress(null);
    setOptimizerResult(null);
    setOptimizerError("");

    try {
      const cohort = await loadCohort();
      if (optimizerSearchRef.current?.searchToken !== searchToken) return;
      if (!cohort.dataset.targets.length) {
        throw new Error("No target snapshots matched these filters.");
      }
      setOptimizerCohortCount(cohort.dataset.targets.length);

      const context: OptimizerEvaluationContext = {
        base: {
          level,
          ranks,
          durationSeconds: duration,
          actions,
          continueAutos,
          yunTalStacks,
          targetMode: "mortal",
        },
        targets: cohort.dataset.targets,
        objective: optimizerObjective,
        candidateOptions: {
          eligibleItemIds: OPTIMIZER_ELIGIBLE_ITEM_IDS,
          constraints: {
            slotCount: optimizerSlotCount,
            bootRule: "required",
            maxBoots: 1,
          },
        },
      };
      worker.postMessage({
        type: "optimizer/optimize",
        searchToken,
        context,
        topN: optimizerTopN,
        chunkSize: 2,
      } satisfies OptimizerWorkerCommand);
    } catch (caught) {
      if (optimizerSearchRef.current?.searchToken !== searchToken) return;
      optimizerSearchRef.current = null;
      setOptimizerRunning(false);
      setOptimizerProgress(null);
      setOptimizerError(caught instanceof Error ? caught.message : "Optimizer search failed.");
    }
  }, [
    actions,
    continueAutos,
    duration,
    level,
    loadCohort,
    optimizerObjective,
    optimizerSlotCount,
    optimizerTopN,
    ranks,
    yunTalStacks,
  ]);

  const run = useCallback(
    async (overrides: { selectedTargetId?: string; targetChampion?: string } = {}) => {
      if (autoRunTimerRef.current !== null) {
        clearTimeout(autoRunTimerRef.current);
        autoRunTimerRef.current = null;
      }
      setLoading(true);
      setError("");
      try {
        if (!isLegalRankShape(ranks, level)) {
          const corrected = clampSkillRanks(ranks, level);
          setRanks(corrected);
          setRankNotice(
            `Ranks were invalid at level ${level}; the calculation is paused until the legal ranks Q${corrected.q} W${corrected.w} E${corrected.e} R${corrected.r} are applied.`,
          );
          return;
        }
        const duplicates = [...duplicateItemIds(itemsA), ...duplicateItemIds(itemsB)];
        if (duplicates.length) {
          throw new Error(
            `A build repeats ${uniqueStrings(duplicates.map(itemLabel)).join(", ")}. Remove the duplicate completed item before simulating.`,
          );
        }
        const cohort = await loadCohort(overrides);
        const dataset = cohort.dataset;
        const targets = dataset.targets;
        if (!targets.length) throw new Error("No target snapshots matched these filters.");
        const base = {
          level,
          ranks,
          durationSeconds: duration,
          actions,
          continueAutos,
          yunTalStacks,
          targetMode: "mortal" as const,
        };
        const buildA = { name: labels.a, itemIds: itemsA };
        const buildB = { name: labels.b, itemIds: itemsB };
        const main = await runWorker({
          id: ++requestIdRef.current,
          base,
          buildA,
          buildB,
          targets,
          selectedTargetId: overrides.selectedTargetId ?? selectedTargetId,
          metric,
        });
        setResult({
          dataset,
          target: main.representative.target,
          a: main.representative.a,
          b: main.representative.b,
          comparison: main.comparison,
          breakpoints: main.breakpoints,
          assumptions: `Patch ${PATCH} (Data Dragon ${DATA_VERSION}) · level ${level} · Q${ranks.q} W${ranks.w} E${ranks.e} R${ranks.r} · expected crits · Yun Tal starts at ${yunTalStacks}/125 ranged stacks.`,
          modelWarnings: uniqueStrings([
            ...main.representative.a.warnings,
            ...main.representative.b.warnings,
          ]),
        });

        if (identical) {
          setWindowSummaries([]);
          setDrafts([]);
          return;
        }
        const [summaries, draftRows] = await Promise.all([
          collectWindowSummaries({
            base,
            buildA,
            buildB,
            targets,
            metric,
            duration,
            main: main.comparison,
            runWorker,
            nextId: () => ++requestIdRef.current,
          }),
          collectDraftRows({
            base,
            buildA,
            buildB,
            targets,
            metric,
            main: main.comparison,
            enabled: targetMode === "realistic",
            runWorker,
            nextId: () => ++requestIdRef.current,
          }),
        ]);
        setWindowSummaries(summaries);
        setDrafts(draftRows);
      } catch (caught) {
        setResult(null);
        setWindowSummaries([]);
        setDrafts([]);
        setError(caught instanceof Error ? caught.message : "Simulation failed");
      } finally {
        setLoading(false);
      }
    },
    [
      actions,
      continueAutos,
      duration,
      identical,
      itemsA,
      itemsB,
      labels.a,
      labels.b,
      level,
      loadCohort,
      metric,
      ranks,
      runWorker,
      selectedTargetId,
      targetMode,
      yunTalStacks,
    ],
  );

  const autoKey = JSON.stringify({
    level, duration, metric, targetMode, region, rank, phase, role,
    buildAItems, buildBItems, ranks, actions, continueAutos, yunTalStacks,
    manual, selectedTargetId,
  });
  const runAutomatically = useEffectEvent(() => void run());
  useEffect(() => {
    const timer = setTimeout(runAutomatically, 280);
    autoRunTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (autoRunTimerRef.current === timer) autoRunTimerRef.current = null;
    };
  }, [autoKey]);

  function markBuildsEdited() {
    buildsEditedRef.current = true;
    setBuildsEdited(true);
  }

  function updateOptimizerSlotCount(next: number) {
    optimizerSlotEditedRef.current = true;
    setOptimizerSlotCount(next);
  }

  function useOptimizerBuild(candidate: OptimizerCandidate, side: "a" | "b") {
    markBuildsEdited();
    const itemIds = [...candidate.itemIds];
    if (side === "a") setBuildAItems(itemIds);
    else setBuildBItems(itemIds);
    setContinueAutos(optimizerContinuationForObjective(optimizerObjective, continueAutos));
    setMetric(optimizerObjective === "ttk" ? "ttk" : "damage");
  }

  function updateSide(side: "a" | "b", index: number, value: number | null) {
    markBuildsEdited();
    const setter = side === "a" ? setBuildAItems : setBuildBItems;
    setter((current) => writeSlot(current, index, value));
  }

  function updateShared(aIndex: number, bIndex: number, value: number | null) {
    markBuildsEdited();
    setBuildAItems((current) => writeSlot(current, aIndex, value));
    setBuildBItems((current) => writeSlot(current, bIndex, value));
  }

  function addSide(side: "a" | "b") {
    markBuildsEdited();
    const setter = side === "a" ? setBuildAItems : setBuildBItems;
    setter((current) => (current.length >= 6 ? current : [...current, 0]));
  }

  function addShared() {
    markBuildsEdited();
    setBuildAItems((current) => (current.length >= 6 ? current : [...current, 0]));
    setBuildBItems((current) => (current.length >= 6 ? current : [...current, 0]));
  }

  function resetToDefault() {
    const seeded = progressionComparison(progression);
    setBuildAItems(seeded.a);
    setBuildBItems(seeded.b);
    buildsEditedRef.current = false;
    setBuildsEdited(false);
    ranksEditedRef.current = false;
    comboEditedRef.current = false;
    setRanks(
      progression?.skill.ranks && isLegalRankShape(progression.skill.ranks, level)
        ? progression.skill.ranks
        : defaultSkillRanks(level),
    );
    setActions(defaultActionsForLevel(level));
    setContinueAutos(true);
    setYunTalStacks(0);
  }

  function adjustRank(key: "q" | "w" | "e" | "r", delta: number) {
    const next = tryAdjustSkillRank(ranks, level, key, delta);
    if (!next) return;
    ranksEditedRef.current = true;
    setRanks(next);
    setRankNotice("");
  }

  function applyComboPreset(preset: (typeof COMBO_PRESETS)[number]) {
    const legal = preset.actions.filter((action) => actionAvailable(action, level));
    comboEditedRef.current = true;
    setActions(legal.length ? legal : ["AA"]);
    setContinueAutos(preset.continueAutos);
  }

  function commitTargetChampion() {
    applyChampionFilter(targetChampionDraft.trim().slice(0, 48));
  }

  function applyChampionFilter(next: string) {
    setTargetChampionDraft(next);
    setTargetChampion(next);
    cohortRef.current = null;
    void run({ targetChampion: next });
  }

  function filterToChampion(champion: string) {
    applyChampionFilter(targetChampion === champion ? "" : champion);
  }

  function suggestAlternative(itemId: number) {
    markBuildsEdited();
    setBuildBItems((current) => replaceLastLegendary(current, itemId));
  }

  const dataset = result?.dataset ?? null;
  const comparison = result?.comparison ?? null;
  const datasetLabel = dataset
    ? `${dataset.count} ${dataset.provenance === "riot" ? "Riot" : "fixture"} snapshot${dataset.count === 1 ? "" : "s"}`
    : "no snapshots yet";
  const rarity = useMemo(() => {
    const selection = progression?.selection;
    if (!selection) return null;
    const count = itemsA.filter((id) => !ITEMS[id]?.boots).length;
    return {
      ...progressionRarity(selection, count),
      lowSample: selection.lowSample,
      sampleCount: selection.sampleCount,
    };
  }, [itemsA, progression]);
  const suggestions = useMemo(
    () => progressionThenSupportedAlternatives(progression, itemsA),
    [itemsA, progression],
  );

  return (
    <div className="page">
      <header className="top">
        <div className="top-in">
          <span className="logo" aria-hidden>
            Δ
          </span>
          <strong>DPS lab</strong>
          <div className="top-right">
            <span className="pill pill-gold">
              Patch {PATCH} · {DATA_VERSION}
            </span>
            {dataset && (
              <span className={dataset.provenance === "riot" ? "pill pill-riot" : "pill pill-demo"}>
                {dataset.provenance === "riot" ? "Riot snapshots" : "Fixture / demo data"}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="lab">
        <aside className="rail" aria-label="Simulation setup">
          <AttackerCard
            level={level}
            ranks={ranks}
            rankNotice={rankNotice}
            yunTalStacks={yunTalStacks}
            onLevel={setLevel}
            onAdjustRank={adjustRank}
            onYunTalStacks={setYunTalStacks}
          />
          <OpenerCard
            actions={actions}
            level={level}
            continueAutos={continueAutos}
            duration={duration}
            onPreset={applyComboPreset}
            onAddAction={(action) => {
              if (!actionAvailable(action, level)) return;
              comboEditedRef.current = true;
              setActions((current) => [...current, action]);
            }}
            onRemoveAction={(index) => {
              comboEditedRef.current = true;
              setActions((current) => current.filter((_, position) => position !== index));
            }}
            onMoveAction={(index, direction) => {
              comboEditedRef.current = true;
              setActions((current) => moveItem(current, index, direction));
            }}
            onContinueAutos={setContinueAutos}
            onDuration={(seconds) => setDuration(clampDuration(seconds))}
          />
          <TargetCard
            targetMode={targetMode}
            region={region}
            rank={rank}
            role={role}
            phase={phase}
            targetChampionDraft={targetChampionDraft}
            appliedChampion={targetChampion}
            manual={manual}
            metric={metric}
            snapshotCount={dataset?.count ?? null}
            onTargetMode={setTargetMode}
            onRegion={setRegion}
            onRank={setRank}
            onRole={setRole}
            onPhase={setPhase}
            onChampionDraft={setTargetChampionDraft}
            onCommitChampion={commitTargetChampion}
            onManual={setManual}
            onMetric={setMetric}
          />
          <section className="card status">
            <p>
              <strong>Live</strong> — every change re-runs against the cached cohort. Level and
              filter changes fetch a new one.
            </p>
            <button className="ghost" onClick={() => void run()} disabled={loading}>
              {loading ? "Calculating…" : "Run again"}
            </button>
          </section>
        </aside>

        <main className="board">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          <OptimizerPanel
            objective={optimizerObjective}
            slotCount={optimizerSlotCount}
            topN={optimizerTopN}
            running={optimizerRunning}
            progress={optimizerProgress}
            result={optimizerResult}
            cohortCount={optimizerCohortCount}
            error={optimizerError}
            onObjective={setOptimizerObjective}
            onSlotCount={updateOptimizerSlotCount}
            onTopN={setOptimizerTopN}
            onRun={() => void runOptimizer()}
            onCancel={cancelOptimizer}
            onUseBuild={useOptimizerBuild}
          />

          {identical ? (
            <IdenticalBuildsBand
              itemName={itemsA.map(itemLabel).join(" + ") || "no items"}
              damage={result?.a.totalDamage ?? null}
              dps={result?.a.dps ?? null}
              ttk={result?.a.ttk ?? null}
              suggestions={suggestions.map((suggestion) => ({
                ...suggestion,
                apply: () => suggestAlternative(suggestion.itemId),
              }))}
              onResetDefault={resetToDefault}
            />
          ) : comparison && result ? (
            <VerdictBand
              labels={labels}
              level={level}
              metric={metric}
              duration={duration}
              windows={windowSummaries}
              comparison={comparison}
              drafts={drafts}
              datasetLabel={datasetLabel}
              recomputing={loading}
              onDuration={setDuration}
              onSwitchToTtk={() => setMetric("ttk")}
            >
              <BreakpointHeat points={result.breakpoints} duration={duration} labels={labels} />
            </VerdictBand>
          ) : (
            <section className="card band band-flat" aria-live="polite">
              <div>
                <h1 className="question">
                  {loading ? "Running the comparison…" : "No current comparison"}
                </h1>
                <p className="lede">
                  {loading
                    ? "Simulating both builds against every target in the cohort."
                    : "Correct the input above to see a result."}
                </p>
              </div>
              <div />
            </section>
          )}

          <div className={identical ? "" : "grid2"}>
            <HeadToHead
              labels={labels}
              slotsA={buildAItems}
              slotsB={buildBItems}
              supportedItems={SUPPORTED_BUILD_ITEMS}
              duration={duration}
              resultA={result?.a}
              resultB={result?.b}
              manualNote={
                buildsEdited
                  ? "These builds are manual; they no longer follow the observed level default."
                  : "Untouched builds follow each new level default."
              }
              itemWarnings={uniqueStrings([...itemWarnings(itemsA), ...itemWarnings(itemsB)])}
              onSharedChange={updateShared}
              onSideChange={updateSide}
              onAddShared={addShared}
              onAddSide={addSide}
              onResetDefault={resetToDefault}
            />
            {!identical && (
              <EnemySlices
                rows={drafts}
                labels={labels}
                comparison={comparison}
                dataset={dataset}
                loading={loading}
                onChampion={filterToChampion}
                onRole={setRole}
              />
            )}
          </div>

          <TraceFold
            labels={labels}
            dataset={dataset}
            selectedTargetId={selectedTargetId}
            resultA={result?.a}
            resultB={result?.b}
            compared={showComparedTrace}
            onSelectTarget={(id) => {
              setSelectedTargetId(id);
              void run({ selectedTargetId: id });
            }}
            onToggleCompared={() => setShowComparedTrace((current) => !current)}
          />
          <EvidenceFold
            progression={progression}
            level={level}
            loading={progressionLoading}
            error={progressionError}
            excludedNames={progression?.selection.recommendedExcludedItemNames ?? []}
            rarity={rarity}
          />
          <LimitsFold
            modelWarnings={result?.modelWarnings ?? []}
            assumptions={result?.assumptions ?? ""}
          />
        </main>
      </div>

      <footer>
        rift-delta is an independent project and is not endorsed by Riot Games or anyone officially
        involved in producing or managing League of Legends. League of Legends and Riot Games are
        trademarks or registered trademarks of Riot Games, Inc.
      </footer>
    </div>
  );
}

function defaultOptimizerSlotCount(
  progression: ProgressionApiResponse | null,
  level: number,
): number {
  const observed = progression?.selection.modeCompletedLegendary;
  const completedLegendary = Number.isInteger(observed) ? observed! : Math.max(2, level - 10);
  return Math.max(3, Math.min(6, completedLegendary + 1));
}

function acceptsOptimizerUiResponse(
  message: OptimizerWorkerResponse,
  current: { searchToken: string; contextHash?: string },
): boolean {
  if (message.searchToken !== current.searchToken) return false;
  if (!current.contextHash || message.type === "optimizer/error") return true;
  return "contextHash" in message && message.contextHash === current.contextHash;
}

async function loadProgressionLevel(
  level: number,
  cache: Map<number, ProgressionApiResponse>,
): Promise<ProgressionApiResponse> {
  const cached = cache.get(level);
  if (cached) return cached;
  const response = await fetch(`/api/dps/progression?champion=Yunara&level=${level}`, {
    headers: { accept: "application/json" },
  });
  const payload = (await response.json()) as ProgressionApiResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Progression query failed");
  cache.set(level, payload);
  return payload;
}

function compact(slots: BuildSlots): number[] {
  return slots.filter((id): id is number => id > 0);
}

function writeSlot(slots: BuildSlots, index: number, value: number | null): BuildSlots {
  if (value === null) {
    const next = slots.filter((_, position) => position !== index);
    return next.length > 0 ? next : [0];
  }
  const next = [...slots];
  next[index] = value;
  return next;
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const destination = index + direction;
  if (destination < 0 || destination >= items.length) return items;
  const next = [...items];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

function clampDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return 5;
  return Math.max(1, Math.min(60, Math.round(seconds)));
}

function describeBuild(itemIds: number[], fallback: string): string {
  const names = [...new Set(itemIds.filter((id) => !ITEMS[id]?.boots).map(itemLabel))];
  if (names.length === 0) return fallback;
  if (names.length <= 3) return names.join(" + ");
  return `${names[0]} + ${names[1]} + ${names.length - 2} more`;
}

function defaultActionsForLevel(level: number): ActionKind[] {
  return level < 6 ? ["Q", "AA"] : ["R", "Q", "W", "AA", "AA"];
}

function isLegalRankShape(ranks: AbilityRanks, level: number): boolean {
  const bounds = skillBounds(level);
  return (
    (["q", "w", "e", "r"] as const).every((key) => {
      const value = ranks[key];
      return Number.isInteger(value) && value >= bounds[key].min && value <= bounds[key].max;
    }) && ranks.q + ranks.w + ranks.e + ranks.r <= level
  );
}

function progressionComparison(progression: ProgressionApiResponse | null): {
  a: BuildSlots;
  b: BuildSlots;
} {
  const selection = progression?.selection;
  const observed = (selection?.recommendedSupportedItemIds ?? []).filter((id) =>
    SUPPORTED_BUILD_ITEMS.includes(id),
  );
  const boot = Number(selection?.recommendedBootId);
  const core = [...new Set(observed)].filter((id) => id !== INFINITY_EDGE && id !== LORD_DOMINIKS);
  if (Number.isInteger(boot) && SUPPORTED_BUILD_ITEMS.includes(boot) && !core.includes(boot)) {
    core.push(boot);
  }
  const base = core.length > 0 ? core.slice(0, 5) : [...FALLBACK_CORE];
  return { a: [...base, INFINITY_EDGE], b: [...base, LORD_DOMINIKS] };
}

function replaceLastLegendary(slots: BuildSlots, itemId: number): BuildSlots {
  const next = [...slots];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const current = next[index];
    if (current && current > 0 && !ITEMS[current]?.boots) {
      next[index] = itemId;
      return next;
    }
  }
  return next.length < 6 ? [...next, itemId] : next;
}

function progressionThenSupportedAlternatives(
  progression: ProgressionApiResponse | null,
  current: number[],
): Array<{ id: string; itemId: number; label: string; detail: string }> {
  const observed = (progression?.selection.commonCompletedItems ?? [])
    .filter((item) => SUPPORTED_BUILD_ITEMS.includes(item.itemId) && !current.includes(item.itemId))
    .map((item) => ({
      id: `suggest-${item.itemId}`,
      itemId: item.itemId,
      label: `Test ${itemLabel(item.itemId)} instead`,
      detail: `Seen in ${item.percent}% of observed states at this level`,
    }));
  const filler = SUPPORTED_BUILD_ITEMS.filter(
    (id) =>
      !ITEMS[id]?.boots &&
      !current.includes(id) &&
      !observed.some((suggestion) => suggestion.itemId === id),
  )
    .sort((left, right) => (left === LORD_DOMINIKS ? -1 : right === LORD_DOMINIKS ? 1 : 0))
    .map((id) => ({
      id: `suggest-${id}`,
      itemId: id,
      label: `Test ${itemLabel(id)} instead`,
      detail: "Supported by the engine; not part of an observed core here",
    }));
  return [...observed, ...filler].slice(0, 3);
}

function manualDataset(manual: {
  health: number;
  armor: number;
  magicResist: number;
  bonusHealth: number;
  level: number;
}): LabDataset {
  const target: Target = {
    id: "manual",
    champion: "Custom target",
    health: manual.health,
    armor: manual.armor,
    magicResist: manual.magicResist,
    bonusHealth: manual.bonusHealth,
    level: manual.level,
    provenance: "fixture",
    sampleWeight: 1,
  };
  return {
    targets: [target],
    provenance: "fixture",
    phase: "manual target",
    fallbackLevel: manual.level,
    note: "Manual target values supplied by the user; no Riot snapshot claim is made.",
    count: 1,
    distinctMatchCount: 0,
    snapshotCount: 1,
    availableDistinctMatchCount: 0,
    availableSnapshotCount: 1,
    truncated: false,
    sampleLimitPerMatch: 1,
    uniqueChampions: [target.champion],
    uniqueRoles: [],
    knownRankCount: 0,
    collection: { earliest: null, latest: null },
    summary: summarizeTargets([target]),
  };
}

function summarizeTargets(targets: Target[]) {
  const keys = ["health", "bonusHealth", "armor", "magicResist", "level", "minute"] as const;
  return Object.fromEntries(
    keys.map((key) => {
      const values = targets
        .map((target) => Number((target as unknown as Record<string, unknown>)[key] ?? 0))
        .sort((left, right) => left - right);
      const at = (quantile: number) =>
        values[Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))] ?? 0;
      return [key, { p25: at(0.25), median: at(0.5), p75: at(0.75) }];
    }),
  );
}

interface SweepContext {
  base: WorkerSimulationRequest["base"];
  buildA: WorkerSimulationRequest["buildA"];
  buildB: WorkerSimulationRequest["buildB"];
  targets: Target[];
  metric: "damage" | "ttk";
  main: SampleComparison;
  runWorker: (request: WorkerSimulationRequest) => Promise<WorkerSimulationResponse>;
  nextId: () => number;
}

async function collectWindowSummaries(
  context: SweepContext & { duration: number },
): Promise<WindowSummary[]> {
  const durations = [...new Set([...WINDOWS, context.duration])].sort(
    (left, right) => left - right,
  );
  const summaries: WindowSummary[] = [];
  for (const seconds of durations) {
    if (seconds === context.duration) {
      summaries.push(summarizeWindow(seconds, context.main));
      continue;
    }
    const response = await context.runWorker({
      id: context.nextId(),
      base: { ...context.base, durationSeconds: seconds },
      buildA: context.buildA,
      buildB: context.buildB,
      targets: context.targets,
      metric: context.metric,
      includeBreakpoints: false,
    });
    summaries.push(summarizeWindow(seconds, response.comparison));
  }
  return summaries;
}

async function collectDraftRows(context: SweepContext & { enabled: boolean }): Promise<DraftRow[]> {
  if (!context.enabled || context.targets.length < 6) return [];
  const take = Math.max(2, Math.ceil(context.targets.length / 3));
  const topBy = (pick: (target: Target) => number) =>
    [...context.targets].sort((left, right) => pick(right) - pick(left)).slice(0, take);
  const groups = [
    { key: "hp", label: "Most bonus HP", list: topBy((target) => target.bonusHealth) },
    { key: "armor", label: "Most armor", list: topBy((target) => target.armor) },
    { key: "mr", label: "Most magic resist", list: topBy((target) => target.magicResist) },
  ];
  const rows: DraftRow[] = [draftRow("avg", "Whole cohort", context.main)];
  for (const group of groups) {
    const response = await context.runWorker({
      id: context.nextId(),
      base: context.base,
      buildA: context.buildA,
      buildB: context.buildB,
      targets: group.list,
      metric: context.metric,
      includeBreakpoints: false,
    });
    rows.push(draftRow(group.key, group.label, response.comparison));
  }
  return rows;
}

function draftRow(key: string, label: string, comparison: SampleComparison): DraftRow {
  return {
    key,
    label,
    detail: `${comparison.count} snapshots`,
    delta: comparison.medianRelativeDelta,
    outcome: weightedHeadlineWinner(comparison),
    share: weightedShare(comparison, "a"),
    count: comparison.count,
    decided: comparison.aWins + comparison.bWins,
  };
}
