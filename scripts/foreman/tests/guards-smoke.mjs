#!/usr/bin/env node
/**
 * Smoke test for plan phase A3 + A4 (+ the barrel rule C3 depends on) of
 * plans/ForemanHarness.md.
 *
 * It bundles the real plugin with a stub for @opencode/plugin, loads the tools
 * against throwaway git repositories in os.tmpdir() and a fake `gh` shim, then
 * exercises:
 *   - guard order: STOP -> capacity (B2) -> title/goal -> acceptanceCommands ->
 *     dependsOn -> scope/barrels, with nothing created on refusal. The B2
 *     scenario proves the ordering twice: with 3/3 active steps the capacity
 *     refusal wins over an empty title, and with a free slot the title/goal
 *     refusal wins instead;
 *   - dependsOn: non-verified steps (open, implemented, fixing) refused with
 *     the offending issue and status; verified steps accepted; issue numbers
 *     that name implIssue/fixIssues; external numbers annotated in the body;
 *   - scope overlap: exactly equal, parent/child (both directions), sibling
 *     paths that only share a string prefix (backend/api vs backend/apis),
 *     disjoint scopes, and empty scopes overlapping nothing;
 *   - barrels: refused for a non-integration step, accepted for
 *     kind: "integration", two active barrel steps always in conflict, and the
 *     barrel message wins over the generic overlap message;
 *   - normalisation: "./", "//" and a trailing "/" collapse before comparing.
 *
 * Every refusal is also checked for zero GitHub calls, no new step directory,
 * no cursor change and no `step` ledger record.
 *
 * Run from the repo root: node scripts/foreman/tests/guards-smoke.mjs
 * Nothing touches GitHub: PATH is prefixed with a fake gh that only logs.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const ACCEPT_REQUIRED = "REFUSED: acceptanceCommands is required: the plugin executes these exact commands before good."
const BARRELS = {
  contracts: "shared/contracts/src/index.ts",
  module: "shared/contracts/src/module.ts",
  promotion: "shared/contracts/src/promotion.ts",
  draft: "shared/contracts/src/draft.ts",
}
// The barrel set, the publish branch and the live switch are configuration:
// seed them from the environment before the plugin module is loaded.
process.env.FOREMAN_BARRELS = Object.values(BARRELS).join(",")
process.env.FOREMAN_PUBLISH_BRANCH = "main"
process.env.FOREMAN_LIVE_COMMAND = "npm run live"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-guards-"))
const bodiesDir = path.join(tmp, "bodies")
fs.mkdirSync(bodiesDir, { recursive: true })
const ghLog = path.join(tmp, "gh.log")
const ghCounter = path.join(tmp, "gh.counter")
const bodies = path.join(bodiesDir, "all.md")
const shimDir = path.join(tmp, "bin")
fs.mkdirSync(shimDir, { recursive: true })

fs.writeFileSync(path.join(shimDir, "gh"), [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'N=$(cat "$GH_COUNTER" 2>/dev/null || echo 0)',
  "N=$((N + 1))",
  'printf \'%s\' "$N" > "$GH_COUNTER"',
  'BODY=""',
  'PREV=""',
  'for ARG in "$@"; do',
  '  if [ "$PREV" = "--body-file" ]; then BODY="$ARG"; fi',
  "  PREV=\"$ARG\"",
  "done",
  'if [ -n "$BODY" ]; then',
  '  printf \'\\n===== %s =====\\n\' "$*" >> "$GH_BODIES/all.md"',
  '  cat "$BODY" >> "$GH_BODIES/all.md"',
  "fi",
  'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
  '  echo "https://github.com/fake/repo/issues/$N"',
  "fi",
  "exit 0",
  "",
].join("\n"), { mode: 0o755 })

process.env.GH_LOG = ghLog
process.env.GH_BODIES = bodiesDir
process.env.GH_COUNTER = ghCounter
process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`

const bundle = path.join(tmp, "plugin.mjs")
await build({
  entryPoints: [path.join(repoRoot, "scripts/foreman/plugin.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  alias: { "@opencode/plugin": path.join(here, "plugin-stub.ts") },
  logLevel: "silent",
})
const plugin = (await import(pathToFileURL(bundle).href)).default

/* ------------------------------- helpers ------------------------------- */

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
let fixture = 0

function makeRepo({ branch = "foreman/smoke" } = {}) {
  const dir = path.join(tmp, `repo-${++fixture}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", branch)
  git(dir, "config", "user.email", "smoke@example.com")
  git(dir, "config", "user.name", "Smoke")
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  return { dir, branch, head: git(dir, "rev-parse", "HEAD") }
}

function writeState(repo, patch) {
  fs.mkdirSync(path.join(repo.dir, ".foreman", "steps"), { recursive: true })
  fs.mkdirSync(path.join(repo.dir, ".foreman", "tmp"), { recursive: true })
  const state = {
    startedAt: new Date().toISOString(),
    planPath: path.join(repo.dir, "plan.md"),
    branch: repo.branch,
    repo: "fake/repo",
    model: "smoke",
    maxParallel: 3,
    maxSteps: 200,
    maxMinutes: null,
    cursor: 0,
    current: null,
    blocked: null,
    steps: [],
    ...patch,
  }
  fs.writeFileSync(path.join(repo.dir, ".foreman/state.json"), `${JSON.stringify(state, null, 2)}\n`)
  for (const step of state.steps) {
    fs.mkdirSync(path.join(repo.dir, ".foreman", "steps", String(step.n)), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, ".foreman", "steps", String(step.n), "step.json"), `${JSON.stringify(step, null, 2)}\n`)
  }
  return state
}

const readState = (repo) => readJson(path.join(repo.dir, ".foreman/state.json"))
const readStep = (repo, n) => readJson(path.join(repo.dir, ".foreman", "steps", String(n), "step.json"))
const readLedger = (repo) => fs.existsSync(path.join(repo.dir, ".foreman/ledger.jsonl"))
  ? fs.readFileSync(path.join(repo.dir, ".foreman/ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : []
const stepFile = (repo, n) => path.join(repo.dir, ".foreman", "steps", String(n), "step.json")
const stepDir = (repo, n) => path.join(repo.dir, ".foreman", "steps", String(n))
const ghLogText = () => fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : ""
const bodyText = () => fs.existsSync(bodies) ? fs.readFileSync(bodies, "utf8") : ""

function stateStep(overrides = {}) {
  return {
    n: 1,
    title: "existing",
    goal: "an existing step",
    acceptance: ["criterion"],
    acceptanceCommands: ["true"],
    scope: [],
    dependsOn: [],
    status: "open",
    planIssue: 30,
    implIssue: null,
    fixIssues: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

async function loadTools(root, options = {}) {
  const tools = {}
  const ctx = {
    location: { directory: root },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: { prompt: async () => {}, get: async () => ({}), context: async () => "", compact: async () => {}, ...(options.session ?? {}) },
    permission: { list: async () => [] },
    event: { subscribe: async function* () {} },
  }
  await plugin.setup(ctx)
  return tools
}

const call = async (tools, name, input) => {
  const result = await tools[name].execute(input)
  return String(result?.content ?? "")
}

const baseStep = () => ({
  title: "new step",
  goal: "prove the guard",
  acceptance: ["criterion"],
  acceptanceCommands: ["true"],
})

// A refusal must be inert: no GitHub call, no step directory, no cursor move,
// no ledger record. Everything the guard needs is read before any write.
function assertInert(repo, { stepNumber, cursor = repo.initialCursor ?? 0 }) {
  assert.equal(ghLogText(), repo.ghLogBefore, "a refusal called gh")
  assert.equal(fs.existsSync(stepDir(repo, stepNumber)), false, `a refusal created steps/${stepNumber}`)
  const state = readState(repo)
  assert.equal(state.cursor, cursor, "a refusal moved the cursor")
  assert.equal(state.current, repo.initialCurrent ?? null, "a refusal changed current")
  const ledgerFile = path.join(repo.dir, ".foreman/ledger.jsonl")
  const entries = fs.existsSync(ledgerFile)
    ? fs.readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
  assert.equal(entries.filter((entry) => entry.type === "step").length, 0, "a refusal wrote a step ledger record")
}

function mark(repo) {
  repo.ghLogBefore = ghLogText()
  repo.initialCursor = readState(repo).cursor
  repo.initialCurrent = readState(repo).current
  return repo
}

let passed = 0
const failures = []
async function scenario(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}: ${error?.message ?? error}`)
  }
}

