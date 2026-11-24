#!/usr/bin/env node
/**
 * Concurrency proof for phase B of plans/ForemanHarness.md: every write tool
 * runs inside one critical section (in-process promise chain + .foreman/lock),
 * so capacity, the cursor and the ledger cannot interleave.
 *
 * It bundles the REAL plugin with only `@opencode/plugin` stubbed, and drives
 * concurrent tool calls with Promise.all on throwaway git repositories. Every
 * GitHub call goes through scripts/foreman/fake-bin/gh: no network, no live
 * loop, no touch of the source checkout.
 *
 * In-process probes (each repeated REPEATS times on a fresh repo):
 *   A. Promise.all(two foreman_step) at maxParallel 3 -> both persisted with
 *      distinct n and issues, two `step` ledger records, no orphan issue.
 *   B. the same race at maxParallel 1 -> exactly one STEP and one capacity
 *      refusal, one persisted step, one created issue.
 *   C. Promise.all(two foreman_result) -> both recorded; every recorded step
 *      is implemented with result.json, no state is lost.
 *   D. foreman_verify racing foreman_next -> no lost update: the step is
 *      verified, leaves active, and the dispatch foreman_next wrote survives.
 *
 * Cross-process lock probes (a second process drives the same repo, window
 * FOREMAN_LOCK_STALE_MS = 2s):
 *   E. heartbeat: a critical section held for 3x the window (fake gh sleeps
 *      inside foreman_step) keeps the lock fresh, so the second process is
 *      REFUSED with nothing changed: 1 step, 1 step ledger record, 1 step
 *      issue, no orphan.
 *   F. foreman_verify runs its acceptance commands with no lock held (a 3s
 *      command > the 2s window): the second process creates step 2 during it
 *      and verify's re-loaded state keeps it (no stale save, no orphan).
 *   G. steal rules: a dead recorded pid is stolen (crash recovery), a live
 *      reused pid is never stolen (refused, lock intact), and an owner-less
 *      stale lock (killed before owner.json) falls back to age and is stolen.
 *   H. the lock is removed mid-call: the holder still saves its step and its
 *      release does not recreate or delete the path.
 *   I. two loops hold their own locks simultaneously, both create their step.
 *   J. verify verdicts under the lock refactor: a red acceptance refuses with
 *      no verdict and both runs recorded, a green one verifies.
 *
 * Run from the repo root:
 *   node scripts/foreman/concurrency-probe.mjs
 * Exit 0 only when every repetition of every probe passes.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPEATS = 6
const BRANCH = "foreman/probe"
const PLUGIN_REL = path.join("scripts", "foreman", "plugin.ts")
// The lock window is env-configurable so the probes can prove the stale rules
// in seconds instead of minutes. Every store in this run uses it.
const STALE_MS = 2_000
process.env.FOREMAN_LOCK_STALE_MS = String(STALE_MS)

function locateRepoRoot(start) {
  let current = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(current, PLUGIN_REL)) && fs.existsSync(path.join(current, "package.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`cannot locate the repo root from ${start}`)
    current = parent
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = locateRepoRoot(here)
// FOREMAN_PROBE_PLUGIN points the probe at another copy of the plugin, so a
// pre-fix file can be run to prove the probe really goes red.
const pluginEntry = process.env.FOREMAN_PROBE_PLUGIN
  ? path.resolve(process.env.FOREMAN_PROBE_PLUGIN)
  : path.join(sourceRoot, PLUGIN_REL)
const shimDir = path.join(here, "fake-bin")
if (!fs.existsSync(path.join(shimDir, "gh"))) throw new Error(`fake gh missing in ${shimDir}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-concurrency-"))
const ghLog = path.join(tmp, "gh.log")
const ghCounter = path.join(tmp, "gh.counter")
process.env.GH_LOG = ghLog
process.env.GH_COUNTER = ghCounter
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

const gitSource = (args) => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" }).trimEnd()
const sourceStatusBefore = gitSource(["status", "--porcelain"])
const sourceHeadBefore = gitSource(["rev-parse", "HEAD"])

/* ------------------------------ fixtures -------------------------------- */

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let fixture = 0
function makeRepo() {
  const dir = path.join(tmp, `repo-${++fixture}`)
  // Probes run one after the other: start each fixture with an empty capture so
  // the issue count belongs to this repo only.
  fs.writeFileSync(ghLog, "")
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "probe@example.com")
  git(dir, "config", "user.name", "Foreman Probe")
  fs.writeFileSync(path.join(dir, "plan.md"), "# Probe plan\n\nThrowaway plan for the concurrency probe.\n")
  fs.writeFileSync(path.join(dir, ".gitignore"), ".foreman/\n")
  fs.mkdirSync(path.join(dir, "backend/api/src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "backend/api/src/index.ts"), "export const x = 0\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  // The loop branch exists but the main checkout stays on main: the plugin
  // creates and uses its own worktree on the loop branch.
  git(dir, "branch", BRANCH)
  return { dir, branch: BRANCH }
}

const LOOP_DIR = path.join(".foreman", "active", "plan")
const loopDir = (repo) => path.join(repo.dir, LOOP_DIR)
const loopCheckout = (repo) => path.join(loopDir(repo), "worktree")
const stateFile = (repo) => path.join(loopDir(repo), "state.json")
const readState = (repo) => readJson(stateFile(repo))

// A commit that is not an ancestor of the loop branch, so foreman_result has to
// cherry-pick it and HEAD really moves.
function makeSideCommit(repo) {
  git(repo.dir, "checkout", "-q", "-b", "probe-side")
  fs.writeFileSync(path.join(repo.dir, "backend/api/src/side.ts"), "export const side = 1\n")
  git(repo.dir, "add", "-A")
  git(repo.dir, "commit", "-q", "-m", "side work")
  const sha = git(repo.dir, "rev-parse", "HEAD")
  git(repo.dir, "checkout", "-q", "main")
  return sha
}
const readStep = (repo, n, name = "step.json") => readJson(path.join(loopDir(repo), "steps", String(n), name))
const readLedger = (repo) => fs.readFileSync(path.join(loopDir(repo), "ledger.jsonl"), "utf8")
  .split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
const ghCalls = () => fs.readFileSync(ghLog, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
const lockDir = (repo) => path.join(loopDir(repo), "lock")
const ownerPath = (repo) => path.join(lockDir(repo), "owner.json")
const staleTrash = (repo) => fs.readdirSync(loopDir(repo))
  .filter((name) => name.startsWith("lock.stale-"))
const createdStepIssues = (messages) => messages
  .map((message) => message.match(/^STEP (\d+) created: #(\d+) /))
  .filter(Boolean)
  .map((match) => ({ n: Number(match[1]), issue: Number(match[2]) }))

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(50)
  }
}

// A pid that is guaranteed dead: a child that already exited.
const deadPid = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true })
  child.on("error", reject)
  child.on("close", () => {
    const pid = child.pid
    try { process.kill(pid, 0); reject(new Error(`pid ${pid} is still alive`)) } catch { resolve(pid) }
  })
})

