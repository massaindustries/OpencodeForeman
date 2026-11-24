# Demo

| File | What it is |
| --- | --- |
| `demo.gif` | 26 s, 1.6 MB — the inline README clip: the loop turning a plan into real GitHub issues, then those issues on GitHub. |
| `demo.mp4` | 34 s — the full cut: TUI boot → `/foreman start` → the loop working → GitHub issue list → issue detail. |
| `demo/capture.mjs` | the headless terminal recorder that produced the TUI segment (Windows; opens no window). |
| `demo/keys.json` | the keystrokes the recorder types — `/foreman start plans/Demo.md`. |
| `demo/retime.mjs` | the piecewise retimers that cut the boot idle and time-lapse the "working" stretch. |
| `demo/segments.json` | the keep-windows for `retime.mjs` (see *Trimming the dead time*). |

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

The raw capture is the honest, unedited run. That run took ~200 s of wall clock, but
almost all of it is the model thinking: the command is typed at ~12 s and the first
tick only prints its summary at ~194 s. So before rendering, the cast is retimed.

### Trimming the dead time

`demo/retime.mjs` keeps a list of windows and compresses time inside each one by a
factor (`demo/segments.json`):

| Window | Speed | Kept |
| --- | --- | --- |
| 1.0 – 2.5 s | 1× | a short opening beat so it doesn't start mid-action |
| 11.6 – 13.9 s | 1× | the command being typed and submitted |
| 13.9 – 194.4 s | 12× | the 180 s of "working" time-lapsed |
| 194.4 – 200 s | 1× | the summary: *issue #1 created, worker dispatched* |

Everything outside the windows is dropped, so the 200 s run becomes a 24 s clip with
no idle.

```sh
node docs/demo/retime.mjs docs/demo.cast docs/demo-tight.cast docs/demo/segments.json
```

### Rendering

`agg` and a static `ffmpeg` build are the only tools needed. Render the cast at its
natural size (1006×644) so there is no letterboxing, then stitch it to the GitHub
stills — the stills are cover-cropped to the same frame, so every second of the MP4
is edge to edge:

```sh
# asciicast -> GIF (1x; the retime already removed the dead time)
agg --speed 1 --idle-time-limit 1.5 --last-frame-duration 0.6 --font-size 15 \
  --line-height 1.3 --theme asciinema docs/demo-tight.cast docs/demo-tui.gif

# TUI + headless GitHub screenshots -> MP4, edge to edge
ffmpeg -y -i docs/demo-tui.gif -loop 1 -t 4 -i gh-issues.png -loop 1 -t 5 -i gh-issue1.png \
  -filter_complex "[0:v]fps=25,scale=1006:644,setsar=1[v0];[1:v]scale=1006:644:force_original_aspect_ratio=increase,crop=1006:644,setsar=1,fps=25[v1];[2:v]scale=1006:644:force_original_aspect_ratio=increase,crop=1006:644,setsar=1,fps=25[v2];[v0][v1][v2]concat=n=3:v=1:a=0[out]" \
  -map "[out]" -c:v libx264 -crf 21 -pix_fmt yuv420p -movflags +faststart docs/demo.mp4
```

The inline GIF is the same TUI segment plus the two stills, built at 15 fps to stay
small:

```sh
ffmpeg -y -i docs/demo-tui.gif -loop 1 -t 2.5 -i gh-issues.png -loop 1 -t 2.5 -i gh-issue1.png \
  -filter_complex "[0:v]trim=end=21,setpts=PTS-STARTPTS,fps=15,scale=872:558,setsar=1[a];[1:v]scale=872:558:force_original_aspect_ratio=increase,crop=872:558,setsar=1,fps=15[b];[2:v]scale=872:558:force_original_aspect_ratio=increase,crop=872:558,setsar=1,fps=15[c];[a][b][c]concat=n=3:v=1:a=0[cat];[cat]split[s1][s2];[s1]palettegen=stats_mode=diff[p];[s2][p]paletteuse=dither=bayer:bayer_scale=3[out]" \
  -map "[out]" -loop 0 docs/demo.gif
```

The GitHub screenshots are ordinary headless-browser captures; nothing is retouched.
On macOS/Linux the same cast can be produced with
`asciinema record --headless -c opencode`, so the recorder script is only needed on
Windows.

### Why `--theme asciinema`

A terminal theme colours the *empty* cells too. The app draws its own near-black
panels (`#131313`), but the cells around them use the theme background — with a lighter
theme (Dracula is `#282a36`) that shows up as a grey frame around the whole TUI. The
`asciinema` theme's background (`#121314`) matches the panels almost exactly, so the
frame disappears and nothing else is recoloured.

## Keeping it small

GitHub renders the inline GIF straight from the README, so keep it under ~2 MB —
large GIFs are slow on mobile. Anything longer belongs in the MP4, which the README
links to instead.
