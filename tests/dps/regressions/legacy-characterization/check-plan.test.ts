import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  readAuditedBaselineSnapshot,
  runCheckPlan,
  validatePlanDocument,
  type BaselineSnapshot,
} from "../../../../tools/dps/check-plan.ts";

type JsonObject = Record<string, unknown>;

const repoRoot = resolve(import.meta.dirname, "../../../..");

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadPlanDocument(): JsonObject {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(repoRoot, "tools/dps/plan-contract.json"), "utf8"),
  );
  if (!isRecord(parsed)) throw new Error("plan-contract.json fixture must be an object");
  const clone: unknown = structuredClone(parsed);
  if (!isRecord(clone)) throw new Error("cloned plan-contract.json fixture must be an object");
  return clone;
}

function getTask(document: JsonObject, id: string): JsonObject {
  const tasks = document.tasks;
  if (!Array.isArray(tasks)) throw new Error("fixture tasks must be an array");
  const task = tasks.find((candidate) => isRecord(candidate) && candidate.id === id);
  if (!isRecord(task)) throw new Error(`fixture task ${id} is missing`);
  return task;
}

function getOwnedPath(task: JsonObject, path: string): JsonObject {
  const ownedPaths = task.ownedPaths;
  if (!Array.isArray(ownedPaths)) throw new Error("fixture ownedPaths must be an array");
  const owned = ownedPaths.find((candidate) => isRecord(candidate) && candidate.path === path);
  if (!isRecord(owned)) throw new Error(`fixture owned path ${path} is missing`);
  return owned;
}

function getArray(object: JsonObject, key: string): unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`fixture ${key} must be an array`);
  return value;
}

function auditedBaseline(): BaselineSnapshot {
  const structural = validatePlanDocument(loadPlanDocument());
  if (!structural.plan) throw new Error(structural.errors.join("; "));
  return readAuditedBaselineSnapshot(structural.plan, repoRoot);
}

const baselineSnapshot = auditedBaseline();

function validate(document: unknown) {
  return validatePlanDocument(document, { baselineSnapshot, repoRoot });
}

