# Demo

| File | What it is |
| --- | --- |
| `demo.gif` | 24 s, 1.4 MB — the inline README clip: the loop turning a plan into real GitHub issues, then those issues on GitHub. |
| `demo.mp4` | 80 s — the full cut: TUI boot → `/foreman start` → the loop working → GitHub issue list → issue detail. |
| `demo/capture.mjs` | the headless terminal recorder that produced the TUI segment (Windows; opens no window). |
| `demo/keys.json` | the keystrokes the recorder types — `/foreman start plans/Demo.md`. |

## What the clip shows

This is not a drill and not simulated typing: it is a headless capture of the real
OpenCode TUI running the throwaway `plans/Demo.md`.

1. `foreman_start` opens the loop on its own branch and creates the first **step**
   as a real GitHub issue — `[Demo] Step 1: …`, labelled `foreman:plan`,
   `loop:Demo` and `step:1`.
2. The tick dispatches a worker into an isolated git worktree and launches a
   background subagent.
3. `foreman_verify` re-runs the step's acceptance commands, records the evidence,
   and closes the issue as `foreman:verified`.

The GitHub frames at the end are the repository as it looked right after the run.

## How it was recorded

The TUI is captured through a ConPTY, so **no terminal window is opened** — it works
in CI or over SSH. On Windows:

```sh
npm i -D @homebridge/node-pty-prebuilt-multiarch
node docs/demo/capture.mjs docs/demo.cast 200 . docs/demo/keys.json
```

Then render the cast and stitch the video (`agg` and a static `ffmpeg` build are the
only tools needed):

```sh
# asciicast -> GIF
agg --speed 3.2 --idle-time-limit 0.8 --font-size 15 --line-height 1.3 \
  --theme dracula --cols 120 --rows 34 docs/demo.cast docs/demo-tui.gif

# trimmed TUI GIF + headless GitHub screenshots -> MP4
ffmpeg -y -i docs/demo-tui.gif -loop 1 -t 6 -i gh-issues.png -loop 1 -t 7 -i gh-issue1.png \
  -filter_complex "[0:v]trim=start=46:end=60,setpts=PTS-STARTPTS,fps=25,scale=1280:820:force_original_aspect_ratio=decrease,pad=1280:820:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1[v0];[1:v]scale=1280:820:force_original_aspect_ratio=decrease,pad=1280:820:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1,fps=25[v1];[2:v]scale=1280:820:force_original_aspect_ratio=decrease,pad=1280:820:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1,fps=25[v2];[v0][v1][v2]concat=n=3:v=1:a=0[out]" \
  -map "[out]" -c:v libx264 -crf 21 -pix_fmt yuv420p -movflags +faststart docs/demo.mp4
```

The GitHub screenshots are ordinary headless-browser captures; nothing is retouched.
On macOS/Linux the same cast can be produced with
`asciinema record --headless -c opencode`, so the recorder script is only needed on
Windows.

## Keeping it small

GitHub renders the inline GIF straight from the README, so keep it under ~2 MB —
large GIFs are slow on mobile. Anything longer belongs in the MP4, which the README
links to instead.