// Plant a lock as a crashed loop would leave it: owner.json plus an old mtime.
function plantLock(repo, { pid, ageMs, nonce = "planted", withOwner = true }) {
  const dir = lockDir(repo)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  if (withOwner) {
    writeJson(path.join(dir, "owner.json"), {
      pid,
      host: os.hostname(),
      nonce,
      at: new Date(Date.now() - ageMs).toISOString(),
    })
  }
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, when, when)
}

/* ---------------------------- load the plugin --------------------------- */

const stubFile = path.join(tmp, "plugin-stub.ts")
fs.writeFileSync(stubFile, [
  "export const Plugin = { define: (config: unknown) => config }",
  "export default { Plugin }",
  "",
].join("\n"))

async function bundlePlugin() {
  const outfile = path.join(tmp, "plugin.bundle.mjs")
  try {
    const esbuild = await import("esbuild")
    await esbuild.build({
      entryPoints: [pluginEntry], bundle: true, platform: "node", format: "esm", outfile,
      alias: { "@opencode/plugin": stubFile }, logLevel: "silent",
    })
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
    execFileSync("npx", [
      "--no-install", "esbuild", pluginEntry, "--bundle", "--platform=node", "--format=esm",
      `--alias:@opencode/plugin=${stubFile}`, `--outfile=${outfile}`, "--log-level=silent",
    ], { cwd: sourceRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  }
  return outfile
}

const bundlePath = await bundlePlugin()
const plugin = (await import(pathToFileURL(bundlePath).href)).default

function contextFor(root, tools) {
  return {
    location: { directory: root },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: {
      prompt: async () => {},
      get: async () => ({ agent: { id: "foreman" }, time: { idle: true } }),
      context: async () => "",
      compact: async () => {},
    },
    permission: { list: async () => [] },
    event: { subscribe: async function* () {} },
  }
}

async function loadTools(root) {
  const tools = {}
  await plugin.setup(contextFor(root, tools))
  return tools
}

// A second process driving the same checkout: this is the only way to contend
// on the .foreman/lock directory, because in-process calls queue on `serialise`.
const childScript = path.join(tmp, "tool-child.mjs")
fs.writeFileSync(childScript, [
  'import { pathToFileURL } from "node:url"',
  "",
  "const [bundle, root, name, inputJson] = process.argv.slice(2)",
  "const mod = await import(pathToFileURL(bundle).href)",
  "const tools = {}",
  "const ctx = {",
  "  location: { directory: root },",
  '  tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },',
  '  session: { prompt: async () => {}, get: async () => ({ agent: { id: "foreman" }, time: { idle: true } }), context: async () => "", compact: async () => {} },',
  "  permission: { list: async () => [] },",
  "  event: { subscribe: async function* () {} },",
  "}",
  "await mod.default.setup(ctx)",
  "const result = await tools[name].execute(JSON.parse(inputJson), { sessionID: \"ses_probe\" })",
  'process.stdout.write(String(result?.content ?? ""))',
  "",
].join("\n"))

// Returns the child plus a promise of { code, stdout, stderr }; the caller
// decides whether to await it now or after doing something else.
function runTool(repo, name, input = {}) {
  const child = spawn(process.execPath, [childScript, bundlePath, repo.dir, name, JSON.stringify(input)], {
    cwd: repo.dir, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += String(chunk) })
  child.stderr.on("data", (chunk) => { stderr += String(chunk) })
  const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })))
  return { child, done }
}