describe("offline ownership contract validator", () => {
  test("reports malformed top-level and nested schema types without throwing", () => {
    const malformed: JsonObject = {
      schemaVersion: "one",
      repository: 42,
      baselineCommit: null,
      roadmapIssue: [],
      integrationOwner: "stale status snapshot",
      tasks: [
        {
          id: 0,
          issue: "4",
          prerequisites: ["P00", 7],
          ownedPaths: [
            {
              path: "docs/example.ts",
              existsAtAuditedBaseline: "false",
              excludes: "not-an-array",
              handoffFrom: [null],
              handoffTo: [1],
            },
          ],
        },
      ],
    };

    const result = validate(malformed);

    const expectedMessages = [
      "top-level.schemaVersion must be a finite integer",
      "top-level.repository must be a string",
      "top-level.baselineCommit must be a string",
      "top-level.baselineTree is required",
      "roadmapIssue must be an object",
      "top-level.integrationOwner is not part of the ownership contract",
      "tasks[0].id must be a string",
      "tasks[0].issue must be a finite integer",
      "tasks[0].url is required",
      "tasks[0].prerequisites[1] must be a string",
      "tasks[0].ownedPaths[0].existsAtAuditedBaseline must be a boolean",
      "tasks[0].ownedPaths[0].excludes must be an array of strings",
      "tasks[0].ownedPaths[0].handoffFrom[0] must be a string",
      "tasks[0].ownedPaths[0].handoffTo[0] must be a string",
    ];
    for (const message of expectedMessages) expect(result.errors).toContain(message);
  });

  test("checks existing and future declarations against the audited Git tree", () => {
    const existingMismatch = loadPlanDocument();
    getOwnedPath(
      getTask(existingMismatch, "P00"),
      "docs/implementation/baseline.md",
    ).existsAtAuditedBaseline = true;
    const existingResult = validate(existingMismatch);
    expect(existingResult.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P00 owned path docs/implementation/baseline.md declares existing but matches no file or directory in audited tree",
        ),
      ]),
    );

    const futureMismatch = loadPlanDocument();
    getOwnedPath(getTask(futureMismatch, "P02"), "scripts/sync-static.ts").existsAtAuditedBaseline =
      false;
    const futureResult = validate(futureMismatch);
    expect(futureResult.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P02 owned path scripts/sync-static.ts declares future but matches 1 audited-tree path(s)",
        ),
      ]),
    );
  });

  test("does not accept a substituted audited commit or tree in the offline contract", () => {
    const changed = loadPlanDocument();
    changed.baselineCommit = "0".repeat(40);
    changed.baselineTree = "1".repeat(40);
    expect(validate(changed).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "baselineCommit must remain f2747db43ca89d12338982b0e7ed2f700ee2b591",
        ),
        expect.stringContaining(
          "baselineTree must remain c009c80956c8eb844dbbd8e75f6c820b89530d2b",
        ),
      ]),
    );
  });

  test("runs offline in a real depth-1 checkout and rejects a changed bundled path list", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-contract-shallow-"));
    const source = join(root, "source");
    const shallow = join(root, "shallow");
    try {
      mkdirSync(join(source, "tools/dps"), { recursive: true });
      copyFileSync(
        join(repoRoot, "tools/dps/plan-contract.json"),
        join(source, "tools/dps/plan-contract.json"),
      );
      copyFileSync(
        join(repoRoot, "tools/dps/plan-baseline-files.txt"),
        join(source, "tools/dps/plan-baseline-files.txt"),
      );
      execFileSync("git", ["init", "-q", source]);
      execFileSync("git", ["add", "."], { cwd: source });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: source },
      );
      expect(runCheckPlan(source)).toBe(0);
      execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(source).href, shallow]);
      expect(
        execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
          cwd: shallow,
          encoding: "utf8",
        }).trim(),
      ).toBe("true");
      expect(runCheckPlan(shallow)).toBe(0);

      const bundledPath = join(shallow, "tools/dps/plan-baseline-files.txt");
      writeFileSync(
        bundledPath,
        readFileSync(bundledPath, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
      );
      expect(runCheckPlan(shallow)).toBe(0);

      writeFileSync(bundledPath, "changed\n");
      const structural = validatePlanDocument(loadPlanDocument());
      if (!structural.plan) throw new Error(structural.errors.join("; "));
      expect(() => readAuditedBaselineSnapshot(structural.plan!, shallow)).toThrow(
        "bundled audited path list has an unexpected SHA-256",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing and duplicate slice IDs and incorrect issue mapping", () => {
    const duplicate = loadPlanDocument();
    getArray(duplicate, "tasks").push(structuredClone(getTask(duplicate, "P02")));
    expect(validate(duplicate).errors).toEqual(
      expect.arrayContaining(["duplicate task id: P02", "expected 31 parent tasks, found 32"]),
    );

    const missing = loadPlanDocument();
    missing.tasks = getArray(missing, "tasks").filter(
      (task) => !isRecord(task) || task.id !== "P04",
    );
    expect(validate(missing).errors).toContain("missing parent task: P04");

    const wrongIssue = loadPlanDocument();
    getTask(wrongIssue, "P02").issue = 8;
    expect(validate(wrongIssue).errors).toEqual(
      expect.arrayContaining([
        "P02 must map to issue 6, found 8",
        "issue 8 is mapped by both P02 and P04",
      ]),
    );

    const wrongUrl = loadPlanDocument();
    getTask(wrongUrl, "P04").url = "https://github.com/MaximilianMauroner/dps.lol/issues/6";
    expect(validate(wrongUrl).errors).toContain("P04 has incorrect issue URL");
  });

  test("rejects missing prerequisites and dependency cycles", () => {
    const missing = loadPlanDocument();
    getArray(getTask(missing, "P02"), "prerequisites").push("P99");
    expect(validate(missing).errors).toContain("P02 has missing prerequisite P99");

    const cycle = loadPlanDocument();
    getArray(getTask(cycle, "P00"), "prerequisites").push("P02");
    expect(validate(cycle).errors.some((error) => error.startsWith("dependency cycle:"))).toBe(
      true,
    );
  });

  test("rejects copied work-order and live status fields", () => {
    const document = loadPlanDocument();
    getTask(document, "P02").scope = "stale scope copy";
    getTask(document, "P02").issueUpdatedAt = "2026-09-18T20:10:14Z";
    expect(validate(document).errors).toEqual(
      expect.arrayContaining([
        "tasks[2].scope is not part of the ownership contract",
        "tasks[2].issueUpdatedAt is not part of the ownership contract",
      ]),
    );
  });

  test("detects literal ancestor and descendant ownership conflicts", () => {
    const document = loadPlanDocument();
    getArray(getTask(document, "P02"), "ownedPaths").push({
      path: "src/domain/contracts/example.ts",
      existsAtAuditedBaseline: false,
    });

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "conflicting owned paths: P01 src/domain/contracts/** <> P02 src/domain/contracts/example.ts",
        ),
      ]),
    );
  });

  test("rejects exclusions that are broad, unrelated, or not strictly narrower", () => {
    const document = loadPlanDocument();
    getOwnedPath(getTask(document, "P17"), "src/domain/mechanics/champions/<id>/**").excludes = [
      "src/domain/mechanics/**",
    ];

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P17 exclusion src/domain/mechanics/** must be strictly narrower than and contained by owned path src/domain/mechanics/champions/<id>/**",
        ),
      ]),
    );
  });

  test("rejects a handoff from a task without a coherent path claim", () => {
    const document = loadPlanDocument();
    getOwnedPath(getTask(document, "P29"), "src/app/page.tsx").handoffFrom = ["P00"];

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P29 handoffFrom P00 is not coherent: the sender must own an equivalent scope",
        ),
        expect.stringContaining(
          "conflicting owned paths: P24 src/app/page.tsx <> P29 src/app/page.tsx",
        ),
      ]),
    );
  });

  test("rejects an over-broad receiver scope even when it declares a handoff", () => {
    const document = loadPlanDocument();
    getOwnedPath(getTask(document, "P02"), "docs/implementation/planning/CONTENT_TASKS.json").path =
      "docs/implementation/planning/**";

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P02 handoffFrom P00 is not coherent: the sender must own an equivalent scope",
        ),
      ]),
    );
  });

  test("rejects an excluded path when the receiver omits handoffFrom", () => {
    const document = loadPlanDocument();
    getOwnedPath(
      getTask(document, "P02"),
      "docs/implementation/planning/CONTENT_TASKS.json",
    ).handoffFrom = [];

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "conflicting owned paths: P00 docs/implementation/planning/** <> P02 docs/implementation/planning/CONTENT_TASKS.json",
        ),
      ]),
    );
  });

  test("rejects an excluded path claimed by the wrong recipient", () => {
    const document = loadPlanDocument();
    getArray(getTask(document, "P03"), "ownedPaths").push({
      path: "docs/implementation/planning/CONTENT_TASKS.json",
      existsAtAuditedBaseline: false,
      handoffFrom: ["P00"],
    });

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P03 handoffFrom P00 is not coherent: the sender must own an equivalent scope",
        ),
        expect.stringContaining(
          "conflicting owned paths: P02 docs/implementation/planning/CONTENT_TASKS.json <> P03 docs/implementation/planning/CONTENT_TASKS.json",
        ),
      ]),
    );
  });

  test("accepts the exact and narrow P00-to-P02 carve-out only for P02", () => {
    const document = loadPlanDocument();
    const p00 = getOwnedPath(getTask(document, "P00"), "docs/implementation/planning/**");
    const p02 = getOwnedPath(
      getTask(document, "P02"),
      "docs/implementation/planning/CONTENT_TASKS.json",
    );

    expect(p00.handoffTo).toEqual(["P02"]);
    expect(p02.handoffFrom).toEqual(["P00"]);
    expect(validate(document).errors).toEqual([]);
  });

  test("rejects an exact handoff when the receiver declares handoffFrom but the sender omits handoffTo", () => {
    const document = loadPlanDocument();
    delete getOwnedPath(getTask(document, "P24"), "src/app/page.tsx").handoffTo;

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P29 handoffFrom P24 is not coherent: the sender must own an equivalent scope",
        ),
        expect.stringContaining(
          "conflicting owned paths: P24 src/app/page.tsx <> P29 src/app/page.tsx",
        ),
      ]),
    );
  });

  test("rejects an exact handoff when the sender authorizes the wrong recipient", () => {
    const document = loadPlanDocument();
    getOwnedPath(getTask(document, "P24"), "src/app/page.tsx").handoffTo = ["P03"];

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P29 handoffFrom P24 is not coherent: the sender must own an equivalent scope",
        ),
        expect.stringContaining(
          "conflicting owned paths: P24 src/app/page.tsx <> P29 src/app/page.tsx",
        ),
      ]),
    );
  });

  test("rejects an orphan sender handoff and a partial carve-out transfer", () => {
    const document = loadPlanDocument();
    delete getOwnedPath(
      getTask(document, "P02"),
      "docs/implementation/planning/CONTENT_MANIFEST.json",
    ).handoffFrom;

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P00 handoffTo P02 for docs/implementation/planning/CONTENT_MANIFEST.json is missing a matching receiver handoffFrom",
        ),
      ]),
    );
  });

  test("accepts the explicit two-sided exact P24-to-P29 handoff", () => {
    const document = loadPlanDocument();
    const p24 = getOwnedPath(getTask(document, "P24"), "src/app/page.tsx");
    const p29 = getOwnedPath(getTask(document, "P29"), "src/app/page.tsx");

    expect(p24.handoffTo).toEqual(["P29"]);
    expect(p29.handoffFrom).toEqual(["P24"]);
    expect(validate(document).errors).toEqual([]);
  });

  test("rejects malformed glob syntax with an actionable path error", () => {
    const document = loadPlanDocument();
    getOwnedPath(getTask(document, "P03"), "tests/observations/**").path =
      "tests/observations/[z-a].ts";

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P03 owned path has malformed glob/pattern syntax in segment [z-a].ts",
        ),
      ]),
    );
  });

  test("does not handoff or overlap disjoint glob scopes", () => {
    const document = loadPlanDocument();
    getArray(getTask(document, "P03"), "ownedPaths").push({
      path: "docs/validator/alpha*.ts",
      existsAtAuditedBaseline: false,
    });
    getArray(getTask(document, "P04"), "ownedPaths").push({
      path: "docs/validator/beta*.ts",
      existsAtAuditedBaseline: false,
      handoffFrom: ["P03"],
    });

    const result = validate(document);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "P04 handoffFrom P03 is not coherent: the sender must own an equivalent scope",
        ),
      ]),
    );
    expect(
      result.errors.some((error) =>
        error.includes("conflicting owned paths: P03 docs/validator/alpha*.ts"),
      ),
    ).toBe(false);
  });
});