/* ------------------------------ scenarios ------------------------------ */

await scenario("order: STOP beats every other guard", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "open", planIssue: 30 })], cursor: 1 })
  fs.writeFileSync(path.join(repo.dir, ".foreman/STOP"), "stoppedAt: now\nreason: smoke\n")
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), title: "", dependsOn: ["#30"], acceptanceCommands: [] })
  assert.match(message, /^REFUSED: STOP present/)
  assertInert(repo, { stepNumber: 2 })
})

await scenario("B2: capacity 3/3 refusal beats an empty title; with spare capacity title wins", async () => {
  // Three active steps at maxParallel 3: the pipeline is full, so the capacity
  // guard refuses before any field is read.
  const repo = makeRepo()
  const full = [1, 2, 3].map((n) => stateStep({ n, planIssue: 30 + n }))
  writeState(repo, { maxParallel: 3, steps: full, cursor: 3, active: [1, 2, 3] })
  mark(repo)
  let tools = await loadTools(repo.dir)
  const atCapacity = await call(tools, "foreman_step", { ...baseStep(), title: "" })
  assert.match(atCapacity, /^REFUSED: capacity reached \(3\/3\)\./)
  assertInert(repo, { stepNumber: 4, cursor: 3 })

  // The same pipeline with step 3 verified: capacity is free, so the field
  // guard is the one that refuses.
  writeState(repo, {
    maxParallel: 3,
    steps: [full[0], full[1], stateStep({ n: 3, planIssue: 33, status: "verified" })],
    cursor: 3,
    active: [1, 2, 3],
  })
  mark(repo)
  tools = await loadTools(repo.dir)
  const spare = await call(tools, "foreman_step", { ...baseStep(), title: "" })
  assert.equal(spare, "REFUSED: title and goal are required.")
  assertInert(repo, { stepNumber: 4, cursor: 3 })
})

await scenario("order: title/goal beat acceptanceCommands and dependsOn", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "fixing", planIssue: 30 })], cursor: 1 })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), title: " ", dependsOn: ["#30"], acceptanceCommands: [] })
  assert.equal(message, "REFUSED: title and goal are required.")
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("order: acceptanceCommands beat dependsOn", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "fixing", planIssue: 30 })], cursor: 1 })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#30"], acceptanceCommands: [] })
  assert.equal(message, ACCEPT_REQUIRED)
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("A3: a dependsOn step that is open, implemented or fixing is refused", async () => {
  for (const status of ["open", "implemented", "fixing"]) {
    const repo = makeRepo()
    writeState(repo, { steps: [stateStep({ status, planIssue: 30 })], cursor: 1 })
    mark(repo)
    const tools = await loadTools(repo.dir)
    const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#30"] })
    assert.equal(message, `REFUSED: dependsOn is not satisfied: #30 is ${status} (step 1). Only verified steps of this loop may be depended on.`)
    assertInert(repo, { stepNumber: 2, cursor: 1 })
  }
})

await scenario("A3: every offending dependency is reported", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [
      stateStep({ n: 1, status: "fixing", planIssue: 30 }),
      stateStep({ n: 2, status: "open", planIssue: 40, scope: ["backend/api"] }),
    ],
    cursor: 2,
  })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#30", "depends on #40"] })
  assert.match(message, /^REFUSED: dependsOn is not satisfied: #30 is fixing \(step 1\), #40 is open \(step 2\)\./)
  assertInert(repo, { stepNumber: 3, cursor: 2 })
})

await scenario("A3: verified plan, impl and fix issues are accepted and external numbers are annotated", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({
      status: "verified",
      planIssue: 30,
      implIssue: 31,
      fixIssues: [32, 33],
      scope: ["backend/apis"],
    })],
    cursor: 1,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    dependsOn: ["#30", "#31", "#32", "#33", "external #999"],
    scope: ["shared/other/file.ts"],
  })
  assert.match(message, /^STEP 2 created: #\d+/)
  assert.match(message, /external dependencies: external #999 \(annotated in the issue\)/)
  const step = readStep(repo, 2)
  assert.deepEqual(step.dependsOn, ["#30", "#31", "#32", "#33", "external #999"])
  assert.deepEqual(step.externalDependencies, ["external #999"])
  assert.equal(step.status, "open")
  assert.equal(readState(repo).cursor, 2)
  assert.equal(readState(repo).current, 2)
  const body = bodyText()
  assert.ok(body.includes("- #30\n") || body.includes("- #30\r\n"), "verified dependency missing from the body")
  assert.ok(body.includes("- external #999 (external dependency: not a step of this loop)"), "external dependency not annotated")
  assert.ok(!body.includes("- #31 (external dependency"), "impl issue of this loop must not be external")
})

await scenario("A3: a number that belongs to another loop is external, not a blocker", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "fixing", planIssue: 30 })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#77"] })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(repo, 2).externalDependencies, ["#77"])
  assert.ok(bodyText().includes("- #77 (external dependency: not a step of this loop)"))
})

// The tag belongs to each number, not to the entry: one entry may carry a step
// of this loop and an outside issue at the same time.
function bodySince(offset) {
  return bodyText().slice(offset)
}

