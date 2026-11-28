#!/usr/bin/env node
/**
 * Local drill harness for the foreman loop (plan phase A7,
 * plans/ForemanHarness.md).
 *
 * It boots the REAL plugin (scripts/foreman/plugin.ts) with only
 * `@opencode/plugin` stubbed, registers a loop with `foreman_start` in a
 * throwaway git repository and drives `foreman_step` / `foreman_result` /
 * `foreman_verify` / `foreman_next` exactly as the foreman does. Every GitHub
 * call goes through scripts/foreman/fake-bin/gh, which only logs its arguments
 * and prints fake issue URLs: no network, no live issue mutation.
 *
 * Scenarios (all must PASS):
 *   1. a step without acceptanceCommands is refused with the exact message;
 *   2. dependsOn naming a step of this loop that is not verified is refused
 *      with the offending issue and its status;
 *   3. a scope intersecting an active step is refused with step and path;
 *   4. foreman_verify good with an acceptance command exiting 1 is refused,
 *      records no verdict, closes nothing and leaves the step implemented;
 *   5. foreman_verify good with every command exiting 0 verifies and closes it;
 *   6. three byte-identical failures create a fix issue each time, leave the
 *      step fixing and never block the loop (no STOP, no state.blocked, no
 *      blocked ledger record); foreman_next dispatches the latest fix;
 *   7. the ledger prevHash chain validates end to end, and a negative control
 *      proves a tampered record is reported invalid;
 *   8. result.json carries attempt (1, then 2 after a fix), the optional worker
 *      durationMs (including 0) and the worktree; a non-numeric or negative
 *      duration is refused before any side effect;
 *   9. verify.json carries evidenceLevel 0-5; -1, 6, 3.5 and non-numeric are
 *      refused with nothing recorded, and acceptanceRuns stays alongside it;
 *  10. every ledger record carries the kind mapped from its type (decision /
 *      fact / evidence) and the prevHash chain stays valid across all of them;
 *  11. a verified step removes and prunes its worktree, with a ledger record;
 *  12. a missing worktree path, the repo root and the loop's own checkout are
 *      no-ops: nothing is removed and nothing errors;
 *  13. foreman_status reports attempts, multi-attempt steps, verifier pass
 *      rate, the median duration (even count, 0 and a huge value) and the
 *      minutes spent in fixes;
 *  14. a legacy state and ledger without any of the new fields still render,
 *      with n/a for the metrics that have no data, and still chain new records;
 *  15. B1: a legacy scalar current migrates to active[] on read (missing, null,
 *      string and array shapes), current stays written for one release, a
 *      verified step leaves active and a verified entry is pruned on read;
 *  16. B2: with maxParallel 3 a third active step can be created and a fourth
 *      is refused at capacity with the exact message; verifying one frees the
 *      slot again and foreman_next prints CAPACITY: n/3;
 *  17. B3/B4: an implemented step N and an open step N+1 produce one multi
 *      tick (worker first, background, then the serial verifier; each ready
 *      unit with a disjoint scope is offered in the same tick), and a
 *      result is cherry-picked serially in the loop worktree as a new commit
 *      carrying the worker tree, with HEAD on the branch;
 *  18. B5: nothing dispatchable returns wait with NEXT about five minutes
 *      ahead, state.nextWakeAt is persisted, a tick before it is skipped and a
 *      tick at/after it runs; a full pipeline also waits;
 *  19. (FOREMAN_DRILL=parallel) three disjoint-scope steps, two in flight
 *      workers, CAPACITY, two dispatch actions in step order, at most one
 *      create_step and no scope conflict.
 *  20. C1: foreman_graph refuses non-arrays, an empty graph, duplicate,
 *      malformed and non-string ids, a missing title, empty or blank scope,
 *      unknown class, unknown/self/cyclic dependencies, seam-parallel without
 *      a seam, integration without dependencies and a non-object unit, with
 *      nothing written and no issue; the valid graph is persisted with
 *      canonical scope and seam; foreman_step requires unitId, refuses an
 *      unknown, taken (open or fixing) or verified unit, and gives the
 *      integration unit kind integration while a parallel unit waits for its
 *      dependency.
 *  21. C2: the ready set — an independent unit is ready at once, a serial unit
 *      waits for its dependency unit, a seam-parallel unit waits for the seam
 *      file and then for the verified step that landed it (a verified directory
 *      scope counts as covering the file), a unit whose scope overlaps an
 *      active step is blocked and refused, status lists every unit with its
 *      readiness, and a dispatch may share the tick with one create_step.
 *  22. C3: the fan-in — the parallel worker is refused until the integration
 *      step (and its acceptance) exists, kind is derived from the unit class, a
 *      non-integration unit may not claim a barrel nor force the kind, and the
 *      fan-in step is held at capacity until every unit it fans in is verified.
 *  23. C4: plan complete only when every unit has a verified step and active is
 *      empty; one pending unit offers create_step instead, a step still in
 *      flight blocks it, and a loop without a graph never sees plan complete.
 *  24. (plan §8) a full graph run — the fan-in acceptance first, the seam
 *      worker then a verified seam commit, the two seam-parallel workers in
 *      parallel (one create_step per tick, 3/3 capacity), the fan-in dispatched
 *      only after both are verified, then ACTION: plan complete. Every emitted
 *      offer is replayed through foreman_step as printed.
 *  25. backward compatibility and probes — a state without units loads and
 *      keeps the old create_step, a free-text unitId still works without a
 *      graph, the graph cannot change once a unit is taken but may be rewritten
 *      before and may be recorded after legacy steps, a graph step without
 *      unitId is refused, two concurrent foreman_step calls on one unit produce
 *      exactly one step, and broken persisted units never crash a read tool.
 *  26. a blocked fan-in is never offered: with two fan-ins sharing a barrel the
 *      second is blocked by the first, the tick falls back to a ready unit and
 *      foreman_step accepts every offer; a fan-in blocked by an active scope
 *      with its own step missing leaves the tick on wait/NOT_READY because the
 *      fan-in gate is unsatisfied; a seam-parallel unit with a missing seam is
 *      not offered. A non-integration unit that names a barrel is refused by
 *      foreman_graph and, seeded, is never offered while foreman_step refuses
 *      it; a second fan-in is not offered while its dependency owns an open
 *      step, and a seeded dependency step that is open or fixing keeps the
 *      fan-in out; a 42-probe graph/state sweep replays every emitted offer
 *      through foreman_step.
 *  27. a creatable fan-in states pending dependencies and says verified only
 *      when every dependency has a verified step; a declared seam is pending
 *      until the check passes; every offer is accepted by foreman_step.
 *  28. two batches, one fan-in each: batches open in graph order (i1, then ua,
 *      then — only after i1 verifies — i2 and ub), a parallel unit is not
 *      offered while its own fan-in has no acceptance, and every emitted offer
 *      is replayed through foreman_step; a seeded planIssue collision (the
 *      verified dependency's issue is also owned by an open step) emits no
 *      offer and is refused by foreman_step for a parallel and an integration
 *      unit until the second owner closes.
 *  29. the fan-in escape is unit-specific: with i1 and v stepped and i2 (which
 *      depends on v and w) missing, w — i2's private unit — is neither offered
 *      nor accepted (status says why) because sharing v with the stepped i1
 *      must not unlock it; after v and i1 verify, i2 is offered and accepted,
 *      then w, and the plan completes 4/4. The escape still covers a unit an
 *      already-stepped fan-in really shares (i1, i2, u all offered). A nested
 *      fan-in (integration depending on integration) is documented honestly:
 *      the only ordering is its dependency, so the outer acceptance waits for
 *      the inner step to verify.
 *  30. the human channel: an open issue labelled `human` + `loop:<id>` is
 *      delivered as ACTION: steer before any create_step, with the body
 *      delimited as data; foreman_step refuses until acknowledged; `applied`
 *      comments and keeps the issue open (no re-delivery), a blocked loop still
 *      receives a reply and `unblock` clears the blocker, and `done` comments
 *      and closes. The channel never creates a step.
 *
 * The last ten are numbered from 20 in parallel mode, so the printed
 * `n/SCENARIO_TOTAL` stays contiguous in both modes.
 *
 * Run from anywhere: the repo root is located from this file, not from cwd.
 *   node scripts/foreman/drill.mjs
 * Exit 0 only when every scenario and guard passes.
 *
 * Scenarios 2 and 3 seed `.foreman/state.json` before calling the tool: at
 * this head `foreman_step` refuses while any step is current, so the only way
 * to reach the dependsOn/scope guards is a loop that already owns an
 * unfinished, non-current step (the state Phase B's active[] produces). The
 * guards themselves run in the real plugin; only the precondition is seeded.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ACCEPT_REQUIRED = "REFUSED: acceptanceCommands is required: the plugin executes these exact commands before good."
const BRANCH = "foreman/drill"
// Every tool call carries a session id: the loop is bound to it and resolved
// per session, exactly as the foreman agent is.
const SESSION_ID = "ses_drill"
const PLUGIN_REL = path.join("scripts", "foreman", "plugin.ts")
// FOREMAN_DRILL=parallel adds the phase B concurrency scenario (plan §8).
const PARALLEL_MODE = /^parallel$/i.test(String(process.env.FOREMAN_DRILL ?? "").trim())
// Scenarios 1-18 are always run; 19 is the phase B concurrency one and only
// runs in parallel mode; the phase C scenarios follow, so their numbers shift
// by one when 19 is present. SCENARIO_TOTAL is the number actually executed.
const PARALLEL_SCENARIO = 19
const FIRST_GRAPH_SCENARIO = PARALLEL_MODE ? PARALLEL_SCENARIO + 1 : PARALLEL_SCENARIO
const GRAPH_SCENARIOS = 13
const SCENARIO_TOTAL = FIRST_GRAPH_SCENARIO + GRAPH_SCENARIOS - 1
// Plan A5 mapping, copied so the drill checks the contract of this plugin version
// and not a helper imported from it.
const LEDGER_KIND = {
  start: "decision",
  resume: "decision",
  attach: "decision",
  stop: "decision",
  handoff: "decision",
  step: "fact",
  result: "fact",
  rejected: "evidence",
  verified: "evidence",
  blocked: "evidence",
  worktree: "evidence",
  graph: "decision",
  human: "decision",
}

/* --------------------------- repo root + temp --------------------------- */

function locateRepoRoot(start) {
  let current = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(current, PLUGIN_REL)) && fs.existsSync(path.join(current, "package.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`cannot locate the repo root from ${start}: no ${PLUGIN_REL}`)
    current = parent
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = locateRepoRoot(here)
const pluginEntry = path.join(sourceRoot, PLUGIN_REL)
const shimDir = path.join(here, "fake-bin")
const shimPath = path.join(shimDir, "gh")
if (!fs.existsSync(shimPath)) throw new Error(`fake gh missing: ${shimPath}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-drill-"))
const ghLog = path.join(tmp, "gh.log")
const ghCounter = path.join(tmp, "gh.counter")
process.env.GH_LOG = ghLog
process.env.GH_COUNTER = ghCounter
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`
// The barrel set is configuration: seed it before the plugin module loads. The
// drill's fixture uses one shared contract surface.
process.env.FOREMAN_BARRELS = "shared/contracts/src/index.ts,shared/contracts/src/second.ts"

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}
process.on("exit", cleanup)
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { cleanup(); process.exit(130) })
}

// The source checkout must come out of the run byte-identical: snapshot it
// before any work and compare at the end.
const gitSource = (args) => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" }).trimEnd()
const sourceStatusBefore = gitSource(["status", "--porcelain"])
const sourceHeadBefore = gitSource(["rev-parse", "HEAD"])

/* ------------------------------ helpers -------------------------------- */

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex")
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const gitWithEnv = (cwd, env, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
}).trim()

// A worker commit dated far in the past can never be recreated by a cherry-pick
// (the pick stamps a fresh committer date), so the drill can prove that the pick
// creates a new commit instead of hoping the pair stays inside one second.
const WORKER_DATE = "2000-01-01T00:00:00Z"

let fixture = 0

function makeRepo() {
  const dir = path.join(tmp, `repo-${++fixture}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "drill@example.com")
  git(dir, "config", "user.name", "Foreman Drill")
  fs.writeFileSync(path.join(dir, "plan.md"), "# Drill plan\n\nThrowaway plan for scripts/foreman/drill.mjs.\n")
  fs.writeFileSync(path.join(dir, ".gitignore"), ".foreman/\n")
  fs.mkdirSync(path.join(dir, "backend/api/src/projects"), { recursive: true })
  fs.writeFileSync(path.join(dir, "backend/api/src/projects/index.ts"), "export const projects = []\n")
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
  fs.writeFileSync(path.join(dir, "scripts/check-parity.mjs"), "process.exit(1)\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  // The loop branch exists but is not checked out in the main worktree: the
  // plugin creates its own worktree on it. The main checkout stays on main, so
  // its commits are the worker commits the loop cherry-picks.
  git(dir, "branch", BRANCH)
  return { dir, branch: BRANCH, head: git(dir, "rev-parse", "HEAD") }
}

function commitFile(repo, name, content) {
  fs.writeFileSync(path.join(repo.dir, name), content)
  git(repo.dir, "add", name)
  git(repo.dir, "commit", "-q", "-m", `fix ${name}`)
  return git(repo.dir, "rev-parse", "HEAD")
}

// Every loop owns .foreman/active/<loop id>/; the drill always starts the same
// plan.md, so the loop id is `plan`. A legacy state at .foreman/state.json is
// only a pre-per-loop fixture, not what a started loop writes.
const LOOP_ID = "plan"
const loopDir = (repo) => path.join(repo.dir, ".foreman", "active", LOOP_ID)

function seedLoop(repo, mutate) {
  const dir = loopDir(repo)
  const stateFile = path.join(dir, "state.json")
  const state = readJson(stateFile)
  mutate(state)
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  for (const step of state.steps ?? []) {
    const stepDir = path.join(dir, "steps", String(step.n))
    fs.mkdirSync(stepDir, { recursive: true })
    fs.writeFileSync(path.join(stepDir, "step.json"), `${JSON.stringify(step, null, 2)}\n`)
  }
  return state
}

const readState = (repo) => readJson(path.join(loopDir(repo), "state.json"))
const readStep = (repo, n, name = "step.json") => readJson(path.join(loopDir(repo), "steps", String(n), name))
const readLedger = (repo) => fs.readFileSync(path.join(loopDir(repo), "ledger.jsonl"), "utf8")
  .split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))

// Write a ledger fixture the way the plugin does: every line hashes the previous
// line. `entries` are plain records, so a legacy fixture simply omits `kind`.
function seedLedger(repo, entries) {
  const lines = []
  let prevHash = ""
  for (const entry of entries) {
    const line = JSON.stringify({ ...entry, prevHash })
    lines.push(line)
    prevHash = sha256(line)
  }
  const dir = loopDir(repo)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "ledger.jsonl"), `${lines.join("\n")}\n`)
}

// A real git worktree in the throwaway repo. --force allows the drill branch to
// be checked out in the worktree while the root checkout still holds it.
function addWorktree(repo, name, force = true) {
  const dir = path.join(tmp, name)
  const args = ["worktree", "add"]
  if (force) args.push("--force")
  git(repo.dir, ...args, dir, repo.branch)
  return dir
}

// A commit produced outside the dedicated branch, the way a worker worktree
// produces one: the branch ref does not move, so foreman_result must really
// cherry-pick it into the loop checkout.
function commitDetached(repo, name, file, content, { date } = {}) {
  const dir = path.join(tmp, name)
  git(repo.dir, "worktree", "add", "--detach", "-q", dir, repo.branch)
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
  git(dir, "add", file)
  if (date) gitWithEnv(dir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "commit", "-q", "-m", `worker ${name}`)
  else git(dir, "commit", "-q", "-m", `worker ${name}`)
  return { dir, sha: git(dir, "rev-parse", "HEAD") }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}

// The plugin subscribes to the host event stream once per setup. The channel
// lets the drill deliver real session events, so the idle tick handler is
// exercised as it runs in the product and not as a helper.
function eventChannel() {
  const queue = []
  let signal
  return {
    push(event) {
      queue.push(event)
      const resume = signal
      signal = undefined
      if (resume) resume()
    },
    async *subscribe() {
      for (;;) {
        while (queue.length) yield queue.shift()
        await new Promise((resolve) => { signal = resolve })
      }
    },
  }
}


function validateLedger(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return { valid: false, records: 0, reason: "ledger is empty" }
  for (let index = 0; index < lines.length; index += 1) {
    let record
    try { record = JSON.parse(lines[index]) } catch { return { valid: false, records: lines.length, index, reason: `record ${index + 1} is not JSON` } }
    const expected = index === 0 ? "" : sha256(lines[index - 1])
    if (record.prevHash !== expected) {
      return { valid: false, records: lines.length, index, reason: `record ${index + 1} prevHash does not match record ${index}` }
    }
  }
  return { valid: true, records: lines.length, reason: "prevHash chain valid" }
}

/* -------------------------- bundle the real plugin ---------------------- */

const stubFile = path.join(tmp, "plugin-stub.ts")
fs.writeFileSync(stubFile, [
  "// the only stub in the drill: the plugin host module",
  "export const Plugin = { define: (config: unknown) => config }",
  "export default { Plugin }",
  "",
].join("\n"))

async function bundlePlugin() {
  const outfile = path.join(tmp, "plugin.bundle.mjs")
  try {
    const esbuild = await import("esbuild")
    await esbuild.build({
      entryPoints: [pluginEntry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      alias: { "@opencode/plugin": stubFile },
      logLevel: "silent",
    })
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
    // The loop checkout does not carry node_modules: use the esbuild the repo
    // already depends on, without installing anything (--no-install).
    execFileSync("npx", [
      "--no-install", "esbuild", pluginEntry,
      "--bundle", "--platform=node", "--format=esm",
      `--alias:@opencode/plugin=${stubFile}`,
      `--outfile=${outfile}`,
      "--log-level=silent",
    ], { cwd: sourceRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  }
  return outfile
}

const bundle = await bundlePlugin()
const bundleModule = await import(pathToFileURL(bundle).href)
const plugin = bundleModule.default
// Phase B5 backoff predicate, exported by the plugin and used by its tick.
const beforeNextWake = bundleModule.beforeNextWake
assert.equal(typeof beforeNextWake, "function", "the plugin does not export beforeNextWake")

/* ------------------------------ drive tools ----------------------------- */

async function loadTools(root, options = {}) {
  const tools = {}
  const prompts = options.prompts
  const channel = options.channel
  const hooks = options.hooks ?? {}
  const toolHooks = options.toolHooks ?? {}
  const ctx = {
    location: { directory: root },
    tool: {
      transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }),
      hook: async (name, callback) => {
        toolHooks[name] = callback
        return { dispose: async () => {} }
      },
    },
    session: {
      prompt: async (request) => { if (prompts) prompts.push(String(request?.text ?? "")); },
      get: async () => options.sessionInfo ?? { agent: { id: "foreman" }, time: { idle: true } },
      context: async () => (typeof options.contextText === "function" ? options.contextText() : options.contextText ?? ""),
      compact: async (request) => { if (options.compact) options.compact.push(request); },
      hook: async (name, callback) => {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
      instructions: {
        entry: {
          put: async (input) => { if (options.instructions) options.instructions.push(input); },
          remove: async () => {},
        },
      },
    },
    permission: { list: async () => [] },
    event: { subscribe: channel ? channel.subscribe : async function* () {} },
  }
  const dispose = await plugin.setup(ctx)
  if (options.disposers) options.disposers.push(dispose)
  return tools
}

async function call(tools, name, input = {}) {
  assert.ok(tools[name], `tool ${name} is not registered`)
  const result = await tools[name].execute(input, { sessionID: SESSION_ID })
  return String(result?.content ?? "")
}

async function startLoop(repo, options) {
  const tools = await loadTools(repo.dir, options)
  const message = await call(tools, "foreman_start", {
    planPath: "plan.md",
    branch: repo.branch,
    ...(options?.maxParallel !== undefined ? { maxParallel: options.maxParallel } : {}),
    ...(options?.maxVerify !== undefined ? { maxVerify: options.maxVerify } : {}),
  })
  // The message names the loop id (plans/Plan.md -> Plan), so the dot follows it.
  assert.match(message, /^STARTED foreman loop \S+\./)
  assert.equal(readState(repo).branch, repo.branch)
  return tools
}

async function createStep(tools, input) {
  const message = await call(tools, "foreman_step", input)
  const match = message.match(/^STEP (\d+) created: #(\d+) (\S+)/)
  assert.ok(match, `unexpected foreman_step result: ${message}`)
  return { message, n: Number(match[1]), issue: Number(match[2]), url: match[3] }
}

// Every create_step a tick emits must be accepted by foreman_step. The offer is
// replayed exactly as printed: the unit the tick names, with the scope the graph
// declares, so a refusal here is a broken offer and not a copied mistake. Both
// shapes are read: the UNIT block of a lone create_step and the numbered line of
// a multi tick.
function offeredUnitId(tick) {
  const lone = tick.match(/^UNIT: (\S+)$/m)
  if (lone) return lone[1]
  const line = tick.match(/^\d+\. create_step — unit (\S+) \(/m)
  return line?.[1]
}

async function createOffered(tools, units, tick) {
  const id = offeredUnitId(tick)
  assert.ok(id, `next emitted a create_step without a unit line: ${tick}`)
  const unit = units.find((item) => item.id === id)
  assert.ok(unit, `next offered unit ${id}, which is not in the graph`)
  const created = await createStep(tools, {
    title: unit.id, goal: `implement ${unit.id}`, acceptance: ["criterion"],
    acceptanceCommands: [`printf ${unit.id}`], unitId: unit.id, scope: unit.scope,
  })
  return { unitId: unit.id, ...created }
}

/* ------------------------------ reporting ------------------------------- */

const failures = []
const evidence = {}
async function scenario(n, name, fn) {
  try {
    evidence[n] = await fn()
    console.log(`PASS ${n}/${SCENARIO_TOTAL} ${name}: ${evidence[n]}`)
  } catch (error) {
    failures.push({ n, name, error })
    evidence[n] = String(error?.message ?? error).split("\n")[0]
    console.log(`FAIL ${n}/${SCENARIO_TOTAL} ${name}: ${evidence[n]}`)
  }
}

/* ------------------------------ scenarios ------------------------------- */

await scenario(1, "step without acceptanceCommands is refused", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  for (const acceptanceCommands of [undefined, [], ["", "   "], "npx esbuild index.ts"]) {
    const message = await call(tools, "foreman_step", {
      title: "no commands", goal: "must be refused", acceptance: ["criterion"], ...(acceptanceCommands === undefined ? {} : { acceptanceCommands }),
    })
    assert.equal(message, ACCEPT_REQUIRED)
  }
  assert.equal(readState(repo).steps.length, 0)
  assert.equal(readState(repo).cursor, 0)
  return `exact message on 4 shapes, state.steps=0, cursor 0, no issue created`
})

await scenario(2, "dependsOn naming a non-verified step is refused", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const step = await createStep(tools, {
    title: "dependency target", goal: "leave it unfinished", acceptance: ["criterion"],
    acceptanceCommands: ["printf dep"], scope: ["backend/api/src/projects/"],
  })
  // Reach the state Phase B's active[] produces: an unfinished step that is not
  // current, so foreman_step proceeds past its "still open" guard.
  seedLoop(repo, (state) => {
    state.current = null
    state.steps[0].status = "fixing"
  })
  const refused = await call(tools, "foreman_step", {
    title: "depends on unfinished", goal: "must be refused", acceptance: ["criterion"],
    acceptanceCommands: ["printf ok"], scope: ["frontend/src/elsewhere"],
    dependsOn: [`#${step.issue}`],
  })
  const expected = `REFUSED: dependsOn is not satisfied: #${step.issue} is fixing (step 1). Only verified steps of this loop may be depended on.`
  assert.equal(refused, expected)
  assert.equal(readState(repo).steps.length, 1)
  return `#${step.issue} named with status fixing, nothing created`
})

