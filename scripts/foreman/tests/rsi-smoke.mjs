#!/usr/bin/env node
/**
 * Smoke test for foreman_rsi (recursive self-improvement reflection).
 *
 * It bundles the real plugin with the @opencode/plugin stub, seeds two completed
 * loops' state/ledger/verify files in a throwaway repository, and checks:
 *   - the report is written and the totals are computed from the ledger;
 *   - writePlan produces a harness plan with one unit per actionable finding;
 *   - the findings reflect first-pass yield, repeats and follow-ups;
 *   - the tool never needs a bound session (it can run from the harness repo).
 *
 * Run from the repo root: node scripts/foreman/tests/rsi-smoke.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-rsi-"))

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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function loadTools(root, instance = plugin) {
  const tools = {}
  const ctx = {
    location: { directory: root },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: { prompt: async () => {}, get: async () => ({}), context: async () => "", compact: async () => {} },
    permission: { list: async () => [] },
    event: { subscribe: async function* () {} },
  }
  await instance.setup(ctx)
  return tools
}

const call = async (tools, name, input) => {
  const result = await tools[name].execute(input)
  return String(result?.content ?? "")
}

function makeLoop(repo, id, { steps, ledger, units }) {
  const dir = path.join(repo, ".foreman", "active", id)
  writeJson(path.join(dir, "state.json"), {
    id,
    startedAt: "2026-11-27T10:00:00.000Z",
    planPath: path.join(repo, "plans", `${id}.md`),
    branch: "main",
    repo: "fake/repo",
    maxParallel: 4,
    maxVerify: 2,
    maxCreatePerTick: 6,
    maxSteps: 200,
    maxMinutes: null,
    cursor: steps.length,
    active: [],
    current: null,
    blocked: null,
    steps,
    units,
  })
  fs.writeFileSync(path.join(dir, "ledger.jsonl"), `${ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
  for (const step of steps) {
    writeJson(path.join(dir, "steps", String(step.n), "step.json"), step)
    if (step.verify) writeJson(path.join(dir, "steps", String(step.n), "verify.json"), step.verify)
    delete step.verify
  }
  return dir
}

const verifiedStep = (n, { fixes = [], followUpIssues = [], runs = [], appliedAt = "2026-11-27T10:00:00.000Z", verifiedAt = "2026-11-27T10:05:00.000Z" } = {}) => ({
  n,
  title: `step ${n}`,
  goal: "seed",
  acceptance: ["criterion"],
  acceptanceCommands: ["true"],
  unitId: `U${n}`,
  scope: [`u${n}`],
  dependsOn: [],
  status: "verified",
  planIssue: 100 + n,
  implIssue: 200 + n,
  fixIssues: fixes,
  followUpIssues,
  result: { attempt: fixes.length + 1, commit: "deadbeef", appliedAt, durationMs: 1000 },
  verifiedAt,
  verify: {
    verdict: "good",
    commands: [{ command: "true", exitCode: 0 }],
    transcript: "seed",
    acceptanceRuns: runs,
    at: verifiedAt,
  },
})

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

await scenario("RSI: metrics, report and generated harness plan", async () => {
  const repo = path.join(tmp, "repo")
  fs.mkdirSync(path.join(repo, "plans"), { recursive: true })
  const units = [
    { id: "U1", title: "one", class: "serial", dependsOn: [], artifactDependsOn: [], scope: ["u1"], seam: [] },
    { id: "U2", title: "two", class: "serial", dependsOn: ["U1"], artifactDependsOn: [], scope: ["u2"], seam: [] },
  ]
  const steps = [
    verifiedStep(1, { runs: [{ command: "true", exitCode: 0, durationMs: 100, reused: false }] }),
    verifiedStep(2, {
      fixes: [11, 12],
      followUpIssues: [21],
      runs: [{ command: "true", exitCode: 0, durationMs: 50, reused: true }, { command: "false", exitCode: 0, durationMs: 50, reused: false }],
      appliedAt: "2026-11-27T10:10:00.000Z",
      verifiedAt: "2026-11-27T10:20:00.000Z",
    }),
  ]
  makeLoop(repo, "L1", {
    steps,
    units,
    ledger: [
      { at: "2026-11-27T10:05:00.000Z", type: "verified", step: 1, kind: "evidence" },
      { at: "2026-11-27T10:08:00.000Z", type: "rejected", step: 2, issue: 11, signature: "deadbeefcafe", repeat: 0, kind: "evidence" },
      { at: "2026-11-27T10:12:00.000Z", type: "rejected", step: 2, issue: 12, signature: "deadbeefcafe", repeat: 1, kind: "evidence" },
      { at: "2026-11-27T10:20:00.000Z", type: "verified", step: 2, kind: "evidence" },
    ],
  })

  const tools = await loadTools(repo)
  const message = await call(tools, "foreman_rsi", { loops: ["L1"], writePlan: true })
  assert.match(message, /^RSI report:/)
  assert.match(message, /first-pass yield: 50\.0% \(1\/2\)/)
  assert.match(message, /repeats: 1 · follow-ups: 1/)
  assert.match(message, /First-pass yield is below 80%/)

  const report = fs.readFileSync(path.join(repo, ".foreman", "rsi", "report.md"), "utf8")
  assert.match(report, /# Foreman RSI/)
  assert.match(report, /first-pass yield \| 50\.0% \(1\/2\)/)
  assert.match(report, /\| L1 \| 2 \| 2 \| 50\.0% \| 2 \|/)

  const metrics = JSON.parse(fs.readFileSync(path.join(repo, ".foreman", "rsi", "metrics.json"), "utf8"))
  assert.equal(metrics.totals.loops, 1)
  assert.equal(metrics.totals.verified, 2)
  assert.equal(metrics.totals.firstPass, 1)
  assert.equal(metrics.totals.fixAttempts, 2)
  assert.equal(metrics.totals.reused, 1)
  assert.equal(metrics.totals.repeats, 1)
  assert.equal(metrics.totals.followUps, 1)

  const plan = fs.readFileSync(path.join(repo, "plans", "HARNESS_RSI.md"), "utf8")
  assert.match(plan, /^# HARNESS_RSI/)
  assert.match(plan, /## Unit R1 — First-pass yield is below 80%/)
  assert.match(plan, /npm run typecheck/)
  assert.match(plan, /scripts\/foreman/)
})

await scenario("RSI: a clean loop reports no regression and still writes a baseline plan", async () => {
  const repo = path.join(tmp, "repo-clean")
  fs.mkdirSync(path.join(repo, "plans"), { recursive: true })
  makeLoop(repo, "L1", {
    units: [{ id: "U1", title: "one", class: "serial", dependsOn: [], artifactDependsOn: [], scope: ["u1"], seam: [] }],
    steps: [verifiedStep(1, { runs: [{ command: "true", exitCode: 0, durationMs: 10, reused: true }] })],
    ledger: [{ at: "2026-11-27T10:05:00.000Z", type: "verified", step: 1, kind: "evidence" }],
  })
  const tools = await loadTools(repo)
  const message = await call(tools, "foreman_rsi", { loops: ["L1"], writePlan: true })
  assert.match(message, /No harness regression detected/)
  const plan = fs.readFileSync(path.join(repo, "plans", "HARNESS_RSI.md"), "utf8")
  assert.match(plan, /## Unit R1 — Keep the harness green/)
})

await scenario("RSI ship: refuses without git provenance, then installs a pushed harness", async () => {
  const repo = path.join(tmp, "harness")
  const target = path.join(tmp, "install-target")
  const remote = path.join(tmp, "harness-origin.git")
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" })
  fs.mkdirSync(path.join(repo, "scripts/foreman"), { recursive: true })
  fs.mkdirSync(path.join(repo, ".opencode/skills/always-awake-agent"), { recursive: true })
  fs.writeFileSync(path.join(repo, "scripts/foreman/plugin.ts"), "// v1\n")
  fs.writeFileSync(path.join(repo, ".opencode/skills/always-awake-agent/SKILL.md"), "# v1\n")
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@t")
  git(repo, "config", "user.name", "t")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "init")
  git(tmp, "init", "-q", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "push", "-q", "origin", "main")

  const tools = await loadTools(repo)
  const noTargets = await call(tools, "foreman_rsi_ship", { source: repo })
  assert.match(noTargets, /REFUSED: no install targets configured/)
  const notHarness = await call(tools, "foreman_rsi_ship", { source: tmp, targets: [target] })
  assert.match(notHarness, /is not the harness repo/)

  // A dirty harness is refused before any write.
  fs.writeFileSync(path.join(repo, "scripts/foreman/plugin.ts"), "// v2 dirty\n")
  const dirty = await call(tools, "foreman_rsi_ship", { source: repo, targets: [target], reload: false })
  assert.match(dirty, /uncommitted file\(s\) in the harness repo/)

  // Committed but unpushed is refused: the next run installs from origin.
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "v2")
  const unpushed = await call(tools, "foreman_rsi_ship", { source: repo, targets: [target], reload: false })
  assert.match(unpushed, /is not on origin\/main/)
  git(repo, "push", "-q", "origin", "main")

  const dry = await call(tools, "foreman_rsi_ship", { source: repo, targets: [target], reload: false, dryRun: true })
  assert.match(dry, /DRY RUN/)
  assert.equal(fs.existsSync(path.join(target, "scripts/foreman/plugin.ts")), false)

  const shipped = await call(tools, "foreman_rsi_ship", { source: repo, targets: [target], reload: false })
  assert.match(shipped, /^INSTALLED /)
  assert.match(shipped, /scripts\/foreman 1/)
  assert.equal(fs.readFileSync(path.join(target, "scripts/foreman/plugin.ts"), "utf8"), "// v2 dirty\n")
  assert.equal(fs.readFileSync(path.join(target, ".opencode/skills/always-awake-agent/SKILL.md"), "utf8"), "# v1\n")
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".foreman/rsi/install.json"), "utf8"))
  assert.equal(manifest.targets[0].target, target)
  assert.ok(manifest.commit)

  // Idempotent: a second ship changes nothing.
  const again = await call(tools, "foreman_rsi_ship", { source: repo, targets: [target], reload: false })
  assert.match(again, /0 changed \/ 2 file\(s\)/)
})

await scenario("RSI: the plan lands in the harness repo when FOREMAN_RSI_SOURCE is set", async () => {
  const product = path.join(tmp, "product-loop")
  const harnessRepo = path.join(tmp, "product-harness")
  fs.mkdirSync(path.join(product, "plans"), { recursive: true })
  fs.mkdirSync(path.join(harnessRepo, "scripts/foreman"), { recursive: true })
  fs.writeFileSync(path.join(harnessRepo, "scripts/foreman/plugin.ts"), "// harness\n")
  makeLoop(product, "L1", {
    units: [{ id: "U1", title: "one", class: "serial", dependsOn: [], artifactDependsOn: [], scope: ["u1"], seam: [] }],
    steps: [verifiedStep(1, { fixes: [7, 8], runs: [{ command: "true", exitCode: 0, durationMs: 10, reused: false }] })],
    ledger: [{ at: "2026-11-27T10:08:00.000Z", type: "rejected", step: 2, issue: 7, signature: "abc", repeat: 0, kind: "evidence" }],
  })
  process.env.FOREMAN_RSI_SOURCE = harnessRepo
  const sourced = path.join(tmp, "plugin-sourced.mjs")
  await build({
    entryPoints: [path.join(repoRoot, "scripts/foreman/plugin.ts")],
    bundle: true, platform: "node", format: "esm", outfile: sourced,
    alias: { "@opencode/plugin": path.join(here, "plugin-stub.ts") }, logLevel: "silent",
  })
  try {
    const instance = (await import(pathToFileURL(sourced).href)).default
    const tools = await loadTools(product, instance)
    const message = await call(tools, "foreman_rsi", { loops: ["L1"], writePlan: true })
    assert.match(message, /harness repo:/)
    assert.ok(fs.existsSync(path.join(harnessRepo, "plans/HARNESS_RSI.md")))
    assert.equal(fs.existsSync(path.join(product, "plans/HARNESS_RSI.md")), false)
    const plan = fs.readFileSync(path.join(harnessRepo, "plans/HARNESS_RSI.md"), "utf8")
    assert.match(plan, /Harness repo \(where this plan runs\)/)
  } finally {
    delete process.env.FOREMAN_RSI_SOURCE
  }
})

console.log("")
if (failures.length) {
  console.log(`FAILED ${failures.length}/${passed + failures.length} scenarios (fixtures in ${tmp})`)
  for (const failure of failures) console.log(`\n--- ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
console.log(`PASSED ${passed}/${passed} scenarios (fixtures in ${tmp})`)
