#!/usr/bin/env node
/**
 * Smoke test for the repository pointer.
 *
 * Foreman creates its issues in the repository configured for the directory:
 * every gh call carries `--repo <slug>`, resolved with `gh repo view` from the
 * checkout's own remote at start and refreshed on resume. An ambient GH_REPO
 * must never move the ledger, and `git remote set-url origin` (the pointer the
 * directory configures) must be picked up on the next start/resume.
 *
 * Run from the repo root: node scripts/foreman/tests/repo-pointer-smoke.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-repointer-"))
const shimDir = path.join(tmp, "bin")
fs.mkdirSync(shimDir, { recursive: true })
const ghLog = path.join(tmp, "gh.log")
const ghCounter = path.join(tmp, "gh.counter")
const slugFile = path.join(tmp, "slug.txt")
fs.writeFileSync(ghCounter, "0")
fs.writeFileSync(slugFile, "acme/widgets\n")

// The fake gh: `repo view` prints whatever the directory "configures" (the slug
// file), `issue create` numbers the issues, and every call is logged verbatim.
fs.writeFileSync(path.join(shimDir, "gh"), [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then cat "$GH_SLUG_FILE"; exit 0; fi',
  'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
  '  N=$(cat "$GH_COUNTER")',
  "  N=$((N + 1))",
  '  printf \'%s\' "$N" > "$GH_COUNTER"',
  '  printf \'https://github.com/%s/issues/%s\\n\' "$(cat "$GH_SLUG_FILE")" "$N"',
  "  exit 0",
  "fi",
  "exit 0",
  "",
].join("\n"), { mode: 0o755 })
process.env.GH_LOG = ghLog
process.env.GH_COUNTER = ghCounter
process.env.GH_SLUG_FILE = slugFile
// A decoy ambient repo: the plugin must pin `--repo` and never let this win.
process.env.GH_REPO = "intruder/decoy"
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
const ghText = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : "")

function makeRepo() {
  const dir = path.join(tmp, "repo")
  fs.mkdirSync(path.join(dir, "plans"), { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "smoke@example.com")
  git(dir, "config", "user.name", "Smoke")
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n")
  fs.writeFileSync(path.join(dir, "plans", "Pointer.md"), "# Pointer\n")
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
const S = { sessionID: "ses_pointer" }
const stateFile = (id) => path.join(root, ".foreman", "active", id, "state.json")
const latestIssueCreate = () => ghText().split("\n").filter((line) => /^issue create /.test(line)).pop() ?? ""

await scenario("start resolves the pointer from the directory, ignores the ambient GH_REPO", async () => {
  const message = await call(tools, "foreman_start", { planPath: "plans/Pointer.md" }, S)
  assert.match(message, /STARTED foreman loop Pointer/)
  assert.match(message, /- repo: acme\/widgets/)
  assert.equal(readJson(stateFile("Pointer")).repo, "acme/widgets")
})

await scenario("every created issue is pinned with --repo, never the ambient GH_REPO", async () => {
  const created = await call(tools, "foreman_step", {
    title: "prove the pointer",
    goal: "the issue lands in the directory's repo",
    acceptance: ["criterion"],
    acceptanceCommands: ["true"],
  }, S)
  assert.match(created, /STEP 1 created/)
  const line = latestIssueCreate()
  assert.match(line, /--repo acme\/widgets/, "the issue was not pinned to the directory's repo")
  assert.doesNotMatch(line, /intruder\/decoy/, "an ambient GH_REPO leaked into the issue call")
  assert.doesNotMatch(ghText(), /intruder\/decoy/, "the decoy repo reached gh at all")
})

await scenario("changing the directory's repo re-points the ledger on resume", async () => {
  await call(tools, "foreman_stop", { reason: "repoint" }, S)
  // The directory now "configures" a sandbox: the pointer must follow it.
  fs.writeFileSync(slugFile, "sandbox/lab\n")
  const message = await call(tools, "foreman_start", { planPath: "plans/Pointer.md" }, S)
  assert.match(message, /RESUMED foreman loop Pointer/)
  assert.match(message, /- repo: sandbox\/lab/)
  assert.equal(readJson(stateFile("Pointer")).repo, "sandbox/lab")

  const created = await call(tools, "foreman_step", {
    title: "after the repoint",
    goal: "the next issue lands in the sandbox",
    acceptance: ["criterion"],
    acceptanceCommands: ["true"],
  }, S)
  assert.match(created, /STEP 2 created/)
  assert.match(latestIssueCreate(), /--repo sandbox\/lab/, "the resumed loop kept the stale pointer")
})

process.stdout.write(`\nPASSED ${passed.length}/${passed.length} scenarios (fixtures in ${tmp})\n`)
