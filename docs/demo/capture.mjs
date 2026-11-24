// capture.mjs — record the real OpenCode TUI into an asciicast v2 file through a
// headless ConPTY. No terminal window is ever opened, so it also works in CI.
//
//   node capture.mjs <out.cast> <seconds> <cwd> [keys.json]
//
// keys.json is an array of { at: <ms>, data: "<keys>" }: keystrokes typed into the
// session at that offset. Environment:
//   REC_CMD   command to run in the TUI (default: opencode)
//   REC_COLS  terminal columns (default: 120)
//   REC_ROWS  terminal rows    (default: 34)
import mod from "@homebridge/node-pty-prebuilt-multiarch"
import fs from "node:fs"

const pty = mod?.spawn ? mod : (mod?.default ?? mod)

const out = process.argv[2] || "demo.cast"
const seconds = Number(process.argv[3] || 8)
const cwd = process.argv[4] || process.cwd()
const keysFile = process.argv[5] || ""
const cols = Number(process.env.REC_COLS || 120)
const rows = Number(process.env.REC_ROWS || 34)
const command = process.env.REC_CMD || "opencode"

const fd = fs.openSync(out, "w")
const t0 = process.hrtime.bigint()
const now = () => Number(process.hrtime.bigint() - t0) / 1e9
const emit = (e) => fs.writeSync(fd, JSON.stringify(e) + "\n")

emit({ version: 2, width: cols, height: rows, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color" } })

// Windows runs the command through cmd.exe; on macOS/Linux pass it straight to sh.
const shell = process.platform === "win32" ? "cmd.exe" : "sh"
const argv = process.platform === "win32" ? ["/c", command] : ["-lc", command]

const p = pty.spawn(shell, argv, {
  name: "xterm-256color",
  cols, rows, cwd,
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
})

p.onData((d) => { try { emit([now(), "o", d]) } catch {} })
p.onExit(({ exitCode }) => console.error(`[capture] pty exit ${exitCode} at ${now().toFixed(2)}s`))

if (keysFile) {
  const keys = JSON.parse(fs.readFileSync(keysFile, "utf8").replace(/^\uFEFF/, ""))
  for (const step of keys) setTimeout(() => {
    try { emit([now(), "i", step.data]); p.write(step.data) } catch (e) { console.error("[capture] input err", e.message) }
  }, step.at)
}

setTimeout(() => {
  try { p.kill() } catch {}
  try { fs.closeSync(fd) } catch {}
  console.error(`[capture] done, ${seconds}s -> ${out}`)
  process.exit(0)
}, seconds * 1000)
