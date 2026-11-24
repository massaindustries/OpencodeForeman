#!/usr/bin/env node
/**
 * Real end-to-end foreman run, outside the harness fixtures.
 *
 *   - a real clone of the real repository (shared object store, no copy)
 *   - the real node_modules (1.7GB) hardlinked into the worker worktree
 *   - real git worktrees, real cherry-pick, real merge into a real bare origin
 *   - acceptance commands that really execute in the loop checkout, resolving
 *     the monorepo's own dependencies (npx --no-install tsc)
 *   - a local `gh` shim and an `npm` shim (only the live switch is stubbed), so
 *     nothing touches GitHub and the local stack is not restarted
 *
 * Usage:
 *   node scripts/foreman/tests/real-stack.mjs
 *
 * Env:
 *   FOREMAN_REAL_SOURCE   git repo to clone from      (default: this repo)
 *   FOREMAN_REAL_INSTALL  node_modules to share        (default: this checkout)
 *   FOREMAN_REAL_REPO     reuse a prepared fixture     (skips clone + install)
 *   FOREMAN_WORKTREE_LINK hardlink | symlink | copy    (passed to the plugin)
 *
 * Takes ~1 min from zero (the node_modules hardlink is the expensive part).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const platform = path.resolve(here, "../../..")
const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: platform, encoding: "utf8" }).trim()
const source = process.env.FOREMAN_REAL_SOURCE || path.resolve(platform, commonDir, "..")
const stub = path.join(platform, "scripts/foreman/tests/plugin-stub.ts")
const nmSource = process.env.FOREMAN_REAL_INSTALL || path.join(platform, "node_modules")
const { build } = await import(pathToFileURL(path.join(platform, "node_modules/esbuild/lib/main.js")).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-realtest-"))
const keep = Boolean(process.env.FOREMAN_REAL_KEEP)
const shim = path.join(tmp, "bin")
fs.mkdirSync(shim, { recursive: true })

const step = (name) => process.stdout.write(`\n== ${name}\n`)
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const exists = (p) => fs.existsSync(p)
const clock = () => Date.now()

// --- fake gh (no network) and npm (only the live switch is stubbed) --------
fs.writeFileSync(path.join(shim, "gh"), [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'case "$1 ${2:-}" in',
  '  "repo view") printf "%s\\n" "real/test" ;;',
  '  "issue create") printf "%s\\n" "https://github.com/real/test/issues/1" ;;',
  'esac',
  "exit 0",
].join("\n"), { mode: 0o755 })
const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim()
fs.writeFileSync(path.join(shim, "npm"), [
  "#!/bin/sh",
  'if [ "${1:-} ${2:-}" = "run live" ]; then echo "[stub] npm run live"; exit 0; fi',
  `exec ${realNpm} "$@"`,
].join("\n"), { mode: 0o755 })
process.env.GH_LOG = path.join(tmp, "gh.log")
fs.writeFileSync(process.env.GH_LOG, "")
process.env.PATH = `${shim}:${process.env.PATH ?? ""}`
// The publish branch and the live switch are configuration: seed them before
// the plugin module is loaded.
process.env.FOREMAN_PUBLISH_BRANCH = "main"
process.env.FOREMAN_LIVE_COMMAND = "npm run live"

// --- a real clone of the real repo -----------------------------------------
step("clone the real repository (shared objects)")
const repo = process.env.FOREMAN_REAL_REPO || path.join(tmp, "repo")
const reuse = Boolean(process.env.FOREMAN_REAL_REPO)
const t0 = clock()
if (reuse) {
  console.log(`reusing ${repo}`)
  fs.rmSync(path.join(repo, ".foreman"), { recursive: true, force: true })
  git(repo, "checkout", "-q", "--detach", "real-base")
  for (const line of git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))) {
    const dir = line.slice("worktree ".length).trim()
    if (dir !== repo) try { execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "ignore" }) } catch {}
  }
  git(repo, "worktree", "prune")
  try { git(repo, "branch", "-D", "foreman/RealTest") } catch {}
  try { git(repo, "branch", "-D", "foreman/RealFail") } catch {}
} else {
execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", source, repo])
git(repo, "checkout", "-q", "-B", "real-base", "HEAD")
fs.appendFileSync(path.join(repo, ".gitignore"), "\n.foreman/\n")
fs.mkdirSync(path.join(repo, "docs"), { recursive: true })
fs.writeFileSync(path.join(repo, "docs", "RealTest.md"), "# Real test plan\n\n## S1 — one real unit\n\nAppend REAL-WORKER-MARK.\n\n## S2 — a second real unit\n\nWrite docs/RealTest2.md with REAL-WORKER-MARK-2.\n")
git(repo, "add", "--", ".gitignore", "docs/RealTest.md")
git(repo, "commit", "-q", "-m", "real test plan")
}
console.log(`clone + plan in ${((clock() - t0) / 1000).toFixed(1)}s  head=${git(repo, "rev-parse", "--short", "HEAD")}`)

const t1 = clock()
const origin = reuse ? git(repo, "remote", "get-url", "origin") : path.join(tmp, "origin.git")
if (!reuse) {
  execFileSync("git", ["init", "-q", "--bare", origin])
  git(repo, "remote", "set-url", "origin", origin)
}
git(repo, "push", "-q", "--force", "origin", "real-base:refs/heads/main")
if (!reuse) {
  step("hardlink the real install")
  execFileSync("cp", ["-R", "-p", "-l", nmSource, path.join(repo, "node_modules")])
}
const probe = "typescript/package.json"
const inoRoot = fs.statSync(path.join(repo, "node_modules", probe)).ino
console.log(`node_modules hardlinked in ${((clock() - t1) / 1000).toFixed(1)}s  inode=${inoRoot}`)

// --- load the real plugin with the @opencode/plugin stub -------------------
const bundle = path.join(tmp, "plugin.mjs")
await build({
  entryPoints: [path.join(platform, "scripts/foreman/plugin.ts")],
  bundle: true, platform: "node", format: "esm", outfile: bundle,
  alias: { "@opencode/plugin": stub }, logLevel: "silent",
})
const plugin = (await import(pathToFileURL(bundle).href)).default
const tools = {}
await plugin.setup({
  location: { directory: repo },
  tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
  session: { prompt: async () => {}, get: async () => ({}), context: async () => "", compact: async () => {} },
  permission: { list: async () => [] },
  event: { subscribe: async function* () {} },
})
const call = async (name, input = {}, sessionID = "ses_realtest") =>
  String((await tools[name].execute(input, { sessionID }))?.content ?? "")

const loopDir = (id) => path.join(repo, ".foreman", "active", id)
const readState = (id = "RealTest") => JSON.parse(fs.readFileSync(path.join(loopDir(id), "state.json"), "utf8"))
const readStep = (id, n, file = "step.json") => JSON.parse(fs.readFileSync(path.join(loopDir(id), "steps", String(n), file), "utf8"))
const readLedger = (id = "RealTest") => fs.readFileSync(path.join(loopDir(id), "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const tsc = "npx --no-install tsc --version"

step("foreman_start + graph")
const started = await call("foreman_start", { planPath: "docs/RealTest.md", maxParallel: 2, maxVerify: 1 })
assert.match(started, /^STARTED foreman loop RealTest/, started)
assert.equal(readState().branch, "foreman/RealTest")
assert.match(await call("foreman_graph", {
  units: [
    { id: "u1", title: "append the marker", class: "independent", dependsOn: [], scope: ["docs/RealTest.md"] },
    { id: "u2", title: "write the second file", class: "independent", dependsOn: [], scope: ["docs/RealTest2.md"] },
  ],
}), /GRAPH recorded/)

const realWork = async (n, unit, write) => {
  const created = await call("foreman_step", {
    title: `real step ${n}`, goal: "prove a real worker commit lands on the loop branch",
    acceptance: ["the marker is in the file", "the monorepo tsc resolves"],
    acceptanceCommands: [
      `node -e "const t=require('fs').readFileSync('${write.file}','utf8'); if(!t.includes('${write.marker}')) { console.error('marker missing'); process.exit(3) }"`,
      tsc,
    ],
    unitId: unit, scope: [write.file], planRef: n === 1 ? "1-5" : "7-9",
  })
  assert.match(created, /^STEP \d+ created: #/, created)
  const next = await call("foreman_next")
  assert.match(next, /^ACTION: (dispatch_worker|multi)/, next)
  assert.ok(new RegExp(`STEP: ${n}$`, "m").test(next) || new RegExp(`dispatch_worker — step ${n}, issue`).test(next), next)
  const prepared = await call("foreman_worktree", { step: n })
  assert.match(prepared, /^WORKTREE: /, prepared)
  const worktree = prepared.match(/^WORKTREE: (.+)$/m)[1]
  assert.match(prepared, /NODE_MODULES: (hardlinked|symlinked|present)/, prepared)
  assert.equal(fs.statSync(path.join(worktree, "node_modules", probe)).ino, inoRoot, "node_modules is a copy, not a shared install")
  const t = clock()
  fs.mkdirSync(path.dirname(path.join(worktree, write.file)), { recursive: true })
  fs.appendFileSync(path.join(worktree, write.file), `\n${write.marker}\n`)
  const acceptance = JSON.parse(fs.readFileSync(path.join(loopDir("RealTest"), "steps", String(n), "step.json"), "utf8")).acceptanceCommands
  for (const command of acceptance) execFileSync("sh", ["-c", command], { cwd: worktree, stdio: "pipe" })
  git(worktree, "add", "--", write.file)
  git(worktree, "commit", "-q", "-m", `step ${n}: ${write.marker} (#${n})`)
  const commit = git(worktree, "rev-parse", "HEAD")
  const durationMs = clock() - t
  const recorded = await call("foreman_result", {
    step: n, commit, command: acceptance[0], exitCode: 0,
    summary: `wrote ${write.marker} in a real worktree`, durationMs, worktree,
  })
  assert.match(recorded, /^RESULT recorded for step \d+ \(attempt 1\)/, recorded)
  assert.match(recorded, /cherry-picked/, recorded)
  const loopCheckout = path.join(loopDir("RealTest"), "worktree")
  // A cherry-pick rewrites the commit: same tree, new sha, same message.
  assert.equal(git(loopCheckout, "log", "-1", "--format=%s"), `step ${n}: ${write.marker} (#${n})`, "the worker commit did not land on the loop branch")
  assert.match(fs.readFileSync(path.join(loopCheckout, write.file), "utf8"), new RegExp(write.marker), "the change is not in the loop checkout")
  const verified = await call("foreman_verify", {
    step: n, verdict: "good",
    commands: [{ command: acceptance[0], exitCode: 0 }],
    transcript: `${write.marker} is in ${write.file} and tsc resolves`,
    evidenceLevel: 3,
  })
  assert.match(verified, /^VERIFIED step \d+\./, verified)
  assert.deepEqual(readStep("RealTest", n, "verify.json").acceptanceRuns.map((run) => run.exitCode), [0, 0])
  assert.equal(exists(worktree), false, "the verified step's worktree survived")
  console.log(`step ${n}: worker done in ${(durationMs / 1000).toFixed(1)}s, commit ${commit.slice(0, 10)}, worktree retired`)
}

step("step 1 — real worker, real acceptance, real cherry-pick")
await realWork(1, "u1", { file: "docs/RealTest.md", marker: "REAL-WORKER-MARK" })

step("step 2 — same, different scope")
await realWork(2, "u2", { file: "docs/RealTest2.md", marker: "REAL-WORKER-MARK-2" })

step("a real failing acceptance refuses good")
// A second loop, so the failing step cannot block the plan above. Same clone,
// its own session, branch and state folder.
fs.writeFileSync(path.join(repo, "docs", "RealFail.md"), "# Real fail plan\n\n## S1 — fails\n\nNothing can pass `exit 7`.\n")
await call("foreman_start", { planPath: "docs/RealFail.md", maxParallel: 1, maxVerify: 1 }, "ses_realfail")
assert.match(await call("foreman_graph", {
  units: [{ id: "f1", title: "fails", class: "independent", dependsOn: [], scope: ["docs/RealFail2.md"] }],
}, "ses_realfail"), /GRAPH recorded/)
assert.match(await call("foreman_step", {
  title: "cannot pass", goal: "prove the deterministic gate",
  acceptance: ["impossible"], acceptanceCommands: ["exit 7"],
  unitId: "f1", scope: ["docs/RealFail2.md"],
}, "ses_realfail"), /created/)
// A real result first: the gate refuses `good` on an open step by design.
const slotFail = await call("foreman_worktree", { step: 1 }, "ses_realfail")
const failTree = slotFail.match(/^WORKTREE: (.+)$/m)[1]
fs.writeFileSync(path.join(failTree, "docs", "RealFail2.md"), "# fail\n")
git(failTree, "add", "--", "docs/RealFail2.md")
git(failTree, "commit", "-q", "-m", "step 1: failing attempt (#1)")
assert.match(await call("foreman_result", {
  step: 1, commit: git(failTree, "rev-parse", "HEAD"), command: "exit 7", exitCode: 0,
  summary: "a real attempt whose acceptance cannot pass", worktree: failTree,
}, "ses_realfail"), /^RESULT recorded/)
const refused = await call("foreman_verify", {
  step: 1, verdict: "good", commands: [{ command: "true", exitCode: 0 }], transcript: "trying to cheat",
}, "ses_realfail")
assert.match(refused, /^REFUSED: good requires every acceptance command to exit 0/, refused)
assert.equal(readState("RealFail").steps[0].status, "implemented", "the refused verdict moved the step")
const failVerify = readStep("RealFail", 1, "verify.json")
assert.match(String(failVerify.refused ?? ""), /acceptance command failed with exit 7/, "the refusal was not recorded with the real exit code")
assert.equal(failVerify.verdict, undefined, "a refused verdict was recorded")
console.log("the plugin really executed `exit 7` in the loop checkout and refused")
assert.match(await call("foreman_stop", { reason: "real test" }, "ses_realfail"), /STOP/)

step("foreman_publish merges into a real origin/main and cleans up")
const published = await call("foreman_publish", {})
assert.match(published, /^PUBLISHED foreman\/RealTest -> main/, published)
assert.match(published, /loop checkout removed, branch foreman\/RealTest deleted/, published)
const devTip = git(origin, "rev-parse", "main")
const merged = JSON.parse(fs.readFileSync(path.join(loopDir("RealTest"), "state.json"), "utf8")).published.mergeSha
assert.doesNotThrow(() => git(origin, "merge-base", "--is-ancestor", merged, devTip), "the publish branch does not contain the merge")
assert.equal(git(origin, "log", "-1", "--format=%s", "main").includes("merge:"), true, "the publish branch has no merge commit")
assert.equal(exists(path.join(loopDir("RealTest"), "worktree")), false, "the loop checkout survived")
assert.equal(git(repo, "branch", "--list", "foreman/RealTest"), "", "the loop branch survived")
assert.equal(exists(path.join(loopDir("RealTest"), "workers", "1")), false)
assert.equal(exists(path.join(loopDir("RealTest"), "workers", "2")), false)

step("idempotent second publish")
assert.match(await call("foreman_publish", {}), /^ALREADY PUBLISHED foreman\/RealTest -> main/)

step("ledger chains")
for (const id of ["RealTest", "RealFail"]) {
  const ledger = readLedger(id)
  for (let i = 1; i < ledger.length; i += 1) {
    const prev = JSON.stringify(ledger[i - 1])
    assert.equal(ledger[i].prevHash, createHash("sha256").update(prev).digest("hex"), `${id} ledger record ${i} broke the chain`)
  }
  const types = [...new Set(ledger.map((entry) => entry.type))].sort()
  console.log(`${id}: ${ledger.length} records, chain valid, types=${types.join(",")}`)
}

if (!keep && !reuse) {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}
console.log(`\nREAL TEST PASSED${keep || reuse ? `  (fixture ${tmp})` : ""}`)