await scenario("A3: a mixed entry tags only the external number", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ status: "verified", planIssue: 30, implIssue: 31, fixIssues: [32], scope: ["backend/apis"] })],
    cursor: 1,
  })
  const tools = await loadTools(repo.dir)
  const mark = bodyText().length
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    dependsOn: ["#30, #999"],
    scope: ["shared/mixed/file.ts"],
  })
  assert.match(message, /^STEP 2 created/)
  const step = readStep(repo, 2)
  assert.deepEqual(step.externalDependencies, [])
  assert.deepEqual(step.externalDependencyNumbers, [999])
  const body = bodySince(mark)
  assert.ok(body.includes("- #30, #999 (external dependency: not a step of this loop)"), "mixed entry must tag #999 in place")
  assert.ok(!body.includes("#30 (external dependency"), "a step of this loop must not be tagged external")
  assert.ok(!body.includes("#31 (external dependency"), "impl issue of this loop must not be tagged external")
  assert.ok(!body.includes("#32 (external dependency"), "fix issue of this loop must not be tagged external")
})

await scenario("A3: separate entries tag only the external one", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "verified", planIssue: 30, scope: ["backend/apis"] })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const mark = bodyText().length
  await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#30", "#999"], scope: ["shared/separate/file.ts"] })
  const body = bodySince(mark)
  assert.ok(body.includes("- #30\n") || body.includes("- #30\r\n"), "verified dependency must stay untagged")
  assert.ok(body.includes("- #999 (external dependency: not a step of this loop)"), "external entry must be tagged")
})

await scenario("A3: duplicate external numbers are deduped but every occurrence is tagged", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "verified", planIssue: 30 })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const mark = bodyText().length
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    dependsOn: ["#999, #30", "again #999"],
    scope: ["shared/dupes/file.ts"],
  })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(repo, 2).externalDependencyNumbers, [999])
  const body = bodySince(mark)
  assert.equal((body.match(/#999 \(external dependency: not a step of this loop\)/g) ?? []).length, 2)
  assert.ok(!body.includes("#30 (external dependency"))
})

await scenario("A3: an entry with prose tags the external number in place", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "verified", planIssue: 30 })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const mark = bodyText().length
  await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["Step #999 and #30"], scope: ["shared/prose/file.ts"] })
  const body = bodySince(mark)
  assert.ok(body.includes("Step #999 (external dependency: not a step of this loop) and #30"), "prose must survive and only #999 be tagged")
  assert.ok(!body.includes("#30 (external dependency"))
})

await scenario("A3: a mixed entry with a non-verified step still refuses and names it", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ status: "fixing", planIssue: 30 })], cursor: 1 })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#30, #999"] })
  assert.equal(message, "REFUSED: dependsOn is not satisfied: #30 is fixing (step 1). Only verified steps of this loop may be depended on.")
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

// A number may be owned by several steps (a fix issue of one and the plan issue
// of another). One verified owner must never hide an unfinished owner, and array
// order must not decide the verdict.
await scenario("A3: an ambiguous number owned by a verified and a fixing step is refused in both orders", async () => {
  for (const order of ["verified-first", "fixing-first"]) {
    const repo = makeRepo()
    const verified = stateStep({ n: 0, status: "verified", planIssue: 100, fixIssues: [101] })
    const fixing = stateStep({ n: 0, status: "fixing", planIssue: 101 })
    const steps = order === "verified-first" ? [verified, fixing] : [fixing, verified]
    steps.forEach((step, index) => { step.n = index + 1 })
    writeState(repo, { steps, cursor: 2 })
    mark(repo)
    const tools = await loadTools(repo.dir)
    const message = await call(tools, "foreman_step", {
      ...baseStep(),
      dependsOn: ["#101"],
      scope: ["shared/ambiguous/file.ts"],
    })
    const fixingN = steps.find((step) => step.status === "fixing").n
    assert.equal(message, `REFUSED: dependsOn is not satisfied: #101 is fixing (step ${fixingN}). Only verified steps of this loop may be depended on.`)
    assertInert(repo, { stepNumber: 3, cursor: 2 })
  }
})

await scenario("A3: a number owned by two verified steps is accepted", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [
      stateStep({ n: 1, status: "verified", planIssue: 100, fixIssues: [101] }),
      stateStep({ n: 2, status: "verified", planIssue: 101 }),
    ],
    cursor: 2,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#101"], scope: ["shared/two-verified/file.ts"] })
  assert.match(message, /^STEP 3 created/)
  assert.deepEqual(readStep(repo, 3).externalDependencies, [])
})

await scenario("A3: a number owned by a verified and an open step is refused on the open step", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [
      stateStep({ n: 1, status: "verified", planIssue: 100, fixIssues: [101] }),
      stateStep({ n: 2, status: "open", planIssue: 101 }),
    ],
    cursor: 2,
  })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#101"], scope: ["shared/verified-open/file.ts"] })
  assert.equal(message, "REFUSED: dependsOn is not satisfied: #101 is open (step 2). Only verified steps of this loop may be depended on.")
  assertInert(repo, { stepNumber: 3, cursor: 2 })
})

await scenario("A3: a number owned only as a fix issue follows that step's status", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [
      stateStep({ n: 1, status: "verified", planIssue: 100 }),
      stateStep({ n: 2, status: "fixing", planIssue: 200, fixIssues: [101] }),
    ],
    cursor: 2,
  })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const refused = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#101"], scope: ["shared/fix-only/file.ts"] })
  assert.equal(refused, "REFUSED: dependsOn is not satisfied: #101 is fixing (step 2). Only verified steps of this loop may be depended on.")
  assertInert(repo, { stepNumber: 3, cursor: 2 })

  writeState(repo, {
    steps: [
      stateStep({ n: 1, status: "verified", planIssue: 100 }),
      stateStep({ n: 2, status: "verified", planIssue: 200, fixIssues: [101] }),
    ],
    cursor: 2,
  })
  const tools2 = await loadTools(repo.dir)
  const accepted = await call(tools2, "foreman_step", { ...baseStep(), dependsOn: ["#101"], scope: ["shared/fix-only-2/file.ts"] })
  assert.match(accepted, /^STEP 3 created/)
})

// "#0" is malformed but the gate accepts any number outside the loop: the only
// thing that must never happen is a missing issue number matching it. Every
// step below leaves implIssue null (and one leaves planIssue null too), which
// Number() would turn into 0.
await scenario("A3: #0 is external, not an unfinished owner, when the only step is open", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ status: "open", planIssue: 30, implIssue: null, fixIssues: [] })],
    cursor: 1,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#0"] })
  assert.match(message, /^STEP 2 created/)
  const step = readStep(repo, 2)
  assert.deepEqual(step.externalDependencies, ["#0"])
  assert.deepEqual(step.externalDependencyNumbers, [0])
  assert.ok(bodyText().includes("- #0 (external dependency: not a step of this loop)"), "#0 must be annotated as external")
})