const call = async (tools, name, input = {}) => {
  assert.ok(tools[name], `tool ${name} is not registered`)
  return String((await tools[name].execute(input, { sessionID: "ses_probe" }))?.content ?? "")
}

async function startLoop(repo, maxParallel) {
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_start", { planPath: "plan.md", branch: repo.branch, ...(maxParallel ? { maxParallel } : {}) })
  assert.match(message, /^STARTED foreman loop \S+\./, message)
  return tools
}

const stepInput = (index, extra = {}) => ({
  title: `conc ${index}`,
  goal: "prove the write path is atomic",
  acceptance: ["nothing interleaves"],
  acceptanceCommands: [`printf c${index}`],
  scope: [`backend/api/src/conc-${index}`],
  ...extra,
})

/* ----------------------------- in-process probes ------------------------ */

const STEP_RE = /^STEP (\d+) created: #(\d+) /

async function probeCapacity(maxParallel) {
  const repo = makeRepo()
  const tools = await startLoop(repo, maxParallel)
  const messages = await Promise.all([
    call(tools, "foreman_step", stepInput(1)),
    call(tools, "foreman_step", stepInput(2)),
  ])
  const state = readState(repo)
  const ledger = readLedger(repo).filter((entry) => entry.type === "step")
  const createdIssues = ghCalls().filter((line) => /args=issue create --title (?:\[[^\]]+\] )?Step \d+:/.test(line))
  const created = createdStepIssues(messages)

  if (maxParallel === 3) {
    assert.equal(created.length, 2, `expected two created steps, got:\n${messages.join("\n")}`)
    assert.notEqual(created[0].n, created[1].n, "two steps share a step number")
    assert.notEqual(created[0].issue, created[1].issue, "two steps share an issue")
    assert.equal(state.steps.length, 2, `state kept ${state.steps.length} step(s)`)
    assert.equal(state.cursor, 2)
    assert.deepEqual([...state.active].sort(), [1, 2])
    assert.deepEqual(ledger.map((entry) => entry.step).sort(), [1, 2], "step ledger records lost")
    for (const step of state.steps) {
      const stored = readStep(repo, step.n)
      assert.equal(stored.status, "open", `step ${step.n} not persisted as open`)
      assert.equal(stored.planIssue, step.planIssue)
    }
    // No orphan: the issues created by the two calls are exactly the persisted ones.
    assert.equal(createdIssues.length, 2, `${createdIssues.length} issue(s) created for 2 steps`)
    assert.deepEqual(
      created.map((item) => item.issue).sort((a, b) => a - b),
      state.steps.map((step) => step.planIssue).sort((a, b) => a - b),
      "an issue was created without a persisted step",
    )
    return `2 steps n=${created.map((item) => item.n).join(",")}, issues #${created.map((item) => item.issue).join(" #")}, 2 step records, no orphan`
  }

  const refusals = messages.filter((message) => message.startsWith("REFUSED: capacity reached (1/1)."))
  assert.equal(created.length, 1, `expected exactly one created step, got:\n${messages.join("\n")}`)
  assert.equal(refusals.length, 1, `expected exactly one capacity refusal, got:\n${messages.join("\n")}`)
  assert.equal(state.steps.length, 1)
  assert.equal(readLedger(repo).filter((entry) => entry.type === "step").length, 1)
  assert.equal(createdIssues.length, 1, "the refused call created an issue")
  return `1 step n=${created[0].n} issue #${created[0].issue}, 1 refusal (1/1), 1 step record, 1 issue`
}

