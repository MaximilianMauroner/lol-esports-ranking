import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type OwnedPath = {
  path: string;
  existsAtAuditedBaseline: boolean;
  excludes?: string[];
  handoffFrom?: string[];
  handoffTo?: string[];
};

export type Task = {
  id: string;
  issue: number;
  url: string;
  prerequisites: string[];
  ownedPaths: OwnedPath[];
};

export type RoadmapIssue = {
  number: number;
  url: string;
};

export type Plan = {
  schemaVersion: number;
  repository: string;
  baselineCommit: string;
  baselineTree: string;
  roadmapIssue: RoadmapIssue;
  tasks: Task[];
};

export type BaselineSnapshot = {
  commit: string;
  tree: string;
  files: readonly string[];
};

export type PathStateCounts = {
  declaredExisting: number;
  declaredFuture: number;
  auditedPresent: number;
  auditedAbsent: number;
  currentPresent: number;
  currentAbsent: number;
};

export type ValidationResult = {
  errors: string[];
  plan?: Plan;
  pathStateCounts: PathStateCounts;
};

export type ValidationOptions = {
  baselineSnapshot?: BaselineSnapshot;
  repoRoot?: string;
};

type JsonObject = Record<string, unknown>;
type PathClaim = { task: Task; owned: OwnedPath };
type ParsedPattern = { segments: string[]; recursive: boolean };

const PLAN_RELATIVE_PATH = "tools/dps/plan-contract.json";
const BASELINE_FILES_RELATIVE_PATH = "tools/dps/plan-baseline-files.txt";
const BASELINE_FILES_SHA256 = "bed903c39ded67b4731d225eb2b0aed462e373bcfd724cbdff93a08c2c92b061";
const REPOSITORY = "MaximilianMauroner/dps.lol";
const EXPECTED_BASELINE_COMMIT = "f2747db43ca89d12338982b0e7ed2f700ee2b591";
const EXPECTED_BASELINE_TREE = "c009c80956c8eb844dbbd8e75f6c820b89530d2b";
const EXPECTED_SCHEMA_VERSION = 2;
const EXPECTED_TASK_IDS = Array.from({ length: 31 }, (_, index) => expectedTaskId(index));

export function validatePlanDocument(
  document: unknown,
  options: ValidationOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const pathStateCounts: PathStateCounts = {
    declaredExisting: 0,
    declaredFuture: 0,
    auditedPresent: 0,
    auditedAbsent: 0,
    currentPresent: 0,
    currentAbsent: 0,
  };
  const plan = parsePlanDocument(document, errors);

  if (!plan) return { errors, pathStateCounts };

  validatePlanMetadata(plan, errors);
  const tasksById = validateTasks(plan, errors, options, pathStateCounts);
  const pathClaims = validateOwnedPaths(plan, tasksById, errors, options, pathStateCounts);

  validateOwnership(pathClaims, errors);
  return { errors, plan, pathStateCounts };
}

export function readGitBaselineSnapshot(
  plan: Pick<Plan, "baselineCommit" | "baselineTree">,
  repoRoot = resolve(process.cwd()),
): BaselineSnapshot {
  if (!isFullSha(plan.baselineCommit)) {
    throw new Error("baselineCommit must be a full 40-character SHA before Git lookup");
  }
  if (!isFullSha(plan.baselineTree)) {
    throw new Error("baselineTree must be a full 40-character SHA before Git lookup");
  }

  const resolvedCommit = readGitRevision(
    repoRoot,
    `${plan.baselineCommit}^{commit}`,
    "baselineCommit",
  );
  if (resolvedCommit !== plan.baselineCommit) {
    throw new Error(
      `baselineCommit resolves to ${resolvedCommit}, not the declared ${plan.baselineCommit}`,
    );
  }

  const commitTree = readGitRevision(
    repoRoot,
    `${plan.baselineCommit}^{tree}`,
    "baselineCommit tree",
  );
  const resolvedTree = readGitRevision(repoRoot, `${plan.baselineTree}^{tree}`, "baselineTree");
  if (commitTree !== plan.baselineTree || resolvedTree !== plan.baselineTree) {
    throw new Error(
      `baselineTree mismatch: commit ${plan.baselineCommit} has ${commitTree}, declared tree resolves to ${resolvedTree}, declared ${plan.baselineTree}`,
    );
  }

  const output = readGitCommand(repoRoot, ["ls-tree", "-r", "--name-only", plan.baselineTree]);
  const files = output
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => file.length > 0);

  return { commit: resolvedCommit, tree: plan.baselineTree, files };
}