await scenario("A3: #0 is external when the only step is verified", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ status: "verified", planIssue: 30, implIssue: null, fixIssues: [] })],
    cursor: 1,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#0"] })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(repo, 2).externalDependencies, ["#0"])
  assert.ok(bodyText().includes("- #0 (external dependency: not a step of this loop)"))
})

await scenario("A3: null planIssue, implIssue and fixIssues entries never own #0", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [
      stateStep({ n: 1, status: "open", planIssue: null, implIssue: null, fixIssues: [null] }),
      stateStep({ n: 2, status: "fixing", planIssue: 40, implIssue: null, fixIssues: [null, 41] }),
    ],
    cursor: 2,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#0"] })
  assert.match(message, /^STEP 3 created/)
  assert.deepEqual(readStep(repo, 3).externalDependencies, ["#0"])
  assert.ok(bodyText().includes("- #0 (external dependency: not a step of this loop)"))
})

// The same fixtures still resolve real owners, so the null guard did not turn
// the gate into accept-everything.
await scenario("A3: a real number still wins over the null guard", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ status: "open", planIssue: null, implIssue: null, fixIssues: [null, 41] })],
    cursor: 1,
  })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const refused = await call(tools, "foreman_step", { ...baseStep(), dependsOn: ["#41"] })
  assert.equal(refused, "REFUSED: dependsOn is not satisfied: #41 is open (step 1). Only verified steps of this loop may be depended on.")
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("A4: an exactly equal scope is refused after normalisation", async () => {
  const repo = makeRepo()
  const target = "shared/contracts/src/client.ts"
  writeState(repo, { steps: [stateStep({ scope: [target] })], cursor: 1 })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    scope: [`.//${target}/`],
  })
  assert.equal(message, `REFUSED: scope overlaps step 1 on ${target}`)
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("A4: a parent directory overlaps its child file and reports the specific path", async () => {
  const target = "shared/contracts/src/client.ts"
  const parent = makeRepo()
  writeState(parent, { steps: [stateStep({ scope: ["shared/contracts/src"] })], cursor: 1 })
  mark(parent)
  let tools = await loadTools(parent.dir)
  let message = await call(tools, "foreman_step", { ...baseStep(), scope: [target] })
  assert.equal(message, `REFUSED: scope overlaps step 1 on ${target}`)
  assertInert(parent, { stepNumber: 2, cursor: 1 })

  const child = makeRepo()
  writeState(child, { steps: [stateStep({ scope: [target] })], cursor: 1 })
  mark(child)
  tools = await loadTools(child.dir)
  message = await call(tools, "foreman_step", { ...baseStep(), scope: ["shared/contracts/src"] })
  assert.equal(message, `REFUSED: scope overlaps step 1 on ${target}`)
  assertInert(child, { stepNumber: 2, cursor: 1 })
})

await scenario("A4: backend/api and backend/apis do not overlap (no bare string prefix)", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ scope: ["backend/api"], status: "implemented" })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), scope: ["backend/apis"] })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(repo, 2).scope, ["backend/apis"])
})

await scenario("A4: disjoint scopes are accepted and normalised on the step", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ scope: [BARRELS.contracts], status: "fixing" })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), scope: ["./backend//apis/", "backend/api"] })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(repo, 2).scope, ["backend/apis", "backend/api"])
})

await scenario("A4: an empty scope on either side overlaps nothing", async () => {
  const newEmpty = makeRepo()
  writeState(newEmpty, { steps: [stateStep({ scope: ["backend/api"] })], cursor: 1 })
  let tools = await loadTools(newEmpty.dir)
  let message = await call(tools, "foreman_step", { ...baseStep() })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(newEmpty, 2).scope, [])

  const existingEmpty = makeRepo()
  writeState(existingEmpty, { steps: [stateStep({ scope: [] })], cursor: 1 })
  tools = await loadTools(existingEmpty.dir)
  message = await call(tools, "foreman_step", { ...baseStep(), scope: ["backend/api"] })
  assert.match(message, /^STEP 2 created/)
})

await scenario("C3: a barrel in a non-integration step is refused with its own message", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ scope: ["backend/apis"] })], cursor: 1 })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), scope: [BARRELS.module] })
  assert.equal(message, `REFUSED: barrel ${BARRELS.module} may only be touched by an integration step. Pass kind: "integration" for the fan-in step.`)
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("C3: an integration step may list a barrel", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [stateStep({ scope: ["backend/apis"], status: "verified" })], cursor: 1 })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    kind: "integration",
    scope: [`.//${BARRELS.promotion}/`],
  })
  assert.match(message, /^STEP 2 created/)
  const step = readStep(repo, 2)
  assert.equal(step.kind, "integration")
  assert.deepEqual(step.scope, [BARRELS.promotion])
})

await scenario("C3: two active barrel steps are in mutual conflict, even on different barrels", async () => {
  for (const barrel of [BARRELS.contracts, BARRELS.draft]) {
    const repo = makeRepo()
    writeState(repo, {
      steps: [stateStep({ n: 1, status: "open", kind: "integration", scope: [BARRELS.contracts], planIssue: 30 })],
      cursor: 1,
    })
    mark(repo)
    const tools = await loadTools(repo.dir)
    const message = await call(tools, "foreman_step", {
      ...baseStep(),
      kind: "integration",
      scope: [barrel],
    })
    assert.equal(message, `REFUSED: step 1 already touches barrel ${BARRELS.contracts}; two active steps may not both touch barrels.`)
    assertInert(repo, { stepNumber: 2, cursor: 1 })
  }
})

await scenario("C3: the barrel conflict message wins over the generic overlap message", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, status: "implemented", kind: "integration", scope: [BARRELS.contracts], planIssue: 30 })],
    cursor: 1,
  })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), kind: "integration", scope: [BARRELS.contracts] })
  assert.match(message, /^REFUSED: step 1 already touches barrel .*; two active steps may not both touch barrels\.$/)
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("C3: a verified barrel step no longer conflicts", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, status: "verified", kind: "integration", scope: [BARRELS.contracts], planIssue: 30 })],
    cursor: 1,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), kind: "integration", scope: [BARRELS.contracts] })
  assert.match(message, /^STEP 2 created/)
})

await scenario("A4: dependsOn runs before scope (order proof)", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, status: "fixing", planIssue: 30, scope: ["backend/api"] })],
    cursor: 1,
  })
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    dependsOn: ["#30"],
    scope: ["backend/api"],
  })
  assert.match(message, /^REFUSED: dependsOn is not satisfied: #30 is fixing/)
  assertInert(repo, { stepNumber: 2, cursor: 1 })
})

