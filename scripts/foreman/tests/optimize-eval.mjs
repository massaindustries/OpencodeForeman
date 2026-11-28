#!/usr/bin/env node
/**
 * Foreman RSI optimization eval — tokens and time per task, three cycles.
 *
 * One fixed task, one fixed pathology: a single step whose worker subagent is
 * dispatched and then vanishes without producing a result. That is exactly what
 * live loop LOOPRES_PLAN showed (see .foreman/active/LOOPRES_PLAN/ledger.jsonl):
 * step 7 was offered 147 times in 21 minutes with zero results.
 *
 * The harness is driven through three cycles on the *same bundle*, each cycle a
 * different optimization, and the eval reports tokens and time per task. The
 * expectation is logarithmic, not linear, improvement; a cycle that does not
 * beat the previous one is reported as STERILE.
 *
 *   cycle 0  baseline       no stall backoff, no fruitless cap
 *   cycle 1  backoff        a dead dispatch parks the step and backs off 2^n
 *   cycle 2  backoff + cap  after the cap the loop blocks and asks for a human
 *                           instead of paying for another turn
 *
 * "tokens/task" = the bytes the harness emits to the model each tick (tool
 * return + queued prompt) plus the modeled model context: the agent and tool
 * schemas ride every request, and the skill is re-read once vs every tick.
 * "time/task" = the model turns (one launch/dispatch is one turn) and the
 * harness CPU actually spent.
 *
 * Run from the repo root: node scripts/foreman/tests/optimize-eval.mjs
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-opt-eval-"))

// The fixed task: 21 minutes of wall clock, one tick every 8s (the live incident
// averaged ~6s between fruitless offers).
const TICK_MS = 8_000
const HORIZON_MS = 21 * 60_000

// --- virtual clock: Date.now() and new Date() stay coherent -----------------
const RealDate = Date
let clockMs = RealDate.now()
class VirtualDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(clockMs); else super(...args) }
  static now() { return clockMs }
}
globalThis.Date = VirtualDate
const advance = (ms) => { clockMs += ms }

// --- fake gh: no network, no auth ------------------------------------------
const shimDir = path.join(tmp, "bin")
fs.mkdirSync(shimDir, { recursive: true })
fs.writeFileSync(path.join(shimDir, "gh"), [
  "#!/bin/sh",
  'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "fake/repo"; exit 0; fi',
  'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then echo "https://github.com/fake/repo/issues/1"; exit 0; fi',
  "exit 0",
  "",
].join("\n"), { mode: 0o755 })
process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`

const bundle = path.join(tmp, "plugin.mjs")
await build({
  entryPoints: [path.join(repoRoot, "scripts/foreman/plugin.ts")],
  bundle: true, platform: "node", format: "esm", outfile: bundle,
  alias: { "@opencode/plugin": path.join(here, "plugin-stub.ts") },
  logLevel: "silent",
})

// --- fixture helpers --------------------------------------------------------
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"))
  git(dir, "init", "-q", "-b", "foreman/Stall")
  git(dir, "config", "user.email", "eval@example.com")
  git(dir, "config", "user.name", "Eval")
  fs.writeFileSync(path.join(dir, "README.md"), "# eval\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  return dir
}

const unitDef = (id) => ({ id, title: `unit ${id}`, dependsOn: [], scope: [`backend/api/src/${id}`], seam: [], class: "independent" })

function stateStep(overrides = {}) {
  return {
    n: 1, title: "stall", goal: "a step whose dispatch keeps dying",
    acceptance: ["criterion"], acceptanceCommands: ["true"], unitId: "u1", kind: null,
    scope: ["backend/api/src/u1"], dependsOn: [], status: "open", planIssue: 30,
    implIssue: null, fixIssues: [], createdAt: new Date().toISOString(), ...overrides,
  }
}

function writeState(dir, patch) {
  fs.mkdirSync(path.join(dir, ".foreman", "steps", "1"), { recursive: true })
  const state = {
    startedAt: new Date().toISOString(),
    planPath: path.join(dir, "plans", "Stall.md"),
    branch: "foreman/Stall", repo: "fake/repo", model: "eval",
    maxParallel: 1, maxSteps: 2000, maxMinutes: null, cursor: 1, current: 1, blocked: null,
    ...patch,
  }
  fs.writeFileSync(path.join(dir, ".foreman", "state.json"), `${JSON.stringify(state, null, 2)}\n`)
  return state
}
const readState = (dir) => readJson(path.join(dir, ".foreman", "state.json"))
const readLedger = (dir) => fs.existsSync(path.join(dir, ".foreman", "ledger.jsonl"))
  ? fs.readFileSync(path.join(dir, ".foreman", "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : []

// `plugin` is the module instance of the cycle currently running.
let plugin = null

async function loadTools(root, options = {}) {
  const tools = {}
  const promptBytes = { total: 0 }
  const ctx = {
    location: { directory: root },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: {
      // Every child is gone the moment it is looked up: the vanishing worker.
      get: async () => undefined,
      prompt: async (input) => { promptBytes.total += String(input?.text ?? "").length },
      context: async () => "", compact: async () => {},
      ...(options.session ?? {}),
    },
    permission: { list: async () => [] },
    event: { subscribe: async function* () {} },
  }
  await plugin.setup(ctx)
  return { tools, promptBytes }
}

const call = async (tools, name, input, context) => String((await tools[name].execute(input, context))?.content ?? "")

// --- static model context: agent + tool schemas every request, skill once/per-tick
const staticBytes = (() => {
  const read = (rel) => { try { return fs.statSync(path.join(repoRoot, rel)).size } catch { return 0 } }
  return {
    agent: read(".opencode/agents/foreman.md"),
    skill: read(".opencode/skills/always-awake-agent/SKILL.md"),
  }
})()
const schemaBytes = (tools) => Object.values(tools).reduce((sum, tool) =>
  sum + String(tool?.description ?? "").length + JSON.stringify(tool?.input ?? {}).length, 0)

// --- one cycle --------------------------------------------------------------
async function runCycle({ label, backoffMs, fruitlessCap, skillPolicy }) {
  process.env.FOREMAN_DISPATCH_BACKOFF_MS = String(backoffMs)
  process.env.FOREMAN_DISPATCH_MAX_FRUITLESS = String(fruitlessCap)
  // A fresh module instance re-reads the env at import and keeps its own tools.
  plugin = (await import(`${pathToFileURL(bundle).href}?c=${encodeURIComponent(label)}`)).default

  const dir = makeRepo()
  fs.mkdirSync(path.join(dir, "plans"), { recursive: true })
  fs.writeFileSync(path.join(dir, "plans", "Stall.md"), "# Stall plan\n\n## U1 stall unit\n")
  writeState(dir, {
    units: [unitDef("u1")],
    steps: [stateStep({ status: "open" })],
  })

  const { tools, promptBytes } = await loadTools(dir, { session: {} })
  const metrics = { label, ticks: 0, skipped: 0, dispatches: 0, emitted: 0, blocked: false, complete: false }
  metrics.schemaBytes = schemaBytes(tools)

  const started = Date.now()
  let elapsed = 0
  let deadCounter = 0
  while (elapsed < HORIZON_MS) {
    const state = readState(dir)
    if (state?.blocked) { metrics.blocked = true; break }
    const wake = Date.parse(String(state?.nextWakeAt ?? ""))
    if (Number.isFinite(wake) && wake > Date.now()) { metrics.skipped += 1; advance(TICK_MS); elapsed += TICK_MS; continue }

    const before = promptBytes.total
    const out = await call(tools, "foreman_next")
    metrics.ticks += 1
    metrics.emitted += out.length + (promptBytes.total - before)

    if (/^ACTION: blocked/.test(out)) { metrics.blocked = true; break }
    if (/^ACTION: plan complete/.test(out)) { metrics.complete = true; break }

    const launches = (out.match(/dispatch_worker/g) ?? []).length
    if (launches) {
      metrics.dispatches += launches
      // The foreman launched the worker; the child then vanished. Mirror a
      // recorded-then-died dispatch so the sweep retires it as "gone".
      const next = readState(dir)
      for (const step of next.steps ?? []) {
        if (step.status !== "open" && step.status !== "fixing") continue
        step.dispatchSessionID = `ses_dead_${++deadCounter}`
        delete step.dispatchedAt
      }
      fs.writeFileSync(path.join(dir, ".foreman", "state.json"), `${JSON.stringify(next, null, 2)}\n`)
    }
    advance(TICK_MS)
    elapsed += TICK_MS
  }
  metrics.harnessMs = Date.now() - started

  const perRequest = staticBytes.agent + metrics.schemaBytes
  const skillEveryTick = skillPolicy === "per-tick" ? staticBytes.skill * metrics.ticks : staticBytes.skill
  metrics.contextBytes = perRequest * metrics.ticks + skillEveryTick
  metrics.tokensPerTask = Math.round((metrics.emitted + metrics.contextBytes) / 4)
  return { metrics, dir }
}

// --- cycles -----------------------------------------------------------------
const CYCLES = [
  { label: "0 baseline", backoffMs: 0, fruitlessCap: 1_000_000, skillPolicy: "per-tick" },
  { label: "1 backoff", backoffMs: 30_000, fruitlessCap: 1_000_000, skillPolicy: "per-tick" },
  { label: "2 backoff+cap", backoffMs: 30_000, fruitlessCap: 4, skillPolicy: "once" },
]

console.log(`optimize-eval: one fixed stalling-worker task, ${HORIZON_MS / 60_000} min horizon, tick ${TICK_MS}ms`)
console.log(`static context: agent ${staticBytes.agent}B + skill ${staticBytes.skill}B + tool schemas (per cycle)\n`)

const rows = []
for (const cycle of CYCLES) {
  const { metrics } = await runCycle(cycle)
  rows.push(metrics)
  console.log(
    `${metrics.label.padEnd(14)} ticks=${String(metrics.ticks).padStart(3)} skipped=${String(metrics.skipped).padStart(3)} ` +
    `dispatches=${String(metrics.dispatches).padStart(3)} emitted=${String(metrics.emitted).padStart(7)}B ` +
    `context=${String(metrics.contextBytes).padStart(8)}B tokens/task=${String(metrics.tokensPerTask).padStart(7)} ` +
    (metrics.blocked ? "BLOCKED" : metrics.complete ? "COMPLETE" : "horizon"),
  )
}

console.log("\n--- trend (log) ---")
let sterile = []
for (let i = 1; i < rows.length; i += 1) {
  const prev = rows[i - 1]
  const cur = rows[i]
  const tokRatio = cur.tokensPerTask ? prev.tokensPerTask / cur.tokensPerTask : 1
  const dispRatio = cur.dispatches ? prev.dispatches / Math.max(1, cur.dispatches) : prev.dispatches
  const improving = cur.tokensPerTask < prev.tokensPerTask && cur.dispatches <= prev.dispatches
  if (!improving) sterile.push(cur.label)
  console.log(
    `${prev.label} -> ${cur.label}: tokens x${tokRatio.toFixed(1)} better, dispatch turns x${dispRatio.toFixed(1)} better` +
    `  ${improving ? "improved" : "STERILE"}`,
  )
}

const summary = {
  task: "one step whose worker dispatch always dies without a result",
  horizonMs: HORIZON_MS,
  cycles: rows.map((row) => ({
    label: row.label, ticks: row.ticks, skipped: row.skipped, dispatches: row.dispatches,
    emittedBytes: row.emitted, contextBytes: row.contextBytes, tokensPerTask: row.tokensPerTask,
    blocked: row.blocked, harnessMs: row.harnessMs,
  })),
  sterile,
}
fs.writeFileSync(path.join(tmp, "optimize-eval.json"), `${JSON.stringify(summary, null, 2)}\n`)
console.log(`\nsterile cycles: ${sterile.length ? sterile.join(", ") : "none"}`)
console.log(`report: ${path.join(tmp, "optimize-eval.json")}`)

// The eval only earns its name if the trend is non-sterile and logarithmic.
assert.ok(rows[1].dispatches < rows[0].dispatches / 5, `backoff did not cut dispatch turns by 5x (${rows[0].dispatches} -> ${rows[1].dispatches})`)
assert.ok(rows[2].tokensPerTask < rows[1].tokensPerTask, "the fruitless cap did not lower tokens/task")
assert.equal(sterile.length, 0, `sterile cycle(s): ${sterile.join(", ")}`)
console.log("\nOK optimize-eval: every cycle improved on the same task")