export function readAuditedBaselineSnapshot(
  plan: Pick<Plan, "baselineCommit" | "baselineTree">,
  repoRoot = resolve(process.cwd()),
): BaselineSnapshot {
  const contents = readFileSync(join(repoRoot, BASELINE_FILES_RELATIVE_PATH), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  if (contents.includes("\r")) {
    throw new Error("bundled audited path list has invalid line endings");
  }
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== BASELINE_FILES_SHA256) {
    throw new Error(`bundled audited path list has an unexpected SHA-256: ${digest}`);
  }
  const files = contents.trimEnd().split("\n");
  if (
    files.length !== 93 ||
    files.some((file) => !isSafeRelativePath(file)) ||
    new Set(files).size !== files.length ||
    files.some((file, index) => index > 0 && files[index - 1]! >= file)
  ) {
    throw new Error("bundled audited path list must contain 93 unique sorted safe paths");
  }
  if (!isFullSha(plan.baselineCommit) || !isFullSha(plan.baselineTree)) {
    throw new Error("audited baseline commit and tree must be full 40-character SHAs");
  }
  if (
    plan.baselineCommit !== EXPECTED_BASELINE_COMMIT ||
    plan.baselineTree !== EXPECTED_BASELINE_TREE
  ) {
    throw new Error("audited baseline identity differs from the sealed P00 baseline");
  }

  if (gitObjectExists(repoRoot, `${plan.baselineCommit}^{commit}`)) {
    const snapshot = readGitBaselineSnapshot(plan, repoRoot);
    if (snapshot.files.join("\n") !== files.join("\n")) {
      throw new Error("bundled audited path list differs from the immutable Git baseline tree");
    }
    return snapshot;
  }
  return { commit: plan.baselineCommit, tree: plan.baselineTree, files };
}