await scenario("A4: an unknown kind is refused before any write", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  mark(repo)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), kind: "fan-in" })
  assert.equal(message, 'REFUSED: kind must be "integration" when set.')
  assertInert(repo, { stepNumber: 1, cursor: 0 })
})

await scenario("A4: the repo root ('.', '/') overlaps every scope, on both sides", async () => {
  for (const root of [".", "/"]) {
    // Root requested against an active child step.
    const requestedRoot = makeRepo()
    writeState(requestedRoot, { steps: [stateStep({ scope: ["backend/api"] })], cursor: 1 })
    mark(requestedRoot)
    let tools = await loadTools(requestedRoot.dir)
    let message = await call(tools, "foreman_step", { ...baseStep(), scope: [root] })
    assert.equal(message, "REFUSED: scope overlaps step 1 on backend/api")
    assertInert(requestedRoot, { stepNumber: 2, cursor: 1 })

    // Root held by an active step against a requested child.
    const activeRoot = makeRepo()
    writeState(activeRoot, { steps: [stateStep({ scope: [root] })], cursor: 1 })
    mark(activeRoot)
    tools = await loadTools(activeRoot.dir)
    message = await call(tools, "foreman_step", { ...baseStep(), scope: ["backend/api"] })
    assert.equal(message, "REFUSED: scope overlaps step 1 on backend/api")
    assertInert(activeRoot, { stepNumber: 2, cursor: 1 })
  }

  const bothRoot = makeRepo()
  writeState(bothRoot, { steps: [stateStep({ scope: ["."] })], cursor: 1 })
  mark(bothRoot)
  const tools = await loadTools(bothRoot.dir)
  const message = await call(tools, "foreman_step", { ...baseStep(), scope: ["/"] })
  assert.equal(message, "REFUSED: scope overlaps step 1 on .")
  assertInert(bothRoot, { stepNumber: 2, cursor: 1 })
})

await scenario("A4: interior '.' and '..' segments are resolved before comparing", async () => {
  const target = "shared/contracts/src/client.ts"
  const cases = [
    ["shared/contracts/src/./client.ts", "shared/contracts/src", target],
    [`${target}/../client.ts`, "shared/contracts/src", target],
    ["shared/contracts/src/../src/client.ts", "shared/contracts/src", target],
    ["../escape/../backend/api", "backend/api", "backend/api"],
  ]
  for (const [requested, active, overlap] of cases) {
    const repo = makeRepo()
    writeState(repo, { steps: [stateStep({ scope: [active] })], cursor: 1 })
    mark(repo)
    const tools = await loadTools(repo.dir)
    const message = await call(tools, "foreman_step", { ...baseStep(), scope: [requested] })
    assert.equal(message, `REFUSED: scope overlaps step 1 on ${overlap}`)
    assertInert(repo, { stepNumber: 2, cursor: 1 })
  }

  // A scope that escapes the repo is stored as the root sentinel: conservative
  // (it overlaps everything) instead of a path that cannot be compared.
  const escaping = makeRepo()
  writeState(escaping, { steps: [stateStep({ scope: ["backend/api"], status: "verified" })], cursor: 1 })
  const escapingTools = await loadTools(escaping.dir)
  const created = await call(escapingTools, "foreman_step", { ...baseStep(), scope: ["../escape"] })
  assert.match(created, /^STEP 2 created/)
  assert.deepEqual(readStep(escaping, 2).scope, ["."])
})

await scenario("A4: canonical scope is what gets stored", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_step", {
    ...baseStep(),
    scope: ["./backend//apis/./v2/", "Backend/Api", "./backend/apis/v2"],
  })
  assert.match(message, /^STEP 1 created/)
  // Ordinary scopes keep their case: only barrel identity is case-insensitive.
  assert.deepEqual(readStep(repo, 1).scope, ["backend/apis/v2", "Backend/Api"])
})

await scenario("C3: barrel identity is case-insensitive and survives odd spellings", async () => {
  const spellings = [
    "shared/contracts/src/./index.ts",
    "Shared/Contracts/src/index.ts",
    "shared//contracts/src/index.ts",
    "./SHARED/contracts/src/index.ts",
  ]
  for (const spelling of spellings) {
    const repo = makeRepo()
    writeState(repo, { steps: [stateStep({ scope: ["backend/apis"] })], cursor: 1 })
    mark(repo)
    const tools = await loadTools(repo.dir)
    const message = await call(tools, "foreman_step", { ...baseStep(), scope: [spelling] })
    assert.equal(message, `REFUSED: barrel ${BARRELS.contracts} may only be touched by an integration step. Pass kind: "integration" for the fan-in step.`)
    assertInert(repo, { stepNumber: 2, cursor: 1 })
  }

  // Two active steps still conflict when one of them spells the barrel differently.
  const conflict = makeRepo()
  writeState(conflict, {
    steps: [stateStep({ n: 1, status: "open", kind: "integration", scope: [BARRELS.contracts], planIssue: 30 })],
    cursor: 1,
  })
  mark(conflict)
  const conflictTools = await loadTools(conflict.dir)
  const conflictMessage = await call(conflictTools, "foreman_step", {
    ...baseStep(),
    kind: "integration",
    scope: ["Shared/Contracts/src/./index.ts"],
  })
  assert.equal(conflictMessage, `REFUSED: step 1 already touches barrel ${BARRELS.contracts}; two active steps may not both touch barrels.`)
  assertInert(conflict, { stepNumber: 2, cursor: 1 })

  // A path that merely starts like a barrel is not a barrel.
  const prefix = makeRepo()
  writeState(prefix, { steps: [stateStep({ scope: ["backend/api"], status: "verified" })], cursor: 1 })
  const prefixTools = await loadTools(prefix.dir)
  const prefixMessage = await call(prefixTools, "foreman_step", { ...baseStep(), scope: ["Shared/Contracts/src"] })
  assert.match(prefixMessage, /^STEP 2 created/)
  assert.deepEqual(readStep(prefix, 2).scope, ["Shared/Contracts/src"])
})

await scenario("C3: all four barrels are recognised through normalisation", async () => {
  for (const barrel of Object.values(BARRELS)) {
    const refused = makeRepo()
    writeState(refused, { steps: [stateStep({ scope: ["backend/apis"] })], cursor: 1 })
    mark(refused)
    const refusedTools = await loadTools(refused.dir)
    const message = await call(refusedTools, "foreman_step", {
      ...baseStep(),
      scope: [`./${barrel.replace(/\//g, "//")}`],
    })
    assert.equal(message, `REFUSED: barrel ${barrel} may only be touched by an integration step. Pass kind: "integration" for the fan-in step.`)
    assertInert(refused, { stepNumber: 2, cursor: 1 })

    const allowed = makeRepo()
    writeState(allowed, { steps: [stateStep({ scope: ["backend/apis"], status: "verified" })], cursor: 1 })
    const allowedTools = await loadTools(allowed.dir)
    const created = await call(allowedTools, "foreman_step", {
      ...baseStep(),
      kind: "integration",
      scope: [barrel.toUpperCase()],
    })
    assert.match(created, /^STEP 2 created/)
    // Stored as written (normalised): barrel identity is only resolved for the guard.
    assert.deepEqual(readStep(allowed, 2).scope, [barrel.toUpperCase()])
  }
})