async function probeResults() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  for (const index of [1, 2]) {
    assert.match(await call(tools, "foreman_step", stepInput(index)), STEP_RE)
  }
  const messages = await Promise.all([
    call(tools, "foreman_result", { step: 1, commit: git(repo.dir, "rev-parse", "HEAD"), command: "printf c1", exitCode: 0, summary: "first" }),
    call(tools, "foreman_result", { step: 2, commit: git(repo.dir, "rev-parse", "HEAD"), command: "printf c2", exitCode: 0, summary: "second" }),
  ])
  const recorded = messages.filter((message) => message.startsWith("RESULT recorded"))
  const refused = messages.filter((message) => message.startsWith("REFUSED: another tool call is writing the loop state"))
  assert.equal(recorded.length + refused.length, 2, `unexpected results:\n${messages.join("\n")}`)
  const state = readState(repo)
  const ledgerResults = readLedger(repo).filter((entry) => entry.type === "result")
  assert.equal(ledgerResults.length, recorded.length, `${ledgerResults.length} result record(s) for ${recorded.length} success(es)`)
  for (const message of refused) assert.match(message, /nothing was changed/)
  // No lost state: exactly the recorded steps are implemented, the rest are
  // untouched, and every implemented step has a result.json on disk.
  for (const step of state.steps) {
    const stored = readStep(repo, step.n)
    assert.equal(stored.status, step.status, `state/step.json disagree on step ${step.n}`)
    if (step.status === "implemented") {
      assert.match(String(messageFor(messages, step.n)), /^RESULT recorded/)
      assert.equal(readStep(repo, step.n, "result.json").attempt, 1)
    } else {
      assert.equal(step.status, "open")
      assert.equal(fs.existsSync(path.join(loopDir(repo), "steps", String(step.n), "result.json")), false)
    }
  }
  assert.equal(recorded.length, 2, `expected both results recorded, got:\n${messages.join("\n")}`)
  return `2 results recorded (attempt 1 each), 2 result records, state and step.json agree`
}

function messageFor(messages, n) {
  return messages.find((message) => new RegExp(`\\bstep ${n}\\b`).test(message)) ?? ""
}

async function probeVerifyNext() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  assert.match(await call(tools, "foreman_step", stepInput(1)), STEP_RE)
  assert.match(await call(tools, "foreman_result", {
    step: 1, commit: git(repo.dir, "rev-parse", "HEAD"), command: "printf c1", exitCode: 0, summary: "shipped",
  }), /^RESULT recorded/)
  assert.match(await call(tools, "foreman_step", stepInput(2)), STEP_RE)
  assert.deepEqual([...readState(repo).active].sort(), [1, 2])

  const [verified, next] = await Promise.all([
    call(tools, "foreman_verify", {
      step: 1, verdict: "good", commands: [{ command: "printf ok", exitCode: 0 }], transcript: "user saw it",
    }),
    call(tools, "foreman_next"),
  ])
  assert.match(verified, /^VERIFIED step 1\./, verified)
  assert.match(next, /^ACTION: (multi|dispatch_worker)/, next)

  const state = readState(repo)
  const one = state.steps.find((step) => step.n === 1)
  const two = state.steps.find((step) => step.n === 2)
  assert.equal(one.status, "verified", "the verify save was lost")
  assert.equal(readStep(repo, 1).status, "verified")
  assert.deepEqual(state.active, [2], `active is ${JSON.stringify(state.active)}, step 1 did not leave`)
  // The dispatch foreman_next wrote must survive verify's save, whichever ran first.
  assert.ok(two.dispatchedAt, "foreman_next's dispatch marker was clobbered")
  assert.equal(readStep(repo, 2).dispatchedAt, two.dispatchedAt, "state/step.json disagree on the dispatch")
  assert.ok(readLedger(repo).some((entry) => entry.type === "verified" && entry.step === 1))
  return `step 1 verified, active [2], dispatch of step 2 kept (${String(two.dispatchedAt).slice(11, 19)}), ledger verified`
}

/* --------------------------- cross-process probes ----------------------- */

