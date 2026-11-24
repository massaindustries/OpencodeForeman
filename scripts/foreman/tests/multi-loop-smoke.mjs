#!/usr/bin/env node
/**
 * Smoke test for parallel, independent loops.
 *
 * One loop per plan: `plans/Alpha.md` -> id Alpha, branch `foreman/Alpha`,
 * state `.foreman/active/Alpha/`, own git worktree. A second session starting a
 * second plan must not touch the first loop's state, STOP or checkout.
 *
 * Run from the repo root: node scripts/foreman/tests/multi-loop-smoke.mjs
 * Nothing touches GitHub: PATH is prefixed with a fake gh.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-multiloop-"))
const shimDir = path.join(tmp, "bin")
fs.mkdirSync(shimDir, { recursive: true })
const ghLog = path.join(tmp, "gh.log")

fs.writeFileSync(path.join(shimDir, "gh"), [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_LOG"',
  'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "fake/repo"; exit 0; fi',
  'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then echo "https://github.com/fake/repo/issues/1"; exit 0; fi',
  "exit 0",
  "",
].join("\n"), { mode: 0o755 })
process.env.GH_LOG = ghLog
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

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const exists = (file) => fs.existsSync(file)

function makeRepo() {
  const dir = path.join(tmp, "repo")
  fs.mkdirSync(path.join(dir, "plans"), { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "smoke@example.com")
  git(dir, "config", "user.name", "Smoke")
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n")
  fs.writeFileSync(path.join(dir, "plans", "Alpha.md"), "# Alpha\n")
  fs.writeFileSync(path.join(dir, "plans", "Beta.md"), "# Beta\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  return dir
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

const call = async (tools, name, input, context) => {
  const result = await tools[name].execute(input, context)
  return String(result?.content ?? "")
}

const passed = []
const scenario = async (name, fn) => { await fn(); passed.push(name); process.stdout.write(`PASS ${name}\n`) }

const root = makeRepo()
const tools = await loadTools(root)
const A = { sessionID: "ses_A" }
const B = { sessionID: "ses_B" }
const loopDir = (id) => path.join(root, ".foreman", "active", id)
const stateFile = (id) => path.join(loopDir(id), "state.json")

await scenario("start Alpha: state + branch + worktree are derived from the plan name", async () => {
  const message = await call(tools, "foreman_start", { planPath: "plans/Alpha.md" }, A)
  assert.match(message, /STARTED foreman loop Alpha/)
  const state = readJson(stateFile("Alpha"))
  assert.equal(state.id, "Alpha")
  assert.equal(state.sessionID, "ses_A")
  assert.equal(state.branch, "foreman/Alpha")
  assert.equal(state.worktree, path.join(loopDir("Alpha"), "worktree"))
  assert.equal(git(state.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "foreman/Alpha")
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the session checkout is never switched")
})

await scenario("start Beta in another session: both loops run side by side", async () => {
  const before = fs.readFileSync(stateFile("Alpha"), "utf8")
  const message = await call(tools, "foreman_start", { planPath: "plans/Beta.md" }, B)
  assert.match(message, /STARTED foreman loop Beta/)
  const beta = readJson(stateFile("Beta"))
  assert.equal(beta.branch, "foreman/Beta")
  assert.equal(git(beta.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "foreman/Beta")
  assert.equal(fs.readFileSync(stateFile("Alpha"), "utf8"), before, "Alpha state must not change")
  assert.equal(git(root, "branch", "--list", "foreman/Alpha").trim().length > 0, true)
  assert.equal(git(root, "branch", "--list", "foreman/Beta").trim().length > 0, true)
})

await scenario("status reports the calling session's loop only", async () => {
  assert.match(await call(tools, "foreman_status", {}, A), /Alpha/)
  assert.doesNotMatch(await call(tools, "foreman_status", {}, A), /Beta/)
  assert.match(await call(tools, "foreman_status", {}, B), /Beta/)
})

await scenario("stop Alpha leaves Beta running", async () => {
  await call(tools, "foreman_stop", { reason: "test" }, A)
  assert.equal(exists(path.join(loopDir("Alpha"), "STOP")), true)
  assert.equal(exists(path.join(loopDir("Beta"), "STOP")), false, "Beta must not be stopped")
  assert.match(await call(tools, "foreman_status", {}, B), /Beta/)
})

await scenario("one session cannot drive two plans", async () => {
  const message = await call(tools, "foreman_start", { planPath: "plans/Beta.md" }, A)
  assert.match(message, /already drives Alpha/)
})

await scenario("a stopped loop resumes in the session that restarts it", async () => {
  const message = await call(tools, "foreman_start", { planPath: "plans/Alpha.md" }, A)
  assert.match(message, /RESUMED foreman loop Alpha/)
  assert.equal(exists(path.join(loopDir("Alpha"), "STOP")), false)
  assert.equal(readJson(stateFile("Alpha")).sessionID, "ses_A")
})

await scenario("issue titles carry [Plan] and step x/n", async () => {
  await call(tools, "foreman_graph", {
    units: [
      { id: "u1", title: "first", scope: ["src/a"] },
      { id: "u2", title: "second", scope: ["src/b"] },
    ],
  }, A)
  const title = "prove the title"
  const message = await call(tools, "foreman_step", {
    unitId: "u1",
    title,
    goal: "prove the title format",
    acceptanceCommands: ["true"],
  }, A)
  assert.match(message, /STEP 1 created/)
  const calls = fs.readFileSync(ghLog, "utf8")
  assert.match(calls, /issue create .*Alpha\] Step 1\/2: prove the title/)
  assert.match(calls, /--label loop:Alpha/)
})

process.stdout.write(`\nPASSED ${passed.length}/${passed.length} scenarios (fixtures in ${tmp})\n`)