export function runCheckPlan(repoRoot = resolve(process.cwd())): number {
  const planPath = join(repoRoot, PLAN_RELATIVE_PATH);
  let document: unknown;

  try {
    document = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check-plan: unable to read valid JSON from ${PLAN_RELATIVE_PATH}: ${message}`);
    return 1;
  }

  const structural = validatePlanDocument(document, { repoRoot });
  let result = structural;

  if (structural.plan) {
    try {
      const baselineSnapshot = readAuditedBaselineSnapshot(structural.plan, repoRoot);
      result = validatePlanDocument(document, {
        baselineSnapshot,
        repoRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`audited baseline lookup failed: ${message}`);
    }
  }

  console.log(`plan: ${PLAN_RELATIVE_PATH}`);
  if (result.plan) {
    const uniqueIds = new Set(result.plan.tasks.map((task) => task.id)).size;
    console.log(
      `parent tasks: ${String(result.plan.tasks.length)}; unique IDs: ${String(uniqueIds)}`,
    );
    console.log(
      `owned paths: declared-existing=${String(result.pathStateCounts.declaredExisting)}, declared-future=${String(result.pathStateCounts.declaredFuture)}, audited-present=${String(result.pathStateCounts.auditedPresent)}, audited-absent=${String(result.pathStateCounts.auditedAbsent)}, current-present=${String(result.pathStateCounts.currentPresent)}, current-absent=${String(result.pathStateCounts.currentAbsent)}`,
    );
    console.log(
      "path declarations are checked against the immutable baselineCommit/baselineTree; current filesystem presence is reported separately",
    );
  }

  if (result.errors.length > 0) {
    console.error(`check-plan: ${String(result.errors.length)} error(s)`);
    for (const message of result.errors) console.error(`- ${message}`);
    return 1;
  }

  console.log(
    "check-plan: PASS (schema, issue mappings, prerequisites, acyclic graph, audited path state, exclusions, handoffs, and ownership scopes)",
  );
  return 0;
}

function parsePlanDocument(document: unknown, errors: string[]): Plan | undefined {
  if (!isRecord(document)) {
    errors.push("document must be a JSON object");
    return undefined;
  }
  rejectUnknownKeys(
    document,
    ["schemaVersion", "repository", "baselineCommit", "baselineTree", "roadmapIssue", "tasks"],
    "top-level",
    errors,
  );

  const schemaVersion = requiredNumber(document, "schemaVersion", "top-level", errors);
  const repository = requiredString(document, "repository", "top-level", errors);
  const baselineCommit = requiredString(document, "baselineCommit", "top-level", errors);
  const baselineTree = requiredString(document, "baselineTree", "top-level", errors);
  const roadmapIssue = parseRoadmapIssue(document.roadmapIssue, errors);
  const tasks = parseTasks(document.tasks, errors);

  if (
    schemaVersion === undefined ||
    repository === undefined ||
    baselineCommit === undefined ||
    baselineTree === undefined ||
    roadmapIssue === undefined ||
    tasks === undefined
  ) {
    return undefined;
  }

  return {
    schemaVersion,
    repository,
    baselineCommit,
    baselineTree,
    roadmapIssue,
    tasks,
  };
}

function parseRoadmapIssue(value: unknown, errors: string[]): RoadmapIssue | undefined {
  if (!isRecord(value)) {
    errors.push("roadmapIssue must be an object");
    return undefined;
  }
  rejectUnknownKeys(value, ["number", "url"], "roadmapIssue", errors);
  const number = requiredNumber(value, "number", "roadmapIssue", errors);
  const url = requiredString(value, "url", "roadmapIssue", errors);
  if (number === undefined || url === undefined) return undefined;
  return { number, url };
}

function parseTasks(value: unknown, errors: string[]): Task[] | undefined {
  if (!Array.isArray(value)) {
    errors.push("tasks must be an array");
    return undefined;
  }

  const tasks: Task[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const task = parseTask(value[index], `tasks[${String(index)}]`, errors);
    if (task) tasks.push(task);
  }
  return tasks;
}

function parseTask(value: unknown, location: string, errors: string[]): Task | undefined {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ["id", "issue", "url", "prerequisites", "ownedPaths"], location, errors);

  const id = requiredString(value, "id", location, errors);
  const issue = requiredNumber(value, "issue", location, errors);
  const url = requiredString(value, "url", location, errors);
  const prerequisites = requiredStringArray(value, "prerequisites", location, errors);
  const ownedPaths = parseOwnedPaths(value.ownedPaths, `${location}.ownedPaths`, errors);

  if (
    id === undefined ||
    issue === undefined ||
    url === undefined ||
    prerequisites === undefined ||
    ownedPaths === undefined
  ) {
    return undefined;
  }

  return {
    id,
    issue,
    url,
    prerequisites,
    ownedPaths,
  };
}

function parseOwnedPaths(
  value: unknown,
  location: string,
  errors: string[],
): OwnedPath[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array`);
    return undefined;
  }
  if (value.length === 0) errors.push(`${location} must contain at least one owned path`);

  const ownedPaths: OwnedPath[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const ownedPath = parseOwnedPath(value[index], `${location}[${String(index)}]`, errors);
    if (ownedPath) ownedPaths.push(ownedPath);
  }
  return ownedPaths;
}

function parseOwnedPath(value: unknown, location: string, errors: string[]): OwnedPath | undefined {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    ["path", "existsAtAuditedBaseline", "excludes", "handoffFrom", "handoffTo"],
    location,
    errors,
  );

  const path = requiredString(value, "path", location, errors);
  const existsAtAuditedBaseline = requiredBoolean(
    value,
    "existsAtAuditedBaseline",
    location,
    errors,
  );
  const excludes = optionalStringArray(value, "excludes", location, errors);
  const handoffFrom = optionalStringArray(value, "handoffFrom", location, errors);
  const handoffTo = optionalStringArray(value, "handoffTo", location, errors);

  if (path === undefined || existsAtAuditedBaseline === undefined) return undefined;
  return { path, existsAtAuditedBaseline, excludes, handoffFrom, handoffTo };
}