await scenario(3, "scope intersecting an active step is refused", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "owns a directory", goal: "hold the scope", acceptance: ["criterion"],
    acceptanceCommands: ["printf owned"], scope: ["backend/api/src/projects"],
  })
  seedLoop(repo, (state) => {
    state.current = null
    state.steps[0].status = "implemented"
  })
  const scope = "backend/api/src/projects/nested/file.ts"
  const refused = await call(tools, "foreman_step", {
    title: "overlap", goal: "must be refused", acceptance: ["criterion"],
    acceptanceCommands: ["printf ok"], scope: [scope],
  })
  assert.equal(refused, `REFUSED: scope overlaps step 1 on ${scope}`)
  assert.equal(readState(repo).steps.length, 1)
  return `step 1 owns backend/api/src/projects, ${scope} refused`
})

await scenario(4, "foreman_verify good with a command exiting 1 is refused", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "red acceptance", goal: "must not close", acceptance: ["criterion"],
    acceptanceCommands: ["exit 1"], scope: ["backend/api/src/red"],
  })
  const recorded = await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "exit 1", exitCode: 0, summary: "worker shipped it", outputTail: "ok",
  })
  assert.match(recorded, /^RESULT recorded/)
  const refused = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "echo verifier-ok", exitCode: 0 }], transcript: "user saw the feature",
  })
  assert.match(refused, /^REFUSED: good requires every acceptance command to exit 0; `exit 1` exited 1 after \d+ms\./)
  const stored = readStep(repo, 1)
  assert.equal(stored.status, "implemented")
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(Object.hasOwn(verify, "verdict"), false)
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [1])
  assert.equal(readState(repo).current, 1)
  assert.equal(readLedger(repo).some((entry) => entry.type === "verified"), false)
  return `exit 1 refused, no verdict, step implemented, no verified ledger record`
})

await scenario(5, "foreman_verify good with green commands verifies the step", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const step = await createStep(tools, {
    title: "green acceptance", goal: "must close", acceptance: ["criterion"],
    acceptanceCommands: ["git rev-parse --abbrev-ref HEAD", "printf drill-green"], scope: ["backend/api/src/green"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "git rev-parse --abbrev-ref HEAD", exitCode: 0, summary: "worker shipped it",
  })
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "echo verifier-ok", exitCode: 0 }], transcript: "user saw the feature",
  })
  assert.match(message, /^VERIFIED step 1\./)
  assert.equal(readStep(repo, 1).status, "verified")
  assert.equal(readState(repo).current, null)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.verdict, "good")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0, 0])
  assert.ok(verify.acceptanceRuns[0].outputTail.includes(repo.branch))
  assert.ok(verify.acceptanceRuns[1].outputTail.includes("drill-green"))
  const verified = readLedger(repo).find((entry) => entry.type === "verified")
  assert.ok(verified, "no verified ledger record")
  assert.equal(verified.step, 1)
  assert.equal(verified.acceptance, 2)
  const ghLines = fs.readFileSync(ghLog, "utf8")
  assert.ok(ghLines.includes(`issue close ${step.issue} --reason completed`), "plan issue was not closed through gh")
  return `2 acceptance runs exit 0, step verified, plan issue #${step.issue} closed, ledger verified`
})

await scenario(6, "three byte-identical failures create a fix issue each time and never block", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "parity", goal: "fail three times with identical evidence", acceptance: ["parity holds"],
    acceptanceCommands: ["node scripts/check-parity.mjs"], scope: ["scripts/check-parity.mjs"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "node scripts/check-parity.mjs", exitCode: 0, summary: "first attempt",
  })

  // Retry is pure and unbounded (plan §1): the plugin must not special-case a
  // repeated failure signature. Every attempt below therefore carries the
  // BYTE-IDENTICAL command and outputTail — no attempt number, no variation.
  const COMMAND = "node scripts/check-parity.mjs"
  const OUTPUT_TAIL = "AssertionError: parity mismatch at scripts/check-parity.mjs:1"
  const failure = [{ command: COMMAND, exitCode: 1, outputTail: OUTPUT_TAIL }]
  const attempts = 3
  const fixIssues = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      const fixCommit = commitFile(repo, "scripts/check-parity.mjs", `process.exit(1) // attempt ${attempt}\n`)
      const recorded = await call(tools, "foreman_result", {
        step: 1, commit: fixCommit, command: COMMAND, exitCode: 0, summary: `fix attempt ${attempt}`,
      })
      assert.match(recorded, /^RESULT recorded/)
    }
    // Rebuild the array each call from the same constants: same bytes on every
    // attempt, so the legacy failure signature would repeat if it still existed.
    const verdict = await call(tools, "foreman_verify", {
      step: 1, verdict: "no-good",
      commands: failure.map((item) => ({ ...item })),
      transcript: "parity is still wrong on the real stack",
    })
    const fix = Number(verdict.match(/^REJECTED step 1: fix issue #(\d+) created\./)?.[1])
    assert.ok(Number.isInteger(fix), `attempt ${attempt} did not create a fix issue: ${verdict}`)
    assert.equal(readStep(repo, 1).status, "fixing", `attempt ${attempt} left the step not fixing`)
    fixIssues.push(fix)
  }
  assert.equal(new Set(fixIssues).size, attempts, `fix issues are not fresh: ${fixIssues.join(", ")}`)

  const state = readState(repo)
  const stored = readStep(repo, 1)
  assert.deepEqual(stored.fixIssues, fixIssues)
  assert.equal(stored.status, "fixing")
  assert.equal(state.steps[0].status, "fixing")
  assert.equal(state.blocked, null)
  assert.equal(fs.existsSync(path.join(loopDir(repo), "STOP")), false)
  assert.equal(readLedger(repo).some((entry) => entry.type === "blocked"), false)
  assert.equal(readLedger(repo).filter((entry) => entry.type === "rejected").length, attempts)
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: dispatch_worker/)
  assert.ok(next.includes(`ISSUE: ${fixIssues[fixIssues.length - 1]}`), `next tick does not dispatch the latest fix: ${next}`)
  return `identical failure x${attempts} -> fix ${fixIssues.map((fix) => `#${fix}`).join(" ")}, step fixing, blocked=null, no STOP, no blocked ledger, ACTION dispatch_worker on #${fixIssues[fixIssues.length - 1]}`
})

await scenario(7, "ledger prevHash chain validates and detects tampering", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "ledger", goal: "write records", acceptance: ["criterion"],
    acceptanceCommands: ["printf ledger"], scope: ["backend/api/src/ledger"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf ledger", exitCode: 0, summary: "worker shipped it",
  })
  await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf ledger", exitCode: 0 }], transcript: "user saw the ledger",
  })

  const ledgerFile = path.join(loopDir(repo), "ledger.jsonl")
  const valid = validateLedger(ledgerFile)
  assert.equal(valid.valid, true, `ledger chain invalid: ${valid.reason}`)
  assert.ok(valid.records >= 4, `expected start/step/result/verified, got ${valid.records}`)
  const types = readLedger(repo).map((entry) => entry.type)
  for (const type of ["start", "step", "result", "verified"]) assert.ok(types.includes(type), `ledger lacks a ${type} record`)
  assert.equal(readLedger(repo)[0].prevHash, "")

  // Negative control: rewrite one middle record on a copy and require the same
  // checker to reject the chain at the next record.
  const lines = fs.readFileSync(ledgerFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  const tampered = JSON.parse(lines[1])
  tampered.branch = "tampered/branch"
  lines[1] = JSON.stringify(tampered)
  const tamperedFile = path.join(tmp, "ledger.tampered.jsonl")
  fs.writeFileSync(tamperedFile, `${lines.join("\n")}\n`)
  const invalid = validateLedger(tamperedFile)
  assert.equal(invalid.valid, false, "tampered ledger still validated")
  assert.equal(invalid.index, 2)
  assert.match(invalid.reason, /record 3 prevHash does not match record 2/)

  return `${valid.records} records valid; tampered record 2 reported invalid (${invalid.reason})`
})

await scenario(8, "result.json carries attempt, durationMs (including 0) and worktree", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "telemetry", goal: "record attempt and duration", acceptance: ["criterion"],
    acceptanceCommands: ["printf telemetry"], scope: ["backend/api/src/telemetry"],
  })
  const worktree = path.join(tmp, "worker worktree with spaces")

  // A declared duration must be a finite, non-negative number, checked before
  // the cherry-pick so a bad value changes nothing.
  for (const bad of ["fast", -5, "12ms", Number.NaN, true]) {
    const refused = await call(tools, "foreman_result", {
      step: 1, commit: repo.head, command: "printf telemetry", exitCode: 0, summary: "bad duration", durationMs: bad,
    })
    assert.match(refused, /^REFUSED: durationMs must be a finite non-negative number of milliseconds/)
  }
  assert.equal(fs.existsSync(path.join(loopDir(repo), "steps", "1", "result.json")), false)

  const first = await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf telemetry", exitCode: 0, summary: "first attempt",
    durationMs: 1500, worktree,
  })
  assert.match(first, /^RESULT recorded for step 1 \(attempt 1\)/)
  const firstResult = readStep(repo, 1, "result.json")
  assert.equal(firstResult.attempt, 1)
  assert.equal(firstResult.durationMs, 1500)
  assert.equal(firstResult.worktree, worktree)
  assert.equal(readStep(repo, 1).worktree, worktree)

  const rejected = await call(tools, "foreman_verify", {
    step: 1, verdict: "no-good",
    commands: [{ command: "printf telemetry", exitCode: 1 }],
    transcript: "the feature is wrong on the real stack",
  })
  assert.match(rejected, /^REJECTED step 1: fix issue #\d+ created\./)

  const fixCommit = commitFile(repo, "backend/api/src/projects/index.ts", "export const projects = ['fixed']\n")
  const second = await call(tools, "foreman_result", {
    step: 1, commit: fixCommit, command: "printf telemetry", exitCode: 0, summary: "second attempt", durationMs: 0,
  })
  assert.match(second, /^RESULT recorded for step 1 \(attempt 2\)/)
  const secondResult = readStep(repo, 1, "result.json")
  assert.equal(secondResult.attempt, 2)
  assert.equal(secondResult.durationMs, 0)
  // A later result that omits the path records the step's canonical tree: it is
  // where the attempt happened, and result.json must be self-describing.
  assert.equal(secondResult.worktree, worktree, "the result did not record the step's canonical worktree")
  // The step remembers where the worker was, even when the next result omits it.
  assert.equal(readStep(repo, 1).worktree, worktree)

  const verified = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf telemetry", exitCode: 0 }], transcript: "user saw the feature",
  })
  assert.match(verified, /^VERIFIED step 1\./)
  assert.equal(readStep(repo, 1).worktree, worktree)
  assert.equal(readLedger(repo).some((entry) => entry.type === "worktree"), false, "a missing worktree was reported as removed")
  return "attempt 1 then 2, duration 1500ms then 0ms, worktree persisted on result and step, missing path ignored"
})

await scenario(9, "verify.json carries evidenceLevel inside the ladder", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "evidence ladder", goal: "declare the rung", acceptance: ["criterion"],
    acceptanceCommands: ["printf evidence"], scope: ["backend/api/src/evidence"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf evidence", exitCode: 0, summary: "worker shipped it",
  })
  const verifyFile = path.join(loopDir(repo), "steps", "1", "verify.json")

  for (const bad of [-1, 6, 3.5, "high", 1e9, true]) {
    const refused = await call(tools, "foreman_verify", {
      step: 1, verdict: "good", commands: [{ command: "printf evidence", exitCode: 0 }],
      transcript: "user saw the feature", evidenceLevel: bad,
    })
    assert.match(refused, /^REFUSED: evidenceLevel must be an integer between 0 and 5/)
  }
  assert.equal(fs.existsSync(verifyFile), false, "a refused evidenceLevel still wrote verify.json")
  assert.equal(readStep(repo, 1).status, "implemented")
  assert.equal(readLedger(repo).some((entry) => entry.type === "verified"), false)

  // 0 is a legal rung: the ladder starts at "nothing yet".
  const rejected = await call(tools, "foreman_verify", {
    step: 1, verdict: "no-good", commands: [{ command: "printf evidence", exitCode: 1 }],
    transcript: "the feature is not there", evidenceLevel: 0,
  })
  assert.match(rejected, /^REJECTED step 1: fix issue #\d+ created\./)
  assert.equal(readStep(repo, 1, "verify.json").evidenceLevel, 0)

  const fixCommit = commitFile(repo, "backend/api/src/projects/index.ts", "export const projects = ['evidence']\n")
  await call(tools, "foreman_result", {
    step: 1, commit: fixCommit, command: "printf evidence", exitCode: 0, summary: "fix attempt",
  })
  const verified = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf evidence", exitCode: 0 }],
    transcript: "user saw the feature at rung 5", evidenceLevel: 5,
  })
  assert.match(verified, /^VERIFIED step 1\./)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.evidenceLevel, 5)
  assert.equal(verify.verdict, "good")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0])
  assert.equal(readLedger(repo).find((entry) => entry.type === "verified").evidenceLevel, 5)
  return "0 and 5 persisted with acceptanceRuns; -1, 6, 3.5, high, 1e9 refused with nothing written"
})

await scenario(10, "every ledger record carries the mapped kind and the chain stays valid", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "ledger kinds", goal: "produce every record type", acceptance: ["criterion"],
    acceptanceCommands: ["printf kinds"], scope: ["backend/api/src/kinds"],
  })
  const worktree = addWorktree(repo, "kind ledger worktree")
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf kinds", exitCode: 0, summary: "first attempt", worktree,
  })
  await call(tools, "foreman_verify", {
    step: 1, verdict: "no-good", commands: [{ command: "printf kinds", exitCode: 1 }], transcript: "wrong output",
  })
  const fixCommit = commitFile(repo, "backend/api/src/projects/index.ts", "export const projects = ['kinds']\n")
  await call(tools, "foreman_result", {
    step: 1, commit: fixCommit, command: "printf kinds", exitCode: 0, summary: "fix attempt", worktree,
  })
  await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf kinds", exitCode: 0 }], transcript: "user saw the kinds",
  })
  assert.equal(fs.existsSync(worktree), false, "the verified worktree was not removed")
  await call(tools, "foreman_handoff", { summary: "drill handoff for the ledger kinds scenario" })
  await call(tools, "foreman_stop", { reason: "drill stop" })
  const resumed = await call(tools, "foreman_start", { planPath: "plan.md", branch: repo.branch })
  assert.match(resumed, /^RESUMED foreman loop/)

  const valid = validateLedger(path.join(loopDir(repo), "ledger.jsonl"))
  assert.equal(valid.valid, true, `ledger chain invalid: ${valid.reason}`)
  const entries = readLedger(repo)
  for (const entry of entries) {
    assert.ok(entry.kind, `record ${entry.type} has no kind`)
    assert.equal(entry.kind, LEDGER_KIND[entry.type], `record ${entry.type} has kind ${entry.kind}, expected ${LEDGER_KIND[entry.type]}`)
  }
  const types = entries.map((entry) => entry.type)
  for (const type of ["start", "step", "result", "rejected", "verified", "worktree", "handoff", "stop", "resume"]) {
    assert.ok(types.includes(type), `ledger lacks a ${type} record`)
  }
  const kinds = [...new Set(entries.map((entry) => entry.kind))].sort()
  assert.deepEqual(kinds, ["decision", "evidence", "fact"])

  // The kind is part of the hashed payload: re-classifying one record must break
  // the chain at the next record, exactly like editing any other field.
  const lines = fs.readFileSync(path.join(loopDir(repo), "ledger.jsonl"), "utf8")
    .split("\n").map((line) => line.trim()).filter(Boolean)
  const index = lines.findIndex((line) => JSON.parse(line).type === "result")
  const tampered = JSON.parse(lines[index])
  tampered.kind = "decision"
  lines[index] = JSON.stringify(tampered)
  const tamperedFile = path.join(tmp, "ledger.kind.tampered.jsonl")
  fs.writeFileSync(tamperedFile, `${lines.join("\n")}\n`)
  const invalid = validateLedger(tamperedFile)
  assert.equal(invalid.valid, false, "a re-classified record still validated")
  assert.equal(invalid.index, index + 1)
  return `${entries.length} records, kinds decision/fact/evidence, all 9 types present, chain valid; kind tamper rejected at record ${invalid.index + 1}`
})