await scenario("A4: an absolute scope is resolved against the loop root, never slash-stripped into a dead path", async () => {
  // Absolute path of the directory an active step owns: resolves to the same
  // repo-relative path, so the overlap guard sees it.
  const owned = makeRepo()
  writeState(owned, { steps: [stateStep({ scope: ["backend/api/src"] })], cursor: 1 })
  mark(owned)
  let tools = await loadTools(owned.dir)
  let message = await call(tools, "foreman_step", { ...baseStep(), scope: [path.join(owned.dir, "backend/api/src")] })
  assert.equal(message, "REFUSED: scope overlaps step 1 on backend/api/src")
  assertInert(owned, { stepNumber: 2, cursor: 1 })

  // Absolute path elsewhere inside the repo: stored repo-relative, accepted.
  const inside = makeRepo()
  writeState(inside, { steps: [stateStep({ scope: ["backend/api"], status: "verified" })], cursor: 1 })
  tools = await loadTools(inside.dir)
  message = await call(tools, "foreman_step", { ...baseStep(), scope: [path.join(inside.dir, "shared/other/file.ts")] })
  assert.match(message, /^STEP 2 created/)
  assert.deepEqual(readStep(inside, 2).scope, ["shared/other/file.ts"])

  // Absolute path outside the repo cannot be compared: root sentinel, so it
  // overlaps the active step instead of becoming an inert dead path.
  const outside = makeRepo()
  writeState(outside, { steps: [stateStep({ scope: ["backend/api"] })], cursor: 1 })
  mark(outside)
  tools = await loadTools(outside.dir)
  message = await call(tools, "foreman_step", { ...baseStep(), scope: [path.join(tmp, "elsewhere/backend/api")] })
  assert.equal(message, "REFUSED: scope overlaps step 1 on backend/api")
  assertInert(outside, { stepNumber: 2, cursor: 1 })

  // Same, with no active step: stored as the root sentinel, never as an
  // absolute or dead repo-relative path.
  const silent = makeRepo()
  writeState(silent, {})
  tools = await loadTools(silent.dir)
  message = await call(tools, "foreman_step", { ...baseStep(), scope: [path.join(tmp, "elsewhere/backend")] })
  assert.match(message, /^STEP 1 created/)
  assert.deepEqual(readStep(silent, 1).scope, ["."])

  // An absolute path that climbs out of the repo collapses the same way.
  const climbing = makeRepo()
  writeState(climbing, { steps: [stateStep({ scope: ["backend/api"] })], cursor: 1 })
  mark(climbing)
  tools = await loadTools(climbing.dir)
  message = await call(tools, "foreman_step", { ...baseStep(), scope: [path.join(climbing.dir, "../backend/api")] })
  assert.equal(message, "REFUSED: scope overlaps step 1 on backend/api")
  assertInert(climbing, { stepNumber: 2, cursor: 1 })
})

/* ---------------------- parallel dispatch (phase C7/C8) ---------------------- */

const unitDef = (id) => ({
  id,
  title: `unit ${id}`,
  dependsOn: [],
  scope: [`backend/api/src/${id}`],
  seam: [],
  class: "independent",
})

await scenario("C8: one tick offers every ready unit with a disjoint scope, up to the worker budget", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    units: ["u1", "u2", "u3", "u4"].map(unitDef),
    steps: [],
    cursor: 0,
    active: [],
  })
  const tools = await loadTools(repo.dir)
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: multi/)
  assert.ok(next.includes("CAPACITY: 0/3"), next)
  assert.ok(next.includes("VERIFY: 0/2"), next)
  const creates = next.split("\n").filter((line) => /^\d+\. create_step — unit /.test(line))
  assert.deepEqual(creates, [
    "1. create_step — unit u1 (independent)",
    "2. create_step — unit u2 (independent)",
    "3. create_step — unit u3 (independent)",
  ])
  // Each offer carries the step number it will create.
  const steps = next.split("\n").filter((line) => /NEXT_STEP: /.test(line)).map((line) => line.trim())
  assert.deepEqual(steps, ["NEXT_STEP: 1", "NEXT_STEP: 2", "NEXT_STEP: 3"])
})

await scenario("C8: a unit whose scope overlaps an offer is deferred to the next tick", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    units: [unitDef("u1"), { ...unitDef("u2"), scope: ["backend/api/src/u1"] }, unitDef("u3")],
    steps: [],
    cursor: 0,
    active: [],
  })
  const tools = await loadTools(repo.dir)
  const next = await call(tools, "foreman_next")
  const creates = next.split("\n").filter((line) => /^\d+\. create_step — unit /.test(line))
  assert.deepEqual(creates, [
    "1. create_step — unit u1 (independent)",
    "2. create_step — unit u3 (independent)",
  ])
})

await scenario("C7: an implemented step does not hold a worker slot, the total pipeline is still bounded", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    maxVerify: 1,
    steps: [
      stateStep({ n: 1, planIssue: 31, status: "open", scope: ["backend/api/src/w1"] }),
      stateStep({ n: 2, planIssue: 32, status: "open", scope: ["backend/api/src/w2"] }),
      stateStep({ n: 3, planIssue: 33, status: "implemented", scope: ["backend/api/src/w3"] }),
    ],
    cursor: 3,
    active: [1, 2, 3],
  })
  let tools = await loadTools(repo.dir)
  const fourth = await call(tools, "foreman_step", { ...baseStep(), scope: ["backend/api/src/w4"] })
  assert.match(fourth, /^STEP 4 created/)
  // Three workers + one verifier is the whole pipeline: a fifth step is refused.
  const fifth = await call(tools, "foreman_step", { ...baseStep(), scope: ["backend/api/src/w5"] })
  assert.match(fifth, /^REFUSED: capacity reached \(3\/3\)/)
})

