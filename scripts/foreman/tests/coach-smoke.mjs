#!/usr/bin/env node
/**
 * Mid-loop coach smoke test.
 *
 * Between one step and the next the harness reads back the builder/verifier
 * exchange: it writes a coach card (guidance for the next pair) and — when the
 * ledger proves a harness defect and a distinct harness repo is configured —
 * returns ACTION: coach upgrade at an idle boundary. The upgrade runs inline and
 * the product loop resumes from the same cursor.
 *
 * Run from the repo root: node scripts/foreman/tests/coach-smoke.mjs
 * Nothing touches GitHub: PATH is prefixed with a fake gh and the plugin stub.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-coach-"))

// A distinct harness repo: `foreman_rsi_ship`'s source. The plugin resolves it
// from FOREMAN_RSI_SOURCE at import.
const harness = path.join(tmp, "Harness")
fs.mkdirSync(path.join(harness, "scripts/foreman"), { recursive: true })
fs.writeFileSync(path.join(harness, "scripts/foreman/plugin.ts"), "// harness\n")

process.env.FOREMAN_RSI_SOURCE = harness
process.env.FOREMAN_RSI_MIDLOOP = "on"
process.env.FOREMAN_RSI_MIDLOOP_EVERY = "1"
process.env.FOREMAN_RSI_MIDLOOP_MIN_MS = "0"

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
const plugin = (await import(pathToFileURL(bundle).href)).default

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const exists = (file) => fs.existsSync(file)

const unit = (id) => ({ id, title: `unit ${id}`, dependsOn: [], scope: [`backend/api/src/${id}`], seam: [], class: "independent" })

function makeRepo({ ownHarness = false } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"))
  git(dir, "init", "-q", "-b", "foreman/Legacy")
  git(dir, "config", "user.email", "coach@example.com")
  git(dir, "config", "user.name", "Coach")
  fs.writeFileSync(path.join(dir, "README.md"), "# coach\n")
  if (ownHarness) fs.mkdirSync(path.join(dir, "scripts/foreman"), { recursive: true })
  if (ownHarness) fs.writeFileSync(path.join(dir, "scripts/foreman/plugin.ts"), "// self\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  fs.mkdirSync(path.join(dir, ".foreman", "steps", "1"), { recursive: true })
  return dir
}

function writeState(dir, steps) {
  const state = {
    id: "legacy",
    startedAt: new Date().toISOString(),
    planPath: path.join(dir, "plan.md"),
    branch: "foreman/Legacy", repo: "fake/repo", model: "coach",
    maxParallel: 3, maxSteps: 2000, maxMinutes: null,
    cursor: 1, current: null, blocked: null, active: [],
    units: [unit("u1"), unit("u2")],
    steps,
  }
  fs.writeFileSync(path.join(dir, ".foreman/state.json"), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

const writeLedger = (dir, entries) => {
  fs.writeFileSync(path.join(dir, ".foreman/ledger.jsonl"), `${entries.map((entry) => JSON.stringify({ at: new Date().toISOString(), ...entry })).join("\n")}\n`)
}

const verifiedStep = () => ({
  n: 1, title: "done", goal: "be done", acceptance: ["criterion"], acceptanceCommands: ["true"],
  unitId: "u1", kind: null, scope: ["backend/api/src/u1"], dependsOn: [], status: "verified",
  planIssue: 30, implIssue: null, fixIssues: [9], createdAt: new Date().toISOString(),
  verify: { acceptanceRuns: [{ command: "true", exitCode: 0, reused: false }] },
})

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
const call = async (tools, name, input) => String((await tools[name].execute(input, {}))?.content ?? "")

let passed = 0
const scenario = async (name, fn) => { await fn(); passed += 1; console.log(`PASS ${name}`) }

await scenario("coach: a verified step writes a card and upgrades the distinct harness repo at an idle boundary", async () => {
  const dir = makeRepo()
  writeState(dir, [verifiedStep()])
  // 3 worker offers, 2 results, one repeat rejection: a harness defect.
  writeLedger(dir, [
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "result", step: 1 },
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "result", step: 1 },
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "rejected", step: 1, issue: 9, signature: "abcdef012345", repeat: 1 },
    { type: "verified", step: 1, commands: 1, acceptance: 1, fixes: [9] },
  ])
  const tools = await loadTools(dir)
  const out = await call(tools, "foreman_next")
  assert.match(out, /^ACTION: coach upgrade/, out)
  assert.ok(out.includes(`HARNESS: ${harness}`), out)
  assert.ok(out.includes("FINDINGS:"), out)
  const plan = path.join(harness, "plans", "HARNESS_RSI.md")
  assert.ok(exists(plan), "the harness plan was not written")
  assert.match(fs.readFileSync(plan, "utf8"), /# HARNESS_RSI/)
  const state = readJson(path.join(dir, ".foreman/state.json"))
  assert.equal(state.coach.pending, false)
  assert.equal(state.coach.upgradeStep, 1)
  assert.ok(state.coach.guidance.join(" ").includes("died"), state.coach.guidance)
  const ledger = fs.readFileSync(path.join(dir, ".foreman/ledger.jsonl"), "utf8")
  assert.match(ledger, /"type":"coach"/)
  assert.match(ledger, /"type":"coach_upgrade"/)
})

await scenario("coach: the upgrade fires once, then the loop resumes with a normal action", async () => {
  const dir = makeRepo()
  writeState(dir, [verifiedStep()])
  writeLedger(dir, [
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "result", step: 1 },
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "result", step: 1 },
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "rejected", step: 1, issue: 9, signature: "abcdef012345", repeat: 1 },
    { type: "verified", step: 1, commands: 1, acceptance: 1, fixes: [9] },
  ])
  const tools = await loadTools(dir)
  assert.match(await call(tools, "foreman_next"), /^ACTION: coach upgrade/)
  const resumed = await call(tools, "foreman_next")
  assert.match(resumed, /^ACTION: create_step/, resumed)
  assert.doesNotMatch(resumed, /coach upgrade/)
})

await scenario("coach: a repeat rejection coaches a committed falsification test", async () => {
  const dir = makeRepo({ ownHarness: true }) // its own root == harness: no upgrade armed
  writeState(dir, [{ ...verifiedStep(), status: "implemented" }])
  // A rejected verdict is the latest terminal event; the next tick reads it.
  writeLedger(dir, [
    { type: "dispatch", step: 1, action: "dispatch_worker", issue: 30 },
    { type: "result", step: 1 },
    { type: "rejected", step: 1, issue: 9, signature: "deadbeef0000", repeat: 1 },
  ])
  const tools = await loadTools(dir)
  const out = await call(tools, "foreman_next")
  const state = readJson(path.join(dir, ".foreman/state.json"))
  assert.match(state.coach.guidance.join(" "), /falsification test/, JSON.stringify(state.coach))
  // Its own root is not a distinct harness: no mid-loop code upgrade.
  assert.doesNotMatch(out, /coach upgrade/)
})

console.log(`\nPASSED ${passed}/${passed} scenarios (fixtures in ${tmp})`)