await scenario(11, "verified removes and prunes the step worktree with a ledger record", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const worktree = addWorktree(repo, "retire worktree with spaces")
  const realWorktree = fs.realpathSync(worktree)
  assert.ok(git(repo.dir, "worktree", "list", "--porcelain").includes(worktree), "worktree was not registered")
  await createStep(tools, {
    title: "retire", goal: "drop the worktree after good", acceptance: ["criterion"],
    acceptanceCommands: ["printf retire"], scope: ["backend/api/src/retire"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf retire", exitCode: 0, summary: "worker shipped it", worktree,
  })
  const verified = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf retire", exitCode: 0 }], transcript: "user saw the feature",
  })
  assert.match(verified, /^VERIFIED step 1\./)
  assert.ok(verified.includes(`worktree: removed ${realWorktree}`), `verified message does not report the removal: ${verified}`)
  assert.equal(fs.existsSync(worktree), false, "the worktree directory still exists")
  assert.ok(!git(repo.dir, "worktree", "list", "--porcelain").includes(worktree), "the worktree is still registered")
  const record = readLedger(repo).find((entry) => entry.type === "worktree")
  assert.ok(record, "no worktree ledger record")
  assert.equal(record.step, 1)
  assert.equal(record.kind, "evidence")
  assert.equal(record.removed, true)
  assert.equal(record.pruned, true)
  assert.equal(readStep(repo, 1).status, "verified")
  return `worktree ${path.basename(worktree)} removed and pruned, ledger worktree record removed=true pruned=true kind=evidence`
})

await scenario(12, "worktree cleanup is a no-op for a missing path, the repo root and the loop checkout", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const noWorktreeRecords = () => assert.equal(readLedger(repo).some((entry) => entry.type === "worktree"), false, "a no-op wrote a worktree ledger record")

  const missing = path.join(tmp, "worktree that was never created")
  await createStep(tools, {
    title: "missing", goal: "no path", acceptance: ["criterion"],
    acceptanceCommands: ["printf missing"], scope: ["backend/api/src/missing"],
  })
  await call(tools, "foreman_result", { step: 1, commit: repo.head, command: "printf missing", exitCode: 0, summary: "no worktree", worktree: missing })
  const first = await call(tools, "foreman_verify", { step: 1, verdict: "good", commands: [{ command: "printf missing", exitCode: 0 }], transcript: "user saw it" })
  assert.match(first, /^VERIFIED step 1\./)
  assert.equal(fs.existsSync(missing), false)
  noWorktreeRecords()

  await createStep(tools, {
    title: "root", goal: "the repo root is never removed", acceptance: ["criterion"],
    acceptanceCommands: ["printf root"], scope: ["backend/api/src/root"],
  })
  await call(tools, "foreman_result", { step: 2, commit: repo.head, command: "printf root", exitCode: 0, summary: "root as worktree", worktree: repo.dir })
  const second = await call(tools, "foreman_verify", { step: 2, verdict: "good", commands: [{ command: "printf root", exitCode: 0 }], transcript: "user saw it" })
  assert.match(second, /^VERIFIED step 2\./)
  assert.ok(fs.existsSync(path.join(repo.dir, ".git")), "the repo root was touched")
  noWorktreeRecords()

  // The loop's own checkout: a separate worktree the plugin verifies in. It is
  // the one path that must never be removed while the loop is running.
  const loopCheckout = addWorktree(repo, "loop checkout with spaces")
  seedLoop(repo, (state) => { state.worktree = loopCheckout })
  await createStep(tools, {
    title: "loop checkout", goal: "never remove the loop", acceptance: ["criterion"],
    acceptanceCommands: ["printf checkout"], scope: ["backend/api/src/checkout"],
  })
  await call(tools, "foreman_result", { step: 3, commit: repo.head, command: "printf checkout", exitCode: 0, summary: "loop checkout", worktree: loopCheckout })
  const third = await call(tools, "foreman_verify", { step: 3, verdict: "good", commands: [{ command: "printf checkout", exitCode: 0 }], transcript: "user saw it" })
  assert.match(third, /^VERIFIED step 3\./)
  assert.ok(fs.existsSync(loopCheckout), "the loop checkout was removed")
  noWorktreeRecords()
  return "missing path, repo root and loop checkout untouched, no worktree ledger record, no error"
})

await scenario(13, "foreman_status reports attempts, pass rate, median duration and fix minutes", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  seedLoop(repo, (state) => {
    state.cursor = 4
    state.current = null
    state.steps = [
      { n: 1, title: "one", status: "verified", planIssue: 101, implIssue: 201, fixIssues: [301], result: { durationMs: 0 } },
      { n: 2, title: "two", status: "verified", planIssue: 102, implIssue: 202, fixIssues: [], result: { durationMs: 1000 } },
      { n: 3, title: "three", status: "implemented", planIssue: 103, implIssue: 203, fixIssues: [], result: { durationMs: 3000 } },
      { n: 4, title: "four", status: "open", planIssue: 104, implIssue: null, fixIssues: [], result: { durationMs: 2_000_000_000 } },
    ]
  })
  seedLedger(repo, [
    { at: "2026-01-01T00:00:00.000Z", type: "start", planPath: "plan.md", branch: BRANCH, repo: "drill/repo", kind: "decision" },
    { at: "2026-01-01T00:01:00.000Z", type: "step", step: 1, issue: 101, kind: "fact" },
    { at: "2026-01-01T00:02:00.000Z", type: "rejected", step: 1, issue: 301, kind: "evidence" },
    // A second rejection with no result in between must collapse into the same
    // fix window: the result below is counted once, from the last rejection.
    { at: "2026-01-01T00:02:30.000Z", type: "rejected", step: 1, issue: 302, kind: "evidence" },
    { at: "2026-01-01T00:03:30.000Z", type: "result", step: 1, issue: 201, kind: "fact" },
    { at: "2026-01-01T00:04:00.000Z", type: "verified", step: 1, kind: "evidence" },
    { at: "2026-01-01T00:05:00.000Z", type: "verified", step: 2, kind: "evidence" },
  ])
  const status = await call(tools, "foreman_status")
  assert.match(status, /- attempts: 4 step\(s\) total, 1 with more than one attempt/)
  assert.match(status, /- verifier pass rate: 50\.0% \(2 verified \/ 2 rejected\)/)
  // durations 0, 1000, 3000, 2e9: even count, median = (1000 + 3000) / 2
  assert.match(status, /- step duration: median 2000ms \(n=4\)/)
  // one closed window, 00:02:30 -> 00:03:30: the earlier rejection is superseded
  assert.match(status, /- fixes: 1\.0 min \(1 closed window\(s\), rejected verdict to the next result of the same step\)/)
  assert.match(status, /#1 one \[verified\].*attempts 2/)
  assert.match(status, /#2 two \[verified\].*attempts 1/)
  return "attempts 2 on step 1 (1 multi), pass rate 50%, median 2000ms across 4 values, 1.0 min in 1 fix window"
})

await scenario(14, "legacy state and ledger without the new fields still summarise", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  seedLoop(repo, (state) => {
    state.cursor = 2
    state.current = 1
    state.steps = [
      { n: 1, title: "legacy open", status: "implemented", planIssue: 111, implIssue: 211 },
      { n: 2, title: "legacy verified", status: "verified", planIssue: 112, implIssue: 212 },
    ]
  })
  // A ledger written before A5: no kind on any record.
  seedLedger(repo, [
    { at: "2025-12-01T00:00:00.000Z", type: "start", planPath: "plan.md", branch: BRANCH, repo: "drill/repo" },
    { at: "2025-12-01T00:01:00.000Z", type: "step", step: 1, issue: 111 },
  ])
  const status = await call(tools, "foreman_status")
  assert.match(status, /- attempts: 2 step\(s\) total, 0 with more than one attempt/)
  assert.match(status, /- verifier pass rate: n\/a \(0 verified \/ 0 rejected\)/)
  assert.match(status, /- step duration: median n\/a \(no durationMs recorded\)/)
  assert.match(status, /- fixes: n\/a \(no rejected verdict\)/)
  assert.match(status, /#2 legacy verified \[verified\].*attempts 1/)
  const ledger = await call(tools, "foreman_ledger")
  assert.match(ledger, /2025-12-01T00:00:00\.000Z start/)
  assert.equal(readLedger(repo).every((entry) => !Object.hasOwn(entry, "kind")), true)

  // Writing after a legacy ledger must chain onto it and still carry a kind.
  await call(tools, "foreman_handoff", { summary: "handoff on top of a legacy ledger" })
  const valid = validateLedger(path.join(loopDir(repo), "ledger.jsonl"))
  assert.equal(valid.valid, true, `legacy chain broke on append: ${valid.reason}`)
  const entries = readLedger(repo)
  assert.equal(entries[entries.length - 1].type, "handoff")
  assert.equal(entries[entries.length - 1].kind, "decision")
  return "legacy state renders n/a for pass rate, duration and fixes; legacy ledger stays valid and gains a kind on append"
})

await scenario(15, "B1: legacy current migrates to active[] and verified steps leave it", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await createStep(tools, {
    title: "legacy current", goal: "migrate on read", acceptance: ["criterion"],
    acceptanceCommands: ["printf migrate"], scope: ["backend/api/src/migrate"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf migrate", exitCode: 0, summary: "worker shipped it",
  })
  const verified = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf migrate", exitCode: 0 }], transcript: "user saw it",
  })
  assert.match(verified, /^VERIFIED step 1\./)
  const empty = readState(repo)
  assert.deepEqual(empty.active, [])
  assert.equal(empty.current, null)

  await createStep(tools, {
    title: "legacy shape", goal: "be the step in flight", acceptance: ["criterion"],
    acceptanceCommands: ["printf legacy"], scope: ["backend/api/src/legacy"],
  })
  assert.deepEqual(readState(repo).active, [2])
  assert.equal(readState(repo).current, 2)

  // Every shape an older writer can leave behind: no active key at all, an
  // explicit null, a scalar and an array. All load as active [2].
  const shapes = [
    ["missing", (state) => { delete state.active; state.current = 2 }],
    ["null", (state) => { state.active = null; state.current = 2 }],
    ["scalar", (state) => { state.active = "2"; state.current = 2 }],
    ["array", (state) => { state.active = [2]; state.current = 2 }],
  ]
  for (const [label, mutate] of shapes) {
    seedLoop(repo, (state) => {
      // Emulate an old writer clearing the dispatch: no in-flight lease and no
      // stall backoff, so every shape is independently offerable.
      for (const step of state.steps) {
        delete step.dispatchedAt
        delete step.nextOfferAt
        delete step.dispatchAttempts
      }
      mutate(state)
    })
    const next = await call(tools, "foreman_next")
    assert.match(next, /^ACTION: dispatch_worker/, `${label}: ${next}`)
    const stored = readState(repo)
    assert.deepEqual(stored.active, [2], `${label} did not load as active [2]`)
    assert.equal(stored.current, 2, `${label} did not keep current written for old readers`)
    assert.equal(Object.hasOwn(stored, "active"), true)
  }

  // A verified entry left in active by an older writer is pruned on read, so a
  // verified step can never consume a capacity slot.
  seedLoop(repo, (state) => {
    state.steps[1].status = "verified"
    state.active = [2]
    state.current = 2
  })
  const afterVerified = await call(tools, "foreman_next")
  assert.match(afterVerified, /^ACTION: create_step/, afterVerified)
  const pruned = readState(repo)
  assert.deepEqual(pruned.active, [])
  assert.equal(pruned.current, null)
  return "current 2 loads as active [2] for missing/null/string/array, current kept; verification removes the step and a verified entry is pruned"
})

await scenario(16, "B2: capacity admits maxParallel steps and refuses the next one", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo, { maxParallel: 3 })
  const titles = ["cap one", "cap two", "cap three"]
  for (const [index, title] of titles.entries()) {
    await createStep(tools, {
      title, goal: "hold a pipeline slot", acceptance: ["criterion"],
      acceptanceCommands: [`printf cap${index + 1}`], scope: [`backend/api/src/cap-${index + 1}`],
    })
  }
  assert.deepEqual(readState(repo).active, [1, 2, 3])
  const refused = await call(tools, "foreman_step", {
    title: "cap four", goal: "must be refused", acceptance: ["criterion"],
    acceptanceCommands: ["printf cap4"], scope: ["backend/api/src/cap-4"],
  })
  assert.equal(refused, "REFUSED: capacity reached (3/3). Active steps: #1 cap one [open], #2 cap two [open], #3 cap three [open]. Verify one with foreman_verify before creating another.")
  assert.equal(readState(repo).steps.length, 3)
  assert.equal(readState(repo).cursor, 3)
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: multi/)
  assert.ok(next.includes("CAPACITY: 3/3"), next)
  assert.equal((next.match(/create_step/g) ?? []).length, 0)

  // A verified step frees its slot: the fourth step is accepted afterwards.
  await call(tools, "foreman_result", {
    step: 3, commit: repo.head, command: "printf cap3", exitCode: 0, summary: "third shipped",
  })
  await call(tools, "foreman_verify", {
    step: 3, verdict: "good", commands: [{ command: "printf cap3", exitCode: 0 }], transcript: "user saw cap three",
  })
  assert.deepEqual(readState(repo).active, [1, 2])
  const fourth = await createStep(tools, {
    title: "cap four", goal: "take the freed slot", acceptance: ["criterion"],
    acceptanceCommands: ["printf cap4"], scope: ["backend/api/src/cap-4"],
  })
  assert.equal(fourth.n, 4)
  return "3 active allowed, the fourth refused with the exact capacity message, CAPACITY 3/3; verifying step 3 freed the slot for step 4"
})

await scenario(17, "B3/B4: verifier of N and worker of N+1 share a tick, results stay serial", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo, { maxParallel: 3, maxVerify: 1 })
  const one = await createStep(tools, {
    title: "pipe one", goal: "be implemented while two starts", acceptance: ["criterion"],
    acceptanceCommands: ["printf pipe1"], scope: ["backend/api/src/pipe-one"],
  })
  const two = await createStep(tools, {
    title: "pipe two", goal: "start while one is verified", acceptance: ["criterion"],
    acceptanceCommands: ["printf pipe2"], scope: ["backend/api/src/pipe-two"],
  })
  const loopCheckout = addWorktree(repo, "pipeline loop checkout")
  seedLoop(repo, (state) => { state.worktree = loopCheckout })

  const recorded = await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "printf pipe1", exitCode: 0, summary: "worker one shipped it",
  })
  assert.match(recorded, /^RESULT recorded for step 1/)
  assert.ok(recorded.includes(`- applied in: ${loopCheckout}`), recorded)
  assert.equal(git(loopCheckout, "rev-parse", "--abbrev-ref", "HEAD"), repo.branch)

  // Pipeline: step 1 implemented and step 2 open in the same tick. The worker
  // is launched first (background) and the serial verifier follows; there is no
  // create_step while both budgets are busy.
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: multi/)
  assert.ok(next.includes("CAPACITY: 1/3"), next)
  assert.ok(next.includes("VERIFY: 1/1"), next)
  const actions = next.split("\n").filter((line) => /^\d+\. /.test(line))
  assert.equal(actions.length, 2, next)
  assert.match(actions[0], /^1\. dispatch_worker — step 2, issue #\d+$/)
  assert.match(actions[1], /^2\. dispatch_verifier — step 1, issue #\d+$/)
  assert.ok(next.includes('kind "verifier"'), "the verifier dispatch does not name its worktree slot")
  assert.equal((next.match(/create_step/g) ?? []).length, 0)

  // The verifier of step 1 covers the worker latency of step 2.
  const verified = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf pipe1", exitCode: 0 }], transcript: "user saw pipe one",
  })
  assert.match(verified, /^VERIFIED step 1\./)
  assert.deepEqual(readState(repo).active, [2])

  // The worker commit is produced on a detached HEAD, so the branch only moves
  // through the serial cherry-pick inside the loop checkout. Its dates are fixed
  // in the past, so the pick must create a new commit object: assert the content
  // that landed, not the object identity.
  const beforePick = git(loopCheckout, "rev-parse", "HEAD")
  const worker = commitDetached(repo, "pipe-two-worker", "backend/api/src/pipe-two/index.ts", "export const two = 1\n", { date: WORKER_DATE })
  const workerTree = git(loopCheckout, "rev-parse", `${worker.sha}^{tree}`)
  const applied = await call(tools, "foreman_result", {
    step: 2, commit: worker.sha, command: "printf pipe2", exitCode: 0, summary: "worker two shipped it",
  })
  assert.match(applied, /^RESULT recorded for step 2/)
  assert.ok(applied.includes("cherry-picked"), applied)
  assert.ok(applied.includes(`- applied in: ${loopCheckout}`), applied)
  const picked = git(loopCheckout, "rev-parse", "HEAD")
  assert.notEqual(picked, beforePick, "the branch did not move through the cherry-pick")
  assert.notEqual(picked, worker.sha, "the cherry-pick reproduced the worker commit instead of creating one")
  assert.equal(git(loopCheckout, "rev-parse", `${picked}^{tree}`), workerTree, "the picked commit does not carry the worker tree")
  assert.equal(git(loopCheckout, "log", "-1", "--format=%s"), "worker pipe-two-worker")
  assert.equal(git(loopCheckout, "show", `${picked}:backend/api/src/pipe-two/index.ts`), "export const two = 1", "the picked commit does not carry the worker content")
  assert.equal(git(loopCheckout, "rev-parse", "--abbrev-ref", "HEAD"), repo.branch)
  assert.equal(git(loopCheckout, "status", "--porcelain"), "")
  // The pick landed a new commit on top of the branch: the old head is an
  // ancestor, the worker commit itself never is.
  assert.doesNotThrow(() => git(loopCheckout, "merge-base", "--is-ancestor", beforePick, "HEAD"), "the branch did not advance from its pre-pick head")
  let workerIsAncestor = false
  try { git(loopCheckout, "merge-base", "--is-ancestor", worker.sha, "HEAD"); workerIsAncestor = true } catch (error) { if (error?.status !== 1) throw error }
  assert.equal(workerIsAncestor, false, "the worker commit is an ancestor: the pick reused the worker object instead of creating a commit")
  assert.ok(readState(repo).active.includes(2))
  assert.equal(one.issue > 0 && two.issue > 0, true)
  return `tick: worker step 2 first (background) then verifier step 1 (CAPACITY 1/3, VERIFY 1/1, no create_step); step 2 cherry-picked serially in the loop checkout as a new commit with the worker tree, HEAD on ${repo.branch}`
})