// E. A live long critical section is never stolen: the heartbeat refreshes the
// lock, so a second process is refused instead of stealing and orphaning.
async function probeHeartbeatRefusal() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  const holdMs = 3 * STALE_MS
  process.env.GH_SLEEP_MS = String(holdMs)
  const holding = call(tools, "foreman_step", stepInput(1))
  try {
    await waitFor(() => fs.existsSync(ownerPath(repo)), "the lock owner.json")
    const owner = readJson(ownerPath(repo))
    assert.equal(owner.pid, process.pid, "the lock is not owned by this process")
    assert.equal(owner.host, os.hostname())
    assert.ok(owner.nonce, "the lock carries no nonce")
    // 2.25 windows: without the heartbeat the lock would already look crashed.
    await sleep(Math.floor(STALE_MS * 2.25))
    const ageMs = Date.now() - fs.statSync(lockDir(repo)).mtimeMs
    assert.ok(ageMs < STALE_MS, `lock mtime is ${ageMs}ms old, the heartbeat did not refresh it`)
    // A second process contends while the first is still inside the section.
    const contender = runTool(repo, "foreman_step", stepInput(2))
    const refused = await contender.done
    assert.equal(refused.code, 0, `child exited ${refused.code}: ${refused.stderr}`)
    assert.match(refused.stdout, /^REFUSED: another tool call is writing the loop state; nothing was changed\./, refused.stdout)
    const message = await holding
    assert.match(message, /^STEP 1 created/, message)
    // The refused call changed nothing and orphaned nothing.
    const state = readState(repo)
    const created = createdStepIssues([message])
    assert.equal(created.length, 1, message)
    assert.equal(state.steps.length, 1)
    assert.equal(state.cursor, 1)
    assert.equal(readLedger(repo).filter((entry) => entry.type === "step").length, 1)
    const issues = ghCalls().filter((line) => /args=issue create --title (?:\[[^\]]+\] )?Step \d+:/.test(line))
    assert.equal(issues.length, 1, `${issues.length} step issues for 1 step`)
    assert.equal(state.steps[0].planIssue, created[0].issue)
    assert.deepEqual(staleTrash(repo), [], "a stolen lock left its stale copy behind")
    assert.equal(fs.existsSync(lockDir(repo)), false, "the lock was not released")
    return `held ${holdMs}ms over a ${STALE_MS}ms window (mtime age ${ageMs}ms), second process REFUSED: 1 step, 1 record, 1 issue, no orphan`
  } finally {
    delete process.env.GH_SLEEP_MS
    await holding.catch(() => {})
  }
}

// F. Acceptance commands run with no lock held, and verify applies its verdict
// to a re-loaded state, so a step created during the run survives.
let acceptanceMarker = 0
async function probeVerifyLockFree() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  const marker = path.join(tmp, `acceptance-${++acceptanceMarker}`)
  const acceptance = `printf started >> ${marker} && sleep 3`
  assert.match(await call(tools, "foreman_step", stepInput(1, { acceptanceCommands: [acceptance] })), STEP_RE)
  assert.match(await call(tools, "foreman_result", {
    step: 1, commit: git(repo.dir, "rev-parse", "HEAD"), command: "printf c1", exitCode: 0, summary: "shipped",
  }), /^RESULT recorded/)

  const verifying = call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf ok", exitCode: 0 }], transcript: "user saw it",
  })
  await waitFor(() => fs.existsSync(marker), "the acceptance command to start")
  assert.equal(fs.existsSync(lockDir(repo)), false, "the lock is held while the acceptance command runs")
  // 3s of acceptance against a 2s window: the old code held the lock here and a
  // second process either waited or stole it, then verify clobbered its step.
  const contender = runTool(repo, "foreman_step", stepInput(2))
  const created = await contender.done
  assert.equal(created.code, 0, `child exited ${created.code}: ${created.stderr}`)
  assert.match(created.stdout, /^STEP 2 created: #\d+/, created.stdout)
  const verified = await verifying
  assert.match(verified, /^VERIFIED step 1\./, verified)

  const state = readState(repo)
  assert.equal(state.steps.length, 2, "verify saved a stale snapshot and dropped the concurrent step")
  assert.equal(state.steps.find((step) => step.n === 1).status, "verified")
  assert.equal(state.steps.find((step) => step.n === 2).status, "open")
  assert.deepEqual(state.active, [2])
  assert.equal(readLedger(repo).filter((entry) => entry.type === "step").length, 2, "one step ledger record per created step")
  const issues = ghCalls().filter((line) => /args=issue create --title (?:\[[^\]]+\] )?Step \d+:/.test(line))
  assert.equal(issues.length, 2, `${issues.length} step issues for 2 steps`)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.verdict, "good")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0])
  assert.ok(verify.acceptanceRuns[0].durationMs >= 3_000, `acceptance took ${verify.acceptanceRuns[0].durationMs}ms`)
  assert.equal(readStep(repo, 1).status, "verified")
  assert.equal(fs.existsSync(lockDir(repo)), false, "the lock was not released")
  return `acceptance ran ${verify.acceptanceRuns[0].durationMs}ms with no lock; a second process created step 2 and verify kept it: 2 steps, 2 issues, no orphan`
}

