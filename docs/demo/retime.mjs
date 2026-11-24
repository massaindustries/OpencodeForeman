// retime2.mjs — piecewise retime an asciicast v2 file into a tighter cut.
//   node retime2.mjs <src.cast> <dst.cast> <segments.json>
//
// segments.json is a list of keep-windows, each { from, to, speed }. Time inside a
// window is compressed by `speed` (1 = real time); everything outside every window is
// dropped. That is how we cut the boot idle and time-lapse the "working" stretch while
// leaving the typing and the summary at normal speed.
import fs from "node:fs"

const [, , src, dst, segFile] = process.argv
const segments = JSON.parse(fs.readFileSync(segFile, "utf8"))

const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean)
const header = JSON.parse(lines[0])
const ev = lines.slice(1).map((l) => JSON.parse(l))

let acc = 0
const segs = segments.map((s) => {
  const o = { ...s, offset: acc, dur: (s.to - s.from) / s.speed }
  acc += o.dur
  return o
})

const map = (t) => {
  for (const s of segs) if (t >= s.from && t <= s.to) return s.offset + (t - s.from) / s.speed
  return null
}

const out = [header]
let last = 0
for (const e of ev) {
  const nt = map(e[0])
  if (nt === null) continue
  last = nt
  out.push([nt, e[1], e[2]])
}
fs.writeFileSync(dst, out.map((o) => JSON.stringify(o)).join("\n") + "\n")
console.log("segments: " + segs.map((s) => `${s.from}-${s.to}s @${s.speed}x = ${s.dur.toFixed(2)}s`).join(" | "))
console.log("total " + last.toFixed(2) + "s, events kept " + (out.length - 1))