function validatePlanMetadata(plan: Plan, errors: string[]): void {
  if (plan.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    errors.push(
      `unsupported schemaVersion ${String(plan.schemaVersion)}; expected ${String(EXPECTED_SCHEMA_VERSION)}`,
    );
  }
  if (plan.repository !== REPOSITORY) {
    errors.push(`unexpected repository ${plan.repository}; expected ${REPOSITORY}`);
  }
  if (!isFullSha(plan.baselineCommit))
    errors.push("baselineCommit must be a full 40-character SHA");
  if (!isFullSha(plan.baselineTree)) errors.push("baselineTree must be a full 40-character SHA");
  if (plan.baselineCommit !== EXPECTED_BASELINE_COMMIT) {
    errors.push(`baselineCommit must remain ${EXPECTED_BASELINE_COMMIT}`);
  }
  if (plan.baselineTree !== EXPECTED_BASELINE_TREE) {
    errors.push(`baselineTree must remain ${EXPECTED_BASELINE_TREE}`);
  }
  if (plan.roadmapIssue.number !== 3) {
    errors.push(`roadmapIssue.number must be 3, found ${String(plan.roadmapIssue.number)}`);
  }
  if (plan.roadmapIssue.url !== `https://github.com/${REPOSITORY}/issues/3`) {
    errors.push("roadmapIssue.url must point to GitHub issue #3");
  }
}

function validateTasks(
  plan: Plan,
  errors: string[],
  options: ValidationOptions,
  pathStateCounts: PathStateCounts,
): Map<string, Task> {
  const tasksById = new Map<string, Task>();
  if (plan.tasks.length !== EXPECTED_TASK_IDS.length) {
    errors.push(`expected 31 parent tasks, found ${String(plan.tasks.length)}`);
  }

  for (const task of plan.tasks) {
    if (tasksById.has(task.id)) {
      errors.push(`duplicate task id: ${task.id}`);
    } else {
      tasksById.set(task.id, task);
    }

    if (!/^P\d{2}$/.test(task.id) || !EXPECTED_TASK_IDS.includes(task.id)) {
      errors.push(`invalid or unexpected task id: ${task.id}`);
    } else {
      const expectedIssue = Number(task.id.slice(1)) + 4;
      if (task.issue !== expectedIssue) {
        errors.push(
          `${task.id} must map to issue ${String(expectedIssue)}, found ${String(task.issue)}`,
        );
      }
    }

    const expectedUrl = `https://github.com/${REPOSITORY}/issues/${String(task.issue)}`;
    if (task.url !== expectedUrl) errors.push(`${task.id} has incorrect issue URL`);
    if (task.prerequisites.includes(task.id)) {
      errors.push(`${task.id} lists itself as a prerequisite`);
    }
    if (new Set(task.prerequisites).size !== task.prerequisites.length) {
      errors.push(`${task.id} has duplicate prerequisites`);
    }
  }

  for (const expectedId of EXPECTED_TASK_IDS) {
    if (!tasksById.has(expectedId)) errors.push(`missing parent task: ${expectedId}`);
  }

  const issueOwners = new Map<number, string>();
  for (const task of plan.tasks) {
    const previous = issueOwners.get(task.issue);
    if (previous)
      errors.push(`issue ${String(task.issue)} is mapped by both ${previous} and ${task.id}`);
    issueOwners.set(task.issue, task.id);
    for (const prerequisite of task.prerequisites) {
      if (!tasksById.has(prerequisite)) {
        errors.push(`${task.id} has missing prerequisite ${prerequisite}`);
      }
    }
  }

  const visitState = new Map<string, "visiting" | "visited">();
  const reportedCycles = new Set<string>();
  function visit(taskId: string, stack: string[] = []): void {
    const state = visitState.get(taskId);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), taskId].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        reportedCycles.add(cycle);
        errors.push(`dependency cycle: ${cycle}`);
      }
      return;
    }
    const task = tasksById.get(taskId);
    if (!task) return;
    visitState.set(taskId, "visiting");
    for (const prerequisite of task.prerequisites) visit(prerequisite, [...stack, taskId]);
    visitState.set(taskId, "visited");
  }
  for (const task of plan.tasks) visit(task.id);

  for (const task of plan.tasks) {
    for (const owned of task.ownedPaths) {
      if (owned.existsAtAuditedBaseline) pathStateCounts.declaredExisting += 1;
      else pathStateCounts.declaredFuture += 1;
      if (currentPathMatch(owned.path, options.repoRoot ?? process.cwd())) {
        pathStateCounts.currentPresent += 1;
      } else {
        pathStateCounts.currentAbsent += 1;
      }
    }
  }

  return tasksById;
}

