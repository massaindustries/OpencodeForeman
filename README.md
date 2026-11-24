# OpencodeForeman

A **config-driven, always-awake foreman loop** for [OpenCode](https://opencode.ai).
One self-contained plugin turns a plan into a graph of units, dispatches parallel
workers into isolated git worktrees, verifies each one against its acceptance
criteria, and — once every unit is verified — publishes the finished plan.

Everything project-specific is configuration, not code. Out of the box it assumes
nothing about your repository: no barrels, no auth lane, no publish branch beyond
`main`.

## What it does

- **Plans as graphs.** A plan becomes units with scopes, dependencies, seams and a
  class (`independent`, `serial`, `seam-parallel`, `integration`). The loop opens
  work in dependency order and refuses overlapping scopes.
- **Parallel workers.** Each step runs in its own git worktree, launched with
  `background: true`, so the loop keeps creating and verifying while workers run.
- **A real verifier.** `foreman_verify` re-runs the acceptance commands and records
  evidence; a verified step retires its worktree.
- **A GitHub ledger.** Steps, plans, fixes and human steering all live as issues,
  pinned to the repository the directory points at.
- **A human channel.** An open issue labelled `human` **and** `loop:<Loop>` is a
  free-text steering message for that loop — no chat, no session needed.
- **Publishing.** `foreman_publish` merges the loop branch into the configured
  publish branch, moves the running stack onto the merge (if a live command is
  configured), and retires every worktree.

## Layout

| Path | Contents |
| --- | --- |
| `scripts/foreman/plugin.ts` | the plugin: state, GitHub ledger, worktrees, ticks, compaction, context pruning, tool handlers |
| `scripts/foreman/drill.mjs` | end-to-end drill for the loop (phases A–C, plan access and token hygiene) |
| `scripts/foreman/concurrency-probe.mjs` | lock and race probes |
| `scripts/foreman/tests/` | smoke suites (`guards`, `acceptance`, `multi-loop`, `human-steer`, `parallel-scale`, `repo-pointer`, `real-stack`) |
| `.opencode/plugins/foreman-loop/index.ts` | the three-line re-export OpenCode discovers |
| `.opencode/agents/foreman.md` | the `foreman` agent |
| `.opencode/commands/foreman.md` | the `/foreman` command |
| `.opencode/skills/always-awake-agent/` | the operating skill |

OpenCode only discovers plugins under `.opencode/plugins/`, so
`.opencode/plugins/foreman-loop/index.ts` re-exports `scripts/foreman/plugin.ts`.
The whole harness lives in `scripts/foreman/` so it can be dropped into a project
as one folder.

## Install

Copy the harness into your project:

```sh
cp -r scripts/foreman  <your-repo>/scripts/foreman
mkdir -p <your-repo>/.opencode/plugins/foreman-loop
printf 'export * from "../../../scripts/foreman/plugin"\nexport { default } from "../../../scripts/foreman/plugin"\n' \
  > <your-repo>/.opencode/plugins/foreman-loop/index.ts
cp -r .opencode/agents .opencode/commands .opencode/skills <your-repo>/.opencode/
```

Then, in `<your-repo>`:

```sh
npm install --save-dev esbuild typescript @types/node
```

`gh` must be installed and authenticated; the loop creates its ledger in the
repository the directory's `origin` remote points at.

## Configuration

Every project-specific value is configuration, seeded from the environment and
refined from `.foreman/foreman.config.json` (read relative to the loop's
directory) when the plugin starts. Environment variables always win over the
file.

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

Example `.foreman/foreman.config.json`:

```json
{
  "publishBranch": "main",
  "liveCommand": "npm run live",
  "barrels": ["shared/contracts/src/index.ts"]
}
```

`barrels` accepts a comma- or newline-separated list (or a JSON array). With no
`authHealCommand` there is no auth preflight at all, so a project that does not
use a browser lane pays nothing for the feature.

## Usage

Start a loop from a plan in the `foreman` agent (or via `/foreman start plans/X.md`).
The plugin exposes the tools the agent drives:

| Tool | Role |
| --- | --- |
| `foreman_start` / `foreman_stop` | begin and end a loop |
| `foreman_plan` | read a verbatim heading or line range of the plan |
| `foreman_graph` | declare the plan's units, dependencies, scopes and seams |
| `foreman_next` | ask what to do now (creates steps, dispatches workers, delivers human steering) |
| `foreman_step` | create or update a step |
| `foreman_worktree` | create/reset a step's worktree |
| `foreman_result` | record a worker's commit and acceptance run |
| `foreman_verify` | verify a step and record evidence |
| `foreman_dispatch_failed` | retire a dispatch whose child died without a result |
| `foreman_handoff` | hand a loop to another session |
| `foreman_steer` | acknowledge a human-channel message |
| `foreman_status` / `foreman_ledger` | inspect the loop and its issue ledger |
| `foreman_publish` | merge a complete plan into the publish branch |

## Development

```sh
npm install
npm run typecheck        # tsc --noEmit against the local @opencode/plugin stub
npm run foreman:drill    # phases A–C end-to-end (fake gh, no network)
npm run foreman:concurrency
npm run foreman:test     # guards, acceptance, multi-loop, human-steer, parallel-scale, repo-pointer
npm run foreman:real     # a real clone + real merge (~1 min)
```

The smoke suites use a fake `gh` and shell stubs, so they are POSIX-oriented and
run cleanly under WSL, macOS or Linux. `real-stack.mjs` is the only one that
touches real git objects and a real `node_modules`.

See [`scripts/foreman/README.md`](scripts/foreman/README.md) for the full harness
documentation (repository pointer, human channel, plan access and context,
dispatch tracking, parallelism, attempts and rework).

## License

MIT — see [`LICENSE`](LICENSE).