await scenario(18, "B5: wait backs off five minutes and the tick honours nextWakeAt", async () => {
  const repo = makeRepo()
  const prompts = []
  const channel = eventChannel()
  const tools = await startLoop(repo, { channel, prompts, maxParallel: 3 })
  await createStep(tools, {
    title: "wait one", goal: "be in flight", acceptance: ["criterion"],
    acceptanceCommands: ["printf wait1"], scope: ["backend/api/src/wait-one"],
  })
  const dispatched = await call(tools, "foreman_next")
  assert.match(dispatched, /^ACTION: dispatch_worker/)
  assert.ok(dispatched.includes("CAPACITY: 1/3"))

  const parked = await call(tools, "foreman_next")
  assert.match(parked, /^ACTION: wait/)
  assert.ok(parked.includes("CAPACITY: 1/3"))
  assert.ok(parked.includes("WAITING: #1 open"), parked)
  const nextLine = parked.match(/^NEXT: (.+)$/m)?.[1]
  assert.ok(nextLine, parked)
  const wakeAt = Date.parse(nextLine)
  const delta = wakeAt - Date.now()
  assert.ok(delta > 4 * 60_000 && delta <= 5 * 60_000 + 5_000, `NEXT is ${delta}ms away`)
  const stored = readState(repo)
  assert.equal(stored.nextWakeAt, nextLine)
  const now = Date.now()
  assert.equal(beforeNextWake(stored, now), true)
  assert.equal(beforeNextWake({ nextWakeAt: new Date(now).toISOString() }, now), false, "a tick exactly at nextWakeAt must run")
  assert.equal(beforeNextWake({ nextWakeAt: new Date(now + 1).toISOString() }, now), true)

  // A session event before nextWakeAt is skipped: no tick text is queued.
  channel.push({ type: "session.idle", sessionID: SESSION_ID })
  await sleep(400)
  assert.deepEqual(prompts, [], `a parked tick still queued: ${prompts.join(" | ")}`)

  // The same state wakes the loop as soon as nextWakeAt has passed.
  seedLoop(repo, (state) => { state.nextWakeAt = new Date(Date.now() - 1).toISOString() })
  channel.push({ type: "session.idle", sessionID: SESSION_ID })
  assert.equal(await waitFor(() => prompts.length > 0), true, "the tick after nextWakeAt was skipped")
  assert.match(prompts[0], /^\[foreman\] Tick\./)

  // A full pipeline waits too: this is the capacity case, not "no ready work".
  const full = makeRepo()
  const fullTools = await startLoop(full, { maxParallel: 3 })
  for (let index = 1; index <= 3; index += 1) {
    await createStep(fullTools, {
      title: `full ${index}`, goal: "fill the pipeline", acceptance: ["criterion"],
      acceptanceCommands: [`printf full${index}`], scope: [`backend/api/src/full-${index}`],
    })
  }
  const workers = await call(fullTools, "foreman_next")
  assert.match(workers, /^ACTION: multi/)
  assert.ok(workers.includes("CAPACITY: 3/3"), workers)
  const fullWait = await call(fullTools, "foreman_next")
  assert.match(fullWait, /^ACTION: wait/)
  assert.ok(fullWait.includes("CAPACITY: 3/3"))
  // A finished dispatch is a state change: its end must clear the idle park so
  // the completion is a tick instead of one skipped until nextWakeAt. Track the
  // child, fill the pipeline so the tick parks, end the child, then show the
  // very next idle tick queues. The `session.execution.*` channel is exactly
  // what the product emits when a subagent ends; the drill otherwise never
  // pushes it.
  const endRepo = makeRepo()
  const endPrompts = []
  const endChannel = eventChannel()
  const endTools = await startLoop(endRepo, { channel: endChannel, prompts: endPrompts, maxParallel: 3 })
  await createStep(endTools, {
    title: "park then end", goal: "a freed worker slot ticks at once", acceptance: ["criterion"],
    acceptanceCommands: ["printf park-end"], scope: ["backend/api/src/park-end"],
  })
  assert.match(await call(endTools, "foreman_next"), /^ACTION: dispatch_worker/)
  seedLoop(endRepo, (state) => { state.steps[0].dispatchSessionID = "ses_child_park" })
  const endParked = await call(endTools, "foreman_next")
  assert.match(endParked, /^ACTION: wait/, endParked)
  assert.ok(readState(endRepo).nextWakeAt, "the full pipeline did not park")
  endChannel.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child_park" } })
  assert.equal(await waitFor(() => readStep(endRepo, 1).dispatchEndedAt !== undefined), true, "the dispatch end was not recorded")
  assert.equal(await waitFor(() => !readState(endRepo).nextWakeAt), true, "the finished dispatch left the idle park in place")
  endChannel.push({ type: "session.idle", sessionID: SESSION_ID })
  assert.equal(await waitFor(() => endPrompts.some((item) => /^\[foreman\] Tick\./.test(item))), true, "the tick after the dispatch end was skipped")

  return `wait ${Math.round(delta / 1000)}s ahead, nextWakeAt persisted, tick before it skipped, tick at/after it queued, full pipeline 3/3 waits, a finished dispatch clears the park`
})

if (PARALLEL_MODE) {
  await scenario(19, "parallel: three disjoint steps, two workers, capacity and step order", async () => {
    const repo = makeRepo()
    const tools = await startLoop(repo, { maxParallel: 3 })
    const scopes = ["backend/api/src/par-a", "backend/api/src/par-b", "scripts/par-c"]
    for (const [index, scope] of scopes.entries()) {
      const created = await createStep(tools, {
        title: `par ${index + 1}`, goal: "run beside its peers", acceptance: ["criterion"],
        acceptanceCommands: [`printf par${index + 1}`], scope: [scope],
      })
      assert.equal(created.n, index + 1)
    }
    assert.deepEqual(readState(repo).active, [1, 2, 3])

    // Closing step 3 proves the slot comes back and leaves two live workers.
    await call(tools, "foreman_result", {
      step: 3, commit: repo.head, command: "printf par3", exitCode: 0, summary: "third shipped",
    })
    const verified = await call(tools, "foreman_verify", {
      step: 3, verdict: "good", commands: [{ command: "printf par3", exitCode: 0 }], transcript: "user saw par three",
    })
    assert.match(verified, /^VERIFIED step 3\./)
    assert.deepEqual(readState(repo).active, [1, 2])

    const next = await call(tools, "foreman_next")
    assert.match(next, /^ACTION: multi/)
    assert.ok(next.includes("CAPACITY: 2/3"), next)
    const dispatches = next.split("\n").filter((line) => /^\d+\. /.test(line))
    assert.equal(dispatches.length, 2, next)
    assert.match(dispatches[0], /^1\. dispatch_worker — step 1, issue #\d+$/)
    assert.match(dispatches[1], /^2\. dispatch_worker — step 2, issue #\d+$/)
    assert.ok((next.match(/create_step/g) ?? []).length <= 1, "more than one create_step in a tick")

    // No scope conflict among the three, and a step that reaches into step 1's
    // scope is refused while a fourth disjoint step is accepted.
    const overlap = await call(tools, "foreman_step", {
      title: "par overlap", goal: "must be refused", acceptance: ["criterion"],
      acceptanceCommands: ["printf par5"], scope: ["backend/api/src/par-a/nested"],
    })
    assert.equal(overlap, "REFUSED: scope overlaps step 1 on backend/api/src/par-a/nested")
    const fourth = await createStep(tools, {
      title: "par 4", goal: "run beside its peers", acceptance: ["criterion"],
      acceptanceCommands: ["printf par4"], scope: ["backend/api/src/par-d"],
    })
    assert.equal(fourth.n, 4)
    return "3 disjoint steps created, active [1,2] after step 3 verified, CAPACITY 2/3, two workers in step order, no create_step, disjoint step 4 accepted, overlap refused"
  })
}

/* --------------------------- phase C: the graph ------------------------- */

const SEAM_FILE = "shared/contracts/src/seam.ts"
const BARREL_FILE = "shared/contracts/src/index.ts"
const SECOND_BARREL_FILE = "shared/contracts/src/second.ts"
const SEAM_CONTENT = "export const seam = 1\n"

const unitDef = (id, extra = {}) => ({
  id, title: `unit ${id}`, dependsOn: [], scope: [`backend/api/src/${id}`], seam: [], class: "independent", ...extra,
})
const issueCreateLines = () => fs.readFileSync(ghLog, "utf8").split("\n").filter((line) => /args=issue create --title (?:\[[^\]]+\] )?Step /.test(line))

await scenario(FIRST_GRAPH_SCENARIO, "C1: foreman_graph refuses malformed graphs and buys each unit exactly once", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  assert.deepEqual(readState(repo).units, [])
  const stepRecords = () => readLedger(repo).filter((entry) => entry.type === "step").length
  const issuesBefore = issueCreateLines().length

  const refusals = [
    ["not an array", "nope", /^REFUSED: units is required: pass the plan units as an array/],
    ["empty graph", [], /^REFUSED: units is required: the graph must declare at least one unit\./],
    ["duplicate id", [unitDef("a"), unitDef("a")], /^REFUSED: duplicate unit id a/],
    ["id with a space", [unitDef("a b")], /^REFUSED: unit id "a b" is malformed/],
    ["id with a slash", [unitDef("a/b")], /^REFUSED: unit id "a\/b" is malformed/],
    ["id starting with a dash", [unitDef("-a")], /^REFUSED: unit id "-a" is malformed/],
    ["empty id", [{ ...unitDef("a"), id: " " }], /has no id/],
    ["missing title", [{ ...unitDef("a"), title: " " }], /has no title/],
    ["empty scope", [{ ...unitDef("a"), scope: [] }], /^REFUSED: unit a needs a non-empty scope/],
    ["blank scope", [{ ...unitDef("a"), scope: ["   "] }], /^REFUSED: unit a needs a non-empty scope/],
    ["unknown class", [{ ...unitDef("a"), class: "batch" }], /^REFUSED: unit a has unknown class "batch"\. Allowed: independent, seam-parallel, serial, integration\./],
    ["unknown dependency", [{ ...unitDef("a"), dependsOn: ["ghost"] }], /^REFUSED: unit a depends on unknown unit ghost/],
    ["self dependency", [{ ...unitDef("a"), dependsOn: ["a"] }], /^REFUSED: unit a depends on itself: the graph has a cycle \(a -> a\)\./],
    ["cycle", [{ ...unitDef("a"), dependsOn: ["b"] }, { ...unitDef("b"), dependsOn: ["a"] }], /^REFUSED: the unit graph has a cycle: a -> b -> a\./],
    ["seam-parallel without a seam", [{ ...unitDef("a"), class: "seam-parallel" }], /^REFUSED: unit a is seam-parallel but declares no seam/],
    ["integration without dependencies", [{ ...unitDef("a"), class: "integration" }], /^REFUSED: integration unit a must depend on the units it fans in\./],
    ["unit is not an object", ["a"], /^REFUSED: unit 1 is not an object\./],
    ["non-string id", [{ ...unitDef("a"), id: 5 }], /^REFUSED: unit 1 id must be a string\./],
    ["dependsOn is a string", [{ ...unitDef("a"), dependsOn: "b" }], /^REFUSED: unit a dependsOn must be an array of unit ids\./],
    ["seam is a string", [{ ...unitDef("a"), seam: "shared/contracts/src/seam.ts" }], /^REFUSED: unit a seam must be an array of paths\./],
  ]
  for (const [label, units, expected] of refusals) {
    const message = await call(tools, "foreman_graph", { units })
    assert.match(message, expected, `${label}: ${message}`)
    assert.deepEqual(readState(repo).units, [], `${label} wrote the graph`)
    assert.equal(readState(repo).steps.length, 0, `${label} created a step`)
    assert.equal(readState(repo).cursor, 0, `${label} moved the cursor`)
  }
  assert.equal(stepRecords(), 0)
  assert.equal(issueCreateLines().length, issuesBefore, "a refused graph created a GitHub issue")

  // The valid graph is persisted, in plan order, with canonical scope paths.
  const units = [
    { id: "seam", title: "Seam", class: "serial", dependsOn: [], scope: ["shared//contracts/src/seam.ts"], seam: [] },
    { id: "api", title: "API", class: "serial", dependsOn: ["seam"], scope: ["backend/api/src/api-"] },
    { id: "fanin", title: "Fan-in", class: "integration", dependsOn: ["api"], scope: [BARREL_FILE] },
  ]
  const graph = await call(tools, "foreman_graph", { units })
  assert.match(graph, /^GRAPH recorded: 3 unit\(s\)/)
  assert.ok(graph.includes("ORDER: create the integration step for unit fanin first"), graph)
  const stored = readState(repo).units
  assert.deepEqual(stored.map((unit) => unit.id), ["seam", "api", "fanin"])
  assert.deepEqual(stored.map((unit) => unit.class), ["serial", "serial", "integration"])
  assert.deepEqual(stored[0].scope, [SEAM_FILE], "scope was not normalised")
  assert.deepEqual(stored[1].scope, ["backend/api/src/api-"], "a trailing slash was not collapsed")
  assert.deepEqual(stored[2].scope, [BARREL_FILE])
  assert.equal(readLedger(repo).find((entry) => entry.type === "graph").kind, "decision")

  const base = { goal: "drive the unit", acceptance: ["criterion"], acceptanceCommands: ["printf unit"] }
  assert.equal(
    await call(tools, "foreman_step", { ...base, title: "no unit", scope: ["backend/api/src/nounit"] }),
    "REFUSED: unitId is required: this loop has a 3-unit graph. Pass the unit this step implements (seam, api, fanin).",
  )
  assert.equal(
    await call(tools, "foreman_step", { ...base, title: "ghost", unitId: "ghost", scope: ["backend/api/src/ghost"] }),
    "REFUSED: unit ghost is not in the graph. Units: seam, api, fanin.",
  )

  // C3: the integration step is taken first, on purpose, so its acceptance
  // exists before the parallel workers; every later unit then works on a batch
  // whose fan-in is already written.
  const fanIn = await createStep(tools, { ...base, title: "fan-in", unitId: "fanin", scope: [BARREL_FILE] })
  assert.equal(readStep(repo, fanIn.n).kind, "integration")
  assert.ok(fanIn.message.includes("- fan-in: the acceptance for fanin is recorded now, before the parallel workers start."), fanIn.message)

  const seam = await createStep(tools, { ...base, title: "seam", unitId: "seam", scope: [SEAM_FILE] })
  assert.match(seam.message, /- unit: seam \(serial\)/)
  assert.equal(readStep(repo, seam.n).unitId, "seam")
  assert.equal(
    await call(tools, "foreman_step", { ...base, title: "seam again", unitId: "seam", scope: ["backend/api/src/other"] }),
    `REFUSED: unit seam is already taken by step ${seam.n} (open). A unit has exactly one step.`,
  )

  // A unit taken by a step that is fixing is still taken.
  seedLoop(repo, (state) => { state.steps.find((step) => step.unitId === "seam").status = "fixing" })
  assert.equal(
    await call(tools, "foreman_step", { ...base, title: "seam fixing", unitId: "seam", scope: ["backend/api/src/other"] }),
    `REFUSED: unit seam is already taken by step ${seam.n} (fixing). A unit has exactly one step.`,
  )
  seedLoop(repo, (state) => { state.steps.find((step) => step.unitId === "seam").status = "open" })

  assert.equal(
    await call(tools, "foreman_step", { ...base, title: "api early", unitId: "api", scope: ["backend/api/src/api-"] }),
    "REFUSED: unit api waits for seam: only verified dependency units may be taken.",
  )

  await call(tools, "foreman_result", { step: seam.n, commit: repo.head, command: "printf unit", exitCode: 0, summary: "seam shipped" })
  const verified = await call(tools, "foreman_verify", { step: seam.n, verdict: "good", commands: [{ command: "printf unit", exitCode: 0 }], transcript: "user saw the seam" })
  assert.match(verified, new RegExp(`^VERIFIED step ${seam.n}\\.`))
  assert.equal(
    await call(tools, "foreman_step", { ...base, title: "seam verified", unitId: "seam", scope: ["backend/api/src/other"] }),
    `REFUSED: unit seam is already verified by step ${seam.n}. A unit has exactly one step.`,
  )
  const api = await createStep(tools, { ...base, title: "api", unitId: "api", scope: ["backend/api/src/api-"] })
  assert.equal(readStep(repo, api.n).unitId, "api")
  assert.deepEqual(readStep(repo, api.n).dependsOn, [`#${seam.issue}`], "the graph dependency did not become an issue dependency")
  return `20 malformed graphs refused with units [] and no issue; valid 3-unit graph persisted with normalised scope/seam; unitId required, unknown/taken/fixing/verified units refused, fan-in taken first with kind integration, api waits for seam then is accepted`
})

await scenario(FIRST_GRAPH_SCENARIO + 1, "C2: the ready set waits for verified dependencies, the seam and disjoint scope", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const units = [
    { id: "seam", title: "Seam", class: "serial", dependsOn: [], scope: ["shared/contracts/src"] },
    { id: "report", title: "Report", class: "seam-parallel", dependsOn: [], scope: ["frontend/src/report"], seam: [SEAM_FILE] },
    { id: "api", title: "API", class: "seam-parallel", dependsOn: ["seam"], scope: ["backend/api/src/feat-api"], seam: [SEAM_FILE] },
    { id: "overlap", title: "Overlap", class: "independent", dependsOn: [], scope: ["frontend/src/report/nested"] },
    { id: "later", title: "Later", class: "serial", dependsOn: ["api"], scope: ["backend/api/src/later"] },
  ]
  assert.match(await call(tools, "foreman_graph", { units }), /^GRAPH recorded: 5 unit\(s\)/)

  // Nothing has run: the seam and the independent unit are ready, the
  // seam-parallel one waits for the file, the serial ones for their units.
  let status = await call(tools, "foreman_status")
  assert.match(status, /- units: 0\/5 verified/)
  assert.match(status, /- seam \[serial\] · ready · scope shared\/contracts\/src/)
  assert.match(status, /- report \[seam-parallel\] · seam shared\/contracts\/src\/seam\.ts · waiting \(seam: shared\/contracts\/src\/seam\.ts is not on foreman\/drill yet\)/)
  assert.match(status, /- api \[seam-parallel\] after seam · seam shared\/contracts\/src\/seam\.ts · waiting \(waits for seam\)/)
  assert.match(status, /- overlap \[independent\] · ready/)
  assert.match(status, /- later \[serial\] after api · waiting \(waits for api\)/)

  // The offer follows the ready set, in plan order; the first tick offers every
  // ready unit with a disjoint scope.
  const first = await call(tools, "foreman_next")
  assert.match(first, /^ACTION: (create_step|multi)/)
  assert.ok(first.includes("UNIT: seam"), first)
  assert.ok(first.includes("UNIT_CLASS: serial"), first)

  const seam = await createStep(tools, {
    title: "seam", goal: "land the shared contract", acceptance: ["criterion"],
    acceptanceCommands: ["printf seam"], unitId: "seam", scope: [SEAM_FILE],
  })
  // Seam absent: the seam-parallel unit is refused with the reason, not queued.
  assert.match(
    await call(tools, "foreman_step", {
      title: "report early", goal: "must wait for the seam", acceptance: ["criterion"],
      acceptanceCommands: ["printf report"], unitId: "report", scope: ["frontend/src/report"],
    }),
    /^REFUSED: unit report is seam-parallel and its seam is not a verified commit on foreman\/drill: shared\/contracts\/src\/seam\.ts is not on foreman\/drill yet\./,
  )

  // The seam lands on the branch as an implementation, before the verdict.
  const seamCommit = commitDetached(repo, "seam-worker", SEAM_FILE, SEAM_CONTENT, { date: WORKER_DATE })
  await call(tools, "foreman_result", { step: seam.n, commit: seamCommit.sha, command: "printf seam", exitCode: 0, summary: "seam landed" })
  assert.doesNotThrow(() => git(repo.dir, "cat-file", "-e", `${repo.branch}:${SEAM_FILE}`), "the seam is not on the branch")
  status = await call(tools, "foreman_status")
  assert.match(status, /- report \[seam-parallel\] · seam shared\/contracts\/src\/seam\.ts · waiting \(seam: shared\/contracts\/src\/seam\.ts is on foreman\/drill but no verified step landed it\)/)

  const verified = await call(tools, "foreman_verify", { step: seam.n, verdict: "good", commands: [{ command: "printf seam", exitCode: 0 }], transcript: "user saw the seam" })
  assert.match(verified, /^VERIFIED step 1\./)
  status = await call(tools, "foreman_status")
  assert.match(status, /- units: 1\/5 verified/)
  assert.match(status, /- report \[seam-parallel\] · seam shared\/contracts\/src\/seam\.ts · ready/)
  assert.match(status, /- api \[seam-parallel\] after seam · seam shared\/contracts\/src\/seam\.ts · ready/)

  // A ready unit is offered in the same tick as a dispatch, once.
  const second = await call(tools, "foreman_next")
  assert.match(second, /^ACTION: (create_step|multi)/)
  assert.ok(second.includes("UNIT: report"), second)
  assert.ok(second.includes(`SEAM: ${SEAM_FILE} verified on foreman/drill`), second)
  const report = await createStep(tools, {
    title: "report", goal: "build on the seam", acceptance: ["criterion"],
    acceptanceCommands: ["printf report"], unitId: "report", scope: ["frontend/src/report"],
  })
  assert.ok(report.n > seam.n)
  status = await call(tools, "foreman_status")
  assert.match(status, /- overlap \[independent\] · blocked \(scope overlaps step 2 on frontend\/src\/report\/nested\)/)
  assert.match(status, /- later \[serial\] after api · waiting \(waits for api\)/)
  // A blocked unit cannot be forced through foreman_step.
  assert.equal(
    await call(tools, "foreman_step", {
      title: "overlap", goal: "must be blocked", acceptance: ["criterion"],
      acceptanceCommands: ["printf overlap"], unitId: "overlap", scope: ["frontend/src/report/nested"],
    }),
    "REFUSED: scope overlaps step 2 on frontend/src/report/nested",
  )
  // One dispatch plus one create_step in the same tick.
  const tick = await call(tools, "foreman_next")
  assert.match(tick, /^ACTION: multi/)
  const tickLines = tick.split("\n").filter((line) => /^\d+\. /.test(line))
  assert.equal(tickLines.length, 2, tick)
  assert.match(tickLines[0], /^1\. dispatch_worker — step 2, issue #\d+$/)
  assert.match(tickLines[1], /^2\. create_step — unit api \(seam-parallel\)$/)
  const api = await createStep(tools, {
    title: "api", goal: "build on the seam", acceptance: ["criterion"],
    acceptanceCommands: ["printf api"], unitId: "api", scope: ["backend/api/src/feat-api"],
  })
  assert.equal(readStep(repo, api.n).unitId, "api")
  return "ready set: seam+independent ready, seam-parallel waits for the file then for a verified step, serial waits for its unit, blocked unit refused; status lists every unit; every ready unit with a disjoint scope is offered in one tick"
})

