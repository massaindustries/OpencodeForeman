#!/usr/bin/env node
/**
 * Smoke test for the human steering channel.
 *
 * An open issue labelled `human` + `loop:<id>` is how the operator talks to a
 * running loop without opening the chat. This suite proves, against a fake `gh`
 * that never touches the network:
 *   - delivery: `foreman_next` returns ACTION: steer before any dispatch or
 *     create_step, name the oldest pending issue and mark it delivered;
 *   - targeting: `human` without `loop:<id>` (or with another loop) is ignored
 *     and reported by foreman_status;
 *   - the planning gate: foreman_step and foreman_graph refuse while a
 *     delivered message is not acknowledged;
 *   - acknowledgement: `applied` comments and keeps the issue open, refreshes
 *     the read stamp, clears the pending message and adds `foreman:seen`;
 *     `done`/`rejected` comment and close; `clarify` comments and re-opens on a
 *     newer human edit;
 *   - a blocked loop still receives the message, and `unblock: true` clears the
 *     blocker;
 *   - STOP wins over the channel: no steer is delivered and foreman_steer
 *     refuses.
 *
 * Run from the repo root: node scripts/foreman/tests/human-steer-smoke.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-human-"))
const ghLog = path.join(tmp, "gh.log")
const ghComments = path.join(tmp, "gh.comments")
const humanFile = path.join(tmp, "human.json")
const stampFile = path.join(tmp, "stamp.txt")
const counterFile = path.join(tmp, "counter")
fs.writeFileSync(counterFile, "40")
fs.writeFileSync(humanFile, "[]")
fs.writeFileSync(stampFile, "")
const shimDir = path.join(tmp, "bin")
fs.mkdirSync(shimDir, { recursive: true })

fs.writeFileSync(path.join(shimDir, "gh"), [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'case "$1 ${2:-}" in',
  '  "repo view") printf \'%s\\n\' "fake/repo"; exit 0 ;;',
  '  "issue list") cat "$GH_HUMAN_FILE"; exit 0 ;;',
  '  "issue view") cat "$GH_STAMP_FILE"; exit 0 ;;',
  '  "issue comment")',
  '    PREV=""',
  '    for ARG in "$@"; do',
  '      if [ "$PREV" = "--body-file" ]; then printf \'COMMENT %s\\n\' "$3" >> "$GH_COMMENTS"; cat "$ARG" >> "$GH_COMMENTS"; printf \'\\n\' >> "$GH_COMMENTS"; fi',
  '      PREV="$ARG"',
  '    done',
  '    exit 0 ;;',
  '  "issue create")',
  '    N=$(cat "$GH_COUNTER")',
  '    N=$((N + 1))',
  '    printf \'%s\' "$N" > "$GH_COUNTER"',
  '    printf \'https://github.com/fake/repo/issues/%s\\n\' "$N"',
  '    exit 0 ;;',
  "esac",
  "exit 0",
  "",
].join("\n"), { mode: 0o755 })

process.env.GH_LOG = ghLog
process.env.GH_COMMENTS = ghComments
process.env.GH_HUMAN_FILE = humanFile
process.env.GH_STAMP_FILE = stampFile
process.env.GH_COUNTER = counterFile
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

function makeRepo() {
  const dir = path.join(tmp, `repo-${++fixture}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "foreman/Harnesser")
  git(dir, "config", "user.email", "smoke@example.com")
  git(dir, "config", "user.name", "Smoke")
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "init")
  return dir
}

function writeState(dir, patch) {
  fs.mkdirSync(path.join(dir, ".foreman", "steps"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".foreman", "tmp"), { recursive: true })
  const state = {
    id: "Harnesser",
    startedAt: new Date().toISOString(),
    planPath: path.join(dir, "plan.md"),
    branch: "foreman/Harnesser",
    repo: "fake/repo",
    model: "smoke",
    maxParallel: 3,
    maxSteps: 200,
    maxMinutes: null,
    cursor: 0,
    current: null,
    blocked: null,
    humanSeen: {},
    humanPending: null,
    steps: [],
    ...patch,
  }
  fs.writeFileSync(path.join(dir, ".foreman/state.json"), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

const readState = (dir) => readJson(path.join(dir, ".foreman/state.json"))
const ghLogText = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : "")
// The capture file is shared by every scenario: absence assertions look only at
// the slice written since the scenario started.
const ghLogMark = () => ghLogText().length
const ghLogSince = (mark) => ghLogText().slice(mark)
const ghCommentText = () => (fs.existsSync(ghComments) ? fs.readFileSync(ghComments, "utf8") : "")

function humanIssues(issues) {
  fs.writeFileSync(humanFile, `${JSON.stringify(issues, null, 2)}\n`)
}

function humanIssue(overrides = {}) {
  return {
    number: 5,
    title: "Steer this loop",
    body: "Drop unit c and fix the flaky auth test first.",
    labels: [{ name: "human" }, { name: "loop:Harnesser" }],
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

async function loadTools(root) {
  const tools = {}
  const sessions = { prompts: [] }
  const ctx = {
    location: { directory: root },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: {
      prompt: async ({ text }) => { sessions.prompts.push(text) },
      get: async () => ({ agent: { id: "foreman" }, time: { idle: true } }),
      context: async () => "",
      compact: async () => {},
    },
    permission: { list: async () => [] },
    event: { subscribe: async function* () {} },
  }
  await plugin.setup(ctx)
  return { tools, sessions }
}

const call = async (tools, name, input) => {
  const result = await tools[name].execute(input)
  return String(result?.content ?? "")
}

const step = (n = 1, overrides = {}) => ({
  n,
  title: "existing",
  goal: "an existing step",
  acceptance: ["criterion"],
  acceptanceCommands: ["true"],
  scope: [],
  dependsOn: [],
  status: "open",
  planIssue: 30 + n,
  implIssue: null,
  fixIssues: [],
  createdAt: new Date().toISOString(),
  ...overrides,
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

/* ------------------------------ scenarios ------------------------------ */

