#!/usr/bin/env node
/**
 * Scale suite: the foreman loop as a wide parallel team.
 *
 * guards-smoke proves the C7/C8 dispatch rules on three units. This suite raises
 * the pressure to a scale factory and pins the behaviour a large plan depends
 * on:
 *   - an uncapped worker budget (`maxParallel: 0`) with a wide graph: the
 *     per-tick create_step flood guard still offers at most maxCreatePerTick
 *     (default 6) units, but once the units are taken every open worker is
 *     dispatched in the same tick, up to the whole team;
 *   - the ramp knob `maxCreatePerTick`: the default ramps a wide plan 6 units a
 *     turn, while a raised value exposes the whole team in one offer batch;
 *     `foreman_start` persists it per loop like maxParallel/maxVerify;
 *   - a wide fan-in team (12 workers) offered, dispatched and released as one;
 *   - the fan-in team flow end to end: the integration acceptance is created
 *     before its parallel workers, the fan-in stays a hold until every unit it
 *     fans in is verified, then it is dispatched, then the plan is complete;
 *   - disjoint-scope filtering at scale: overlapping units are deferred to the
 *     next tick instead of sharing a worker batch;
 *   - the verifier slot cap on a large implemented backlog;
 *   - the concurrency metric `foreman_status` reports (peak workers and minutes
 *     spent at two or more) is computed from the dispatch ledger, so a running
 *     factory can prove how much of its wall-clock really overlapped.
 *
 * Run from the repo root: node scripts/foreman/tests/parallel-scale.mjs
 * Nothing touches GitHub: PATH is prefixed with a fake gh that only logs.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const WIDE = 20
const CREATE_PER_TICK = 6

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-scale-"))
const shimDir = path.join(tmp, "bin")
fs.mkdirSync(shimDir, { recursive: true })
const ghLog = path.join(tmp, "gh.log")
const ghCounter = path.join(tmp, "gh.counter")

fs.writeFileSync(path.join(shimDir, "gh"), [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'N=$(cat "$GH_COUNTER" 2>/dev/null || echo 0)',
  "N=$((N + 1))",
  'printf \'%s\' "$N" > "$GH_COUNTER"',
  'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "fake/repo"; exit 0; fi',
  'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
  '  echo "https://github.com/fake/repo/issues/$N"',
  "fi",
  "exit 0",
  "",
].join("\n"), { mode: 0o755 })

process.env.GH_LOG = ghLog
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

function makeRepo({ branch = "foreman/scale" } = {}) {
  const dir = path.join(tmp, `repo-${++fixture}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", branch)
  git(dir, "config", "user.email", "scale@example.com")
  git(dir, "config", "user.name", "Scale")
  fs.writeFileSync(path.join(dir, "README.md"), "# scale\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  return { dir, branch }
}

function writeState(repo, patch) {
  fs.mkdirSync(path.join(repo.dir, ".foreman", "steps"), { recursive: true })
  fs.mkdirSync(path.join(repo.dir, ".foreman", "tmp"), { recursive: true })
  const state = {
    startedAt: new Date().toISOString(),
    planPath: path.join(repo.dir, "plan.md"),
    branch: repo.branch,
    repo: "fake/repo",
    model: "scale",
    maxParallel: 3,
    maxSteps: 2000,
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
const readLedger = (repo) => fs.existsSync(path.join(repo.dir, ".foreman/ledger.jsonl"))
  ? fs.readFileSync(path.join(repo.dir, ".foreman/ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : []
const writeLedger = (repo, entries) => {
  fs.writeFileSync(path.join(repo.dir, ".foreman/ledger.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
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

const call = async (tools, name, input, context) => {
  const result = await tools[name].execute(input, context)
  return String(result?.content ?? "")
}

const unitDef = (id, extra = {}) => ({
  id,
  title: `unit ${id}`,
  dependsOn: [],
  scope: [`backend/api/src/${id}`],
  seam: [],
  class: "independent",
  ...extra,
})

function stateStep(overrides = {}) {
  return {
    n: 1,
    title: "existing",
    goal: "an existing step",
    acceptance: ["criterion"],
    acceptanceCommands: ["true"],
    unitId: null,
    kind: null,
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

const stepInput = (unit) => ({
  unitId: unit.id,
  title: `implement ${unit.id}`,
  goal: `implement ${unit.id} at scale`,
  acceptance: ["criterion"],
  acceptanceCommands: ["true"],
  scope: unit.scope,
})

// The worker/verifier action lines the tick emits, in order.
const actionLines = (message) => message.split("\n").filter((line) => /^\d+\. /.test(line))
const createLines = (message) => message.split("\n").filter((line) => /^\d+\. create_step — unit /.test(line))
const dispatchLines = (message, kind) => actionLines(message).filter((line) => line.includes(`${kind} — step`))

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

await scenario("scale: an uncapped loop ramps 6 units per tick, then dispatches the whole team in one tick", async () => {
  const repo = makeRepo()
  const units = Array.from({ length: WIDE }, (_, index) => unitDef(`u${index + 1}`))
  writeState(repo, { maxParallel: 0, units, steps: [], cursor: 0, active: [] })
  const tools = await loadTools(repo.dir)

  // The create_step flood guard is independent of the worker budget: one tick
  // never offers more than maxCreatePerTick (default 6) units, even at maxParallel 0.
  const ramp = await call(tools, "foreman_next")
  assert.ok(ramp.includes("CAPACITY: 0/∞"), ramp)
  const offers = createLines(ramp)
  assert.equal(offers.length, CREATE_PER_TICK, `expected ${CREATE_PER_TICK} offers, got ${offers.length}`)
  assert.deepEqual(
    ramp.split("\n").filter((line) => /NEXT_STEP: /.test(line)).map((line) => line.trim()),
    Array.from({ length: CREATE_PER_TICK }, (_, index) => `NEXT_STEP: ${index + 1}`),
  )

  for (const unit of units) {
    const created = await call(tools, "foreman_step", stepInput(unit))
    assert.match(created, /^STEP \d+ created/)
  }
  const state = readState(repo)
  assert.equal(state.steps.length, WIDE, "not every unit became a step")
  assert.equal(state.cursor, WIDE)
  assert.equal(new Set(state.steps.map((step) => step.unitId)).size, WIDE, "a unit was taken twice")

  // Every open step is dispatched in the same tick: the whole team launches
  // together instead of one worker per tick.
  const mass = await call(tools, "foreman_next")
  assert.ok(mass.includes(`CAPACITY: ${WIDE}/∞`), mass)
  assert.equal(createLines(mass).length, 0, "every unit is taken, nothing new to create")
  const workers = dispatchLines(mass, "dispatch_worker")
  assert.equal(workers.length, WIDE, `expected ${WIDE} workers in one tick, got ${workers.length}`)
  assert.equal(new Set(workers).size, WIDE, "a worker was dispatched twice")
  const dispatchRecords = readLedger(repo).filter((entry) => entry.type === "dispatch")
  assert.equal(dispatchRecords.length, WIDE, "the dispatch ledger does not record the whole team")
  assert.equal(dispatchRecords.every((entry) => entry.action === "dispatch_worker"), true)

  // The team is now in flight: the next tick starts nothing until a result or
  // the lease expires.
  const next = await call(tools, "foreman_next")
  assert.match(next, /^ACTION: wait/, next)
})

await scenario("scale: the fan-in team flow runs offer → parallel workers → hold → dispatch → plan complete", async () => {
  const repo = makeRepo()
  const workers = ["w1", "w2", "w3", "w4"].map((id) => unitDef(id))
  const fan = unitDef("fan", { class: "integration", scope: ["shared/contracts/src/index.ts"], dependsOn: ["w1", "w2", "w3", "w4"] })
  writeState(repo, { maxParallel: 0, units: [...workers, fan], steps: [], cursor: 0, active: [] })
  const tools = await loadTools(repo.dir)

  // C3: while the fan-in acceptance is unwritten its parallel workers are held,
  // so the first tick offers the integration unit alone in the single-action
  // form (an integration offer gets the fan-in ORDER note).
  const first = await call(tools, "foreman_next")
  assert.match(first, /^ACTION: create_step/, first)
  assert.ok(first.includes("UNIT: fan"), first)
  assert.ok(first.includes("UNIT_CLASS: integration"), first)
  assert.ok(first.includes("ORDER: the fan-in acceptance is written before the parallel workers start"), first)
  assert.equal(createLines(first).length, 0, "a lone offer is the single-action form, not a numbered batch")

  const fanStep = await call(tools, "foreman_step", stepInput(fan))
  assert.match(fanStep, /^STEP 1 created/)

  // With the fan-in acceptance now written, the workers it fans in unblock in
  // one offer batch, in plan order.
  const second = await call(tools, "foreman_next")
  assert.deepEqual(createLines(second), [
    "1. create_step — unit w1 (independent)",
    "2. create_step — unit w2 (independent)",
    "3. create_step — unit w3 (independent)",
    "4. create_step — unit w4 (independent)",
  ])
  for (const unit of workers) assert.match(await call(tools, "foreman_step", stepInput(unit)), /^STEP \d+ created/)

  // The four workers launch together; the fan-in is a hold, so it is not
  // dispatched and does not take a worker slot.
  const fanOut = await call(tools, "foreman_next")
  assert.equal(dispatchLines(fanOut, "dispatch_worker").length, 4, fanOut)
  assert.equal(/dispatch_worker — step 1,/.test(fanOut), false, "the fan-in was dispatched before its units were verified")

  // Once every fanned-in unit is verified the fan-in is released and dispatched.
  const wSteps = workers.map((unit, index) => stateStep({ n: index + 2, unitId: unit.id, status: "verified", planIssue: 40 + index }))
  writeState(repo, {
    maxParallel: 0,
    units: [...workers, fan],
    steps: [stateStep({ n: 1, unitId: "fan", status: "open", planIssue: 30 }), ...wSteps],
    cursor: 5,
    active: [1],
  })
  const released = await call(tools, "foreman_next")
  assert.ok(released.includes("ACTION: dispatch_worker"), released)
  assert.ok(released.includes("STEP: 1"), released)
  assert.ok(released.includes("ISSUE: 30"), released)

  // Every unit verified and the pipeline empty: the plan is complete.
  writeState(repo, {
    maxParallel: 0,
    units: [...workers, fan],
    steps: [stateStep({ n: 1, unitId: "fan", status: "verified", planIssue: 30 }), ...wSteps],
    cursor: 5,
    active: [],
  })
  const complete = await call(tools, "foreman_next")
  assert.match(complete, /^ACTION: plan complete/, complete)
  assert.ok(complete.includes("UNITS: 5/5 verified"), complete)
})

await scenario("scale: overlapping units are deferred to the next tick instead of sharing a batch", async () => {
  const repo = makeRepo()
  const disjoint = ["a", "b", "c", "d"].map((id) => unitDef(id))
  // Four units that all collide with unit a (and one another).
  const overlapped = ["e", "f", "g", "h"].map((id) => unitDef(id, { scope: ["backend/api/src/a"] }))
  writeState(repo, { maxParallel: 0, units: [...disjoint, ...overlapped], steps: [], cursor: 0, active: [] })
  const tools = await loadTools(repo.dir)
  const next = await call(tools, "foreman_next")
  assert.deepEqual(createLines(next), [
    "1. create_step — unit a (independent)",
    "2. create_step — unit b (independent)",
    "3. create_step — unit c (independent)",
    "4. create_step — unit d (independent)",
  ])
})

await scenario("scale: a large implemented backlog is trimmed to the verifier slot cap", async () => {
  const repo = makeRepo()
  const steps = Array.from({ length: 6 }, (_, index) =>
    stateStep({ n: index + 1, status: "implemented", planIssue: 50 + index, scope: [`backend/api/src/v${index + 1}`] }))
  writeState(repo, { maxParallel: 0, maxVerify: 2, units: [], steps, cursor: 6, active: [1, 2, 3, 4, 5, 6] })
  const tools = await loadTools(repo.dir)
  const next = await call(tools, "foreman_next")
  assert.ok(next.includes("VERIFY: 6/2"), next)
  const verifiers = dispatchLines(next, "dispatch_verifier")
  assert.equal(verifiers.length, 2, `expected 2 verifiers, got ${verifiers.length}`)
  assert.deepEqual(verifiers, [
    "1. dispatch_verifier — step 1, issue #50",
    "2. dispatch_verifier — step 2, issue #51",
  ])
})

await scenario("scale: maxParallel 0 is uncapped, not zero workers", async () => {
  const repo = makeRepo()
  writeState(repo, {
    maxParallel: 0,
    units: [unitDef("solo")],
    steps: [stateStep({ n: 1, unitId: "solo", status: "open", planIssue: 31, scope: ["backend/api/src/solo"] })],
    cursor: 1,
    active: [1],
  })
  const tools = await loadTools(repo.dir)
  const next = await call(tools, "foreman_next")
  assert.ok(next.includes("ACTION: dispatch_worker"), next)
  assert.ok(next.includes("STEP: 1"), next)
  assert.ok(next.includes("ISSUE: 31"), next)
  assert.ok(next.includes("CAPACITY: 1/∞"), next)
})

await scenario("scale: foreman_status reports the true peak concurrency and overlap of the team", async () => {
  const repo = makeRepo()
  const minute = 60_000
  const t0 = Date.now() - 40 * minute
  const iso = (offsetMin) => new Date(t0 + offsetMin * minute).toISOString()
  const steps = [1, 2, 3].map((n) => stateStep({ n, status: "open", planIssue: 60 + n, scope: [`backend/api/src/s${n}`] }))
  writeState(repo, { maxParallel: 0, startedAt: iso(0), units: [], steps, cursor: 3, active: [1, 2, 3] })
  // Three workers overlap from minute 2 to minute 10; steps 1 and 2 stay open
  // until 10/12, so the team spends 11 minutes at two or more in flight.
  writeLedger(repo, [
    { type: "dispatch", action: "dispatch_worker", step: 1, at: iso(0) },
    { type: "dispatch", action: "dispatch_worker", step: 2, at: iso(1) },
    { type: "dispatch", action: "dispatch_worker", step: 3, at: iso(2) },
    { type: "result", step: 1, at: iso(10) },
    { type: "result", step: 2, at: iso(12) },
    { type: "result", step: 3, at: iso(20) },
  ])
  const tools = await loadTools(repo.dir)
  const status = await call(tools, "foreman_status")
  assert.ok(status.includes("parallelism: peak 3 worker(s)"), status)
  assert.ok(status.includes("11.0 min with 2+"), status)
  assert.ok(status.includes("(3 run(s))"), status)
})

await scenario("scale: the create_step ramp is maxCreatePerTick, and a capped loop is bounded by the worker budget", async () => {
  // Uncapped, default knob: a 15-unit graph ramps 6 units a turn, in three turns.
  {
    const repo = makeRepo()
    const units = Array.from({ length: 15 }, (_, index) => unitDef(`u${index + 1}`))
    writeState(repo, { maxParallel: 0, units, steps: [], cursor: 0, active: [] })
    const tools = await loadTools(repo.dir)
    const perTick = []
    for (let guard = 0; guard < 12 && readState(repo).steps.length < units.length; guard += 1) {
      const tick = await call(tools, "foreman_next")
      const offers = createLines(tick)
      assert.ok(offers.length <= CREATE_PER_TICK, `the default ramp exceeded ${CREATE_PER_TICK}: ${offers.length}`)
      perTick.push(offers.length)
      for (const unit of units) {
        const taken = readState(repo).steps.some((step) => step.unitId === unit.id)
        if (taken || !offers.some((line) => line.includes(`unit ${unit.id} (`))) continue
        assert.match(await call(tools, "foreman_step", stepInput(unit)), /^STEP \d+ created/)
      }
    }
    assert.deepEqual(perTick, [6, 6, 3], `a 15-unit ramp was ${perTick.join(",")}`)
    assert.equal(readState(repo).steps.length, 15)
  }
  // Raised knob: the whole 15-unit graph is offered in a single tick.
  {
    const repo = makeRepo()
    const units = Array.from({ length: 15 }, (_, index) => unitDef(`u${index + 1}`))
    writeState(repo, { maxParallel: 0, maxCreatePerTick: 25, units, steps: [], cursor: 0, active: [] })
    const tools = await loadTools(repo.dir)
    const tick = await call(tools, "foreman_next")
    assert.equal(createLines(tick).length, 15, tick)
    assert.ok(tick.split("\n").some((line) => /NEXT_STEP: 15/.test(line)), tick)
  }
  // A capped loop is bounded by the free worker budget, not the per-tick knob:
  // raising maxCreatePerTick past maxParallel creates no extra workers.
  {
    const repo = makeRepo()
    const units = Array.from({ length: 15 }, (_, index) => unitDef(`u${index + 1}`))
    writeState(repo, { maxParallel: 4, maxCreatePerTick: 25, units, steps: [], cursor: 0, active: [] })
    const tools = await loadTools(repo.dir)
    const tick = await call(tools, "foreman_next")
    assert.equal(createLines(tick).length, 4, tick)
    for (const unit of units.slice(0, 4)) assert.match(await call(tools, "foreman_step", stepInput(unit)), /^STEP \d+ created/)
    const after = await call(tools, "foreman_next")
    assert.ok(after.includes("CAPACITY: 4/4"), after)
    assert.equal(createLines(after).length, 0, "the worker budget, not maxCreatePerTick, bounds a capped loop")
  }
})

await scenario("scale: a wide 12-worker fan-in team dispatches together and releases only after every worker verifies", async () => {
  const repo = makeRepo()
  const workers = Array.from({ length: 12 }, (_, index) => unitDef(`w${index + 1}`))
  const fan = unitDef("fan", { class: "integration", scope: ["shared/contracts/src/index.ts"], dependsOn: workers.map((unit) => unit.id) })
  writeState(repo, { maxParallel: 0, maxCreatePerTick: 12, units: [...workers, fan], steps: [], cursor: 0, active: [] })
  const tools = await loadTools(repo.dir)

  // C3: the fan-in acceptance is written first, so this tick offers it alone.
  const first = await call(tools, "foreman_next")
  assert.match(first, /^ACTION: create_step/, first)
  assert.ok(first.includes("UNIT: fan"), first)
  assert.match(await call(tools, "foreman_step", stepInput(fan)), /^STEP 1 created/)

  // With its acceptance written, all twelve workers are offered in one tick.
  const second = await call(tools, "foreman_next")
  assert.equal(createLines(second).length, 12, second)
  for (const unit of workers) assert.match(await call(tools, "foreman_step", stepInput(unit)), /^STEP \d+ created/)

  // The twelve launch together; the fan-in is still a hold.
  const fanOut = await call(tools, "foreman_next")
  assert.equal(dispatchLines(fanOut, "dispatch_worker").length, 12, fanOut)
  assert.equal(/dispatch_worker — step 1,/.test(fanOut), false, "the fan-in was dispatched before its units were verified")

  // Every worker verified: the fan-in is released and the plan completes.
  const wSteps = workers.map((unit, index) => stateStep({ n: index + 2, unitId: unit.id, status: "verified", planIssue: 100 + index }))
  writeState(repo, {
    maxParallel: 0,
    maxCreatePerTick: 12,
    units: [...workers, fan],
    steps: [stateStep({ n: 1, unitId: "fan", status: "open", planIssue: 30 }), ...wSteps],
    cursor: 13,
    active: [1],
  })
  const released = await call(tools, "foreman_next")
  assert.ok(released.includes("ACTION: dispatch_worker"), released)
  assert.ok(released.includes("STEP: 1"), released)
  assert.ok(released.includes("ISSUE: 30"), released)

  writeState(repo, {
    maxParallel: 0,
    maxCreatePerTick: 12,
    units: [...workers, fan],
    steps: [stateStep({ n: 1, unitId: "fan", status: "verified", planIssue: 30 }), ...wSteps],
    cursor: 13,
    active: [],
  })
  const complete = await call(tools, "foreman_next")
  assert.match(complete, /^ACTION: plan complete/, complete)
  assert.ok(complete.includes("UNITS: 13/13 verified"), complete)
})

await scenario("scale: foreman_start persists maxCreatePerTick per loop, on start and resume", async () => {
  const repo = makeRepo()
  fs.mkdirSync(path.join(repo.dir, "plans"), { recursive: true })
  fs.writeFileSync(path.join(repo.dir, "plans", "Scale.md"), "# Scale plan\n")
  git(repo.dir, "add", "-A")
  git(repo.dir, "commit", "-q", "-m", "plan")
  const tools = await loadTools(repo.dir)
  const ctx = { sessionID: "ses_scale" }
  const stateFile = path.join(repo.dir, ".foreman", "active", "Scale", "state.json")

  const started = await call(tools, "foreman_start", { planPath: "plans/Scale.md", maxParallel: 0, maxVerify: 2, maxCreatePerTick: 25 }, ctx)
  assert.match(started, /STARTED foreman loop Scale/, started)
  assert.ok(started.includes("maxCreatePerTick: 25"), started)
  assert.equal(readJson(stateFile).maxCreatePerTick, 25)

  await call(tools, "foreman_stop", { reason: "scale test" }, ctx)
  assert.ok(fs.existsSync(path.join(repo.dir, ".foreman", "active", "Scale", "STOP")), "the loop STOP file was not written")
  const resumed = await call(tools, "foreman_start", { planPath: "plans/Scale.md", maxCreatePerTick: 9 }, ctx)
  assert.match(resumed, /RESUMED foreman loop Scale/, resumed)
  assert.ok(resumed.includes("maxCreatePerTick: 9"), resumed)
  assert.equal(readJson(stateFile).maxCreatePerTick, 9)
})

/* -------------------------------- report -------------------------------- */

console.log("")
if (failures.length) {
  console.log(`FAILED ${failures.length}/${passed + failures.length} scenarios (fixtures in ${tmp})`)
  for (const failure of failures) console.log(`\n--- ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
console.log(`PASSED ${passed}/${passed} scenarios (fixtures in ${tmp})`)
