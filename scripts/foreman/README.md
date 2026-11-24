# Foreman

The foreman loop as one self-contained folder, so it can be synced to another
machine by copying `scripts/foreman/`.

| Path | Contents |
| --- | --- |
| `plugin.ts` | the plugin: state, GitHub ledger, worktrees, ticks, compaction, context pruning, tool handlers |
| `drill.mjs` | end-to-end drill for the loop (phases A–C, plan access and token hygiene) |
| `concurrency-probe.mjs` | lock and race probes |
| `tests/` | `acceptance-`, `guards-` and `multi-loop-` smoke suites |
| `tests/plugin-stub.ts` | the `@opencode/plugin` stub used by the suites |
| `fake-bin/` | fake `gh` used by the drill: no network |

## OpenCode entry point

OpenCode only discovers plugins under `.opencode/plugins/`, so
`.opencode/plugins/foreman-loop/index.ts` is a three-line shim that re-exports
`scripts/foreman/plugin.ts`. Everything else lives here.

## Syncing to another machine

Copy `scripts/foreman/` and recreate the shim at
`.opencode/plugins/foreman-loop/index.ts`:

```ts
export * from "../../../scripts/foreman/plugin"
export { default } from "../../../scripts/foreman/plugin"
```

Also copy the foreman agent, command and skill:
`.opencode/agents/foreman.md`, `.opencode/commands/foreman.md`,
`.opencode/skills/always-awake-agent/`.

## Configuration