await scenario("C7: every open step is dispatched in one multi tick, workers first", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    maxVerify: 1,
    steps: [
      stateStep({ n: 1, planIssue: 31, status: "open", scope: ["backend/api/src/w1"] }),
      stateStep({ n: 2, planIssue: 32, status: "open", scope: ["backend/api/src/w2"] }),
    ],
    cursor: 2,
    active: [1, 2],
  })
  const tools = await loadTools(repo.dir)
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: multi/)
  assert.ok(next.includes("CAPACITY: 2/3"), next)
  const actions = next.split("\n").filter((line) => /^\d+\. /.test(line))
  assert.deepEqual(actions, [
    "1. dispatch_worker — step 1, issue #31",
    "2. dispatch_worker — step 2, issue #32",
  ])
  assert.match(next, /background: true/)
  // The dispatch is a ledger record, so the parallelism metric is auditable.
  const dispatches = readLedger(repo).filter((entry) => entry.type === "dispatch")
  assert.deepEqual(dispatches.map((entry) => [entry.step, entry.action]), [[1, "dispatch_worker"], [2, "dispatch_worker"]])
})

await scenario("C7: every worker is dispatched in the background, a lone one included", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    steps: [stateStep({ n: 1, planIssue: 31, status: "open" })],
    cursor: 1,
    active: [1],
  })
  const tools = await loadTools(repo.dir)
  const lone = await call(tools, "foreman_next")
  assert.match(lone, /^ACTION: dispatch_worker/)
  assert.match(lone, /in the background/)
  assert.match(lone, /foreman_worktree with step 1/, "the dispatch does not tell how to get the worktree")
  assert.equal(lone.includes("in the foreground"), false, lone)
})

await scenario("C7: at most maxVerify verifiers are dispatched, the next one waits for the verdict", async () => {  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    maxVerify: 1,
    steps: [
      stateStep({ n: 1, planIssue: 31, status: "implemented", scope: ["backend/api/src/w1"] }),
      stateStep({ n: 2, planIssue: 32, status: "implemented", scope: ["backend/api/src/w2"] }),
    ],
    cursor: 2,
    active: [1, 2],
  })
  const tools = await loadTools(repo.dir)
  const first = await call(tools, "foreman_next")
  assert.match(first, /^ACTION: dispatch_verifier/)
  assert.ok(first.includes("STEP: 1"), first)
  const second = await call(tools, "foreman_next")
  assert.match(second, /^ACTION: wait/)
  assert.ok(second.includes("VERIFY: 2/1"), second)
})

await scenario("C7: foreman_status reports peak worker concurrency from the dispatch ledger", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 3,
    steps: [
      stateStep({ n: 1, planIssue: 31, status: "verified" }),
      stateStep({ n: 2, planIssue: 32, status: "verified" }),
    ],
    cursor: 2,
    active: [],
  })
  const now = Date.now()
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
  const ledgerFile = path.join(repo.dir, ".foreman", "ledger.jsonl")
  fs.writeFileSync(ledgerFile, [
    { at: at(20), type: "dispatch", step: 1, action: "dispatch_worker", issue: 31 },
    { at: at(12), type: "dispatch", step: 2, action: "dispatch_worker", issue: 32 },
    { at: at(6), type: "result", step: 1, issue: 31 },
    { at: at(2), type: "result", step: 2, issue: 32 },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  const tools = await loadTools(repo.dir)
  const status = await call(tools, "foreman_status")
  assert.match(status, /- parallelism: peak 2 worker\(s\)/)
  assert.match(status, /- capacity: 0\/3 workers · 0\/2 verify/)
})

/* --------------------------- dead dispatch, handoff --------------------------- */

await scenario("P0: a dispatch whose child session vanished is cleared and offered again", async () => {
  const repo = makeRepo()
  const at = new Date(Date.now() - 10 * 60_000).toISOString()
  writeState(repo, {
    steps: [stateStep({
      n: 1, planIssue: 31, status: "open",
      dispatchSessionID: "ses_gone", dispatchStartedAt: at, dispatchedAt: at,
    })],
    cursor: 1,
    active: [1],
  })
  const tools = await loadTools(repo.dir, {
    session: {
      get: async ({ sessionID }) => {
        if (String(sessionID) === "ses_gone") throw new Error("session not found")
        return {}
      },
    },
  })
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: dispatch_worker/, next)
  const ended = readLedger(repo).filter((entry) => entry.type === "dispatch_end")
  assert.equal(ended.length, 1, "the vanished dispatch was not recorded as ended")
  assert.equal(ended[0].outcome, "gone")
  assert.equal(readStep(repo, 1).dispatchOutcome, "gone")
})

await scenario("P0: a live child session still holds the step in flight", async () => {
  const repo = makeRepo()
  const at = new Date(Date.now() - 10 * 60_000).toISOString()
  writeState(repo, {
    steps: [stateStep({
      n: 1, planIssue: 31, status: "open",
      dispatchSessionID: "ses_live", dispatchStartedAt: at, dispatchedAt: at,
    })],
    cursor: 1,
    active: [1],
  })
  const tools = await loadTools(repo.dir, { session: { get: async () => ({ id: "ses_live" }) } })
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: wait/, next)
  assert.equal(readLedger(repo).some((entry) => entry.type === "dispatch_end"), false)
})

await scenario("P2: handoff writes the checkpoint and never ends the tick", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, planIssue: 31, status: "open" })],
    cursor: 1,
    active: [1],
  })
  const compacted = []
  const tools = await loadTools(repo.dir, { session: { compact: async (request) => { compacted.push(request) } } })
  const handoff = await call(tools, "foreman_handoff", { summary: "checkpoint" })
  assert.match(handoff, /continue this tick/)
  assert.deepEqual(compacted, [], "the handoff queued a compaction")
  assert.equal(readLedger(repo).some((entry) => entry.type === "handoff"), true)
  assert.match(await call(tools, "foreman_next"), /^ACTION: dispatch_worker/)
})

/* ------------------------------- worktrees -------------------------------- */

const commitFile = (repo, name, content = "x\n") => {
  const file = path.join(repo.dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  git(repo.dir, "add", "--", name)
  git(repo.dir, "commit", "-q", "-m", `add ${name}`)
  return git(repo.dir, "rev-parse", "HEAD")
}

await scenario("P0: foreman_worktree creates the step tree with the install hardlinked", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, planIssue: 31, status: "open" })],
    cursor: 1,
    active: [1],
  })
  fs.mkdirSync(path.join(repo.dir, "node_modules", "fake"), { recursive: true })
  fs.writeFileSync(path.join(repo.dir, "node_modules", "fake", "index.js"), "x\n")
  const tools = await loadTools(repo.dir)
  const prepared = await call(tools, "foreman_worktree", { step: 1 })
  assert.match(prepared, /^WORKTREE: /, prepared)
  assert.match(prepared, /NODE_MODULES: hardlinked/, prepared)
  const worktree = prepared.match(/^WORKTREE: (.+)$/m)[1]
  const base = prepared.match(/^BASE: (.+)$/m)[1]
  assert.equal(base, git(repo.dir, "rev-parse", "HEAD"))
  assert.equal(fs.existsSync(path.join(worktree, "node_modules", "fake", "index.js")), true, "node_modules was not linked")
  assert.equal(readStep(repo, 1).worktree, worktree)
  assert.equal(readStep(repo, 1).worktreeBase, base)

  // A fix reuses the same path and wipes the previous attempt.
  fs.writeFileSync(path.join(worktree, "leftover.txt"), "wip\n")
  const again = await call(tools, "foreman_worktree", { step: 1 })
  assert.match(again, /^WORKTREE: /, again)
  assert.match(again, /- reused:/, again)
  assert.equal(again.match(/^WORKTREE: (.+)$/m)[1], worktree)
  assert.equal(fs.existsSync(path.join(worktree, "leftover.txt")), false, "the previous attempt was not wiped")
  assert.equal(fs.existsSync(path.join(worktree, "node_modules", "fake", "index.js")), true, "the install was lost on reset")
})