// K. The acceptance commands run with no lock held, so a concurrent
// foreman_result can cherry-pick onto the checkout while they run. The branch
// name stays the same, so only the resolved commit can detect it: the plugin
// re-prepares and re-runs the acceptance once on the new HEAD instead of
// spending a refused tick, and the verdict then lands on the commit it proved.
async function probeHeadMoved() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  const marker = path.join(tmp, `moved-${++acceptanceMarker}`)
  // The acceptance does not sleep for a guessable time: it waits for the
  // concurrent pick to land, so the HEAD move is always inside the first run.
  const gate = path.join(tmp, `moved-gate-${acceptanceMarker}`)
  const acceptance = `printf 'started\\n' >> ${marker}; while [ ! -f ${gate} ]; do sleep 0.05; done`
  assert.match(await call(tools, "foreman_step", stepInput(1, { acceptanceCommands: [acceptance] })), STEP_RE)
  assert.match(await call(tools, "foreman_step", stepInput(2)), STEP_RE)
  const startSha = git(loopCheckout(repo), "rev-parse", "HEAD")
  assert.match(await call(tools, "foreman_result", {
    step: 1, commit: startSha, command: "printf c1", exitCode: 0, summary: "shipped",
  }), /^RESULT recorded/)
  const sideSha = makeSideCommit(repo)
  assert.equal(git(loopCheckout(repo), "rev-parse", "HEAD"), startSha, "the side commit moved the loop branch")

  const verifying = call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf ok", exitCode: 0 }], transcript: "user saw it",
  })
  await waitFor(() => fs.existsSync(marker), "the acceptance command to start")
  const moved = runTool(repo, "foreman_result", {
    step: 2, commit: sideSha, command: "printf c2", exitCode: 0, summary: "parallel work",
  })
  const picked = await moved.done
  assert.equal(picked.code, 0, `child exited ${picked.code}: ${picked.stderr}`)
  assert.match(picked.stdout, /^RESULT recorded/, picked.stdout)
  const movedSha = git(loopCheckout(repo), "rev-parse", "HEAD")
  assert.notEqual(movedSha, startSha, "the concurrent foreman_result did not move HEAD")
  assert.equal(git(loopCheckout(repo), "rev-parse", "--abbrev-ref", "HEAD"), repo.branch, "the branch name changed, not the commit")
  fs.writeFileSync(gate, "go")

  const short = (sha) => sha.slice(0, 8)
  const verdict = await verifying
  assert.match(verdict, /^VERIFIED step 1\./, verdict)

  const state = readState(repo)
  const one = state.steps.find((step) => step.n === 1)
  assert.equal(one.status, "verified", "the re-run verdict did not land")
  assert.equal(state.steps.find((step) => step.n === 2).status, "implemented")
  // The acceptance ran twice: once on the stale HEAD, once on the moved one.
  const starts = (fs.readFileSync(marker, "utf8").match(/started/g) ?? []).length
  assert.equal(starts, 2, `the acceptance ran ${starts} time(s), expected one automatic re-run`)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.verdict, "good")
  assert.equal(verify.acceptanceRuns.length, 1, "the recorded runs must be the ones that proved the landed commit")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0])
  assert.equal(verify.headSha, movedSha, "the verdict recorded a different commit than the one it proved")
  const verifiedRecords = readLedger(repo).filter((entry) => entry.type === "verified")
  assert.equal(verifiedRecords.length, 1, "the re-run wrote more than one verified record")
  assert.equal(verifiedRecords[0].step, 1)
  assert.equal(fs.existsSync(lockDir(repo)), false, "the lock was not released")
  return `acceptance started at ${short(startSha)}, step 2 picked inside the first run moved HEAD to ${short(movedSha)} on the same branch, the plugin re-ran it once and recorded good on ${short(movedSha)}`
}

// L. Negative control for K: with no concurrent pick the same 3s acceptance
// verifies, so the HEAD check cannot pass by always refusing.
async function probeHeadStable() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  const marker = path.join(tmp, `stable-${++acceptanceMarker}`)
  const acceptance = `printf started >> ${marker} && sleep 3`
  assert.match(await call(tools, "foreman_step", stepInput(1, { acceptanceCommands: [acceptance] })), STEP_RE)
  const headSha = git(loopCheckout(repo), "rev-parse", "HEAD")
  assert.match(await call(tools, "foreman_result", {
    step: 1, commit: headSha, command: "printf c1", exitCode: 0, summary: "shipped",
  }), /^RESULT recorded/)

  const verdict = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf ok", exitCode: 0 }], transcript: "user saw it",
  })
  assert.match(verdict, /^VERIFIED step 1\./, verdict)
  assert.equal(git(loopCheckout(repo), "rev-parse", "HEAD"), headSha, "a verification without a pick moved HEAD")
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.verdict, "good")
  assert.equal(verify.headSha, headSha, "verify.json does not record the commit the acceptance ran on")
  assert.equal(readStep(repo, 1).status, "verified")
  assert.ok(readLedger(repo).some((entry) => entry.type === "verified" && entry.step === 1))
  assert.equal(fs.existsSync(lockDir(repo)), false, "the lock was not released")
  return `3s acceptance on a stable HEAD ${headSha.slice(0, 8)} VERIFIED step 1 and recorded headSha`
}