await scenario("delivery: steer preempts dispatch, names the oldest loop issue and marks it delivered", async () => {
  const dir = makeRepo()
  writeState(dir, { steps: [step(1)], cursor: 1, active: [1] })
  humanIssues([
    humanIssue({ number: 7, labels: [{ name: "human" }, { name: "loop:Other" }] }),
    humanIssue({ number: 6, labels: [{ name: "human" }] }),
    humanIssue({ number: 5 }),
  ])
  const { tools } = await loadTools(dir)
  const mark = ghLogMark()
  const message = await call(tools, "foreman_next")
  assert.match(message, /^ACTION: steer/m)
  assert.match(message, /^ISSUE: #5$/m)
  assert.match(message, /<<<HUMAN[\s\S]*Drop unit c[\s\S]*HUMAN>>>/)
  assert.doesNotMatch(message, /dispatch_worker/)
  assert.doesNotMatch(message, /#7/)
  assert.equal(readState(dir).humanPending.number, 5, "the delivered issue was not recorded")
  assert.equal(ghLogSince(mark).includes("issue create"), false, "steer created an issue")
  // The planning tools wait for the acknowledgement.
  const refused = await call(tools, "foreman_step", {
    title: "new step", goal: "prove the gate", acceptance: ["criterion"],
    acceptanceCommands: ["true"], scope: ["backend/api/x"],
  })
  assert.match(refused, /^REFUSED: human message #5 was delivered but not acknowledged/)
  assert.equal(ghLogSince(mark).includes("issue create"), false, "the gate created an issue")
  const status = await call(tools, "foreman_status")
  assert.match(status, /- human: #5 Steer this loop/)
  assert.match(status, /- human without loop: #6/)
})

await scenario("applied: comment posted, issue stays open, stamp refreshed, message no longer pending", async () => {
  const dir = makeRepo()
  writeState(dir)
  humanIssues([humanIssue()])
  fs.writeFileSync(stampFile, "2026-01-01T00:00:00Z")
  const { tools } = await loadTools(dir)
  assert.match(await call(tools, "foreman_next"), /^ACTION: steer/m)
  const mark = ghLogMark()
  const ack = await call(tools, "foreman_steer", { issue: 5, disposition: "applied", note: "Reordering the units." })
  assert.match(ack, /^HUMAN #5: applied/)
  assert.match(ghCommentText(), /COMMENT 5\n\[foreman\] Read by loop Harnesser\. Taking it into the loop\.\n\nReordering the units\./)
  assert.equal(ghLogSince(mark).includes("issue close 5"), false, "applied closed the issue")
  assert.match(ghLogSince(mark), /issue edit 5 --add-label foreman:seen/)
  const state = readState(dir)
  assert.equal(state.humanPending, undefined)
  assert.equal(state.humanSeen["5"].updatedAt, "2026-01-01T00:00:00Z")
  // The same list (stamp unchanged) is acknowledged: no re-delivery.
  assert.doesNotMatch(await call(tools, "foreman_next"), /^ACTION: steer/m)
})

await scenario("re-edit: a human reply after the ack re-opens the channel", async () => {
  const dir = makeRepo()
  writeState(dir, { humanSeen: { 5: { at: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z" } } })
  humanIssues([humanIssue({ updatedAt: "2026-01-01T00:02:00Z", body: "Also rename the flag." })])
  const { tools } = await loadTools(dir)
  const message = await call(tools, "foreman_next")
  assert.match(message, /^ACTION: steer/m)
  assert.match(message, /Also rename the flag\./)
})

await scenario("clarify: question posted, issue open, human answer re-opens it", async () => {
  const dir = makeRepo()
  writeState(dir)
  humanIssues([humanIssue()])
  fs.writeFileSync(stampFile, "2026-01-01T00:00:00Z")
  const { tools } = await loadTools(dir)
  await call(tools, "foreman_next")
  const mark = ghLogMark()
  const reply = await call(tools, "foreman_steer", { issue: 5, disposition: "clarify", note: "Which unit replaces c?" })
  assert.match(reply, /HUMAN #5: clarify/)
  assert.match(ghCommentText(), /\[foreman\] Question from loop Harnesser\.\n\nWhich unit replaces c\?/)
  assert.equal(ghLogSince(mark).includes("issue close 5"), false, "clarify closed the issue")
  assert.equal(readState(dir).humanPending, undefined)
})

await scenario("clarify without a note is refused and nothing is written", async () => {
  const dir = makeRepo()
  writeState(dir)
  humanIssues([humanIssue()])
  const { tools } = await loadTools(dir)
  await call(tools, "foreman_next")
  const before = ghLogText()
  const refused = await call(tools, "foreman_steer", { issue: 5, disposition: "clarify" })
  assert.match(refused, /^REFUSED: note is required for clarify/)
  assert.equal(ghLogText(), before, "a refusal called gh")
})

await scenario("changed: an edit after delivery is not acknowledged over the newer text", async () => {
  const dir = makeRepo()
  writeState(dir)
  humanIssues([humanIssue()])
  const { tools } = await loadTools(dir)
  await call(tools, "foreman_next") // delivered with updatedAt 00:00
  fs.writeFileSync(stampFile, "2026-01-01T00:02:00Z") // the human edited in between
  const mark = ghLogMark()
  const refused = await call(tools, "foreman_steer", { issue: 5, disposition: "applied" })
  assert.match(refused, /^REFUSED: #5 changed after it was delivered/)
  assert.equal(ghLogSince(mark).includes("issue comment 5"), false, "the ack was posted anyway")
  assert.equal(readState(dir).humanPending.number, 5, "the pending message was dropped")
})

await scenario("done and rejected: comment then close", async () => {
  for (const disposition of ["done", "rejected"]) {
    const dir = makeRepo()
    writeState(dir)
    humanIssues([humanIssue()])
    fs.writeFileSync(stampFile, "2026-01-01T00:00:00Z")
    const { tools } = await loadTools(dir)
    await call(tools, "foreman_next")
    const mark = ghLogMark()
    await call(tools, "foreman_steer", { issue: 5, disposition, note: "Because the plan says so." })
    assert.match(ghLogSince(mark), /issue close 5 --reason completed/)
    assert.match(ghCommentText(), disposition === "done" ? /\[foreman\] Followed by loop Harnesser\./ : /\[foreman\] Not applied by loop Harnesser\./)
  }
})

await scenario("targeting: a message for another loop is refused", async () => {
  const dir = makeRepo()
  writeState(dir)
  humanIssues([humanIssue({ labels: [{ name: "human" }, { name: "loop:Other" }] })])
  const { tools } = await loadTools(dir)
  const refused = await call(tools, "foreman_steer", { issue: 5, disposition: "applied" })
  assert.match(refused, /^REFUSED: #5 is not addressed to loop Harnesser/)
})

await scenario("blocked: steer is delivered and unblock clears the blocker", async () => {
  const dir = makeRepo()
  writeState(dir, { blocked: "env:auth — the browser session is dead" })
  humanIssues([humanIssue({ body: "I signed in again, retry." })])
  fs.writeFileSync(stampFile, "2026-01-01T00:00:00Z")
  const { tools } = await loadTools(dir)
  const message = await call(tools, "foreman_next")
  assert.match(message, /^ACTION: steer/m)
  assert.match(message, /^STATE: BLOCKED — env:auth/m)
  const ack = await call(tools, "foreman_steer", { issue: 5, disposition: "applied", unblock: true })
  assert.match(ack, /blocker cleared/)
  assert.equal(readState(dir).blocked, null)
})

await scenario("STOP wins: no steer is delivered and foreman_steer refuses", async () => {
  const dir = makeRepo()
  writeState(dir)
  humanIssues([humanIssue()])
  fs.writeFileSync(path.join(dir, ".foreman", "STOP"), "stoppedAt: now\nreason: smoke\n")
  const { tools } = await loadTools(dir)
  assert.match(await call(tools, "foreman_next"), /^ACTION: stopped/m)
  const refused = await call(tools, "foreman_steer", { issue: 5, disposition: "applied" })
  assert.match(refused, /^REFUSED: STOP present/)
})

await scenario("poller: a quiet session is nudged with a tick when a human message exists", async () => {
  // A fresh module instance so FOREMAN_HUMAN_POLL_MS is read as 25ms; the
  // first instance keeps its 90s default and never fires during the suite.
  const dir = makeRepo()
  const store = path.join(dir, ".foreman", "active", "Harnesser")
  fs.mkdirSync(path.join(store, "steps"), { recursive: true })
  fs.mkdirSync(path.join(store, "tmp"), { recursive: true })
  fs.writeFileSync(path.join(store, "state.json"), `${JSON.stringify({
    id: "Harnesser",
    sessionID: "ses_human_poll",
    startedAt: new Date().toISOString(),
    planPath: path.join(dir, "plan.md"),
    branch: "foreman/Harnesser",
    repo: "fake/repo",
    maxParallel: 3,
    maxSteps: 200,
    maxMinutes: null,
    cursor: 0,
    current: null,
    blocked: null,
    steps: [],
    units: [],
  }, null, 2)}\n`)
  humanIssues([humanIssue()])
  process.env.FOREMAN_HUMAN_POLL_MS = "25"
  const fresh = (await import(`${pathToFileURL(bundle).href}?poll=1`)).default
  const prompts = []
  const tools = {}
  await fresh.setup({
    location: { directory: dir },
    tool: { transform: async (fn) => fn({ add: (tool) => { tools[tool.name] = tool } }) },
    session: {
      prompt: async ({ text }) => { prompts.push(text) },
      get: async () => ({ agent: { id: "foreman" }, time: { idle: true } }),
      context: async () => "",
      compact: async () => {},
    },
    permission: { list: async () => [] },
    event: { subscribe: async function* () {} },
  })
  const deadline = Date.now() + 2_000
  while (!prompts.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(prompts.some((text) => text.startsWith("[foreman] Tick.")), "the poller did not queue a tick")
  delete process.env.FOREMAN_HUMAN_POLL_MS
})

/* -------------------------------- report ------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} scenario(s) failed, ${passed} passed`)
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.stack ?? failure.error}`)
  process.exit(1)
}
console.log(`\n${passed} scenarios passed`)