function validateOwnedPaths(
  plan: Plan,
  tasksById: Map<string, Task>,
  errors: string[],
  options: ValidationOptions,
  pathStateCounts: PathStateCounts,
): PathClaim[] {
  const pathClaims: PathClaim[] = [];

  for (const task of plan.tasks) {
    for (const owned of task.ownedPaths) {
      const pathIsSafe = validatePathSyntax(owned.path, `${task.id} owned path`, errors);
      if (pathIsSafe && options.baselineSnapshot) {
        const auditedMatches = matchingBaselineFiles(owned.path, options.baselineSnapshot.files);
        if (auditedMatches > 0) pathStateCounts.auditedPresent += 1;
        else pathStateCounts.auditedAbsent += 1;
        if (owned.existsAtAuditedBaseline && auditedMatches === 0) {
          errors.push(
            `${task.id} owned path ${owned.path} declares existing but matches no file or directory in audited tree ${options.baselineSnapshot.tree}`,
          );
        }
        if (!owned.existsAtAuditedBaseline && auditedMatches > 0) {
          errors.push(
            `${task.id} owned path ${owned.path} declares future but matches ${String(auditedMatches)} audited-tree path(s) in ${options.baselineSnapshot.tree}`,
          );
        }
      }

      if (owned.excludes) {
        for (const excluded of owned.excludes) {
          if (!validatePathSyntax(excluded, `${task.id} exclusion`, errors)) continue;
          if (!isStrictlyNarrower(owned.path, excluded)) {
            errors.push(
              `${task.id} exclusion ${excluded} must be strictly narrower than and contained by owned path ${owned.path}`,
            );
          }
        }
      }

      if (owned.handoffFrom) {
        for (const handoffFrom of owned.handoffFrom) {
          const sender = tasksById.get(handoffFrom);
          if (!sender) {
            errors.push(`${task.id} handoff references missing task ${handoffFrom}`);
            continue;
          }
          if (!handoffIsCoherent({ task, owned }, sender)) {
            errors.push(
              `${task.id} handoffFrom ${handoffFrom} is not coherent: the sender must own an equivalent scope or an enclosing scope with an explicit carve-out for ${owned.path}`,
            );
          }
        }
      }
      if (owned.handoffTo) {
        for (const handoffTo of owned.handoffTo) {
          const receiver = tasksById.get(handoffTo);
          if (!receiver) {
            errors.push(`${task.id} handoffTo references missing task ${handoffTo}`);
            continue;
          }
          const transferredScopes = owned.excludes?.length ? owned.excludes : [owned.path];
          for (const scope of transferredScopes) {
            if (
              !receiver.ownedPaths.some(
                (claim) =>
                  patternsEquivalent(claim.path, scope) &&
                  claim.handoffFrom?.includes(task.id) === true &&
                  handoffIsCoherent({ task: receiver, owned: claim }, task),
              )
            ) {
              errors.push(
                `${task.id} handoffTo ${handoffTo} for ${scope} is missing a matching receiver handoffFrom`,
              );
            }
          }
        }
      }

      if (pathIsSafe) pathClaims.push({ task, owned });
    }
  }

  return pathClaims;
}

function validateOwnership(pathClaims: PathClaim[], errors: string[]): void {
  for (let leftIndex = 0; leftIndex < pathClaims.length; leftIndex += 1) {
    const left = pathClaims[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < pathClaims.length; rightIndex += 1) {
      const right = pathClaims[rightIndex]!;
      if (left.task.id === right.task.id || !patternsOverlap(left.owned.path, right.owned.path))
        continue;
      if (ownershipException(left, right)) continue;
      errors.push(
        `conflicting owned paths: ${left.task.id} ${left.owned.path} <> ${right.task.id} ${right.owned.path}; add a valid handoff or a narrower sender exclusion`,
      );
    }
  }
}