await scenario(FIRST_GRAPH_SCENARIO + 2, "C3: the fan-in step is derived, barrel-only and held until its units verify", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo, { maxParallel: 3 })
  const units = [
    { id: "a", title: "A", class: "independent", dependsOn: [], scope: ["backend/api/src/a"] },
    { id: "b", title: "B", class: "independent", dependsOn: [], scope: ["frontend/src/b"] },
    { id: "fan", title: "Fan-in", class: "integration", dependsOn: ["a", "b"], scope: [BARREL_FILE] },
  ]
  const graph = await call(tools, "foreman_graph", { units })
  assert.ok(graph.includes("ORDER: create the integration step for unit fan first"), graph)

  // The parallel worker cannot start before the fan-in acceptance exists.
  assert.equal(
    await call(tools, "foreman_step", {
      title: "a early", goal: "must wait for the fan-in", acceptance: ["criterion"],
      acceptanceCommands: ["printf a"], unitId: "a", scope: ["backend/api/src/a"],
    }),
    "REFUSED: the fan-in acceptance for unit fan must be written before a parallel worker starts. Create the integration step (unitId fan) with its acceptanceCommands first, then this one.",
  )

  const fan = await createStep(tools, {
    title: "fan-in", goal: "close the batch", acceptance: ["end-to-end proof"],
    acceptanceCommands: ["printf fan"], unitId: "fan", scope: [BARREL_FILE],
  })
  assert.equal(readStep(repo, fan.n).kind, "integration", "kind was not derived from the unit class")
  assert.deepEqual(readStep(repo, fan.n).scope, [BARREL_FILE])
  assert.deepEqual(readStep(repo, fan.n).acceptanceCommands, ["printf fan"])

  // Barrel rules unchanged: a parallel unit may not claim one, and a unit that
  // is not integration cannot be forced into the kind.
  assert.equal(
    await call(tools, "foreman_step", {
      title: "a barrel", goal: "steal the barrel", acceptance: ["criterion"],
      acceptanceCommands: ["printf a"], unitId: "a", scope: [BARREL_FILE],
    }),
    `REFUSED: barrel ${BARREL_FILE} may only be touched by an integration step. Pass kind: "integration" for the fan-in step.`,
  )
  assert.equal(
    await call(tools, "foreman_step", {
      title: "a forced", goal: "force the kind", acceptance: ["criterion"],
      acceptanceCommands: ["printf a"], unitId: "a", kind: "integration", scope: ["backend/api/src/a"],
    }),
    "REFUSED: kind is derived from the unit class: unit a is independent, not an integration unit.",
  )

  const first = await call(tools, "foreman_next")
  assert.match(first, /^ACTION: (create_step|multi)/)
  assert.ok(first.includes("UNIT: a"), first)
  const a = await createStep(tools, {
    title: "a", goal: "build a", acceptance: ["criterion"],
    acceptanceCommands: ["printf a"], unitId: "a", scope: ["backend/api/src/a"],
  })
  const second = await call(tools, "foreman_next")
  assert.match(second, /^ACTION: multi/)
  const secondLines = second.split("\n").filter((line) => /^\d+\. /.test(line))
  assert.equal(secondLines.length, 2, second)
  assert.match(secondLines[0], new RegExp(`^1\\. dispatch_worker — step ${a.n}, issue #\\d+$`))
  assert.match(secondLines[1], /^2\. create_step — unit b \(independent\)$/)
  const b = await createStep(tools, {
    title: "b", goal: "build b", acceptance: ["criterion"],
    acceptanceCommands: ["printf b"], unitId: "b", scope: ["frontend/src/b"],
  })

  const workerTick = await call(tools, "foreman_next")
  assert.match(workerTick, /^ACTION: dispatch_worker/)
  assert.ok(workerTick.includes(`STEP: ${b.n}`), workerTick)
  assert.equal(workerTick.includes("create_step"), false, "a create_step at capacity")
  const held = await call(tools, "foreman_next")
  assert.match(held, /^ACTION: wait/)
  assert.ok(held.includes(`HOLDING: step ${fan.n} (integration) waits for a, b`), held)
  // The held fan-in is not a worker: two workers occupy two slots, not three.
  assert.ok(held.includes("CAPACITY: 2/3"), held)

  await call(tools, "foreman_result", { step: a.n, commit: repo.head, command: "printf a", exitCode: 0, summary: "a shipped" })
  await call(tools, "foreman_verify", { step: a.n, verdict: "good", commands: [{ command: "printf a", exitCode: 0 }], transcript: "user saw a" })
  const halfHeld = await call(tools, "foreman_next")
  assert.match(halfHeld, /^ACTION: wait/)
  assert.ok(halfHeld.includes(`HOLDING: step ${fan.n} (integration) waits for b`), halfHeld)

  await call(tools, "foreman_result", { step: b.n, commit: repo.head, command: "printf b", exitCode: 0, summary: "b shipped" })
  await call(tools, "foreman_verify", { step: b.n, verdict: "good", commands: [{ command: "printf b", exitCode: 0 }], transcript: "user saw b" })
  const fanTick = await call(tools, "foreman_next")
  assert.match(fanTick, /^ACTION: dispatch_worker/)
  assert.ok(fanTick.includes(`STEP: ${fan.n}`), fanTick)
  assert.ok(fanTick.includes(`ISSUE: ${fan.issue}`), fanTick)

  // A held fan-in is not a worker: at maxParallel 1 it must not take the only
  // slot, or the graph could never move.
  const tight = makeRepo()
  const tightTools = await startLoop(tight, { maxParallel: 1 })
  await call(tightTools, "foreman_graph", {
    units: [
      { id: "work", title: "Work", class: "independent", dependsOn: [], scope: ["backend/api/src/work"] },
      { id: "fan", title: "Fan-in", class: "integration", dependsOn: ["work"], scope: [BARREL_FILE] },
    ],
  })
  const tightBase = { goal: "unlock the graph", acceptance: ["criterion"], acceptanceCommands: ["printf unlock"] }
  const tightFanStep = await createStep(tightTools, { ...tightBase, title: "fan-in", unitId: "fan", scope: [BARREL_FILE] })
  const tightWork = await createStep(tightTools, { ...tightBase, title: "work", unitId: "work", scope: ["backend/api/src/work"] })
  assert.deepEqual(readState(tight).active, [tightFanStep.n, tightWork.n])
  const tightTick = await call(tightTools, "foreman_next")
  assert.match(tightTick, /^ACTION: dispatch_worker/, tightTick)
  assert.ok(tightTick.includes(`STEP: ${tightWork.n}`), tightTick)
  await call(tightTools, "foreman_result", { step: tightWork.n, commit: tight.head, command: "printf unlock", exitCode: 0, summary: "work shipped" })
  await call(tightTools, "foreman_verify", { step: tightWork.n, verdict: "good", commands: [{ command: "printf unlock", exitCode: 0 }], transcript: "user saw the work" })
  const tightFan = await call(tightTools, "foreman_next")
  assert.match(tightFan, /^ACTION: dispatch_worker/, tightFan)
  assert.ok(tightFan.includes(`STEP: ${tightFanStep.n}`), tightFan)
  return "fan-in first (kind integration, barrel allowed), parallel units refused the barrel and the forced kind, fan-in held at 2/3 workers and after a verified, dispatched only once a and b are verified; a held fan-in never eats the only slot at maxParallel 1"
})

await scenario(FIRST_GRAPH_SCENARIO + 3, "C4: plan complete only when every unit is verified and active is empty", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  await call(tools, "foreman_graph", { units: [unitDef("a"), unitDef("b")] })
  const base = { goal: "finish the unit", acceptance: ["criterion"], acceptanceCommands: ["printf done"] }

  const a = await createStep(tools, { ...base, title: "a", unitId: "a", scope: ["backend/api/src/a"] })
  // The worker of a and the offer of b share the tick: the dispatch comes first
  // and b is created as the only remaining ready unit.
  const firstTick = await call(tools, "foreman_next")
  assert.match(firstTick, /^ACTION: multi/)
  assert.ok(firstTick.includes(`1. dispatch_worker — step ${a.n}, issue #`), firstTick)
  assert.ok(firstTick.includes("2. create_step — unit b (independent)"), firstTick)
  await call(tools, "foreman_result", { step: a.n, commit: repo.head, command: "printf done", exitCode: 0, summary: "a shipped" })
  await call(tools, "foreman_verify", { step: a.n, verdict: "good", commands: [{ command: "printf done", exitCode: 0 }], transcript: "user saw a" })

  // One unit pending: not complete, the pending unit is offered.
  const notYet = await call(tools, "foreman_next")
  assert.match(notYet, /^ACTION: create_step/)
  assert.ok(notYet.includes("UNIT: b"), notYet)
  assert.equal(notYet.includes("plan complete"), false, notYet)

  const b = await createStep(tools, { ...base, title: "b", unitId: "b", scope: ["backend/api/src/b"] })
  assert.match(await call(tools, "foreman_next"), /^ACTION: dispatch_worker/)
  await call(tools, "foreman_result", { step: b.n, commit: repo.head, command: "printf done", exitCode: 0, summary: "b shipped" })
  await call(tools, "foreman_verify", { step: b.n, verdict: "good", commands: [{ command: "printf done", exitCode: 0 }], transcript: "user saw b" })

  const complete = await call(tools, "foreman_next")
  assert.match(complete, /^ACTION: plan complete/)
  assert.ok(complete.includes("UNITS: 2/2 verified"), complete)
  assert.ok(complete.toLowerCase().includes('call foreman_stop with reason "plan complete"'), complete)
  assert.deepEqual(readState(repo).active, [])
  assert.match(await call(tools, "foreman_status"), /- units: 2\/2 verified · plan complete/)

  // Every unit verified but a step still in flight: NOT complete.
  seedLoop(repo, (state) => {
    state.steps.push({
      n: 3, title: "leftover", goal: "keep the pipeline open", acceptance: ["criterion"],
      acceptanceCommands: ["printf leftover"], scope: ["backend/api/src/leftover"],
      status: "implemented", planIssue: 501, implIssue: 502, fixIssues: [],
    })
    state.cursor = 3
    state.active = [3]
  })
  const blockedByActive = await call(tools, "foreman_next")
  assert.match(blockedByActive, /^ACTION: dispatch_verifier/)
  assert.equal(blockedByActive.includes("plan complete"), false, blockedByActive)

  // Without a graph the manual judgement stays: no plan complete ever.
  const bare = makeRepo()
  const bareTools = await startLoop(bare)
  await createStep(bareTools, {
    title: "solo", goal: "no graph", acceptance: ["criterion"],
    acceptanceCommands: ["printf solo"], scope: ["backend/api/src/solo"],
  })
  await call(bareTools, "foreman_result", { step: 1, commit: bare.head, command: "printf solo", exitCode: 0, summary: "solo shipped" })
  await call(bareTools, "foreman_verify", { step: 1, verdict: "good", commands: [{ command: "printf solo", exitCode: 0 }], transcript: "user saw it" })
  const manual = await call(bareTools, "foreman_next")
  assert.match(manual, /^ACTION: create_step/)
  assert.equal(manual.includes("plan complete"), false, manual)
  return "one unit pending -> create_step, 2/2 verified with active [] -> plan complete, a step in flight -> not complete, no graph -> create_step"
})

await scenario(FIRST_GRAPH_SCENARIO + 4, "C: full graph run — seam first, parallel workers, then fan-in", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const units = [
    { id: "seam", title: "Seam", class: "serial", dependsOn: [], scope: [SEAM_FILE] },
    { id: "api", title: "API", class: "seam-parallel", dependsOn: ["seam"], seam: [SEAM_FILE], scope: ["backend/api/src/feat-api"] },
    { id: "ui", title: "UI", class: "seam-parallel", dependsOn: ["seam"], seam: [SEAM_FILE], scope: ["frontend/src/feat-ui"] },
    { id: "fanin", title: "Fan-in", class: "integration", dependsOn: ["api", "ui"], scope: [BARREL_FILE] },
  ]
  assert.match(await call(tools, "foreman_graph", { units }), /^GRAPH recorded: 4 unit\(s\)/)

  // 1. The fan-in acceptance is written before any parallel worker exists.
  // Every offer emitted in this walk is replayed through foreman_step as
  // printed: an offer the tick cannot back with an accepted step fails here.
  const graphTick = await call(tools, "foreman_next")
  assert.match(graphTick, /^ACTION: (create_step|multi)/)
  assert.ok(graphTick.includes("UNIT: fanin"), graphTick)
  assert.ok(graphTick.includes("ORDER: the fan-in acceptance is written before the parallel workers start."), graphTick)
  const fan = await createOffered(tools, units, graphTick)
  assert.equal(readStep(repo, fan.n).kind, "integration")
  assert.deepEqual(readStep(repo, fan.n).acceptanceCommands, ["printf fanin"])

  // 2. The seam runs first; the parallel units cannot be taken yet.
  const seamTick = await call(tools, "foreman_next")
  assert.match(seamTick, /^ACTION: (create_step|multi)/)
  assert.ok(seamTick.includes("UNIT: seam"), seamTick)
  const seam = await createOffered(tools, units, seamTick)
  assert.equal(readStep(repo, seam.n).unitId, "seam")
  assert.match(
    await call(tools, "foreman_step", {
      title: "api early", goal: "must wait for the seam", acceptance: ["criterion"],
      acceptanceCommands: ["printf api"], unitId: "api", scope: ["backend/api/src/feat-api"],
    }),
    /^REFUSED: unit api waits for seam: only verified dependency units may be taken\./,
  )
  const seamWorker = await call(tools, "foreman_next")
  assert.match(seamWorker, /^ACTION: dispatch_worker/)
  assert.ok(seamWorker.includes(`STEP: ${seam.n}`), seamWorker)

  const seamCommit = commitDetached(repo, "graph-seam", SEAM_FILE, SEAM_CONTENT, { date: WORKER_DATE })
  await call(tools, "foreman_result", { step: seam.n, commit: seamCommit.sha, command: "printf seam", exitCode: 0, summary: "seam landed" })
  assert.match(await call(tools, "foreman_next"), /^ACTION: dispatch_verifier/)
  assert.match(
    await call(tools, "foreman_verify", { step: seam.n, verdict: "good", commands: [{ command: "printf seam", exitCode: 0 }], transcript: "user saw the seam" }),
    new RegExp(`^VERIFIED step ${seam.n}\\.`),
  )
  assert.equal(git(repo.dir, "show", `${repo.branch}:${SEAM_FILE}`), SEAM_CONTENT.trim())

  // 3. The parallel workers: the tick offers every ready unit with a disjoint
  // scope, so api and ui are in the same offer list.
  const apiTick = await call(tools, "foreman_next")
  assert.match(apiTick, /^ACTION: (create_step|multi)/)
  assert.ok(apiTick.includes("UNIT: api"), apiTick)
  const api = await createOffered(tools, units, apiTick)
  const uiTick = await call(tools, "foreman_next")
  assert.match(uiTick, /^ACTION: multi/)
  const uiLines = uiTick.split("\n").filter((line) => /^\d+\. /.test(line))
  assert.equal(uiLines.length, 2, uiTick)
  assert.match(uiLines[0], new RegExp(`^1\\. dispatch_worker — step ${api.n}, issue #\\d+$`))
  assert.match(uiLines[1], /^2\. create_step — unit ui \(seam-parallel\)$/)
  assert.equal(uiTick.split("\n").filter((line) => /^\d+\. create_step/.test(line)).length, 1, "more than one create_step in a tick")
  const ui = await createOffered(tools, units, uiTick)
  assert.equal(ui.unitId, "ui")
  assert.deepEqual(readState(repo).active.slice().sort((left, right) => left - right), [fan.n, api.n, ui.n].sort((left, right) => left - right))

  const uiWorker = await call(tools, "foreman_next")
  assert.match(uiWorker, /^ACTION: dispatch_worker/) // ui starts while api is still in flight
  assert.ok(uiWorker.includes(`STEP: ${ui.n}`), uiWorker)
  const dispatched = readLedger(repo).filter((entry) => entry.type === "dispatch" && entry.action === "dispatch_worker").map((entry) => entry.step)
  assert.ok(dispatched.includes(api.n) && dispatched.includes(ui.n), "the second worker was not dispatched before the first result")
  const held = await call(tools, "foreman_next")
  assert.match(held, /^ACTION: wait/)
  assert.ok(held.includes(`HOLDING: step ${fan.n} (integration) waits for api, ui`), held)

  // 4. Parallel results verify; the fan-in lands only after both.
  const apiCommit = commitDetached(repo, "graph-api", "backend/api/src/feat-api/index.ts", "export const api = 1\n", { date: WORKER_DATE })
  await call(tools, "foreman_result", { step: api.n, commit: apiCommit.sha, command: "printf api", exitCode: 0, summary: "api shipped" })
  await call(tools, "foreman_verify", { step: api.n, verdict: "good", commands: [{ command: "printf api", exitCode: 0 }], transcript: "user saw the api" })
  const halfHeld = await call(tools, "foreman_next")
  assert.match(halfHeld, /^ACTION: wait/)
  assert.ok(halfHeld.includes(`HOLDING: step ${fan.n} (integration) waits for ui`), halfHeld)

  const uiCommit = commitDetached(repo, "graph-ui", "frontend/src/feat-ui/index.ts", "export const ui = 1\n", { date: WORKER_DATE })
  await call(tools, "foreman_result", { step: ui.n, commit: uiCommit.sha, command: "printf ui", exitCode: 0, summary: "ui shipped" })
  await call(tools, "foreman_verify", { step: ui.n, verdict: "good", commands: [{ command: "printf ui", exitCode: 0 }], transcript: "user saw the ui" })

  const fanTick = await call(tools, "foreman_next")
  assert.match(fanTick, /^ACTION: dispatch_worker/)
  assert.ok(fanTick.includes(`STEP: ${fan.n}`), fanTick)
  assert.ok(fanTick.includes(`ISSUE: ${fan.issue}`), fanTick)

  // 5. The fan-in closes the batch and the plan is complete.
  await call(tools, "foreman_result", { step: fan.n, commit: repo.head, command: "printf fanin", exitCode: 0, summary: "fan-in closed the batch" })
  assert.match(
    await call(tools, "foreman_verify", { step: fan.n, verdict: "good", commands: [{ command: "printf fanin", exitCode: 0 }], transcript: "user saw both sides through the barrel" }),
    /^VERIFIED step 1\./,
  )
  const complete = await call(tools, "foreman_next")
  assert.match(complete, /^ACTION: plan complete/)
  assert.ok(complete.includes("UNITS: 4/4 verified"), complete)
  assert.match(await call(tools, "foreman_status"), /- units: 4\/4 verified · plan complete/)
  return "fan-in acceptance first, seam worker then a verified seam commit, api/ui in parallel (one create_step per tick, 2 workers + 1 held fan-in), fan-in dispatched after both verified, ACTION: plan complete"
})

