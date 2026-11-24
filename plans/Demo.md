# Demo plan

A tiny two-unit plan used to show the foreman loop turning a plan into issues
and dispatching workers. Each unit owns exactly one file and nothing else.

## Unit 1 — greeting file

Create `docs/hello-foreman.md` containing exactly one line:

    Hello from the foreman loop.

Acceptance: the file exists and contains the line `Hello from the foreman loop.`

Scope: `docs/hello-foreman.md`

## Unit 2 — version file

Create `docs/foreman-version.md` containing exactly one line:

    OpencodeForeman demo

Acceptance: the file exists and contains the line `OpencodeForeman demo`.

Scope: `docs/foreman-version.md`