function ownershipException(left: PathClaim, right: PathClaim): boolean {
  if (declaredHandoffAllows(left, right) || declaredHandoffAllows(right, left)) {
    return true;
  }
  if (
    staticExclusionDisjoint(left.owned, right.owned) ||
    staticExclusionDisjoint(right.owned, left.owned)
  ) {
    return true;
  }
  return false;
}

function declaredHandoffAllows(receiver: PathClaim, sender: PathClaim): boolean {
  return (
    receiver.owned.handoffFrom?.includes(sender.task.id) === true &&
    handoffIsCoherent(receiver, sender.task)
  );
}

function staticExclusionDisjoint(owner: OwnedPath, other: OwnedPath): boolean {
  if (owner.handoffTo !== undefined) return false;
  return (owner.excludes ?? []).some(
    (excluded) => isStrictlyNarrower(owner.path, excluded) && scopeContains(excluded, other.path),
  );
}

function handoffIsCoherent(receiver: PathClaim, sender: Task): boolean {
  return sender.ownedPaths.some((senderOwned) => {
    if (
      patternsEquivalent(senderOwned.path, receiver.owned.path) &&
      isExactPathScope(senderOwned.path) &&
      isExactPathScope(receiver.owned.path)
    ) {
      return senderOwned.handoffTo?.includes(receiver.task.id) === true;
    }
    if (!scopeContains(senderOwned.path, receiver.owned.path)) return false;
    return (senderOwned.excludes ?? []).some(
      (excluded) =>
        senderOwned.handoffTo?.includes(receiver.task.id) === true &&
        isStrictlyNarrower(senderOwned.path, excluded) &&
        scopeContains(excluded, receiver.owned.path),
    );
  });
}

function isExactPathScope(path: string): boolean {
  const parsed = parsePattern(path);
  return !parsed.recursive && parsed.segments.every((segment) => !hasSegmentPattern(segment));
}

function parsePattern(pattern: string): ParsedPattern {
  const rawSegments = pattern.split("/");
  const recursive = rawSegments.at(-1) === "**";
  return {
    segments: recursive ? rawSegments.slice(0, -1) : rawSegments,
    recursive,
  };
}

function patternsOverlap(left: string, right: string): boolean {
  const a = parsePattern(left);
  const b = parsePattern(right);
  const commonLength = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (!segmentsCanOverlap(a.segments[index]!, b.segments[index]!)) return false;
  }
  return true;
}

function scopeContains(parent: string, child: string): boolean {
  const parentPattern = parsePattern(parent);
  const childPattern = parsePattern(child);

  if (parentPattern.recursive) {
    if (childPattern.segments.length < parentPattern.segments.length) return false;
    if (!segmentsContain(parentPattern.segments, childPattern.segments)) return false;
    if (childPattern.segments.length === parentPattern.segments.length)
      return childPattern.recursive;
    return true;
  }

  if (childPattern.segments.length < parentPattern.segments.length) return false;
  return segmentsContain(parentPattern.segments, childPattern.segments);
}

function isStrictlyNarrower(parent: string, child: string): boolean {
  return scopeContains(parent, child) && !patternsEquivalent(parent, child);
}

function patternsEquivalent(left: string, right: string): boolean {
  const a = parsePattern(left);
  const b = parsePattern(right);
  if (a.recursive !== b.recursive || a.segments.length !== b.segments.length) return false;
  return a.segments.every((segment, index) =>
    segmentPatternsEquivalent(segment, b.segments[index]!),
  );
}

function segmentsContain(parent: string[], child: string[]): boolean {
  return parent.every((segment, index) => segmentPatternContains(segment, child[index]!));
}

function segmentPatternsEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  return isWholeSegmentWildcard(left) && isWholeSegmentWildcard(right);
}

function segmentPatternContains(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (isWholeSegmentWildcard(parent)) return true;
  if (isWholeSegmentWildcard(child)) return false;
  if (!hasSegmentPattern(parent)) return false;
  return segmentMatchesPattern(parent, child);
}

function segmentsCanOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPlaceholder = placeholderName(left);
  const rightPlaceholder = placeholderName(right);
  if (leftPlaceholder || rightPlaceholder) {
    if (leftPlaceholder && rightPlaceholder) {
      if (
        leftPlaceholder !== rightPlaceholder &&
        leftPlaceholder !== "id" &&
        rightPlaceholder !== "id"
      ) {
        return false;
      }
    } else if (leftPlaceholder !== "id" && rightPlaceholder !== "id") {
      return false;
    }
  }
  if (!hasSegmentPattern(left) && !hasSegmentPattern(right)) return false;
  if (!hasSegmentPattern(left)) return segmentMatchesPattern(right, left);
  if (!hasSegmentPattern(right)) return segmentMatchesPattern(left, right);
  return globPatternsMayOverlap(left, right);
}

function globPatternsMayOverlap(left: string, right: string): boolean {
  const leftPrefix = literalSegmentPrefix(left);
  const rightPrefix = literalSegmentPrefix(right);
  if (leftPrefix.length === 0 || rightPrefix.length === 0) return true;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function literalSegmentPrefix(pattern: string): string {
  let prefix = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if ("*?[<".includes(pattern[index]!)) return prefix;
    prefix += pattern[index];
  }
  return prefix;
}

function isWholeSegmentWildcard(segment: string): boolean {
  return segment === "*" || segment === "<id>";
}

function placeholderName(segment: string): string | undefined {
  return segment.match(/<([^<>/]+)>/)?.[1];
}

function hasSegmentPattern(segment: string): boolean {
  return (
    segment.includes("*") || segment.includes("?") || segment.includes("[") || segment.includes("<")
  );
}

function segmentMatchesPattern(pattern: string, value: string): boolean {
  if (pattern === value || isWholeSegmentWildcard(pattern)) return true;
  const placeholder = placeholderName(pattern);
  if (placeholder && placeholder !== "id") return false;
  if (!hasSegmentPattern(pattern)) return false;

  return compileSegmentPattern(pattern)?.test(value) ?? false;
}

function compileSegmentPattern(pattern: string): RegExp | undefined {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "<") {
      const end = pattern.indexOf(">", index + 1);
      if (end >= 0) {
        source += "[^/]*";
        index = end;
        continue;
      }
    }
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end >= 0) {
        source += pattern.slice(index, end + 1);
        index = end;
      } else {
        source += "\\[";
      }
    } else {
      source += escapeRegExp(character);
    }
  }
  source += "$";

  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

function matchingBaselineFiles(pattern: string, files: readonly string[]): number {
  return files.filter((file) => pathPatternMatchesFile(pattern, file)).length;
}

function pathPatternMatchesFile(pattern: string, file: string): boolean {
  if (pattern.match(/<([^<>/]+)>/)?.[1] && !pattern.includes("<id>")) return false;
  const parsed = parsePattern(pattern);
  const fileSegments = file.split("/");
  if (fileSegments.length < parsed.segments.length) return false;
  for (let index = 0; index < parsed.segments.length; index += 1) {
    if (!segmentMatchesPattern(parsed.segments[index]!, fileSegments[index]!)) return false;
  }
  if (parsed.recursive) return fileSegments.length > parsed.segments.length;
  return true;
}

function validatePathSyntax(path: string, label: string, errors: string[]): boolean {
  if (!isSafeRelativePath(path)) {
    errors.push(`${label} is not a safe relative path pattern: ${path}`);
    return false;
  }
  const segments = path.split("/");
  const recursiveSegments = segments.filter((segment) => segment === "**");
  if (recursiveSegments.length > 0 && (segments.at(-1) !== "**" || recursiveSegments.length > 1)) {
    errors.push(`${label} may use ** only once as its final path segment: ${path}`);
    return false;
  }
  let valid = true;
  for (const segment of segments) {
    if (segment === "**") continue;
    if (!validateSegmentSyntax(segment, label, errors)) valid = false;
  }
  return valid;
}