await scenario(FIRST_GRAPH_SCENARIO + 5, "C: no-graph compatibility, graph mutation and unit probes", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  // A state written before phase C has no units key at all: it loads unchanged,
  // still runs steps and still returns the old create_step.
  seedLoop(repo, (state) => { delete state.units })
  assert.equal(Object.hasOwn(readState(repo), "units"), false)
  let status = await call(tools, "foreman_status")
  assert.equal(status.includes("Units:"), false, "a loop without a graph printed units")
  const legacyNext = await call(tools, "foreman_next")
  assert.match(legacyNext, /^ACTION: create_step/)
  assert.equal(legacyNext.includes("UNIT:"), false, legacyNext)

  const base = { goal: "run without a graph", acceptance: ["criterion"], acceptanceCommands: ["printf legacy"] }
  const legacy = await createStep(tools, { ...base, title: "legacy", scope: ["backend/api/src/legacy"] })
  assert.equal(readStep(repo, legacy.n).unitId, undefined)
  const labelled = await createStep(tools, { ...base, title: "labelled", unitId: "12c", scope: ["backend/api/src/labelled"] })
  assert.equal(readStep(repo, labelled.n).unitId, "12c", "phase A free-text unitId stopped working")
  assert.equal(
    await call(tools, "foreman_graph", { units: [unitDef("a")] }),
    "REFUSED: the graph cannot change after steps have taken units (12c -> step 2). Start a new loop to plan again.",
  )

  // Before any step takes a unit the graph may be rewritten, after that never.
  const fresh = makeRepo()
  const freshTools = await startLoop(fresh)
  await call(freshTools, "foreman_graph", { units: [unitDef("a"), unitDef("b")] })
  assert.match(await call(freshTools, "foreman_graph", { units: [unitDef("a"), unitDef("b", { dependsOn: ["a"] })] }), /^GRAPH recorded: 2 unit\(s\)/)
  assert.deepEqual(readState(fresh).units.find((unit) => unit.id === "b").dependsOn, ["a"])
  await createStep(freshTools, { ...base, title: "a", unitId: "a", scope: ["backend/api/src/a"] })
  assert.equal(
    await call(freshTools, "foreman_graph", { units: [unitDef("c")] }),
    "REFUSED: the graph cannot change after steps have taken units (a -> step 1). Start a new loop to plan again.",
  )

  // A graph recorded after legacy steps exist is allowed; every new step must
  // then name a unit.
  const late = makeRepo()
  const lateTools = await startLoop(late)
  await createStep(lateTools, { ...base, title: "pre-graph", scope: ["backend/api/src/pre-graph"] })
  assert.match(await call(lateTools, "foreman_graph", { units: [unitDef("a")] }), /^GRAPH recorded: 1 unit\(s\)/)
  assert.match(
    await call(lateTools, "foreman_step", { ...base, title: "no unit", scope: ["backend/api/src/no-unit"] }),
    /^REFUSED: unitId is required: this loop has a 1-unit graph\./,
  )
  assert.equal((await createStep(lateTools, { ...base, title: "a", unitId: "a", scope: ["backend/api/src/a"] })).n, 2)

  // Two foreman_step calls for the same unit never both win.
  const race = makeRepo()
  const raceTools = await startLoop(race)
  await call(raceTools, "foreman_graph", { units: [unitDef("one"), unitDef("two")] })
  const raceInput = { title: "one", goal: "race", acceptance: ["criterion"], acceptanceCommands: ["printf race"], unitId: "one", scope: ["backend/api/src/one"] }
  const [left, right] = await Promise.all([call(raceTools, "foreman_step", raceInput), call(raceTools, "foreman_step", raceInput)])
  assert.equal([left, right].filter((message) => message.startsWith("STEP ")).length, 1, `${left}\n---\n${right}`)
  assert.equal([left, right].filter((message) => message.startsWith("REFUSED: unit one is already taken")).length, 1, `${left}\n---\n${right}`)
  assert.equal(readState(race).steps.length, 1)

  // A hand-edited state with a broken units entry never crashes a read tool.
  seedLoop(race, (state) => { state.units = "not-a-graph" })
  assert.match(await call(raceTools, "foreman_status"), /^Foreman — RUNNING/)
  assert.match(await call(raceTools, "foreman_next"), /^ACTION: (dispatch_worker|create_step)/)
  seedLoop(race, (state) => { state.units = [{ id: "x" }] })
  assert.match(await call(raceTools, "foreman_status"), /^Foreman — RUNNING/)
  return "units-free state loads and keeps create_step; free-text unitId still works without a graph; the graph is refused once a unit is taken, rewritable before, allowed after legacy steps; a graph step without unitId is refused; one winner for two concurrent calls on one unit; broken persisted units never crash a read tool"
})

/* ------------- phase C: offers that foreman_step would refuse ------------- */

