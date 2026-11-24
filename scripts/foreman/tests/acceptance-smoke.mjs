#!/usr/bin/env node
/**
 * Smoke test for plan phase A1 + A2 of plans/ForemanHarness.md.
 *
 * It bundles the real plugin with a stub for @opencode/plugin, loads the tools
 * against throwaway git repositories in os.tmpdir() and a fake `gh` shim, then
 * exercises:
 *   - foreman_step refusing a step without acceptanceCommands (exact message);
 *   - the stored commands landing in steps/<n>/step.json and in the issue body;
 *   - foreman_verify good refusing when an acceptance command exits non-zero,
 *     recording no verdict and leaving the step implemented;
 *   - foreman_verify good closing the step when every command exits 0, with
 *     acceptanceRuns in verify.json, HEAD==branch and .foreman/ dirt ignored;
 *   - the preconditions (dirty tree outside .foreman/, HEAD != branch);
 *   - the legacy path (pre-change steps) with commands passed to foreman_verify;
 *   - running in the loop's own worktree (state.worktree) instead of the root;
 *   - the FOREMAN_ACCEPT_TIMEOUT_MS timeout mapping to exit code 124.
 *
 * Run from the repo root: node scripts/foreman/tests/acceptance-smoke.mjs
 * Nothing touches GitHub: PATH is prefixed with a fake gh that only logs.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const ACCEPT_TIMEOUT_MS = 2500
process.env.FOREMAN_ACCEPT_TIMEOUT_MS = String(ACCEPT_TIMEOUT_MS)

const ACCEPT_REQUIRED = "REFUSED: acceptanceCommands is required: the plugin executes these exact commands before good."

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-acceptance-"))
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

function makeRepo({ branch = "foreman/smoke", extraFiles = {} } = {}) {
  const dir = path.join(tmp, `repo-${++fixture}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", branch)
  git(dir, "config", "user.email", "smoke@example.com")
  git(dir, "config", "user.name", "Smoke")
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n")
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
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
  if (patch?.steps?.length) {
    for (const step of patch.steps) {
      fs.mkdirSync(path.join(repo.dir, ".foreman", "steps", String(step.n)), { recursive: true })
      fs.writeFileSync(path.join(repo.dir, ".foreman", "steps", String(step.n), "step.json"), `${JSON.stringify(step, null, 2)}\n`)
    }
  }
  return state
}

const readState = (repo) => readJson(path.join(repo.dir, ".foreman/state.json"))
const readStep = (repo, n, name = "step.json") => readJson(path.join(repo.dir, ".foreman", "steps", String(n), name))
const stepFile = (repo, n, name = "step.json") => path.join(repo.dir, ".foreman", "steps", String(n), name)

function legacyStep(overrides = {}) {
  return {
    n: 1,
    title: "legacy",
    goal: "step created before acceptanceCommands existed",
    acceptance: ["legacy criterion"],
    scope: ["README.md"],
    dependsOn: [],
    status: "implemented",
    planIssue: 101,
    implIssue: 102,
    fixIssues: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

async function loadTools(root) {
  const tools = {}
  const ctx = {
    location: { directory: root },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: { prompt: async () => {}, get: async () => ({}), context: async () => "", compact: async () => {} },
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

await scenario("A1: foreman_step without acceptanceCommands is refused with the exact message", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  const tools = await loadTools(repo.dir)
  const base = { title: "a step", goal: "do the thing", acceptance: ["criterion"] }
  for (const input of [
    base,
    { ...base, acceptanceCommands: [] },
    { ...base, acceptanceCommands: ["", "   "] },
    { ...base, acceptanceCommands: "npx esbuild index.ts" },
  ]) {
    const message = await call(tools, "foreman_step", input)
    assert.equal(message, ACCEPT_REQUIRED)
    assert.equal(message.split("\n").length, 1)
  }
  assert.equal(readState(repo).steps.length, 0)
})

await scenario("A1: commands are stored on the step and printed in the issue body", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  const tools = await loadTools(repo.dir)
  const commands = ["echo hello", "exit 0"]
  const message = await call(tools, "foreman_step", {
    title: "stored commands",
    goal: "prove persistence",
    acceptance: ["criterion"],
    acceptanceCommands: commands,
    unitId: "A1",
    scope: ["README.md"],
  })
  assert.match(message, /^STEP 1 created: #\d+/)
  const step = readStep(repo, 1)
  assert.deepEqual(step.acceptanceCommands, commands)
  assert.equal(step.unitId, "A1")
  assert.deepEqual(readState(repo).steps[0].acceptanceCommands, commands)
  const body = fs.readFileSync(bodies, "utf8")
  assert.ok(body.includes("## Exact commands (executed by the plugin)"), "issue body lacks the section")
  assert.ok(body.includes("echo hello\nexit 0"), "issue body lacks the commands verbatim")
})

await scenario("A2: good with a failing acceptance command is refused and records no verdict", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  const tools = await loadTools(repo.dir)
  await call(tools, "foreman_step", {
    title: "failing acceptance",
    goal: "prove the plugin refuses",
    acceptance: ["criterion"],
    acceptanceCommands: ["echo first", "echo about-to-fail && exit 7"],
    scope: ["README.md"],
  })
  const result = await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "echo first", exitCode: 0, summary: "worker did it", outputTail: "ok",
  })
  assert.match(result, /^RESULT recorded/)
  assert.equal(readStep(repo, 1).status, "implemented")

  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo first", exitCode: 0 }],
    transcript: "a user saw the feature",
  })
  assert.match(message, /^REFUSED: good requires every acceptance command to exit 0/)
  assert.equal(readStep(repo, 1).status, "implemented")
  assert.equal(readState(repo).current, 1)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(Object.hasOwn(verify, "verdict"), false, "a refused verdict must not be recorded")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0, 7])
  for (const run of verify.acceptanceRuns) {
    assert.equal(typeof run.command, "string")
    assert.equal(typeof run.durationMs, "number")
    assert.equal(typeof run.outputTail, "string")
  }
  assert.ok(verify.acceptanceRuns[1].outputTail.includes("about-to-fail"))
})

await scenario("A2: good with green commands records acceptanceRuns and closes the step", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  const tools = await loadTools(repo.dir)
  await call(tools, "foreman_step", {
    title: "green acceptance",
    goal: "prove the plugin closes the step",
    acceptance: ["criterion"],
    acceptanceCommands: ["pwd", "echo second"],
    scope: ["README.md"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "pwd", exitCode: 0, summary: "worker did it",
  })

  // metaExitCode is accepted for compatibility but must not decide the verdict.
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "pwd", exitCode: 0 }],
    transcript: "a user saw the feature",
    metaCommand: "pwd",
    metaExitCode: 1,
  })
  assert.match(message, /^VERIFIED step 1\./)

  const step = readStep(repo, 1)
  assert.equal(step.status, "verified")
  assert.deepEqual(step.acceptanceCommands, ["pwd", "echo second"])
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.verdict, "good")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0, 0])
  assert.ok(verify.acceptanceRuns[0].outputTail.includes(repo.dir), "acceptance ran outside the root checkout")
  assert.equal(verify.metaExitCode, 1, "meta values are recorded, not decisive")
  const state = readState(repo)
  assert.equal(state.current, null)
  assert.equal(state.steps[0].status, "verified")
  const ledger = fs.readFileSync(path.join(repo.dir, ".foreman/ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert.ok(ledger.some((entry) => entry.type === "verified" && entry.acceptance === 2))
})

await scenario("A2: reportPath replaces the pasted transcript and outputTail is capped", async () => {
  const repo = makeRepo()
  writeState(repo, {})
  const tools = await loadTools(repo.dir)
  await call(tools, "foreman_step", {
    title: "report path",
    goal: "return a short report pointer",
    acceptance: ["criterion"],
    acceptanceCommands: ["echo ok"],
    scope: ["README.md"],
  })
  await call(tools, "foreman_result", {
    step: 1, commit: repo.head, command: "echo ok", exitCode: 0, summary: "worker did it",
  })
  const report = path.join(repo.dir, ".foreman", "verify-report.md")
  fs.writeFileSync(report, `VERDICT: good\nMARKER-REPORT\n${"x".repeat(8_000)}\n`)
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo ok", exitCode: 0, outputTail: "y".repeat(5_000) }],
    reportPath: report,
  })
  assert.match(message, /^VERIFIED step 1\./)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.reportPath, report)
  assert.match(verify.transcript, /MARKER-REPORT/)
  assert.match(verify.transcript, /REPORT: /)
  assert.ok(verify.commands[0].outputTail.length < 1_100, "outputTail was not capped")
})

await scenario("A2: a dirty tree outside .foreman/ refuses good, .foreman/ dirt is ignored", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [legacyStep({ acceptanceCommands: ["echo ok"] })], cursor: 1, current: 1 })
  const tools = await loadTools(repo.dir)
  assert.ok(git(repo.dir, "status", "--porcelain").includes(".foreman/"), ".foreman/ must be dirty for the ignore test")

  fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "uncommitted")
  const refused = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo ok", exitCode: 0 }],
    transcript: "user saw it",
  })
  assert.match(refused, /^REFUSED: 1 uncommitted file\(s\) in /)
  assert.equal(readStep(repo, 1).status, "implemented")
  assert.equal(fs.existsSync(stepFile(repo, 1, "verify.json")), false)

  fs.rmSync(path.join(repo.dir, "dirty.txt"))
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo ok", exitCode: 0 }],
    transcript: "user saw it",
  })
  assert.match(message, /^VERIFIED step 1\./)
})

await scenario("A2: HEAD != state.branch refuses good", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [legacyStep({ acceptanceCommands: ["echo ok"] })], cursor: 1, current: 1 })
  const tools = await loadTools(repo.dir)
  git(repo.dir, "checkout", "-q", "-b", "foreman/other")
  const refused = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo ok", exitCode: 0 }],
    transcript: "user saw it",
  })
  assert.match(refused, /^REFUSED: HEAD of .* is foreman\/other, expected foreman\/smoke/)
  assert.equal(fs.existsSync(stepFile(repo, 1, "verify.json")), false)
})

await scenario("legacy: commands passed to foreman_verify are persisted and executed", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [legacyStep()], cursor: 1, current: 1 })
  assert.equal(Object.hasOwn(readStep(repo, 1), "acceptanceCommands"), false)
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo legacy", exitCode: 0 }],
    transcript: "user saw the legacy step",
    acceptanceCommands: ["echo legacy", "true"],
  })
  assert.match(message, /^VERIFIED step 1\./)
  const step = readStep(repo, 1)
  assert.equal(step.status, "verified")
  assert.deepEqual(step.acceptanceCommands, ["echo legacy", "true"])
  assert.deepEqual(readState(repo).steps[0].acceptanceCommands, ["echo legacy", "true"])
  const verify = readStep(repo, 1, "verify.json")
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.exitCode), [0, 0])
  assert.deepEqual(verify.acceptanceRuns.map((run) => run.command), ["echo legacy", "true"])
})

await scenario("legacy: a step with no commands anywhere refuses good", async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [legacyStep()], cursor: 1, current: 1 })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "echo legacy", exitCode: 0 }],
    transcript: "user saw the legacy step",
  })
  assert.match(message, /^REFUSED: good requires at least one acceptance command\./)
  assert.equal(readStep(repo, 1).status, "implemented")
})

await scenario("A2: commands run in the loop's own worktree, never the shared root", async () => {
  const repo = makeRepo()
  const worktree = path.join(tmp, "repo-loop-worktree")
  git(repo.dir, "worktree", "add", "-q", "-b", "foreman/loop", worktree)
  writeState(repo, {
    branch: "foreman/loop",
    worktree,
    steps: [legacyStep({ acceptanceCommands: ["pwd", "git rev-parse --abbrev-ref HEAD"] })],
    cursor: 1,
    current: 1,
  })
  const tools = await loadTools(repo.dir)
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "pwd", exitCode: 0 }],
    transcript: "user saw the loop worktree",
  })
  assert.match(message, /^VERIFIED step 1\./)
  const verify = readStep(repo, 1, "verify.json")
  assert.ok(verify.acceptanceRuns[0].outputTail.includes(worktree), `pwd ran in ${verify.acceptanceRuns[0].outputTail.trim()}, not the worktree`)
  assert.ok(verify.acceptanceRuns[1].outputTail.includes("foreman/loop"))
  assert.notEqual(git(repo.dir, "rev-parse", "--abbrev-ref", "HEAD"), "foreman/loop", "root must stay on its own branch")
})

await scenario(`timeout: a command killed after ${ACCEPT_TIMEOUT_MS}ms is recorded as exit 124`, async () => {
  const repo = makeRepo()
  writeState(repo, { steps: [legacyStep({ acceptanceCommands: ["sleep 20"] })], cursor: 1, current: 1 })
  const tools = await loadTools(repo.dir)
  const started = Date.now()
  const message = await call(tools, "foreman_verify", {
    step: 1, verdict: "good",
    commands: [{ command: "sleep 20", exitCode: 0 }],
    transcript: "user waited",
  })
  const elapsed = Date.now() - started
  assert.match(message, /^REFUSED: good requires every acceptance command to exit 0; `sleep 20` exited 124/)
  assert.ok(elapsed >= ACCEPT_TIMEOUT_MS - 250, `timeout fired too early: ${elapsed}ms`)
  const verify = readStep(repo, 1, "verify.json")
  assert.equal(verify.acceptanceRuns[0].exitCode, 124)
  assert.equal(readStep(repo, 1).status, "implemented")
})

/* -------------------------------- report -------------------------------- */

console.log("")
if (failures.length) {
  console.log(`FAILED ${failures.length}/${passed + failures.length} scenarios (fixtures in ${tmp})`)
  for (const failure of failures) console.log(`\n--- ${failure.name}\n${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
console.log(`PASSED ${passed}/${passed} scenarios (fixtures in ${tmp})`)