function validateSegmentSyntax(segment: string, label: string, errors: string[]): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === "<") {
      const end = segment.indexOf(">", index + 1);
      if (end < 0 || end === index + 1 || segment.slice(index + 1, end).includes("<")) {
        errors.push(`${label} has malformed placeholder syntax in segment ${segment}`);
        return false;
      }
      index = end;
    } else if (character === ">") {
      errors.push(`${label} has an unmatched > in segment ${segment}`);
      return false;
    } else if (character === "[") {
      const end = segment.indexOf("]", index + 1);
      if (end < 0 || end === index + 1) {
        errors.push(`${label} has malformed character-class syntax in segment ${segment}`);
        return false;
      }
      index = end;
    } else if (character === "]") {
      errors.push(`${label} has an unmatched ] in segment ${segment}`);
      return false;
    }
  }
  if (hasSegmentPattern(segment) && compileSegmentPattern(segment) === undefined) {
    errors.push(`${label} has malformed glob/pattern syntax in segment ${segment}`);
    return false;
  }
  return true;
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function matchingLiteralPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[?*[<]/);
  const literal = (wildcardIndex >= 0 ? pattern.slice(0, wildcardIndex) : pattern).replace(
    /\/+$/,
    "",
  );
  return literal;
}

function currentPathMatch(pattern: string, repoRoot: string): boolean {
  if (pattern.includes("<")) return false;
  const literal = matchingLiteralPrefix(pattern);
  return literal.length > 0 && existsInsideRepository(repoRoot, literal);
}

function existsInsideRepository(repoRoot: string, path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  const absolute = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, absolute);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(".." + "/") && existsSync(absolute))
  );
}

function readGitRevision(repoRoot: string, revision: string, label: string): string {
  try {
    const output = readGitCommand(repoRoot, ["rev-parse", "--verify", revision]).trim();
    if (!output) throw new Error("Git returned an empty revision");
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to resolve ${label} (${revision}): ${message}`, { cause: error });
  }
}

function gitObjectExists(repoRoot: string, revision: string): boolean {
  try {
    readGitCommand(repoRoot, ["cat-file", "-e", revision]);
    return true;
  } catch {
    return false;
  }
}

function readGitCommand(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requiredString(
  object: JsonObject,
  key: string,
  location: string,
  errors: string[],
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    errors.push(`${location}.${key} is required`);
    return undefined;
  }
  const value = object[key];
  if (typeof value !== "string") {
    errors.push(`${location}.${key} must be a string`);
    return undefined;
  }
  if (value.trim().length === 0) {
    errors.push(`${location}.${key} must not be empty`);
    return undefined;
  }
  return value;
}

function requiredNumber(
  object: JsonObject,
  key: string,
  location: string,
  errors: string[],
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    errors.push(`${location}.${key} is required`);
    return undefined;
  }
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`${location}.${key} must be a finite integer`);
    return undefined;
  }
  return value;
}

function requiredBoolean(
  object: JsonObject,
  key: string,
  location: string,
  errors: string[],
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    errors.push(`${location}.${key} is required`);
    return undefined;
  }
  const value = object[key];
  if (typeof value !== "boolean") {
    errors.push(`${location}.${key} must be a boolean`);
    return undefined;
  }
  return value;
}

function requiredStringArray(
  object: JsonObject,
  key: string,
  location: string,
  errors: string[],
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    errors.push(`${location}.${key} is required`);
    return undefined;
  }
  return stringArray(object[key], `${location}.${key}`, errors);
}

function optionalStringArray(
  object: JsonObject,
  key: string,
  location: string,
  errors: string[],
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  return stringArray(object[key], `${location}.${key}`, errors);
}

function stringArray(value: unknown, location: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array of strings`);
    return undefined;
  }
  const values: string[] = [];
  let valid = true;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      errors.push(`${location}[${String(index)}] must be a string`);
      valid = false;
    } else if (item.trim().length === 0) {
      errors.push(`${location}[${String(index)}] must not be empty`);
      valid = false;
    } else {
      values.push(item);
    }
  }
  return valid ? values : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  location: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      errors.push(`${location}.${key} is not part of the ownership contract`);
  }
}

function expectedTaskId(index: number): string {
  return `P${String(index).padStart(2, "0")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) process.exitCode = runCheckPlan();