await scenario(FIRST_GRAPH_SCENARIO + 6, "C: a blocked fan-in is never offered and every offer stays creatable", async () => {
  // (a) Two fan-ins sharing one barrel: the second is blocked by the first, so
  // the tick must not offer it (foreman_step refuses two barrels at once) and
  // must fall back to a ready unit when the fan-in gate is already satisfied.
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const units = [
    unitDef("p", { scope: ["backend/api/src/p"] }),
    { id: "i1", title: "fan-in one", class: "integration", dependsOn: ["p"], scope: [BARREL_FILE], seam: [] },
    { id: "i2", title: "fan-in two", class: "integration", dependsOn: ["p"], scope: [BARREL_FILE], seam: [] },
  ]
  assert.match(await call(tools, "foreman_graph", { units }), /^GRAPH recorded: 3 unit\(s\)/)

  // The first fan-in is creatable while p is unverified (C3) and its block says
  // the dependency is pending, not verified.
  const firstTick = await call(tools, "foreman_next")
  assert.match(firstTick, /^ACTION: create_step/)
  assert.ok(firstTick.includes("UNIT: i1"), firstTick)
  assert.ok(firstTick.includes("DEPENDS_ON_UNITS: p (pending: p)"), firstTick)
  assert.equal(firstTick.includes("(verified)"), false, firstTick)
  const i1 = await createOffered(tools, units, firstTick)

  // i1 holds the barrel and p is still unverified: i2 is blocked, not waiting
  // only for p, and status says exactly that.
  const status = await call(tools, "foreman_status")
  assert.match(status, /- i1 \[integration\] after p · taken by step 1 \(open\)/, status)
  assert.match(status, /- i2 \[integration\] after p · blocked \(barrel shared\/contracts\/src\/index\.ts is held by step 1; scope overlaps step 1 on shared\/contracts\/src\/index\.ts; waits for p\)/, status)

  // The tick offers p instead of i2, and foreman_step accepts that offer. The
  // fan-in is held (not dispatched) until p verifies, so this tick is the
  // create_step alone.
  const secondTick = await call(tools, "foreman_next")
  assert.match(secondTick, /^ACTION: create_step/, secondTick)
  assert.ok(secondTick.includes("UNIT: p"), secondTick)
  assert.equal(secondTick.includes("UNIT: i2"), false, secondTick)
  const p = await createOffered(tools, units, secondTick)

  assert.match(await call(tools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${p.n}\\n`))
  await call(tools, "foreman_result", { step: p.n, commit: repo.head, command: "printf p", exitCode: 0, summary: "p shipped" })
  await call(tools, "foreman_verify", { step: p.n, verdict: "good", commands: [{ command: "printf p", exitCode: 0 }], transcript: "user saw p" })

  // p is verified, so i1 itself is dispatchable now; once it is out, i2 is
  // blocked for the barrel alone and the tick waits instead of offering it.
  assert.match(await call(tools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${i1.n}\\n`))
  const waitTick = await call(tools, "foreman_next")
  assert.match(waitTick, /^ACTION: wait/, waitTick)
  assert.equal(waitTick.includes("create_step"), false, waitTick)
  assert.ok(waitTick.includes("NOT_READY: i2 blocked (barrel shared/contracts/src/index.ts is held by step 1; scope overlaps step 1 on shared/contracts/src/index.ts)"), waitTick)
  assert.match(
    await call(tools, "foreman_step", {
      title: "i2 now", goal: "steal the barrel", acceptance: ["criterion"],
      acceptanceCommands: ["printf i2"], unitId: "i2", scope: [BARREL_FILE],
    }),
    /^REFUSED: step 1 already touches barrel shared\/contracts\/src\/index\.ts; two active steps may not both touch barrels\./,
  )

  // (b) A fan-in blocked by an active step's scope, with its own step still
  // missing: the fan-in gate is unsatisfied, so even a ready unit is not
  // offered — waiting is the only honest tick.
  const gated = makeRepo()
  const gatedTools = await startLoop(gated)
  const hot = await createStep(gatedTools, {
    title: "legacy hot", goal: "hold the scope the fan-in wants", acceptance: ["criterion"],
    acceptanceCommands: ["printf hot"], scope: ["backend/api/src/hot"],
  })
  const gatedUnits = [
    unitDef("free", { scope: ["backend/api/src/free"] }),
    { id: "blocked", title: "blocked fan-in", class: "integration", dependsOn: ["free"], scope: ["backend/api/src/hot"], seam: [] },
  ]
  assert.match(await call(gatedTools, "foreman_graph", { units: gatedUnits }), /^GRAPH recorded: 2 unit\(s\)/)
  // The legacy step is dispatched first, so the next tick has nothing to do but
  // report the blocked fan-in.
  assert.match(await call(gatedTools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${hot.n}\\n`))
  const gatedTick = await call(gatedTools, "foreman_next")
  assert.match(gatedTick, /^ACTION: wait/, gatedTick)
  assert.equal(gatedTick.includes("create_step"), false, gatedTick)
  assert.ok(gatedTick.includes("NOT_READY: free blocked (the fan-in acceptance for unit blocked must be written before a parallel worker starts); blocked blocked (scope overlaps step 1 on backend/api/src/hot; waits for free)"), gatedTick)
  // Both possible offers are refusals: the fan-in by scope, the ready unit by
  // the fan-in gate. The tick told the truth by not offering either.
  assert.match(
    await call(gatedTools, "foreman_step", {
      title: "free", goal: "must not start early", acceptance: ["criterion"],
      acceptanceCommands: ["printf free"], unitId: "free", scope: ["backend/api/src/free"],
    }),
    /^REFUSED: the fan-in acceptance for unit blocked must be written before a parallel worker starts\./,
  )
  assert.equal(
    await call(gatedTools, "foreman_step", {
      title: "blocked", goal: "must not overlap", acceptance: ["criterion"],
      acceptanceCommands: ["printf blocked"], unitId: "blocked", scope: ["backend/api/src/hot"],
    }),
    "REFUSED: scope overlaps step 1 on backend/api/src/hot",
  )

  // (c) A seam-parallel unit with a missing seam is not offered either, and
  // foreman_step agrees with the tick.
  const seamRepo = makeRepo()
  const seamTools = await startLoop(seamRepo)
  const seamUnits = [
    { id: "seamless", title: "Seamless", class: "seam-parallel", dependsOn: [], scope: ["frontend/src/seamless"], seam: [SEAM_FILE] },
    unitDef("solo", { scope: ["backend/api/src/solo"] }),
  ]
  assert.match(await call(seamTools, "foreman_graph", { units: seamUnits }), /^GRAPH recorded: 2 unit\(s\)/)
  const seamTick = await call(seamTools, "foreman_next")
  assert.match(seamTick, /^ACTION: create_step/)
  assert.ok(seamTick.includes("UNIT: solo"), seamTick)
  assert.equal(seamTick.includes("UNIT: seamless"), false, seamTick)
  await createOffered(seamTools, seamUnits, seamTick)
  assert.match(
    await call(seamTools, "foreman_step", {
      title: "seamless", goal: "must wait for the seam", acceptance: ["criterion"],
      acceptanceCommands: ["printf seamless"], unitId: "seamless", scope: ["frontend/src/seamless"],
    }),
    /^REFUSED: unit seamless is seam-parallel and its seam is not a verified commit on foreman\/drill: shared\/contracts\/src\/seam\.ts is not on foreman\/drill yet\./,
  )

  // (d) A non-integration unit that names a barrel is refused at graph time and
  // is never offered from a persisted graph: the readiness guard mirrors
  // foreman_step's barrel rule, so even a hand-edited state cannot emit a
  // create_step the tool would refuse.
  const barrelRepo = makeRepo()
  const barrelTools = await startLoop(barrelRepo)
  const barrelUnits = [
    unitDef("bad", { scope: [BARREL_FILE] }),
    unitDef("good", { scope: ["backend/api/src/good"] }),
  ]
  assert.match(
    await call(barrelTools, "foreman_graph", { units: barrelUnits }),
    /^REFUSED: unit bad is independent and its scope names barrel shared\/contracts\/src\/index\.ts: only an integration unit may touch a barrel\./,
  )
  assert.deepEqual(readState(barrelRepo).units, [], "a refused barrel unit was persisted")
  seedLoop(barrelRepo, (state) => {
    state.units = [
      { id: "bad", title: "bad", class: "independent", dependsOn: [], scope: [BARREL_FILE], seam: [] },
      { id: "good", title: "good", class: "independent", dependsOn: [], scope: ["backend/api/src/good"], seam: [] },
    ]
  })
  const barrelStatus = await call(barrelTools, "foreman_status")
  assert.match(
    barrelStatus,
    /- bad \[independent\] · blocked \(barrel shared\/contracts\/src\/index\.ts may only be touched by an integration step\)/,
    barrelStatus,
  )
  const barrelTick = await call(barrelTools, "foreman_next")
  assert.match(barrelTick, /^ACTION: create_step/, barrelTick)
  assert.ok(barrelTick.includes("UNIT: good"), barrelTick)
  assert.equal(barrelTick.includes("UNIT: bad"), false, barrelTick)
  await createOffered(barrelTools, barrelUnits, barrelTick)
  assert.equal(
    await call(barrelTools, "foreman_step", {
      title: "bad", goal: "steal a barrel", acceptance: ["criterion"],
      acceptanceCommands: ["printf bad"], unitId: "bad", scope: [BARREL_FILE],
    }),
    `REFUSED: barrel ${BARREL_FILE} may only be touched by an integration step. Pass kind: "integration" for the fan-in step.`,
  )

  // (e) A second fan-in is never offered once its dependency owns an open step:
  // foreman_step would add that plan issue to dependsOn and refuse it. The
  // first fan-in is still creatable while the dependency has no step at all —
  // that is C3, and foreman_step accepts it.
  const openRepo = makeRepo()
  const openTools = await startLoop(openRepo)
  const openUnits = [
    unitDef("p", { scope: ["backend/api/src/p"] }),
    { id: "i1", title: "fan-in one", class: "integration", dependsOn: ["p"], scope: [BARREL_FILE], seam: [] },
    { id: "i2", title: "fan-in two", class: "integration", dependsOn: ["p"], scope: [BARREL_FILE], seam: [] },
  ]
  assert.match(await call(openTools, "foreman_graph", { units: openUnits }), /^GRAPH recorded: 3 unit\(s\)/)
  const i1Created = await createOffered(openTools, openUnits, await call(openTools, "foreman_next"))
  assert.equal(i1Created.unitId, "i1")
  const pTick = await call(openTools, "foreman_next")
  assert.ok(pTick.includes("UNIT: p"), pTick)
  assert.equal(pTick.includes("UNIT: i2"), false, pTick)
  const pCreated = await createOffered(openTools, openUnits, pTick)
  assert.equal(readStep(openRepo, pCreated.n).status, "open")
  const openTick = await call(openTools, "foreman_next")
  assert.equal(openTick.includes("UNIT: i2"), false, openTick)
  assert.equal(openTick.includes("create_step"), false, openTick)
  assert.match(
    await call(openTools, "foreman_step", {
      title: "i2 now", goal: "must wait for p", acceptance: ["criterion"],
      acceptanceCommands: ["printf i2"], unitId: "i2", scope: [BARREL_FILE],
    }),
    new RegExp(`^REFUSED: dependsOn is not satisfied: #\\d+ is open \\(step ${pCreated.n}\\)\\. Only verified steps of this loop may be depended on\\.$`),
  )

  // (f) Seeded dependency steps: open and fixing are the two step-level
  // barriers. Both keep the fan-in out of the offer set while the pending list
  // stays honest and status names the step that blocks it.
  const seedRepo = makeRepo()
  const seedTools = await startLoop(seedRepo)
  const seedUnits = [
    { id: "dep", title: "dep", class: "independent", dependsOn: [], scope: ["backend/api/src/dep"], seam: [] },
    { id: "fan", title: "fan", class: "integration", dependsOn: ["dep"], scope: [BARREL_FILE], seam: [] },
  ]
  for (const status of ["open", "fixing"]) {
    seedLoop(seedRepo, (state) => {
      state.units = seedUnits
      state.steps = [{
        n: 1, title: "dep", goal: "leave it unfinished", acceptance: ["criterion"],
        acceptanceCommands: ["printf dep"], scope: ["backend/api/src/dep"], unitId: "dep",
        status, planIssue: 901, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
      }]
      state.cursor = 1
      state.active = [1]
      state.current = 1
      delete state.nextWakeAt
    })
    const tick = await call(seedTools, "foreman_next")
    assert.match(tick, /^ACTION: dispatch_worker/, `${status}: ${tick}`)
    assert.equal(tick.includes("UNIT: fan"), false, `${status}: ${tick}`)
    assert.equal(tick.includes("create_step"), false, `${status}: ${tick}`)
    const seededStatus = await call(seedTools, "foreman_status")
    assert.match(
      seededStatus,
      new RegExp(`- fan \\[integration\\] after dep · blocked \\(dependsOn is not satisfied: #901 is ${status} \\(step 1\\); waits for dep\\)`),
      seededStatus,
    )
    assert.match(
      await call(seedTools, "foreman_step", {
        title: "fan", goal: "must wait for dep", acceptance: ["criterion"],
        acceptanceCommands: ["printf fan"], unitId: "fan", scope: [BARREL_FILE],
      }),
      new RegExp(`^REFUSED: dependsOn is not satisfied: #901 is ${status} \\(step 1\\)\\. Only verified steps of this loop may be depended on\\.$`),
    )
  }

  // (g) Deterministic fuzz: 40 graph/state combinations (4 classes x 2 scopes x
  // 5 dependency states) plus two active-step variants. In every probe the
  // emitted create_step — if any — is replayed through foreman_step exactly as
  // printed, and the two step-level barriers must keep their unit out.
  const fuzzRepo = makeRepo()
  const fuzzTools = await startLoop(fuzzRepo)
  const FUZZ_DEP = ["none", "open", "fixing", "implemented", "verified"]
  let probes = 0
  let offers = 0
  for (const klass of ["independent", "serial", "seam-parallel", "integration"]) {
    for (const scopeKind of ["plain", "barrel"]) {
      for (const depState of FUZZ_DEP) {
        probes += 1
        const target = {
          id: "t", title: "target", class: klass,
          dependsOn: klass === "independent" ? [] : ["d"],
          scope: scopeKind === "barrel" ? [BARREL_FILE] : ["backend/api/src/t"],
          seam: klass === "seam-parallel" ? [SEAM_FILE] : [],
        }
        const dep = { id: "d", title: "dep", class: "independent", dependsOn: [], scope: ["backend/api/src/d"], seam: [] }
        const fuzzUnits = [target, dep]
        seedLoop(fuzzRepo, (state) => {
          state.units = fuzzUnits
          state.steps = depState === "none" ? [] : [{
            n: 1, title: "dep", goal: "seed the dependency", acceptance: ["criterion"],
            acceptanceCommands: ["printf dep"], scope: ["backend/api/src/d"], unitId: "d",
            status: depState, planIssue: 902, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
          }]
          state.cursor = depState === "none" ? 0 : 1
          state.active = depState === "none" || depState === "verified" ? [] : [1]
          state.current = state.active[0] ?? null
          delete state.nextWakeAt
        })
        const tick = await call(fuzzTools, "foreman_next")
        const offered = offeredUnitId(tick)
        const depHasStep = depState !== "none" && depState !== "verified"
        const mustNotOffer = (scopeKind === "barrel" && klass !== "integration") || (klass === "integration" && depHasStep)
        if (mustNotOffer) {
          assert.notEqual(offered, "t", `${klass}/${scopeKind}/${depState} offered a blocked target: ${tick}`)
          assert.equal(tick.includes("UNIT: t"), false, `${klass}/${scopeKind}/${depState} emitted UNIT t: ${tick}`)
          assert.equal(/create_step — unit t \(/.test(tick), false, `${klass}/${scopeKind}/${depState} emitted a create_step for t: ${tick}`)
        }
        if (offered) {
          offers += 1
          await createOffered(fuzzTools, fuzzUnits, tick)
        }
      }
    }
  }

  // Two active-step variants: a legacy step holds the fan-in's barrel, then
  // overlaps its scope. Both are hard foreman_step refusals, so neither may be
  // offered even though every dependency unit is verified.
  for (const [label, activeScope] of [["barrel held", BARREL_FILE], ["scope overlap", "backend/api/src/t/nested"]]) {
    probes += 1
    const variantUnits = [
      { id: "t", title: "target", class: "integration", dependsOn: ["d"], scope: label === "scope overlap" ? ["backend/api/src/t"] : [BARREL_FILE], seam: [] },
      { id: "d", title: "dep", class: "independent", dependsOn: [], scope: ["backend/api/src/d"], seam: [] },
    ]
    seedLoop(fuzzRepo, (state) => {
      state.units = variantUnits
      state.steps = [
        {
          n: 1, title: "dep", goal: "land the dependency", acceptance: ["criterion"],
          acceptanceCommands: ["printf dep"], scope: ["backend/api/src/d"], unitId: "d",
          status: "verified", planIssue: 903, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          n: 2, title: `legacy ${label}`, goal: "hold the target", acceptance: ["criterion"],
          acceptanceCommands: ["printf legacy"], scope: [activeScope],
          status: "open", planIssue: 904, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]
      state.cursor = 2
      state.active = [2]
      state.current = 2
      delete state.nextWakeAt
    })
    const tick = await call(fuzzTools, "foreman_next")
    assert.notEqual(offeredUnitId(tick), "t", `${label}: the blocked fan-in was offered: ${tick}`)
    assert.equal(tick.includes("UNIT: t"), false, `${label}: ${tick}`)
  }
  assert.ok(probes >= 40, `only ${probes} fuzz probes ran`)

  return `two fan-ins on one barrel: i2 blocked and never offered (barrel held by step 1), the tick offered i1 then p and both were accepted, i2 refused by foreman_step; a fan-in blocked by scope with its own step missing left the tick on wait/NOT_READY and both candidate offers refused; a seam-parallel unit with a missing seam was not offered; an independent unit on a barrel was refused by foreman_graph and, seeded, never offered while foreman_step refused it; a second fan-in on an open dependency step was not offered and refused #open; seeded open and fixing dependency steps kept the fan-in out; ${probes} graph/state fuzz probes replayed ${offers} emitted offers through foreman_step, all accepted`
})

await scenario(FIRST_GRAPH_SCENARIO + 7, "C: a creatable fan-in reports pending dependencies and claims verified only when they are", async () => {
  // The fan-in acceptance is written before its dependencies verify (C3), but
  // the tick must say so: the block names them as pending, never as verified.
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const units = [
    unitDef("p1", { scope: ["backend/api/src/p1"] }),
    unitDef("p2", { scope: ["backend/api/src/p2"] }),
    { id: "fan", title: "fan-in", class: "integration", dependsOn: ["p1", "p2"], scope: [BARREL_FILE], seam: [] },
  ]
  assert.match(await call(tools, "foreman_graph", { units }), /^GRAPH recorded: 3 unit\(s\)/)
  const status = await call(tools, "foreman_status")
  // C3 per fan-in: the parallel workers of a fan-in exist only after its own
  // acceptance step, so before it they are blocked, never ready.
  assert.match(status, /- p1 \[independent\] · blocked \(the fan-in acceptance for unit fan must be written before a parallel worker starts\)/, status)
  assert.match(status, /- p2 \[independent\] · blocked \(the fan-in acceptance for unit fan must be written before a parallel worker starts\)/, status)
  assert.equal(status.includes("verified by step"), false, "a dependency was verified before the fan-in was offered")

  const tick = await call(tools, "foreman_next")
  assert.match(tick, /^ACTION: create_step/)
  assert.ok(tick.includes("UNIT: fan"), tick)
  assert.ok(tick.includes("DEPENDS_ON_UNITS: p1, p2 (pending: p1, p2)"), tick)
  assert.equal(tick.includes("(verified)"), false, tick)
  // Still creatable: that is the C3 rule, and foreman_step accepts the offer.
  const fan = await createOffered(tools, units, tick)
  assert.equal(readStep(repo, fan.n).kind, "integration")

  // Only an all-verified dependency set says verified.
  const done = makeRepo()
  const doneTools = await startLoop(done)
  const doneUnits = [
    unitDef("dep", { scope: ["backend/api/src/dep"] }),
    { id: "gate", title: "gate", class: "integration", dependsOn: ["dep"], scope: [BARREL_FILE], seam: [] },
  ]
  assert.match(await call(doneTools, "foreman_graph", { units: doneUnits }), /^GRAPH recorded: 2 unit\(s\)/)
  seedLoop(done, (state) => {
    state.steps.push({
      n: 1, title: "dep", goal: "land the dependency", acceptance: ["criterion"],
      acceptanceCommands: ["printf dep"], scope: ["backend/api/src/dep"], unitId: "dep",
      status: "verified", planIssue: 701, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
    })
    state.cursor = 1
  })
  const verifiedTick = await call(doneTools, "foreman_next")
  assert.match(verifiedTick, /^ACTION: create_step/)
  assert.ok(verifiedTick.includes("UNIT: gate"), verifiedTick)
  assert.ok(verifiedTick.includes("DEPENDS_ON_UNITS: dep (verified)"), verifiedTick)
  await createOffered(doneTools, doneUnits, verifiedTick)

  // A declared seam is reported honestly too: pending until the check passes,
  // and the fan-in stays creatable (its acceptance comes first).
  const seamRepo = makeRepo()
  const seamTools = await startLoop(seamRepo)
  const seamUnits = [
    unitDef("w", { scope: ["backend/api/src/w"] }),
    { id: "seamfan", title: "seam fan-in", class: "integration", dependsOn: ["w"], scope: [BARREL_FILE], seam: [SEAM_FILE] },
  ]
  assert.match(await call(seamTools, "foreman_graph", { units: seamUnits }), /^GRAPH recorded: 2 unit\(s\)/)
  const seamTick = await call(seamTools, "foreman_next")
  assert.match(seamTick, /^ACTION: create_step/)
  assert.ok(seamTick.includes("UNIT: seamfan"), seamTick)
  assert.ok(seamTick.includes(`SEAM: ${SEAM_FILE} (pending: ${SEAM_FILE} is not on foreman/drill yet)`), seamTick)
  assert.equal(seamTick.includes("verified on"), false, seamTick)
  await createOffered(seamTools, seamUnits, seamTick)

  return "fan-in with p1/p2 blocked by its own ordering gate printed (pending: p1, p2) and was accepted; a verified dependency printed (verified); a declared seam printed pending and never verified on; no emit claimed a check that had not passed"
})

await scenario(FIRST_GRAPH_SCENARIO + 8, "C3: batches open in order and a shared plan issue never opens a step", async () => {
  // Two batches, one fan-in each, on distinct barrels. The acceptance of a
  // batch's fan-in is written before that batch's parallel worker starts, and
  // batches open in graph order: the gate is per fan-in, not "the first
  // integration unit in the graph". Every emitted offer is replayed through
  // foreman_step exactly as printed.
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const SECOND_BARREL = SECOND_BARREL_FILE
  const units = [
    unitDef("ua"),
    unitDef("ub"),
    { id: "i1", title: "fan-in one", class: "integration", dependsOn: ["ua"], scope: [BARREL_FILE], seam: [] },
    { id: "i2", title: "fan-in two", class: "integration", dependsOn: ["ub"], scope: [SECOND_BARREL], seam: [] },
  ]
  assert.match(await call(tools, "foreman_graph", { units }), /^GRAPH recorded: 4 unit\(s\)/)

  const created = []
  const offerAndCreate = async (expected, label) => {
    const tick = await call(tools, "foreman_next")
    assert.equal(offeredUnitId(tick), expected, `${label}: ${tick}`)
    const step = await createOffered(tools, units, tick)
    created.push(step.unitId)
    return step
  }

  // 1. The first batch opens. Both parallel workers are blocked by their own
  //    fan-in, so only i1 (the first fan-in in graph order) is offered.
  const i1 = await offerAndCreate("i1", "first tick")
  assert.equal(readStep(repo, i1.n).kind, "integration")

  // 2. ua runs next: the second fan-in cannot be written while the first
  //    batch's barrel step is open, and ub may not start before i2's
  //    acceptance exists.
  const ua = await offerAndCreate("ua", "after i1")
  assert.equal(ua.unitId, "ua")

  // ua is the only dispatch: the fan-in is a hold until its unit verifies.
  assert.match(await call(tools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${ua.n}\\n`))
  await call(tools, "foreman_result", { step: ua.n, commit: repo.head, command: "printf ua", exitCode: 0, summary: "ua shipped" })
  assert.match(
    await call(tools, "foreman_verify", { step: ua.n, verdict: "good", commands: [{ command: "printf ua", exitCode: 0 }], transcript: "user saw ua" }),
    new RegExp(`^VERIFIED step ${ua.n}\\.`),
  )

  // 3. The fan-in of the first batch is dispatchable. While it is out, ub must
  //    not be offered: its own fan-in i2 has no step yet. The tick says so.
  assert.match(await call(tools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${i1.n}\\n`))
  const gatedTick = await call(tools, "foreman_next")
  assert.match(gatedTick, /^ACTION: wait/, gatedTick)
  assert.equal(gatedTick.includes("UNIT: ub"), false, gatedTick)
  assert.equal(/create_step/.test(gatedTick), false, gatedTick)
  assert.ok(gatedTick.includes("ub blocked (the fan-in acceptance for unit i2 must be written before a parallel worker starts"), gatedTick)
  assert.ok(gatedTick.includes(`i2 blocked (barrel ${SECOND_BARREL} is held by step ${i1.n}; waits for ub)`), gatedTick)

  // 4. The first batch closes: only now is the second fan-in offered, before
  //    its parallel worker.
  await call(tools, "foreman_result", { step: i1.n, commit: repo.head, command: "printf i1", exitCode: 0, summary: "first batch closed" })
  await call(tools, "foreman_verify", { step: i1.n, verdict: "good", commands: [{ command: "printf i1", exitCode: 0 }], transcript: "user saw the first batch close" })
  const i2 = await offerAndCreate("i2", "after i1 verified")
  const ub = await offerAndCreate("ub", "after i2")

  // 5. The second batch runs in the same order: ub, then its fan-in.
  assert.match(await call(tools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${ub.n}\\n`))
  await call(tools, "foreman_result", { step: ub.n, commit: repo.head, command: "printf ub", exitCode: 0, summary: "ub shipped" })
  await call(tools, "foreman_verify", { step: ub.n, verdict: "good", commands: [{ command: "printf ub", exitCode: 0 }], transcript: "user saw ub" })
  assert.match(await call(tools, "foreman_next"), new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${i2.n}\\n`))
  await call(tools, "foreman_result", { step: i2.n, commit: repo.head, command: "printf i2", exitCode: 0, summary: "second batch closed" })
  await call(tools, "foreman_verify", { step: i2.n, verdict: "good", commands: [{ command: "printf i2", exitCode: 0 }], transcript: "user saw the second batch close" })
  assert.deepEqual(created, ["i1", "ua", "i2", "ub"])
  const complete = await call(tools, "foreman_next")
  assert.match(complete, /^ACTION: plan complete/, complete)
  assert.ok(complete.includes("UNITS: 4/4 verified"), complete)

  // Seeded planIssue collision: the dependency unit's step is verified, but
  // its plan issue is also owned by an open step. foreman_step adds that issue
  // to dependsOn and refuses it, so the offer gate must not emit the offer
  // either — for a parallel unit and for an integration unit.
  for (const klass of ["independent", "integration"]) {
    const collisionRepo = makeRepo()
    const collisionTools = await startLoop(collisionRepo)
    const collisionUnits = [
      { id: "dc", title: "dep", class: "independent", dependsOn: [], scope: ["backend/api/src/dc"], seam: [] },
      { id: "tc", title: "target", class: klass, dependsOn: ["dc"], scope: klass === "integration" ? [BARREL_FILE] : ["backend/api/src/tc"], seam: [] },
    ]
    assert.match(await call(collisionTools, "foreman_graph", { units: collisionUnits }), /^GRAPH recorded: 2 unit\(s\)/)
    seedLoop(collisionRepo, (state) => {
      state.steps = [
        {
          n: 1, title: "dc", goal: "land the dependency", acceptance: ["criterion"],
          acceptanceCommands: ["printf dc"], scope: ["backend/api/src/dc"], unitId: "dc",
          status: "verified", planIssue: 777, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          n: 2, title: "collision owner", goal: "own the same plan issue", acceptance: ["criterion"],
          acceptanceCommands: ["printf collision"], scope: ["backend/api/src/collision"],
          status: "open", planIssue: 777, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]
      state.cursor = 2
      state.active = [2]
      state.current = 2
      delete state.nextWakeAt
    })
    const collisionTick = await call(collisionTools, "foreman_next")
    assert.match(collisionTick, /^ACTION: dispatch_worker/, collisionTick)
    assert.equal(collisionTick.includes("UNIT: tc"), false, `${klass}: ${collisionTick}`)
    assert.equal(/create_step/.test(collisionTick), false, `${klass}: ${collisionTick}`)
    assert.match(
      await call(collisionTools, "foreman_status"),
      new RegExp(`- tc \\[${klass}\\] after dc · blocked \\(dependsOn is not satisfied: #777 is open \\(step 2\\)\\)`),
    )
    assert.equal(
      await call(collisionTools, "foreman_step", {
        title: "tc", goal: "start on a collision", acceptance: ["criterion"],
        acceptanceCommands: ["printf tc"], unitId: "tc", scope: collisionUnits[1].scope,
      }),
      "REFUSED: dependsOn is not satisfied: #777 is open (step 2). Only verified steps of this loop may be depended on.",
    )
    assert.equal(readState(collisionRepo).steps.length, 2, `${klass}: a refused step was created`)
    // The collision is the only barrier: once the second owner closes, the unit
    // is offered and the emitted offer is accepted.
    await call(collisionTools, "foreman_result", { step: 2, commit: collisionRepo.head, command: "printf collision", exitCode: 0, summary: "collision owner closed" })
    await call(collisionTools, "foreman_verify", { step: 2, verdict: "good", commands: [{ command: "printf collision", exitCode: 0 }], transcript: "user saw the collision owner close" })
    const afterCollision = await call(collisionTools, "foreman_next")
    assert.equal(offeredUnitId(afterCollision), "tc", `${klass}: ${afterCollision}`)
    await createOffered(collisionTools, collisionUnits, afterCollision)
  }

  // C3 guard: a fan-in whose own dependencies have no step is still creatable,
  // even when an earlier fan-in exists. Only its own batch's worker waits —
  // batches are not serialized at the cost of never writing a second
  // acceptance.
  const freeRepo = makeRepo()
  const freeTools = await startLoop(freeRepo)
  const freeUnits = [
    unitDef("wa"),
    unitDef("wb"),
    { id: "j1", title: "fan-in a", class: "integration", dependsOn: ["wa"], scope: ["backend/api/src/j1"], seam: [] },
    { id: "j2", title: "fan-in b", class: "integration", dependsOn: ["wb"], scope: ["backend/api/src/j2"], seam: [] },
  ]
  assert.match(await call(freeTools, "foreman_graph", { units: freeUnits }), /^GRAPH recorded: 4 unit\(s\)/)
  const j1Tick = await call(freeTools, "foreman_next")
  assert.equal(offeredUnitId(j1Tick), "j1", j1Tick)
  await createOffered(freeTools, freeUnits, j1Tick)
  const j2Tick = await call(freeTools, "foreman_next")
  assert.equal(offeredUnitId(j2Tick), "j2", `a creatable fan-in was withheld: ${j2Tick}`)
  await createOffered(freeTools, freeUnits, j2Tick)
  const afterFanIns = await call(freeTools, "foreman_next")
  assert.equal(offeredUnitId(afterFanIns), "wa", afterFanIns)
  await createOffered(freeTools, freeUnits, afterFanIns)

  return `two batches: i1 ${i1.n}, then ua ${ua.n}, then while i1 was open ub was not offered (NOT_READY named i2), i1 verified -> i2 ${i2.n} -> ub ${ub.n}; plan complete 4/4; a verified dependency whose plan issue is also owned by an open step emitted no offer for independent or integration targets and foreman_step refused both, then the unit was offered once the second owner closed; a second fan-in with no acceptance was still offered while its own dependencies had no step (C3) and every replayed offer was accepted`
})

await scenario(FIRST_GRAPH_SCENARIO + 9, "C3: the fan-in escape is unit-specific, never a sibling's private unit", async () => {
  // The verifier's S4: graph v, w, i1(dep v), i2(dep v, w). i1 and v already
  // have steps, i2 has none. The escape used to unlock w because a stepped
  // fan-in (i1) shared ANY dependency (v) with i2, so w — a unit private to i2
  // and not shared with i1 — started before i2's acceptance existed, and i2 was
  // then blocked behind the very work it must precede. The escape is now
  // evaluated per unit: only a unit an already-stepped fan-in also depends on
  // may pass.
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const SECOND_BARREL = SECOND_BARREL_FILE
  const units = [
    unitDef("v"),
    unitDef("w"),
    { id: "i1", title: "fan-in one", class: "integration", dependsOn: ["v"], scope: [BARREL_FILE], seam: [] },
    { id: "i2", title: "fan-in two", class: "integration", dependsOn: ["v", "w"], scope: [SECOND_BARREL], seam: [] },
  ]
  assert.match(await call(tools, "foreman_graph", { units }), /^GRAPH recorded: 4 unit\(s\)/)
  seedLoop(repo, (state) => {
    state.steps = [
      {
        n: 1, title: "i1", goal: "close the shared batch", acceptance: ["criterion"],
        acceptanceCommands: ["printf i1"], scope: [BARREL_FILE], unitId: "i1", kind: "integration",
        status: "open", planIssue: 9001, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        n: 2, title: "v", goal: "land the shared dependency", acceptance: ["criterion"],
        acceptanceCommands: ["printf v"], scope: ["backend/api/src/v"], unitId: "v",
        status: "open", planIssue: 9002, implIssue: null, fixIssues: [], createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]
    state.cursor = 2
    state.active = [1, 2]
    state.current = 1
    delete state.nextWakeAt
  })

  // 1. w is private to i2 and i2 has no acceptance step: w must not be offered
  //    and foreman_step must refuse it. Only the open dependency v is a worker.
  const breakTick = await call(tools, "foreman_next")
  assert.equal(offeredUnitId(breakTick), undefined, `w was offered before i2's acceptance existed: ${breakTick}`)
  assert.equal(breakTick.includes("UNIT: w"), false, breakTick)
  assert.equal(/create_step/.test(breakTick), false, breakTick)
  assert.match(breakTick, /^ACTION: dispatch_worker\nSTEP: 2\n/, breakTick)
  assert.match(
    await call(tools, "foreman_status"),
    /- w \[independent\] · blocked \(the fan-in acceptance for unit i2 must be written before a parallel worker starts\)/,
  )
  assert.equal(
    await call(tools, "foreman_step", {
      title: "w", goal: "start i2's private unit before its acceptance", acceptance: ["criterion"],
      acceptanceCommands: ["printf w"], unitId: "w", scope: ["backend/api/src/w"],
    }),
    "REFUSED: the fan-in acceptance for unit i2 must be written before a parallel worker starts. Create the integration step (unitId i2) with its acceptanceCommands first, then this one.",
  )
  assert.equal(readState(repo).steps.length, 2, "a refused step was created")

  // 2. Once v and i1 verify, i2 is creatable (integration, pending w), is
  //    offered and accepted; only then is w offered. Both offers are replayed.
  await call(tools, "foreman_result", { step: 2, commit: repo.head, command: "printf v", exitCode: 0, summary: "v shipped" })
  await call(tools, "foreman_verify", { step: 2, verdict: "good", commands: [{ command: "printf v", exitCode: 0 }], transcript: "user saw v" })
  await call(tools, "foreman_result", { step: 1, commit: repo.head, command: "printf i1", exitCode: 0, summary: "first fan-in closed" })
  await call(tools, "foreman_verify", { step: 1, verdict: "good", commands: [{ command: "printf i1", exitCode: 0 }], transcript: "user saw the first fan-in close" })
  const i2Tick = await call(tools, "foreman_next")
  assert.equal(offeredUnitId(i2Tick), "i2", `i2 was not offered after v and i1 verified: ${i2Tick}`)
  const i2 = await createOffered(tools, units, i2Tick)
  const wTick = await call(tools, "foreman_next")
  assert.equal(offeredUnitId(wTick), "w", `w was not offered after i2's acceptance existed: ${wTick}`)
  const w = await createOffered(tools, units, wTick)
  assert.deepEqual([i2.unitId, w.unitId], ["i2", "w"])

  // 3. Closing both units empties the plan: C4 still reports complete.
  await call(tools, "foreman_result", { step: w.n, commit: repo.head, command: "printf w", exitCode: 0, summary: "w shipped" })
  await call(tools, "foreman_verify", { step: w.n, verdict: "good", commands: [{ command: "printf w", exitCode: 0 }], transcript: "user saw w" })
  await call(tools, "foreman_result", { step: i2.n, commit: repo.head, command: "printf i2", exitCode: 0, summary: "second fan-in closed" })
  await call(tools, "foreman_verify", { step: i2.n, verdict: "good", commands: [{ command: "printf i2", exitCode: 0 }], transcript: "user saw the second fan-in close" })
  const complete = await call(tools, "foreman_next")
  assert.match(complete, /^ACTION: plan complete/, complete)
  assert.ok(complete.includes("UNITS: 4/4 verified"), complete)

  // 4. The escape still exists for the unit a stepped fan-in really shares:
  //    with i1 stepped and i2 not, u stays ready (or the shared unit would be
  //    blocked forever) and i1, i2, u are all offered in that order.
  const sharedRepo = makeRepo()
  const sharedTools = await startLoop(sharedRepo)
  const sharedUnits = [
    { id: "u", title: "shared", class: "independent", dependsOn: [], scope: ["backend/api/src/u"], seam: [] },
    { id: "i1", title: "fan-in one", class: "integration", dependsOn: ["u"], scope: ["backend/api/src/fan-one"], seam: [] },
    { id: "i2", title: "fan-in two", class: "integration", dependsOn: ["u"], scope: ["backend/api/src/fan-two"], seam: [] },
  ]
  assert.match(await call(sharedTools, "foreman_graph", { units: sharedUnits }), /^GRAPH recorded: 3 unit\(s\)/)
  const s1 = await createOffered(sharedTools, sharedUnits, await call(sharedTools, "foreman_next"))
  assert.equal(s1.unitId, "i1")
  // i2 has no step yet, but it shares u with the stepped i1: that is exactly
  // the escape, and u must not be reported blocked.
  assert.match(await call(sharedTools, "foreman_status"), /- u \[independent\] · ready · scope backend\/api\/src\/u/)
  const s2 = await createOffered(sharedTools, sharedUnits, await call(sharedTools, "foreman_next"))
  const s3 = await createOffered(sharedTools, sharedUnits, await call(sharedTools, "foreman_next"))
  assert.deepEqual([s1.unitId, s2.unitId, s3.unitId], ["i1", "i2", "u"])

  // 5. Nested fan-in (an integration unit depending on an integration unit) is
  //    allowed by the graph, and this is the honest current behaviour: the only
  //    ordering is the dependency itself. i2 cannot be written before i1
  //    verifies because i1's plan issue is open, and no fan-in-to-fan-in
  //    barrier exists beyond that dependency.
  const nestedRepo = makeRepo()
  const nestedTools = await startLoop(nestedRepo)
  const nestedUnits = [
    unitDef("base"),
    { id: "n1", title: "inner fan-in", class: "integration", dependsOn: ["base"], scope: ["backend/api/src/inner-fan"], seam: [] },
    { id: "n2", title: "outer fan-in", class: "integration", dependsOn: ["n1"], scope: ["backend/api/src/outer-fan"], seam: [] },
  ]
  assert.match(await call(nestedTools, "foreman_graph", { units: nestedUnits }), /^GRAPH recorded: 3 unit\(s\)/)
  const n1 = await createOffered(nestedTools, nestedUnits, await call(nestedTools, "foreman_next"))
  assert.equal(n1.unitId, "n1")
  const baseTick = await call(nestedTools, "foreman_next")
  assert.equal(offeredUnitId(baseTick), "base", `a blocked nested fan-in leaked an offer: ${baseTick}`)
  const baseStep = await createOffered(nestedTools, nestedUnits, baseTick)
  assert.match(
    await call(nestedTools, "foreman_status"),
    new RegExp(`- n2 \\[integration\\] after n1 · blocked \\(dependsOn is not satisfied: #${n1.issue} is open \\(step ${n1.n}\\); waits for n1\\)`),
  )
  await call(nestedTools, "foreman_result", { step: baseStep.n, commit: nestedRepo.head, command: "printf base", exitCode: 0, summary: "base shipped" })
  await call(nestedTools, "foreman_verify", { step: baseStep.n, verdict: "good", commands: [{ command: "printf base", exitCode: 0 }], transcript: "user saw base" })
  const n1Dispatch = await call(nestedTools, "foreman_next")
  assert.match(n1Dispatch, new RegExp(`^ACTION: dispatch_worker\\nSTEP: ${n1.n}\\n`), n1Dispatch)
  assert.equal(n1Dispatch.includes("create_step"), false, n1Dispatch)
  await call(nestedTools, "foreman_result", { step: n1.n, commit: nestedRepo.head, command: "printf n1", exitCode: 0, summary: "inner fan-in closed" })
  await call(nestedTools, "foreman_verify", { step: n1.n, verdict: "good", commands: [{ command: "printf n1", exitCode: 0 }], transcript: "user saw the inner fan-in close" })
  const n2Tick = await call(nestedTools, "foreman_next")
  assert.equal(offeredUnitId(n2Tick), "n2", `the outer fan-in was not offered after n1 verified: ${n2Tick}`)
  await createOffered(nestedTools, nestedUnits, n2Tick)

  return `S4 v/w/i1/i2: with i1 and v stepped and i2 missing, no create_step and no w offer (status: w blocked by i2's fan-in acceptance) and foreman_step refused w verbatim; v and i1 verified -> i2 ${i2.n} offered and accepted, then w ${w.n}; plan complete 4/4; shared unit u stayed ready with i1 stepped and i2 absent and i1/i2/u were all offered and accepted; nested fan-in n2 was blocked by n1's open plan issue and offered only after n1 verified`
})

await scenario(FIRST_GRAPH_SCENARIO + 10, "human channel: steer before dispatch, ack, re-edit, unblock, done", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo)
  const issue = (updatedAt, body = "Fix the flaky auth test before the next unit.", labels = [{ name: "human" }, { name: `loop:${LOOP_ID}` }]) =>
    [{ number: 501, title: "Operator steer", body, labels, updatedAt }]
  const base = "2026-01-01T00:00:00Z"
  process.env.GH_HUMAN_JSON = JSON.stringify(issue(base))
  // The stamp the plugin re-reads: equal to the list stamp, so the ack leaves
  // the issue seen (a newer value would be a human edit during the ack).
  process.env.GH_HUMAN_UPDATED = base

  // 1. Delivery: the steer action wins over create_step and the message body is
  //    handed over as delimited data. A step cannot be created meanwhile.
  const steer = await call(tools, "foreman_next")
  assert.match(steer, /^ACTION: steer\nISSUE: #501\n/, steer)
  assert.match(steer, /<<<HUMAN\nFix the flaky auth test[\s\S]*HUMAN>>>/, steer)
  assert.equal(steer.includes("create_step"), false, steer)
  assert.equal(readState(repo).humanPending.number, 501)
  assert.match(
    await call(tools, "foreman_step", {
      title: "too early", goal: "must wait for the ack", acceptance: ["criterion"],
      acceptanceCommands: ["printf early"], scope: ["backend/api/src/projects/"],
    }),
    /^REFUSED: human message #501 was delivered but not acknowledged/,
  )

  // 2. `applied` comments, keeps the issue open and refreshes the stamp: the
  //    same list is not delivered again.
  const ack = await call(tools, "foreman_steer", { issue: 501, disposition: "applied", note: "Auth test first." })
  assert.match(ack, /^HUMAN #501: applied/)
  const afterAck = fs.readFileSync(ghLog, "utf8")
  assert.match(afterAck, /args=issue comment 501 --body-file /)
  assert.equal(afterAck.includes("issue close 501"), false, "applied closed the issue")
  assert.equal(readState(repo).humanPending, undefined)
  assert.doesNotMatch(await call(tools, "foreman_next"), /^ACTION: steer/m)

  // 3. A blocked loop receives the channel and `unblock` clears the blocker.
  seedLoop(repo, (state) => { state.blocked = "env:auth — the session expired" })
  process.env.GH_HUMAN_JSON = JSON.stringify(issue("2026-01-01T00:02:00Z", "I signed in again, retry."))
  process.env.GH_HUMAN_UPDATED = "2026-01-01T00:02:00Z"
  const blockedSteer = await call(tools, "foreman_next")
  assert.match(blockedSteer, /^ACTION: steer/m, blockedSteer)
  assert.match(blockedSteer, /^STATE: BLOCKED — env:auth/m)
  await call(tools, "foreman_steer", { issue: 501, disposition: "applied", unblock: true })
  assert.equal(readState(repo).blocked, null)

  // 4. `done` comments and closes; the loop is running again.
  process.env.GH_HUMAN_JSON = JSON.stringify(issue("2026-01-01T00:04:00Z", "Thanks, close it."))
  process.env.GH_HUMAN_UPDATED = "2026-01-01T00:04:00Z"
  await call(tools, "foreman_next")
  const done = await call(tools, "foreman_steer", { issue: 501, disposition: "done", note: "Auth test landed in step 1." })
  assert.match(done, /^HUMAN #501: done/)
  assert.match(fs.readFileSync(ghLog, "utf8"), /args=issue close 501 --reason completed/)
  const state = readState(repo)
  assert.equal(state.humanSeen["501"].updatedAt, "2026-01-01T00:04:00Z")
  assert.equal(state.steps.length, 0, "the human channel created a step")
  process.env.GH_HUMAN_JSON = "[]"
  delete process.env.GH_HUMAN_UPDATED
  return `steer #501 preempted create_step with the body delimited, foreman_step refused until the ack; applied commented and kept it open (no re-delivery); a blocked loop received a reply and unblock cleared env:auth; done commented and closed; no step was created by the channel`
})

await scenario(FIRST_GRAPH_SCENARIO + 11, "token hygiene: lazy plan, context pruning, state compaction and live dispatch", async () => {
  const repo = makeRepo()
  const planFile = path.join(repo.dir, "plan.md")
  fs.writeFileSync(planFile, [
    "# Drill plan",
    "",
    "## S1 — Alpha",
    "",
    "MARKER-ALPHA",
    "",
    "## S2 — Beta",
    "",
    "MARKER-BETA",
    "",
  ].join("\n"))
  let contextText = "small"
  const prompts = []
  const compact = []
  const hooks = {}
  const toolHooks = {}
  const instructions = []
  const channel = eventChannel()
  const tools = await startLoop(repo, { channel, prompts, compact, hooks, toolHooks, instructions, contextText: () => contextText })

  // The plan is never attached and is read verbatim by section.
  const prompt = {
    text: "Foreman loop control. Argument: `start @plan.md `\n\n<file name=\"plan.md\">\nMARKER-PLAN-BODY\n</file>",
    files: [{ uri: "file:///plan.md" }],
  }
  hooks.prompt({ prompt })
  assert.deepEqual(prompt.files, [], "the prompt hook did not strip the plan attachment")
  assert.equal(prompt.text.includes("@plan.md"), false, "the prompt hook left the file mention")
  assert.equal(prompt.text.includes("MARKER-PLAN-BODY"), false, "the prompt hook left the inlined plan body")
  const alpha = await call(tools, "foreman_plan", { heading: "## S1 — Alpha" })
  assert.match(alpha, /MARKER-ALPHA/, alpha)
  assert.equal(alpha.includes("MARKER-BETA"), false, "foreman_plan leaked the next section")
  const beta = await call(tools, "foreman_plan", { startLine: 9, endLine: 9 })
  assert.match(beta, /9: MARKER-BETA/, beta)
  assert.equal(instructions.some((item) => item.key === "foreman.plan" && item.value.includes(planFile)), true, "the plan instruction was not pinned")

  // Old history is clipped; the plan pointer and the newest evidence survive.
  const messages = [
    { role: "user", content: [{ type: "text", text: "PLAN POINTER" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foreman_plan", input: { maxChars: 24_000 } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "T".repeat(5_000) }] }] },
    ...Array.from({ length: 17 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `tail ${index}` }] })),
  ]
  hooks.context({ agent: "foreman", sessionID: SESSION_ID, messages })
  assert.equal(messages[0].content[0].text, "PLAN POINTER", "the plan pointer was pruned")
  assert.equal(Array.isArray(messages[2].content), true, "the tool result content array was replaced")
  assert.equal(Array.isArray(messages[2].content[0].content), true, "the nested tool result content array was replaced")
  assert.match(messages[2].content[0].content[0].text, /trimmed/, "the old tool result was not clipped")
  assert.equal(typeof messages[1].content[0].input, "object", "the tool-call input shape changed")
  assert.doesNotThrow(() => JSON.stringify(messages), "pruning made the messages non-serialisable")
  assert.match(messages[messages.length - 1].content[0].text, /^tail 16$/, "the newest tail was clipped")

  // A compaction gets a state summary, never the plan body.
  const compactionEvent = { agent: "foreman", sessionID: SESSION_ID, messages: [] }
  hooks.compaction(compactionEvent)
  assert.match(compactionEvent.result.summary, new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.equal(compactionEvent.result.summary.includes("MARKER-ALPHA"), false, "the compaction summary contains the plan body")

  // The step records the exact plan range for the worker and verifier.
  const { n } = await createStep(tools, {
    title: "alpha", goal: "implement alpha", acceptance: ["criterion"], planRef: "3-6",
    acceptanceCommands: ["printf alpha"], scope: ["backend/api/src/alpha"],
  })
  assert.equal(readStep(repo, n).planRef, "3-6", "foreman_step did not persist planRef")
  assert.match(
    await call(tools, "foreman_step", {
      title: "bad plan range", goal: "must be refused", acceptance: ["criterion"], planRef: "9999-10000",
      acceptanceCommands: ["printf bad"], scope: ["backend/api/src/bad-plan-range"],
    }),
    /^REFUSED: planRef 9999-10000 is outside the plan/,
  )

  // A child session recorded by the tool hook keeps the step in flight even
  // after the lease would have expired; a failed dispatch frees it again.
  const dispatch = await call(tools, "foreman_next")
  assert.match(dispatch, /^ACTION: dispatch_worker/, dispatch)
  await toolHooks["execute.after"]({
    tool: "subagent", sessionID: SESSION_ID, status: "completed",
    input: { description: `Work foreman step ${n} issue #1` },
    result: { metadata: { sessionID: "ses_child_drill" } },
  })
  assert.equal(await waitFor(() => readStep(repo, n).dispatchSessionID === "ses_child_drill"), true, "the subagent session id was not recorded")
  const live = await call(tools, "foreman_next")
  assert.match(live, /^ACTION: wait/, live)
  assert.match(await call(tools, "foreman_dispatch_failed", { step: n, reason: "drill ECONNRESET" }), /^RECORDED:/)
  assert.match(await call(tools, "foreman_next"), /^ACTION: dispatch_worker/)

  // Automatic compaction: one compact call, no nudge turns while pending, and
  // a normal tick after session.compacted.
  contextText = "x".repeat(500_000)
  seedLoop(repo, (state) => { delete state.nextWakeAt })
  channel.push({ type: "session.idle", sessionID: SESSION_ID })
  assert.equal(await waitFor(() => compact.length === 1), true, "the idle tick did not request compaction")
  assert.deepEqual(prompts, [], `compaction queued a model turn: ${prompts.join(" | ")}`)
  channel.push({ type: "session.idle", sessionID: SESSION_ID })
  await sleep(150)
  assert.equal(compact.length, 1, "a second compaction was requested while one was pending")
  contextText = "small"
  channel.push({ type: "session.compaction.ended", sessionID: SESSION_ID })
  assert.equal(await waitFor(() => Boolean(readState(repo).lastCompactedAt)), true, "session.compaction.ended was not recorded")
  assert.equal(await waitFor(() => prompts.some((item) => /^\[foreman\] Tick\./.test(item))), true, "the loop did not resume after compaction")

  return "prompt strips @plan, foreman_plan reads verbatim sections, context pruning keeps the head/tail, compaction uses a state summary without the plan body, planRef persists, and a live dispatch is not duplicated"
})

await scenario(FIRST_GRAPH_SCENARIO + 12, "capacity: maxParallel 0 removes the worker cap", async () => {
  const repo = makeRepo()
  const tools = await startLoop(repo, { maxParallel: 0 })
  for (let index = 1; index <= 4; index += 1) {
    await createStep(tools, {
      title: `unbounded ${index}`, goal: "fill beyond the default cap", acceptance: ["criterion"],
      acceptanceCommands: [`printf unbounded${index}`], scope: [`backend/api/src/unbounded-${index}`],
    })
  }
  const tick = await call(tools, "foreman_next")
  assert.match(tick, /^ACTION: multi/)
  assert.equal((tick.match(/^\d+\. dispatch_worker/gm) ?? []).length, 4, tick)
  assert.ok(tick.includes("CAPACITY: 4/∞"), tick)
  const status = await call(tools, "foreman_status")
  assert.ok(status.includes("capacity: 4/∞ workers"), status)
  await call(tools, "foreman_stop", { reason: "drill resume" })
  const resumed = await call(tools, "foreman_start", { planPath: "plan.md", branch: repo.branch, maxParallel: 0 })
  assert.match(resumed, /^RESUMED foreman loop/)
  assert.equal(readState(repo).maxParallel, 0, "resume did not apply maxParallel 0")
  return "maxParallel 0 dispatched four active steps in one tick, reported capacity as 4/∞, and survived a stop/resume"
})

/* ------------------------- guards and isolation ------------------------- */
const checks = []

function guard(name, fn) {
  try {
    checks.push({ name, detail: fn(), ok: true })
    console.log(`PASS guard ${name}: ${checks[checks.length - 1].detail}`)
  } catch (error) {
    checks.push({ name, detail: String(error?.message ?? error), ok: false })
    console.log(`FAIL guard ${name}: ${checks[checks.length - 1].detail}`)
  }
}

guard("fake gh only", () => {
  const lines = fs.readFileSync(ghLog, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  assert.ok(lines.length > 0, "no gh call was captured")
  assert.ok(lines.every((line) => line.startsWith("SHIM ")), "a gh call bypassed the shim")
  const resolved = execFileSync("/bin/sh", ["-c", "command -v gh"], { env: process.env, encoding: "utf8" }).trim()
  assert.equal(resolved, shimPath, `gh resolves to ${resolved}, not the shim`)
  assert.ok(lines.some((line) => /args=repo view/.test(line)), "loop registration did not call gh repo view")
  assert.ok(lines.some((line) => /args=issue create/.test(line)), "no issue was created through the shim")
  return `${lines.length} calls captured, gh -> ${shimPath}, no network`
})

guard("source checkout unchanged", () => {
  const statusAfter = gitSource(["status", "--porcelain"])
  const headAfter = gitSource(["rev-parse", "HEAD"])
  assert.equal(headAfter, sourceHeadBefore, "the drill moved HEAD in the source checkout")
  assert.equal(statusAfter, sourceStatusBefore, "the drill modified the source working tree")
  const dirty = statusAfter.split("\n").filter(Boolean).length
  return `HEAD ${sourceHeadBefore.slice(0, 7)}, ${dirty} pre-existing dirty entries unchanged`
})

/* -------------------------------- report -------------------------------- */

const scenarios = Object.keys(evidence).length
const failed = failures.length + checks.filter((check) => !check.ok).length
if (failed) {
  console.log("")
  for (const failure of failures) {
    console.log(`DRILL FAILED: scenario ${failure.n} (${failure.name}) — ${evidence[failure.n]}`)
    if (failure.error?.stack) console.log(failure.error.stack)
  }
  for (const check of checks.filter((item) => !item.ok)) console.log(`DRILL FAILED: guard ${check.name} — ${check.detail}`)
  process.exit(1)
}
console.log("")
console.log(`OK ${scenarios}/${SCENARIO_TOTAL} scenarios PASS, ${checks.length}/${checks.length} guards PASS (temp repo ${tmp})`)
process.exit(0)