// G. Only a provably dead owner is stolen; a live reused pid blocks the steal;
// an owner-less stale directory (killed before owner.json) falls back to age.
async function probeStealRules() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)

  const pid = await deadPid()
  plantLock(repo, { pid, ageMs: STALE_MS * 3, nonce: "crashed" })
  const recovered = await call(tools, "foreman_step", stepInput(1))
  assert.match(recovered, /^STEP 1 created/, recovered)
  assert.equal(fs.existsSync(lockDir(repo)), false, "the recovered lock was not released")
  assert.deepEqual(staleTrash(repo), [], "the stolen stale directory was not cleaned up")

  // A live pid (a reused pid of an unrelated process) must never be stolen.
  plantLock(repo, { pid: process.pid, ageMs: STALE_MS * 3, nonce: "reused" })
  const before = readState(repo)
  const ghBefore = ghCalls().length
  const refused = await call(tools, "foreman_step", stepInput(2))
  assert.match(refused, /^REFUSED: another tool call is writing the loop state; nothing was changed\./, refused)
  const after = readState(repo)
  assert.equal(after.steps.length, before.steps.length, "a live lock was stolen and a step was created")
  assert.equal(after.cursor, before.cursor, "a live lock was stolen and the cursor moved")
  assert.equal(readLedger(repo).filter((entry) => entry.type === "step").length, 1)
  assert.equal(ghCalls().length, ghBefore, "a refused call reached gh")
  assert.equal(readJson(ownerPath(repo)).nonce, "reused", "the live holder's lock was rewritten")

  // Killed between mkdir and owner.json: no pid to probe, so age decides.
  plantLock(repo, { pid: 0, ageMs: STALE_MS * 3, withOwner: false })
  const recoveredAgain = await call(tools, "foreman_step", stepInput(2))
  assert.match(recoveredAgain, /^STEP 2 created/, recoveredAgain)
  assert.equal(readState(repo).steps.length, 2)
  return `dead pid ${pid} stolen and cleaned, live reused pid refused with the lock intact, owner-less stale lock recovered`
}

// H. A lock removed mid-call must not break the holder's save or recreate the
// directory, and the next call must acquire a fresh lock.
async function probeLockRemoved() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  process.env.GH_SLEEP_MS = "1500"
  const holding = call(tools, "foreman_step", stepInput(1))
  try {
    await waitFor(() => fs.existsSync(ownerPath(repo)), "the lock owner.json")
    fs.rmSync(lockDir(repo), { recursive: true, force: true })
    const message = await holding
    assert.match(message, /^STEP 1 created/, message)
  } finally {
    delete process.env.GH_SLEEP_MS
    await holding.catch(() => {})
  }
  assert.equal(readState(repo).steps.length, 1)
  assert.equal(fs.existsSync(lockDir(repo)), false, "the release re-created the removed lock")
  const next = await call(tools, "foreman_step", stepInput(2))
  assert.match(next, /^STEP 2 created/, next)
  assert.equal(readState(repo).steps.length, 2)
  assert.equal(fs.existsSync(lockDir(repo)), false)
  return "a lock removed mid-call did not break the save, and the following step acquired a fresh lock"
}

// I. The lock is per checkout: two loops write at the same time.
async function probePerLoopLocks() {
  const one = makeRepo()
  const two = makeRepo()
  const oneTools = await startLoop(one, 3)
  const twoTools = await startLoop(two, 3)
  process.env.GH_SLEEP_MS = "1500"
  let first
  let second
  try {
    [first, second] = await Promise.all([
      call(oneTools, "foreman_step", stepInput(1)),
      call(twoTools, "foreman_step", stepInput(1)),
    ])
  } finally {
    delete process.env.GH_SLEEP_MS
  }
  assert.match(first, /^STEP 1 created/, first)
  assert.match(second, /^STEP 1 created/, second)
  assert.equal(readState(one).steps.length, 1)
  assert.equal(readState(two).steps.length, 1)
  assert.equal(fs.existsSync(lockDir(one)), false)
  assert.equal(fs.existsSync(lockDir(two)), false)
  return "two loops held their own lock simultaneously and both created step 1"
}