The plugin is generic: every project-specific value is configuration, seeded
from the environment and refined from `.foreman/foreman.config.json` (read
relative to the loop's directory) when the plugin starts. Environment variables
always win over the file, so a per-invocation override is possible.

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `model` | `FOREMAN_MODEL` | _(inherit)_ | Model pinned on step briefs and dispatch instructions |
| `publishBranch` | `FOREMAN_PUBLISH_BRANCH` | `main` | Branch a complete plan is merged into |
| `liveCommand` | `FOREMAN_LIVE_COMMAND` | _(none)_ | Command that moves the running stack onto the publish merge |
| `barrels` | `FOREMAN_BARRELS` | `[]` | Shared contract surfaces only an integration step may touch |
| `authLaneFallback` | `FOREMAN_AUTH_LANE_FALLBACK` | _(none)_ | Stack URL when a browser lane names none |
| `authHealCommand` | `FOREMAN_AUTH_HEAL_COMMAND` | _(none)_ | Command that heals an expired sign-in; unset = no auth preflight |
| `authLaneMarker` | `FOREMAN_AUTH_LANE_MARKER` | _(none)_ | Regex marking an acceptance command as a browser lane |
| `authLaneEnv` | `FOREMAN_AUTH_LANE_ENV` | _(none)_ | Env var a browser lane exports its stack URL as |
| `authPasswordEnv` | `FOREMAN_AUTH_PASSWORD_ENV` | _(none)_ | Env var carrying the password command for the heal |
| `webPort` | `FOREMAN_WEB_PORT` | _(none)_ | Optional web port shown in status/instructions |
| `apiPort` | `FOREMAN_API_PORT` | _(none)_ | Optional API port shown in status/instructions |

`barrels` accepts a comma- or newline-separated list (or a JSON array). Example
`.foreman/foreman.config.json`:

```json
{
  "publishBranch": "main",
  "liveCommand": "npm run live",
  "barrels": ["shared/contracts/src/index.ts"]
}
```

With no `authHealCommand` there is no auth preflight at all, so a project that
does not use a browser lane pays nothing for the feature.

## Checks

```sh
npx esbuild .opencode/plugins/foreman-loop/index.ts --outfile=/dev/null
node scripts/foreman/drill.mjs
node scripts/foreman/concurrency-probe.mjs
node scripts/foreman/tests/guards-smoke.mjs
node scripts/foreman/tests/acceptance-smoke.mjs
node scripts/foreman/tests/multi-loop-smoke.mjs
node scripts/foreman/tests/human-steer-smoke.mjs
node scripts/foreman/tests/repo-pointer-smoke.mjs
node scripts/foreman/tests/real-stack.mjs     # real clone, real node_modules, real merge (~1 min)
```

`real-stack.mjs` is the one that is not a fixture: it clones the real
repository (shared objects), hardlinks the real `node_modules`, runs a worker
commit through a real worktree and a real cherry-pick, executes the acceptance
commands with the repository's own dependencies, merges into a real bare
`origin/<publish branch>` and checks the cleanup. A local `gh` shim and an `npm`
shim (only the configured live switch is stubbed) keep it off GitHub and off the
running stack. `FOREMAN_REAL_REPO=<dir>` reuses a prepared fixture,
`FOREMAN_REAL_KEEP=1` keeps the temp clone for inspection.

## Repository pointer

The ledger lives in the repository **configured for the directory**: `foreman`
resolves it with `gh repo view` from the loop checkout (`ctx.location.directory`)
and pins every `gh` call with an explicit `--repo <owner/name>`. Foreman therefore
creates its issues in the repo that directory points at — change it with
`git remote set-url origin …` and the ledger follows on the next start or resume.

The slug is resolved at start, refreshed on resume, and stored as `state.repo`;
`STARTED`/`RESUMED` and `foreman_status` print it. Pinning matters because `gh`
otherwise resolves the target from ambient state: a `GH_REPO` set in the session
environment (or a worker whose cwd differs) would silently divert issues, and
`gh repo view` ignores `GH_REPO` while `gh issue …` honours it. With `--repo` the
two agree, so the loop cannot write to a repo other than the directory's own. When
no slug can be resolved (a legacy loop, or a checkout whose remote `gh` cannot
read) the flag is omitted and `gh` falls back to its normal resolution.

## Human channel

An open GitHub issue labelled `human` **and** `loop:<Loop>` is a steering
message for that loop only. The operator writes free text in the body: no chat,
no session needed.

| Step | What happens |
| --- | --- |
| delivery | `foreman_next` polls the open `human` issues, filters `loop:<id>` and returns `ACTION: steer` before `blocked`, `create_step` and every dispatch. The body is handed over delimited as data; the plugin never executes it |
| gate | until the message is acknowledged, `foreman_step` and `foreman_graph` refuse; in-flight workers keep running |
| acknowledgement | `foreman_steer` with `applied` comments “read, taking it into the loop” and keeps the issue open; `clarify` posts a question and stays open; `rejected` and `done` comment and close |
| unblock | `unblock: true` clears `state.blocked` when the message answers the blocker |
| re-read | `state.humanSeen` stores the `updatedAt` stamp read *after* our own comment, so an ack never re-delivers itself; a human reply bumps it and re-opens the channel |
| ignored | a `human` issue without `loop:<id>` is never acted on and `foreman_status` reports it |

The plugin also runs a dedicated poller so a quiet or blocked session is nudged:
`FOREMAN_HUMAN_POLL_MS` (default `90000`) is the interval between polls. STOP
still wins over the channel, and the body can never weaken acceptance or bypass
`foreman_verify`.

## Plan access and context

The plan is never attached to the prompt: `/foreman start plans/X.md` (no `@`)
keeps the file on disk. `foreman_plan` returns a verbatim heading or line range
with line numbers; `foreman_step` stores the same range as `planRef` and puts
the exact `sed -n '<start>,<end>p' <path>` command in the issue. A compaction
uses a state-derived summary (plan path, active steps, ledger tail) and never
summarises the plan body. Old tool results, reasoning and subagent reports are
clipped from later requests; the plan pointer, the compaction summary and the
newest evidence stay intact.

`FOREMAN_COMPACT_TOKENS` (default `100000`) is the automatic compaction
threshold. `FOREMAN_CONTEXT_PRUNE=off` disables request pruning.

## Dispatch tracking

`ctx.tool.hook("execute.after")` records the child session id of every
`subagent` launch. A live child is never re-dispatched, regardless of the
lease. Two fast paths clear a dead one: the session registry is asked every poll
cycle (`FOREMAN_HUMAN_POLL_MS`, 90s) and on every tick, so a child that no longer
exists is recorded as `dispatch_end … gone` immediately; the lease
(`FOREMAN_DISPATCH_LEASE_MS`, default 20m) only covers a dispatch whose child id
was never recorded. `DISPATCH_MAX_MS` (6h) is the last-resort bound and is
deliberately generous: re-dispatching a slow, healthy worker duplicates work.
If a child ends without a result, inspect its worktree and call
`foreman_dispatch_failed` instead of relaunching blindly.

## Parallelism

Two budgets, both printed by `foreman_status` and `foreman_next`:

| Knob | Default | Holds |
| --- | --- | --- |
| `maxParallel` | 4 | `open` + `fixing` steps, i.e. workers that can run now. `0` means no cap: every active open/fixing step is dispatched in the same tick (the per-tick `create_step` budget stays `maxCreatePerTick`) |
| `maxVerify` | 2 | `implemented` steps waiting for a verdict. Verifiers overlap; the plugin's own acceptance runs are serialised per loop (shared checkout and local database), and a cherry-pick that moves `HEAD` during a run triggers one automatic re-run |
| `maxCreatePerTick` | 6 | `create_step` offers per tick. The ramp of a wide plan: raise it so a scale factory exposes more of its graph per turn. The free worker budget and the pipeline cap (`maxParallel + maxVerify`) still bound how many are actually taken |

A tick offers one `create_step` per ready unit with a disjoint scope, up to the
free worker budget, and dispatches every open step in the same tick. Every
worker, a lone one included, is launched with `background: true`: the tick ends
right after the launch, so the loop keeps creating units and verifying while the
workers run. The total pipeline is capped at `maxParallel + maxVerify`. Every
dispatch is a `dispatch` ledger record, and `foreman_status` reports the peak
concurrent workers with the minutes spent at two or more.

## Attempts and rework

One worktree per **step**, not per issue, and the plugin owns it: `foreman_worktree`
creates it detached at the loop branch tip, wipes the previous attempt and shares
the install from the loop checkout (`FOREMAN_WORKTREE_LINK`):

| Mode | Cost for 1.7GB / ~200k files | Trade-off |
| --- | --- | --- |
| `hardlink` (default) | ~1 min, same inodes | `git clean -fdx` unlinks only that tree's links |
| `symlink` | instant | the install is shared: a worker that ran `npm install` would mutate it |
| `copy` | minutes, full disk | isolated, for a filesystem without links |

A new tree therefore costs a minute at worst instead of a full `npm ci`, and a
fix reuses the tree it already has (no install at all). The fix issue carries
the previous attempt's commit and worktree. `foreman_result` refuses a commit
that does not descend from the `BASE` the plugin handed out: a stale tree is
what turns into a cherry-pick conflict or a silent revert later. A worker that
creates its own tree anyway gets it retired, the recorded tree stays canonical.

The verifier gets one slot per loop (`kind: "verifier"`, `.foreman/active/<Loop>/verify-worktree`),
also pre-installed, reset before each verify so it never sees the worker's work
in progress.

Trees are disposable: a verified step retires its tree on the spot, a resume
sweeps the ones a stop or a crash left behind, and `foreman_publish` removes
every remaining tree, the verifier slot, the loop checkout and the loop branch
once the merge is provably contained in the publish branch on `origin`.