await scenario("P0: foreman_result refuses a commit that does not descend from the prepared base", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, planIssue: 31, status: "open" })],
    cursor: 1,
    active: [1],
  })
  const tools = await loadTools(repo.dir)
  assert.match(await call(tools, "foreman_worktree", { step: 1 }), /^WORKTREE: /)
  // An unrelated root commit: it exists in the repository but not on the branch.
  git(repo.dir, "checkout", "-q", "--orphan", "stray")
  fs.writeFileSync(path.join(repo.dir, "stray.txt"), "stray\n")
  git(repo.dir, "add", "--", "stray.txt")
  git(repo.dir, "commit", "-q", "-m", "stray root")
  const stray = git(repo.dir, "rev-parse", "HEAD")
  git(repo.dir, "checkout", "-q", repo.branch)
  const refused = await call(tools, "foreman_result", {
    step: 1, commit: stray, command: "true", exitCode: 0, summary: "stale base",
  })
  assert.match(refused, /^REFUSED: commit .* does not descend from the base/, refused)
  assert.equal(readState(repo).steps[0].status, "open", "the refused result moved the step")
})

await scenario("P0: a stray worker worktree is ignored and retired", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, planIssue: 31, status: "open" })],
    cursor: 1,
    active: [1],
  })
  const tools = await loadTools(repo.dir)
  const prepared = await call(tools, "foreman_worktree", { step: 1 })
  const owned = prepared.match(/^WORKTREE: (.+)$/m)[1]
  const stray = path.join(tmp, `stray-${++fixture}`)
  git(repo.dir, "worktree", "add", "--detach", stray, repo.branch)
  const commit = commitFile(repo, "README.md", "# moved\n")
  const recorded = await call(tools, "foreman_result", {
    step: 1, commit, command: "true", exitCode: 0, summary: "shipped", worktree: stray,
  })
  assert.match(recorded, /^RESULT recorded for step 1/, recorded)
  assert.match(recorded, /ignored .*stray/, recorded)
  assert.equal(fs.existsSync(stray), false, "the stray worktree was not retired")
  assert.equal(readStep(repo, 1).worktree, owned, "the step tree stopped being canonical")
})

await scenario("P2: foreman_worktree refuses a verified step and an unknown step", async () => {
  const repo = makeRepo()
  writeState(repo, {
    steps: [stateStep({ n: 1, planIssue: 31, status: "verified" })],
    cursor: 1,
    active: [],
  })
  const tools = await loadTools(repo.dir)
  assert.match(await call(tools, "foreman_worktree", { step: 1 }), /^REFUSED: step 1 is verified/)
  assert.match(await call(tools, "foreman_worktree", { step: 9 }), /^REFUSED: step 9 does not exist/)
})

await scenario("P1: publish merges into the publish branch and retires the plan's worktrees and branch", async () => {
  const repo = makeRepo()
  // A stub live switch: publish runs `npm run live` in the repo root.
  fs.writeFileSync(path.join(repo.dir, "package.json"), `${JSON.stringify({ name: "smoke", version: "1.0.0", scripts: { live: "true" } }, null, 2)}\n`)
  git(repo.dir, "add", "--", "package.json")
  git(repo.dir, "commit", "-q", "-m", "live stub")
  const tip = git(repo.dir, "rev-parse", "HEAD")

  // The loop branch lives in its own checkout; the root moves aside so the
  // branch can be deleted after the merge.
  const loop = path.join(repo.dir, ".foreman", "loop-checkout")
  git(repo.dir, "worktree", "add", "--force", loop, repo.branch)
  git(repo.dir, "checkout", "-q", "-b", "workstation")
  const stepTree = path.join(repo.dir, ".foreman", "workers", "1")
  git(repo.dir, "worktree", "add", "--detach", stepTree, repo.branch)

  // origin with a publish branch that does not carry the loop work yet.
  const origin = path.join(tmp, `origin-${++fixture}.git`)
  execFileSync("git", ["init", "-q", "--bare", origin])
  git(repo.dir, "remote", "add", "origin", origin)
  git(repo.dir, "push", "-q", "origin", `${repo.branch}~1:refs/heads/main`)

  writeState(repo, {
    branch: repo.branch,
    worktree: loop,
    units: [{ id: "u1", title: "unit one", dependsOn: [], scope: ["backend/api/src/u1"], seam: [], class: "independent" }],
    steps: [stateStep({ n: 1, planIssue: 31, status: "verified", unitId: "u1", worktree: stepTree })],
    active: [],
    cursor: 1,
  })
  const tools = await loadTools(repo.dir)
  const published = await call(tools, "foreman_publish", {})
  assert.match(published, /^PUBLISHED foreman\/smoke -> main/, published)
  assert.match(published, /cleaned: 1 step\/verifier worktree\(s\) removed, loop checkout removed, branch foreman\/smoke deleted/, published)
  assert.equal(fs.existsSync(stepTree), false, "the step worktree survived the publish")
  assert.equal(fs.existsSync(loop), false, "the loop checkout survived the publish")
  assert.equal(git(repo.dir, "branch", "--list", repo.branch), "", "the loop branch survived the publish")
  const devTip = git(origin, "rev-parse", "main")
  assert.doesNotThrow(() => git(origin, "merge-base", "--is-ancestor", tip, devTip), "the publish branch does not contain the merged work")
  // A second publish is a summary, not a second merge.
  const again = await call(tools, "foreman_publish", {})
  assert.match(again, /^ALREADY PUBLISHED foreman\/smoke -> main/, again)
})

/* -------------------------------- report -------------------------------- */

console.log("")
if (failures.length) {
  console.log(`FAILED ${failures.length}/${passed + failures.length} scenarios (fixtures in ${tmp})`)
  for (const failure of failures) console.log(`\n--- ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
console.log(`PASSED ${passed}/${passed} scenarios (fixtures in ${tmp})`)