// J. The lock refactor keeps A2: one non-zero acceptance command refuses with no
// verdict, every run recorded with its duration, and green verifies.
async function probeVerifyVerdicts() {
  const repo = makeRepo()
  const tools = await startLoop(repo, 3)
  assert.match(await call(tools, "foreman_step", stepInput(1, { acceptanceCommands: ["printf ok", "exit 1"] })), STEP_RE)
  assert.match(await call(tools, "foreman_result", {
    step: 1, commit: git(repo.dir, "rev-parse", "HEAD"), command: "printf ok", exitCode: 0, summary: "shipped",
  }), /^RESULT recorded/)
  const red = await call(tools, "foreman_verify", {
    step: 1, verdict: "good", commands: [{ command: "printf ok", exitCode: 0 }], transcript: "user saw it",
  })
  assert.match(red, /^REFUSED: good requires every acceptance command to exit 0; `exit 1` exited 1 after \d+ms\./, red)
  const redVerify = readStep(repo, 1, "verify.json")
  assert.equal(Object.hasOwn(redVerify, "verdict"), false, "a red acceptance recorded a verdict")
  assert.deepEqual(redVerify.acceptanceRuns.map((run) => run.exitCode), [0, 1], "the runs were not sequential")
  assert.ok(redVerify.acceptanceRuns.every((run) => typeof run.durationMs === "number"), "a run has no duration")
  assert.equal(readStep(repo, 1).status, "implemented")
  assert.equal(readState(repo).current, 1)
  assert.equal(readLedger(repo).some((entry) => entry.type === "verified"), false)
  assert.equal(fs.existsSync(lockDir(repo)), false)

  assert.match(await call(tools, "foreman_step", stepInput(2)), STEP_RE)
  assert.match(await call(tools, "foreman_result", {
    step: 2, commit: git(repo.dir, "rev-parse", "HEAD"), command: "printf c2", exitCode: 0, summary: "shipped",
  }), /^RESULT recorded/)
  const green = await call(tools, "foreman_verify", {
    step: 2, verdict: "good", commands: [{ command: "printf ok", exitCode: 0 }], transcript: "user saw it",
  })
  assert.match(green, /^VERIFIED step 2\./, green)
  const greenVerify = readStep(repo, 2, "verify.json")
  assert.equal(greenVerify.verdict, "good")
  assert.deepEqual(greenVerify.acceptanceRuns.map((run) => run.exitCode), [0])
  assert.equal(readStep(repo, 2).status, "verified")
  assert.deepEqual(readState(repo).active, [1])
  return "red acceptance refused with runs [0,1], no verdict, step implemented; green verified step 2, active [1]"
}

/* ------------------------------- reporting ------------------------------- */

const failures = []
const evidence = {}
async function repeat(name, fn, runs = REPEATS) {
  const results = []
  for (let run = 1; run <= runs; run += 1) {
    try {
      results.push(await fn())
    } catch (error) {
      failures.push({ name, run, error })
      console.log(`FAIL ${name} run ${run}/${runs}: ${String(error?.message ?? error).split("\n")[0]}`)
      return
    }
  }
  evidence[name] = results
  console.log(`PASS ${name}: ${runs}/${runs} runs · ${results[0]}`)
}

await repeat("A. two foreman_step at maxParallel 3", () => probeCapacity(3))
await repeat("B. two foreman_step at maxParallel 1", () => probeCapacity(1))
await repeat("C. two concurrent foreman_result", probeResults)
await repeat("D. foreman_verify racing foreman_next", probeVerifyNext)
await repeat("E. heartbeat keeps a 3x-window lock and refuses a second process", probeHeartbeatRefusal, 3)
await repeat("F. acceptance runs outside the lock and verify keeps a concurrent step", probeVerifyLockFree, 3)
await repeat("G. dead pid stolen, live reused pid refused, owner-less stale recovered", probeStealRules)
await repeat("H. lock removed mid-call", probeLockRemoved, 3)
await repeat("I. per-loop locks", probePerLoopLocks, 3)
await repeat("J. verify red and green under the lock refactor", probeVerifyVerdicts)
await repeat("K. a cherry-pick that moves HEAD during acceptance is re-run once on the new HEAD", probeHeadMoved, 2)
await repeat("L. a stable HEAD during acceptance still verifies (negative control)", probeHeadStable, 2)

const statusAfter = gitSource(["status", "--porcelain"])
assert.equal(gitSource(["rev-parse", "HEAD"]), sourceHeadBefore, "the probe moved HEAD in the source checkout")
assert.equal(statusAfter, sourceStatusBefore, "the probe modified the source working tree")

if (failures.length) {
  console.log("")
  for (const failure of failures) {
    console.log(`PROBE FAILED: ${failure.name} run ${failure.run} — ${failure.error?.message ?? failure.error}`)
    if (failure.error?.stack) console.log(failure.error.stack)
  }
  process.exit(1)
}
console.log("")
console.log(`OK ${Object.keys(evidence).length} probes PASS (temp repo ${tmp})`)
process.exit(0)
