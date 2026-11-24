---
description: Foreman loop control — /foreman start <plan> | stop | status
agent: foreman
---

Foreman loop control. Argument: `$ARGUMENTS`.

The `foreman-loop` plugin owns state, STOP and ticks. Do exactly one case, then
stop.

- **start `<path-to-plan>` [maxParallel]** — the path is required. If it is
  missing, print exactly:
  `[foreman] Usage: /foreman start <path-to-plan> [maxParallel] | stop | status`
  and stop. Otherwise call `foreman_start` with `planPath` set to the first
  argument (resolve relative paths against the repo root). A second non-negative
  integer is passed as `maxParallel` (`0` = no worker cap; default 4). Issues are
  created in the repository configured for this directory (`gh repo view`), pinned
  per call, so the ledger follows `origin` even if `GH_REPO` is set. The path
  may be written with or without `@`: the plugin strips any plan attachment,
  the plan stays on disk, and `foreman_plan` reads the exact sections. It is
  never summarised. The loop id, branch
  (`foreman/<plan name without .md>`) and worktree are derived automatically;
  this session then drives that loop only. This command turn **is** the
  first tick: after `foreman_start`, call `foreman_next` and do the returned
  action. Do not ask for confirmation.
- **stop** — call `foreman_stop` with reason `manual stop`. Report the STOP
  path. Do not delete the file.
- **status** — call `foreman_status` and report plan, branch, cursor, open
  issues, last verdict and STOP state. Do not dispatch anything.
- **empty or anything else** — print exactly:
  `[foreman] Usage: /foreman start <path-to-plan> [maxParallel] | stop | status`

When `foreman_next` returns `ACTION: plan complete` (every unit has a verified
step and nothing is in flight), call `foreman_publish` to merge the loop branch
into the configured publish branch, push it and move the running stack onto that
merge, then call `foreman_stop` with reason `plan complete` and report it once.

To steer a running loop without opening the chat, open an issue on GitHub with
the labels `human` and `loop:<Name>` (for example `loop:Harnesser`) and write the
message in the body. `foreman_next` returns `ACTION: steer`, the foreman reads it
and acknowledges it with `foreman_steer`: it comments when it starts, asks with
`clarify` when something is missing, and closes the issue when it has followed
it (`done`) or rejected it (`rejected`). Use `unblock: true` when the message
answers a blocker.

The loop only commits on its own branch. The configured publish branch is the
sacred branch: a complete plan is merged there by `foreman_publish` and the
running stack serves it (via the configured live switch command). No other
branch and no extra long-running port: a scratch port is allowed only for one
test and must be stopped before the turn ends.
Never start the loop in a session whose agent is not `foreman`. Never fake a
STOP removal and never accept a step without `foreman_verify`.
