import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Activity, AgentRun, Git, Plan, PlanStage, PlanState, PlanStep, StepStatus, Timing, Tokens, ToolError, Usage } from '../types'

const TOOL = 'mcp__plan-progress-plus__plan_progress'
const plans = atom({ plugin: 'plan-progress-plus', key: 'plans' } as const, [])
const MAX_BARS = 3
// a space as wide as a digit, so '  0%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)
const isOpen = atom({ plugin: 'plan-progress-plus', key: 'isOpen' } as const, true)
const tick = atom({ plugin: 'plan-progress-plus', key: 'tick' } as const, 0)
const usage = atom({ plugin: 'plan-progress-plus', key: 'usage' } as const, null)
const showUsage = atom({ plugin: 'plan-progress-plus', key: 'showUsage' } as const, true)
const tokens = atom({ plugin: 'plan-progress-plus', key: 'tokens' } as const, { input: 0, output: 0, cacheRead: 0 })
const timing = atom({ plugin: 'plan-progress-plus', key: 'timing' } as const, { totalMs: 0, turnStartedAt: null, lastMs: 0 })
const git = atom({ plugin: 'plan-progress-plus', key: 'git' } as const, null)
const NO_ACTIVITY: Activity = { lastTool: '', lastToolMs: 0, errors: [], skills: 0, tokensPerSec: 0, lastTurnAt: 0 }
const activity = atom({ plugin: 'plan-progress-plus', key: 'activity' } as const, NO_ACTIVITY)
const alerted = atom({ plugin: 'plan-progress-plus', key: 'alerted' } as const, [])
const STRIP_H = 18
const STRIP_GAP = 3
const MAX_STRIPS = 4 // past this, the finished ones fold into one "+N more" strip
const FOLD_MS = 5000 // finished strips stay this long, failed ones stay until the bar closes

const STATE_COLOR: Record<PlanState, string> = { running: '#8B7CF6', needs_input: '#E09A1E', error: '#E5484D', done: '#30A46C' }
const STATE_GLYPH: Record<PlanState, string> = { running: '●', needs_input: '?', error: '!', done: '✓' }
const STATUSES: StepStatus[] = ['pending', 'active', 'done', 'error', 'skipped']
const TRACK_H = 22
const NARROW = 360

const RULES = `# Progress bars
Tasks needing more than ~3 edits or commands get a bar via ${TOOL}: create it once with the full breakdown (2-7 stages with short steps, or kind "todo" for one flat list; titles of at most 4 words, in the user's language), then update it with short calls only: {id, next:true} when the active step is finished, or {id, done:[...], active:"..."}, {id, failed:"...", note}. Send state "needs_input" with a note before asking the user to decide. Never describe the bars to the user.`

type Raw = Record<string, unknown>
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const status = (v: unknown): StepStatus => (STATUSES.includes(v as StepStatus) ? (v as StepStatus) : 'pending')
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []) as Raw[]
const isFinished = (s: StepStatus) => s === 'done' || s === 'skipped'

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// short updates: {next:true}, {done:[titles]}, {active:title}, {failed:title} against the stored plan
function applyOps(stages: PlanStage[], input: Raw): PlanStage[] {
  const next = stages.map(s => ({ ...s, steps: s.steps.map(st => ({ ...st })) }))
  const steps = next.flatMap(s => s.steps)
  const find = (title: string) => steps.find(st => same(st.title, title))
  if (input.next === true) {
    const at = steps.findIndex(st => st.status === 'active') >= 0 ? steps.findIndex(st => st.status === 'active') : steps.findIndex(st => !isFinished(st.status))
    const cur = steps[at]
    if (cur) cur.status = 'done'
    const following = steps.slice(at + 1).find(st => st.status === 'pending')
    if (following) following.status = 'active'
  }
  for (const t of Array.isArray(input.done) ? input.done : []) {
    const st = typeof t === 'string' ? find(t) : undefined
    if (st) st.status = 'done'
  }
  const active = typeof input.active === 'string' ? find(input.active) : undefined
  if (active) {
    const at = steps.indexOf(active)
    steps.forEach((st, i) => {
      if (st.status === 'active' && i !== at) st.status = i < at ? 'done' : 'pending'
    })
    active.status = 'active'
  }
  const failed = typeof input.failed === 'string' ? find(input.failed) : undefined
  if (failed) failed.status = 'error'

  return next
}

function normalize(input: Raw, prev: Plan | null, now: number, id: string): Plan {
  const isPartial = list(input.stages).length === 0 && prev !== null
  const stages: PlanStage[] = isPartial ? applyOps(prev.stages, input) : list(input.stages)
    .map(s => ({
      name: str(s.name, 80) || 'Stage',
      steps: list(s.steps).map(st => ({
        title: str(st.title) || 'Step',
        status: status(st.status),
        substeps: list(st.substeps).map(sub => ({ title: str(sub.title) || '…', status: status(sub.status) })),
      })),
    }))
    .filter(s => s.steps.length > 0) as PlanStage[]
  const title = str(input.title, 80) || prev?.title || 'Plan'
  const steps = stages.flatMap(s => s.steps)
  const isAllDone = steps.length > 0 && steps.every(s => isFinished(s.status))
  const asked = input.state as PlanState
  const failedNow = typeof input.failed === 'string'
  const state: PlanState = ['running', 'needs_input', 'error', 'done'].includes(asked) ? asked : isAllDone ? 'done' : failedNow ? 'error' : 'running'

  return {
    id,
    title,
    kind: input.kind === 'todo' || (isPartial && prev?.kind === 'todo') ? 'todo' : 'plan',
    stages,
    state,
    note: str(input.note, 160) || null,
    startedAt: prev && prev.title === title ? prev.startedAt : now,
  }
}

const clean = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\s*(\d+[.)]|[-*+]|\[[ xX]\])\s+/, '')
    .replace(/^(\d+[.)]|\[[ xX]\])\s+/, '')
    .trim()

function parsePlan(markdown: string, now: number): Plan | null {
  let title = ''
  const headed: PlanStage[] = []
  const items: { depth: number; text: string }[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const text = clean(h[2] ?? '')
      if (h[1] === '#' && !title) title = text
      else headed.push({ name: text, steps: [] })
      continue
    }
    const li = line.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/)
    if (!li) continue
    const depth = Math.floor((li[1] ?? '').replace(/\t/g, '  ').length / 2)
    const text = clean(li[3] ?? '').slice(0, 120)
    if (!text) continue
    items.push({ depth, text })
    const stage = headed[headed.length - 1]
    if (!stage) continue
    const step = stage.steps[stage.steps.length - 1]
    if (depth === 0 || !step) stage.steps.push({ title: text, status: 'pending', substeps: [] })
    else step.substeps.push({ title: text, status: 'pending' })
  }
  let stages = headed.filter(s => s.steps.length > 0)
  if (stages.length === 0) {
    if (items.some(i => i.depth > 0)) {
      for (const item of items) {
        const stage = stages[stages.length - 1]
        if (item.depth === 0 || !stage) stages.push({ name: item.text, steps: [] })
        else stage.steps.push({ title: item.text, status: 'pending', substeps: [] })
      }
      stages = stages.map(s => (s.steps.length ? s : { ...s, steps: [{ title: s.name, status: 'pending', substeps: [] }] }))
    } else if (items.length > 0) {
      stages = [{ name: 'Tasks', steps: items.map(i => ({ title: i.text, status: 'pending' as StepStatus, substeps: [] })) }]
    }
  }
  if (stages.length === 0) return null
  const first = stages[0]?.steps[0]
  if (first) first.status = 'active'

  return { id: 'plan', title: title || 'Plan', kind: stages.length === 1 ? 'todo' : 'plan', stages, state: 'running', note: null, startedAt: now }
}

function st(title: string, s: StepStatus): PlanStep {
  return { title, status: s, substeps: [] }
}

const DEMO = (now: number): Plan => ({
  id: 'demo',
  title: 'Orders module',
  kind: 'plan',
  state: 'running',
  note: null,
  startedAt: now - 260_000,
  stages: [
    { name: 'Analysis', steps: [st('Read modules', 'done'), st('Find dependencies', 'done'), st('List changes', 'done')] },
    { name: 'DB migration', steps: [st('Table schema', 'done'), st('Create migration', 'done'), st('Move data', 'active'), st('Indexes', 'pending')] },
    { name: 'API', steps: [st('Endpoints', 'pending'), st('Validation', 'pending'), st('Access rules', 'pending')] },
    { name: 'Interface', steps: [st('List page', 'pending'), st('Order card', 'pending'), st('Filters', 'pending'), st('Empty states', 'pending')] },
    { name: 'Verify', steps: [st('Tests', 'pending'), st('Build', 'pending')] },
  ],
})

// ---------- drawing ----------

type Where = { pos: number; total: number; stage: number; step: number; stageSize: number }

function where(p: Plan): Where {
  const steps = p.stages.flatMap((s, i) => s.steps.map((step, j) => ({ i, j, step })))
  const at = steps.findIndex(x => !isFinished(x.step.status))
  const pos = p.state === 'done' || at < 0 ? steps.length : at
  const cur = steps[Math.min(pos, steps.length - 1)]
  const stage = cur?.i ?? 0

  return { pos, total: steps.length, stage, step: pos >= steps.length ? (p.stages[stage]?.steps.length ?? 0) : (cur?.j ?? 0) + 1, stageSize: p.stages[stage]?.steps.length ?? 0 }
}

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a: number[], b: number[], m: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))
const rgb = (c: number[]) => `rgb(${c.join(',')})`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}
const textWidth = (s: string, px = 6.7) => [...s].reduce((w, ch) => w + (/[　-鿿]/.test(ch) ? 12 : /[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMWШЩЖМ]/.test(ch) ? 9.5 : px), 0)

const ICON_PATH: Partial<Record<PlanState, string>> = {
  needs_input: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  error: 'M18 6 6 18M6 6l12 12',
  done: 'M20 6 9 17l-5-5',
}

// last drawn head position per plan, so a redraw glides from where the bar was
const lastHead = new Map<string, number>()

// kept as a share of the track, so a band that only got wider or narrower does not glide
function glideFrom(key: string, frac: number, W: number) {
  const from = lastHead.get(key) ?? frac
  lastHead.set(key, frac)

  return from * W
}

function trackSvg(p: Plan, W: number): string {
  const H = TRACK_H
  const w = where(p)
  const done = p.state === 'done'
  // the fill is exactly the finished share: a fresh plan starts empty
  const frac = done ? 1 : Math.min(1, w.pos / Math.max(1, w.total))
  const fx = frac * W
  const from = glideFrom(p.id, frac, W)

  const acc = hex(STATE_COLOR[p.state])
  const light = mix(acc, [255, 255, 255], 0.32)

  const bounds: number[] = []
  let acc2 = 0
  p.stages.forEach((s, i) => {
    acc2 += s.steps.length
    if (i < p.stages.length - 1) bounds.push((acc2 / w.total) * W)
  })

  let marks = ''
  let k = 0
  p.stages.forEach((s, i) => {
    s.steps.forEach((_, j) => {
      if (k > 0) {
        const x = (k / w.total) * W
        const isStage = j === 0
        // stage boundaries are full-height lines, steps are short ticks; bright once passed
        const passed = x < fx - 1
        const h = isStage ? H : 8
        const fill = passed ? rgb(mix(light, [255, 255, 255], 0.45)) : '#8A8984'
        const opacity = passed ? (isStage ? 0.95 : 0.6) : isStage ? 0.7 : 0.45
        marks += `<rect x="${(x - (isStage ? 1 : 0.75)).toFixed(1)}" y="${(H - h) / 2}" width="${isStage ? 2 : 1.5}" height="${h}" rx=".75" fill="${fill}" opacity="${opacity}"/>`
      }
      k++
    })
    void i
  })

  // knob: a pill with stage and count, or a round dot with the stage number when narrow
  const isNarrow = W < NARROW
  const color = STATE_COLOR[p.state]
  const icon = ICON_PATH[p.state]
  const single = p.stages.length === 1
  const number = single ? Math.min(w.total, w.pos + 1) : w.stage + 1
  let knob = ''
  let kw = H
  if (isNarrow) {
    const label = done ? '' : String(number)
    knob = `<circle cx="0" cy="${H / 2}" r="${H / 2}" fill="${color}"/>${
      done ? `<path d="${ICON_PATH.done}" transform="translate(-6 5) scale(.5)" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : `<text x="0" y="${H / 2 + 4.2}" text-anchor="middle" class="kt">${label}</text>`
    }`
  } else {
    // the count alone, over the whole plan: the title beside the bar already names the step
    const count = p.id === AGENTS ? `${w.pos}/${w.total}` : `${Math.min(w.total, done ? w.total : w.pos + 1)}/${w.total}`
    const iconW = icon ? 16 : 0
    kw = Math.round(20 + iconW + textWidth(count))
    const left = -kw / 2 + 10
    knob = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>`
    if (icon) knob += `<path d="${icon}" transform="translate(${left} 5) scale(.5)" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
    knob += `<text x="${left + iconW}" y="${H / 2 + 4.2}" class="kt">${count}</text>`
  }

  return barSvg({ W, fx, from, acc, light, done, marks, knob, kw, glow: color })
}

// the pill every bar is drawn in: a pixel fill up to fx, its marks, and the knob riding the fill's head
function barSvg(b: {
  W: number
  fx: number
  from: number
  acc: number[]
  light: number[]
  done: boolean
  marks: string
  knob: string
  kw: number
  glow?: string // the knob's colour, for its halo
  isCritical?: boolean // under a fifth left: the halo pulses fast
}): string {
  const { W, fx, from, acc, light, done, marks, knob, kw, glow, isCritical } = b
  const H = TRACK_H
  const grey = [132, 130, 138]
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'
  const glide = Math.abs(from - fx) > 0.5

  // pixels: 3px grid, 7 rows, denser and closer to the state colour towards the head
  const buckets = [0, 1, 2, 3, 4].map(b => {
    const m = b / 4
    const dense = done ? 0.8 : 0.22 + 0.78 * Math.pow(m, 1.5)
    return { color: rgb(done ? light : mix(grey, light, m)), opacity: (0.35 + 0.65 * dense).toFixed(2) }
  })
  let px = ''
  for (let col = 0; col * 3 < fx; col++) {
    const x = col * 3
    const u = Math.min(1, (x + 1.5) / fx)
    const dense = done ? 0.8 : 0.22 + 0.78 * Math.pow(u, 1.5)
    const bucket = done ? 4 : Math.min(4, Math.floor(Math.min(1, Math.pow(u, 0.9) * 1.1) * 4.99))
    for (let r = 0; r < 7; r++) {
      if (hash(col, r, 1) > dense + 0.1) continue
      px += `<rect x="${x}" y="${1 + r * 3}" class="b${bucket} t${Math.floor(hash(col, r, 2) * 4)}"/>`
    }
  }

  const clampX = (x: number) => Math.max(kw / 2, Math.min(W - kw / 2, x))
  const kx = clampX(fx)
  const kFrom = clampX(from)

  const style = `<style>
.b0{fill:${buckets[0]?.color};fill-opacity:${buckets[0]?.opacity}}.b1{fill:${buckets[1]?.color};fill-opacity:${buckets[1]?.opacity}}
.b2{fill:${buckets[2]?.color};fill-opacity:${buckets[2]?.opacity}}.b3{fill:${buckets[3]?.color};fill-opacity:${buckets[3]?.opacity}}
.b4{fill:${buckets[4]?.color};fill-opacity:${buckets[4]?.opacity}}
rect[class]{width:2px;height:2px}
.t0,.t1,.t2,.t3{animation:tw ${done ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${done ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${done ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${done ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${done ? 0.8 : 0.45}}}
.kt{font:500 12px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#fff}
.kc{font-weight:400;fill-opacity:.75}
.kd{fill:#0b0f14;font-weight:700}
@media (prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>`
  const glideFill = glide ? `<animate attributeName="width" from="${from.toFixed(1)}" to="${fx.toFixed(1)}" dur=".45s" ${ease} fill="freeze"/>` : ''
  const glideKnob = glide ? `<animateTransform attributeName="transform" type="translate" from="${kFrom.toFixed(1)} 0" to="${kx.toFixed(1)} 0" dur=".45s" ${ease} fill="freeze"/>` : ''

  // motion, all looping in place so a redraw never shows a seam: eased curves, a rest between sweeps
  const swing = 'calcMode="spline" keyTimes="0;.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"'
  const hot = rgb(mix(acc, [255, 255, 255], 0.55))
  // a light sweeping the fill: out of view during its rest, so the loop restarts unseen
  const sweep =
    fx > 8 && !done
      ? `<rect y="0" width="60" height="${H}" fill="url(#sh)" clip-path="url(#fill)"><animate attributeName="x" values="-90;${(fx + 30).toFixed(1)};${(fx + 30).toFixed(1)}" keyTimes="0;.62;1" calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1" dur="5.2s" repeatCount="indefinite"/></rect>`
      : ''
  // the head of the fill breathes
  const edge =
    fx > 6 && fx < W - 2
      ? `<rect x="${(fx - 3).toFixed(1)}" y="1" width="5" height="${H - 2}" rx="2.5" fill="${hot}" filter="url(#glow)"><animate attributeName="opacity" values=".2;.85;.2" ${swing} dur="2.2s" repeatCount="indefinite"/></rect>`
      : ''
  // a halo and a glass highlight on the knob, faster and stronger when nearly out
  const halo = glow
    ? `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${glow}" filter="url(#glow)"><animate attributeName="opacity" values="${isCritical ? '.5;1;.5' : '.25;.65;.25'}" ${swing} dur="${isCritical ? '0.9s' : '2.6s'}" repeatCount="indefinite"/></rect>`
    : ''
  const gloss = `<rect x="${-kw / 2 + 4}" y="1.5" width="${Math.max(0, kw - 8)}" height="${H / 2 - 2}" rx="${H / 4}" fill="#fff" opacity=".16"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style}
<defs><clipPath id="pill"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath><clipPath id="fill"><rect width="${fx.toFixed(1)}" height="${H}">${glideFill}</rect></clipPath>
<linearGradient id="base" x1="0" x2="${fx.toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(acc)}" stop-opacity="${done ? 0.3 : 0.05}"/><stop offset="1" stop-color="${rgb(acc)}" stop-opacity=".33"/></linearGradient>
<linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<pattern id="dt" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#fff" opacity=".06"/><animateTransform attributeName="patternTransform" type="translate" from="0 0" to="6 0" dur="3s" repeatCount="indefinite"/></pattern>
<filter id="glow" x="-60%" y="-80%" width="220%" height="260%"><feGaussianBlur stdDeviation="3.5"/></filter></defs>
<g clip-path="url(#pill)"><rect width="${W}" height="${H}" fill="#808080" fill-opacity=".16"/><rect width="${W}" height="${H}" fill="url(#dt)"/>
<g clip-path="url(#fill)"><rect width="${fx.toFixed(1)}" height="${H}" fill="url(#base)"/>${px}</g>${marks}${sweep}${edge}</g>
<g transform="translate(${kx.toFixed(1)} 0)">${glideKnob}${halo}${knob}${gloss}</g></svg>`
}

// a usage meter in the same pill: filled to the share LEFT, quarter ticks, the knob saying what is left
function meterSvg(m: Meter, W: number): string {
  const H = TRACK_H
  const frac = Math.max(0, 100 - Math.min(100, m.used)) / 100
  const fx = frac * W
  const from = glideFrom(`meter:${m.key}`, frac, W)
  const acc = hex(m.color)
  const light = mix(acc, [255, 255, 255], 0.32)

  let marks = ''
  for (const q of [0.25, 0.5, 0.75]) {
    const x = q * W
    const passed = x < fx - 1
    const fill = passed ? rgb(mix(light, [255, 255, 255], 0.45)) : '#8A8984'
    marks += `<rect x="${(x - 0.75).toFixed(1)}" y="${(H - 8) / 2}" width="1.5" height="8" rx=".75" fill="${fill}" opacity="${passed ? 0.6 : 0.45}"/>`
  }

  const left = Math.max(0, 100 - m.used)
  let knob: string
  let kw = H
  if (W < NARROW) {
    // too narrow for "62% left": a plain dot, the row's % column carries the figure
    knob = `<circle cx="0" cy="${H / 2}" r="${H / 2}" fill="${m.color}"/>`
  } else {
    const num = `${left}% left`
    kw = Math.round(20 + textWidth(num))
    // dark ink: the knob runs green to yellow to red, where white text would wash out
    knob = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${m.color}"/><text x="${-kw / 2 + 10}" y="${H / 2 + 4.2}" class="kt kd">${num}</text>`
  }

  return barSvg({ W, fx, from, acc, light, done: false, marks, knob, kw, glow: m.color, isCritical: left < 20 })
}

// ---------- this chat's tokens and spend, as chips ----------

// glyph stands in for the icon where the terminal draws text
type Chip = { icon: string; glyph: string; text: string; color: string; alt: string }

const CHIP_ICON = {
  input: 'M12 15V3M7 8l5-5 5 5M4 21h16',
  output: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  cache: 'M12 3 2 8l10 5 10-5-10-5zM2 13l10 5 10-5M2 18l10 5 10-5',
  cost: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20M15 8.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2.2 0 3 6 1.6 6 4.6 0 1.4-1.3 2.2-3 2.2-1.4 0-2.5-.5-3-1.5M12 5v14',
  total: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20M12 6v6l4 2',
  task: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 1 0 0 16',
  warm: 'M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4',
  speed: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  skill: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM20 17v5H6.5A2.5 2.5 0 0 1 4 19.5',
}
const CHIP_COLOR = {
  input: '#E0735A',
  output: '#4FAE6E',
  cache: '#6E8CF0',
  cost: '#D3A23A',
  total: '#B07FD9',
  task: '#38A9B8',
  warm: '#5FB3E8',
  speed: '#E6B450',
  tool: '#9AA5B1',
  skill: '#C98BDB',
}
// estimate: the default prompt-cache lifetime after the last response
const CACHE_TTL_MS = 5 * 60_000
const tokenCount = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`)
const duration = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)

  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`
}

// tokens show once a turn has reported them, the spend once the host keeps a ledger, the times once a turn has run
function chips(t: Tokens, u: Usage | null, time: Timing, now: number, act: Activity = NO_ACTIVITY): Chip[] {
  const out: Chip[] = []
  if (t.input + t.output + t.cacheRead > 0) {
    out.push({ icon: CHIP_ICON.input, glyph: '↑', text: tokenCount(t.input), color: CHIP_COLOR.input, alt: `${tokenCount(t.input)} tokens in` })
    out.push({ icon: CHIP_ICON.output, glyph: '↓', text: tokenCount(t.output), color: CHIP_COLOR.output, alt: `${tokenCount(t.output)} tokens out` })
    out.push({ icon: CHIP_ICON.cache, glyph: '≋', text: tokenCount(t.cacheRead), color: CHIP_COLOR.cache, alt: `${tokenCount(t.cacheRead)} tokens read from cache` })
  }
  if (u?.costUsd != null) out.push({ icon: CHIP_ICON.cost, glyph: '', text: `$${u.costUsd.toFixed(2)}`, color: CHIP_COLOR.cost, alt: `$${u.costUsd.toFixed(2)} at API prices` })
  // the turn under way counts live; between turns the task chip holds the last one's length
  const running = time.turnStartedAt !== null ? Math.max(0, now - time.turnStartedAt) : null
  if (running !== null || time.totalMs > 0) {
    const total = duration(time.totalMs + (running ?? 0))
    const task = duration(running ?? time.lastMs)
    out.push({ icon: CHIP_ICON.total, glyph: '◷', text: total, color: CHIP_COLOR.total, alt: `${total} computing in this chat` })
    out.push({ icon: CHIP_ICON.task, glyph: '▸', text: task, color: CHIP_COLOR.task, alt: running !== null ? `${task} on the current task` : `last task took ${task}` })
  }
  // how long the prompt cache stays warm, in whole minutes so the row redraws once a minute at most
  if (act.lastTurnAt > 0) {
    const left = CACHE_TTL_MS - (now - act.lastTurnAt)
    const text = left > 0 ? `≈${Math.ceil(left / 60_000)}m` : 'cold'
    out.push({ icon: CHIP_ICON.warm, glyph: '⏳', text, color: CHIP_COLOR.warm, alt: left > 0 ? `cache warm for about ${text.slice(1)}` : 'cache cold' })
  }
  if (act.tokensPerSec > 0) {
    out.push({ icon: CHIP_ICON.speed, glyph: '⚡', text: `${act.tokensPerSec}/s`, color: CHIP_COLOR.speed, alt: `${act.tokensPerSec} tokens per second last turn` })
  }
  if (act.lastTool) {
    const text = `${act.lastTool} ${duration(act.lastToolMs)}`
    out.push({ icon: CHIP_ICON.tool, glyph: '⚙', text, color: CHIP_COLOR.tool, alt: `last tool ${text}` })
  }
  if (act.skills > 0) {
    out.push({ icon: CHIP_ICON.skill, glyph: '§', text: String(act.skills), color: CHIP_COLOR.skill, alt: plural(act.skills, 'skill') + ' loaded' })
  }

  return out
}

// ---------- board additions: git row, tool errors, Claude's task list ----------

// where git lives when the app's PATH lacks it: Windows installer, Homebrew (Apple silicon / Intel), Xcode tools
const GIT_FALLBACKS = ['C:/Program Files/Git/cmd/git.exe', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
let gitExe: string | null = null // the git that started last time
let gitPending: (() => void) | null = null

async function runGit($: EngineInterface, args: string[]) {
  for (const exe of gitExe ? [gitExe] : ['git', ...GIT_FALLBACKS]) {
    try {
      const result = await $.process.run([exe, ...args], { timeoutMs: 5000 })
      gitExe = exe
      return result
    } catch {
      // not installed there: try the next spot
    }
  }
  gitExe = null
  return null
}

async function refreshGit($: EngineInterface) {
  const top = await runGit($, ['rev-parse', '--show-toplevel'])
  if (!top || top.exitCode !== 0) {
    await update($, git, () => null)
    return
  }
  const repo = top.stdout.trim().split(/[\\/]/).pop() ?? ''
  const branch = (await runGit($, ['branch', '--show-current']))?.stdout.trim() || 'HEAD'
  let stat = await runGit($, ['diff', 'HEAD', '--shortstat'])
  if (!stat || stat.exitCode !== 0) stat = await runGit($, ['diff', '--cached', '--shortstat'])
  const out = stat?.stdout ?? ''
  const next: Git = {
    repo,
    branch,
    add: Number(/(\d+) insertion/.exec(out)?.[1] ?? 0),
    del: Number(/(\d+) deletion/.exec(out)?.[1] ?? 0),
  }
  if (JSON.stringify(await read($, git)) !== JSON.stringify(next)) await update($, git, () => next)
}

function refreshGitSoon($: EngineInterface) {
  gitPending?.()
  gitPending = $.clock.after(1500, () => {
    gitPending = null
    void refreshGit($)
  })
}

const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// a shell command exiting non-zero is often a deliberate check, so shell-only failures only warn
const SHELL_TOOLS = ['Bash', 'PowerShell']

// what a failed call was doing: the command for a shell, else the file or pattern it took
function whatOf(e: Raw) {
  const v = e.command ?? e.file_path ?? e.notebook_path ?? e.pattern ?? e.url ?? e.description ?? ''
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 120)
}

// the line of a failed result most worth reading: one naming an error, else a warning, else the first
function messageOf(text: string | undefined) {
  const lines = (text ?? '')
    .replace(/<\/?[a-z_]+>/gi, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^Exit code/i.test(l))
  const exit = /Exit code (\d+)/i.exec(text ?? '')?.[1]
  const hit =
    lines.find(l => /error|fatal|exception|denied|not found|not recognized|failed|cannot/i.test(l)) ??
    lines.find(l => /warning/i.test(l))
  const line = (hit ?? lines[0] ?? '').slice(0, 200)

  return exit ? `exit ${exit}: ${line}` : line || 'no message'
}

function errorButton(errors: ToolError[]) {
  const names = [...new Set(errors.map(x => x.tool))]
  const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '')

  return {
    label: `${plural(errors.length, 'error')} · ${shown}`,
    isWarnOnly: names.every(n => SHELL_TOOLS.includes(n)),
  }
}

function errorReport(errors: ToolError[]) {
  if (errors.length === 0) return 'No tool errors this turn.'
  return errors.map((d, i) => `${i + 1}. ${d.tool}${d.what ? ` — ${d.what}` : ''}\n   ${d.message}`).join('\n')
}

// a main-loop call that finished: the last tool and its time, a failure with its reason, a skill loaded
async function track($: EngineInterface, e: Raw, ran: { isError?: boolean; text?: string; deny?: string }, ms: number) {
  if (ran.deny !== undefined) return
  const tool = String(e.tool ?? '')
  const failed = ran.isError === true
  await update($, activity, a => ({
    ...a,
    lastTool: tool,
    lastToolMs: ms,
    skills: a.skills + (tool === 'Skill' ? 1 : 0),
    errors: failed ? [...a.errors, { tool, what: whatOf(e), message: messageOf(ran.text) }].slice(-10) : a.errors,
  }))
}

type TaskItem = { id: string; title: string; status: string }
// the task list as the session has it, so TaskUpdate can find TaskCreate's items; a reload starts it empty
let taskItems: TaskItem[] = []

// Claude's own task list as one bar: "Phase: step" titles group into stages, the rest under "Tasks"
function tasksPlan(items: TaskItem[], now: number, prev: Plan | undefined): Plan | null {
  const live = items.filter(t => t.status !== 'deleted')
  if (live.length === 0) return null
  const stages: PlanStage[] = []
  for (const t of live) {
    const m = /^(.{2,40}?):\s+(\S.*)$/.exec(t.title)
    const name = m ? (m[1] ?? 'Tasks') : 'Tasks'
    let stage = stages.find(s => s.name === name)
    if (!stage) stages.push((stage = { name, steps: [] }))
    const s: StepStatus = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending'
    stage.steps.push({ title: str(m ? (m[2] ?? t.title) : t.title) || 'Step', status: s, substeps: [] })
  }
  const steps = stages.flatMap(s => s.steps)
  const isDone = steps.every(s => isFinished(s.status))

  return {
    id: TASKS,
    title: 'Tasks',
    kind: stages.length === 1 ? 'todo' : 'plan',
    stages,
    state: isDone ? 'done' : 'running',
    note: null,
    startedAt: prev?.startedAt ?? now,
  }
}

async function syncTasks($: EngineInterface) {
  const now = await $.clock.now()
  const prev = (await read($, plans)).find(p => p.id === TASKS)
  const next = tasksPlan(taskItems, now, prev)
  if (next) await putPlan($, next)
  else if (prev) await dropPlan($, TASKS)
}

// tinted pills from the left, the icon in the chip's colour and the figure beside it
function chipsSvg(cs: Chip[], W: number): string {
  const H = TRACK_H
  let x = 0
  let body = ''
  for (const c of cs) {
    const w = Math.round(10 + 14 + 6 + textWidth(c.text, 7) + 10)
    if (x + w > W) break
    body += `<rect x="${x}" y="0" width="${w}" height="${H}" rx="${H / 2}" fill="${c.color}" fill-opacity=".18"/>`
    body += `<path d="${c.icon}" transform="translate(${x + 10} 4) scale(.5833)" fill="none" stroke="${c.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
    body += `<text x="${x + 30}" y="${H / 2 + 4.3}" fill="${c.color}" class="ct">${esc(c.text)}</text>`
    x += w + 8
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>.ct{font:600 12.5px ui-monospace,'Cascadia Mono',Consolas,monospace}</style>${body}</svg>`
}

const AGENT_COLOR: Record<AgentRun['state'], string> = {
  running: STATE_COLOR.running,
  waiting: STATE_COLOR.needs_input,
  done: STATE_COLOR.done,
  error: STATE_COLOR.error,
}

const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

// which strips show: all of a small batch; in a big one the unfinished first, the rest folded into one line
function visibleAgents(p: Plan, now: number): { shown: AgentRun[]; hidden: AgentRun[] } | null {
  const list = p.agents ?? []
  if (list.length === 0) return null
  const hasError = list.some(a => a.state === 'error')
  if (p.agentsDoneAt && now - p.agentsDoneAt > FOLD_MS && !hasError) return null
  if (list.length <= MAX_STRIPS) return { shown: list, hidden: [] }
  const keep = new Set(list.filter(a => a.state !== 'done').slice(0, MAX_STRIPS - 1).map(a => a.id))
  for (const a of [...list].reverse()) {
    if (keep.size >= MAX_STRIPS - 1) break
    keep.add(a.id)
  }
  return { shown: list.filter(a => keep.has(a.id)), hidden: list.filter(a => !keep.has(a.id)) }
}

// what each strip showed last time it was drawn, so a change morphs from the old status instead of jumping
const lastStrip = new Map<string, { tool: string; color: string }>()
const MORPH = '.2s'

const stripsHeight = (n: number) => n * STRIP_H + (n - 1) * STRIP_GAP

// one tinted strip per agent: state colour, name, what it does now and for how long; not a progress bar
function stripsSvg(v: { shown: AgentRun[]; hidden: AgentRun[] }, W: number, now: number): string {
  const isNarrow = W < NARROW
  const rows: string[] = []
  v.shown.forEach((a, i) => {
    const c = AGENT_COLOR[a.state]
    const y = i * (STRIP_H + STRIP_GAP)
    const indent = a.depth > 0 ? 12 : 0
    let px = ''
    if (a.state === 'running') {
      for (let col = 0; col * 3 < W; col++) {
        for (let r = 0; r < 4; r++) {
          if (hash(col + i * 41, r, 5) > 0.2) continue
          px += `<rect x="${col * 3}" y="${y + 3 + r * 3.6}" class="t${Math.floor(hash(col, r, 6) * 4)}" fill="${c}" fill-opacity=".32"/>`
        }
      }
    }
    const nameRoom = isNarrow ? W - 30 - indent : W * 0.5
    let name = (a.depth > 0 ? '↳ ' : '') + a.title
    while (name.length > 4 && textWidth(name, 6.2) > nameRoom) name = name.slice(0, -1)
    if (name !== (a.depth > 0 ? '↳ ' : '') + a.title) name = name.trimEnd() + '…'
    const nameX = 19 + indent
    const toolX = nameX + textWidth(name, 6.2) + 8
    const time = elapsed((a.endedAt ?? now) - a.startedAt)
    // a status change: the old word blurs out while the new one blurs in, and the tint flows to the new colour
    const was = lastStrip.get(a.id)
    lastStrip.set(a.id, { tool: a.tool, color: c })
    const isToolChanged = was !== undefined && was.tool !== a.tool
    const flow = (attr: string) => (was && was.color !== c ? `<animate attributeName="${attr}" from="${was.color}" to="${c}" dur="${MORPH}" fill="freeze"/>` : '')
    const tool = isNarrow
      ? ''
      : (isToolChanged ? `<text x="${toolX}" y="${y + 12.5}" class="sn mo" style="fill:${was.color}">${esc(was.tool)}</text>` : '') +
        `<text x="${toolX}" y="${y + 12.5}" class="sn${isToolChanged ? ' mi' : ''}" style="fill:${c}">${esc(a.tool)}</text>` +
        `<text x="${W - 9}" y="${y + 12.5}" text-anchor="end" class="sn st">${time}</text>`
    rows.push(
      `<rect x="0" y="${y}" width="${W}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="${c}" fill-opacity=".15">${flow('fill')}</rect>${px}` +
        `<circle cx="${10 + indent}" cy="${y + STRIP_H / 2}" r="3" fill="${c}"${a.state === 'running' ? ' class="sd"' : ''}>${flow('fill')}</circle>` +
        `<text x="${nameX}" y="${y + 12.5}" class="sn">${esc(name)}</text>` +
        tool,
    )
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length * (STRIP_H + STRIP_GAP)
    const doneCount = v.hidden.filter(a => a.state === 'done').length
    rows.push(
      `<rect x="0" y="${y}" width="${W}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="#808080" fill-opacity=".14"/>` +
        `<text x="10" y="${y + 12.5}" class="sn st">+${plural(v.hidden.length, 'more agent')} · ${doneCount} done</text>`,
    )
  }
  return `<style>.sn{font:400 11.5px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#F0EEFC}.st{fill-opacity:.65}
.sd{animation:sp 1.1s ease-in-out infinite}@keyframes sp{50%{opacity:.3}}
.mi{animation:mi ${MORPH} ease-out both}@keyframes mi{from{opacity:0;filter:blur(3px)}}
.mo{animation:mo ${MORPH} ease-in both}@keyframes mo{to{opacity:0;filter:blur(3px)}}
@media (prefers-reduced-motion:reduce){.sd,.mi,.mo{animation:none}.mo{opacity:0}}</style>${rows.join('')}`
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// ---------- current step and usage left ----------

// " › 3/5 Fill segments": the active step, else the first not yet finished (a failed one included)
function stepLabel(p: Plan): string {
  if (p.state === 'done') return ''
  const steps = p.stages.flatMap(s => s.steps)
  const at = steps.findIndex(st => st.status === 'active')
  const i = at >= 0 ? at : steps.findIndex(st => !isFinished(st.status))
  const step = steps[i]

  return step ? ` › ${i + 1}/${steps.length} ${step.title}` : ''
}

// one meter row under the task bars: a share used, and what to say about the rest
type Meter = { key: string; title: string; detail: string; used: number; color: string; alt: string; pace?: Pace }

// ---------- burn rate: share used against share of the window gone ----------

type Pace = { icon: string; text: string; isWarning: boolean }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

// 🔥 ahead of the clock, ⚡ on it, 🍃 behind it; warns when this pace runs the window dry before its reset
function paceOf(kind: string, percentUsed: number, resetsAt: string | null, now: number): Pace | undefined {
  const win = WINDOW_MS[kind]
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  if (!win || !(reset > now) || percentUsed <= 0) return undefined
  const elapsed = Math.max(60_000, win - (reset - now))
  const ratio = percentUsed / 100 / (elapsed / win)
  const runsOutAt = now + ((100 - percentUsed) / percentUsed) * elapsed
  const icon = ratio > 1.15 ? '🔥' : ratio < 0.85 ? '🍃' : '⚡'
  const isWarning = runsOutAt < reset
  const word = ratio > 1.15 ? 'burning fast' : ratio < 0.85 ? 'relaxed' : 'on pace'

  return { icon, text: isWarning ? `${word} · runs out in ${resetsIn(new Date(runsOutAt).toISOString(), now)}` : word, isWarning }
}

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }
const limitName = (kind: string) => LIMIT_NAME[kind] ?? (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/_/g, ' ')
const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
const METER_COLOR = { context: '#3E95D8', limit: '#2A9D8F' }
// the colour follows what is left: plenty green, half yellow, exhausted red, blended in between
const LEVEL = { green: [61, 220, 132], yellow: [255, 210, 63], red: [255, 77, 109] }
const meterColor = (used: number, _base?: string) => {
  const t = Math.max(0, Math.min(100, 100 - used)) / 100
  const c = t >= 0.5 ? mix(LEVEL.yellow, LEVEL.green, (t - 0.5) * 2) : mix(LEVEL.red, LEVEL.yellow, t * 2)

  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}

function resetsIn(iso: string | null, now: number) {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at) || at <= now) return ''
  // rounded up, so the last half minute still reads "1m"
  const min = Math.max(1, Math.ceil((at - now) / 60_000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)

  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${min % 60}m` : `${min}m`
}

function toUsage(u: { context: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost }): Usage {
  return {
    contextTokens: u.context.tokens ?? null,
    contextWindow: u.context.window,
    contextPercent: u.context.percent ?? null,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
    costUsd: u.cost?.usd ?? null,
  }
}

// the plain call is free; mid-turn it catches the context the last response reported
async function setUsage($: EngineInterface, u: Usage) {
  // an unchanged reading writes nothing, so the bars do not redraw for it
  if (JSON.stringify(await read($, usage)) === JSON.stringify(u)) return
  await update($, usage, () => u)
}

async function refreshUsage($: EngineInterface) {
  try {
    await setUsage($, toUsage(await $.session.usage()))
  } catch {
    // a host without figures keeps the last ones
  }
}

// the context window once a response has measured it, then each limit window the account reports
function meters(u: Usage, now: number): Meter[] {
  const out: Meter[] = []
  // an API key has no limit windows; its spend is the figure that runs out
  const spent = u.limits.length === 0 && u.costUsd !== null ? `$${u.costUsd.toFixed(2)} spent` : ''
  if (u.contextPercent !== null) {
    const used = Math.max(0, Math.min(100, Math.round(u.contextPercent)))
    const left = u.contextTokens !== null ? `${kTokens(Math.max(0, u.contextWindow - u.contextTokens))} of ${kTokens(u.contextWindow)} left` : ''
    const detail = [left, spent].filter(Boolean).join(' · ')
    out.push({ key: 'context', title: 'Context window', detail, used, color: meterColor(used, METER_COLOR.context), alt: `Context window: ${used}% used${detail ? `, ${detail}` : ''}` })
  }
  for (const l of u.limits) {
    // the engine keeps the last response's figures, so a window past its reset is drawn empty until a new reading
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    const isPast = Number.isFinite(at) && at <= now
    // past 100 on an exceeded spend limit; the bar stops full
    const used = isPast ? 0 : Math.max(0, Math.round(l.percentUsed))
    const reset = resetsIn(l.resetsAt, now)
    const detail = isPast ? 'reset' : reset ? `resets in ${reset}` : ''
    const title = limitName(l.kind)
    const pace = isPast ? undefined : paceOf(l.kind, l.percentUsed, l.resetsAt, now)
    out.push({
      key: `limit-${l.kind}`,
      title,
      detail,
      used,
      color: meterColor(used, METER_COLOR.limit),
      alt: `${title}: ${used}% used${detail ? `, ${detail}` : ''}${pace ? `, ${pace.text}` : ''}`,
      pace,
    })
  }

  return out
}

// ---------- engine glue ----------

// the engine's player first (afplay on macOS); PowerShell where it cannot play
function play($: EngineInterface, name: 'decision' | 'error' | 'done') {
  const file = `${$.plugin.root}/sounds/${name}.wav`.replace(/\//g, '\\')
  void $.audio.play({ asset: `sounds/${name}.wav` }).catch(() =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { timeoutMs: 5000 })
      .catch(() => undefined),
  )
}

// the agents bar is the mod's own; the model never owes it an update
const AGENTS = 'agents:auto' // slug() never yields ':', so no model id can take it
// the bar mirroring Claude's own task list (TaskCreate / TodoWrite); like the agents bar, the model never owes it an update
const TASKS = 'tasks:auto'
const isOpenPlan = (p: Plan) => p.id !== AGENTS && p.id !== TASKS && p.state === 'running' && !p.stages.flatMap(s => s.steps).every(s => isFinished(s.status))

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'plan'

// adds or replaces one bar by id; keeps at most MAX_BARS, dropping finished ones first
// computed inside update() from the latest list, so concurrent writers (parallel agents) do not drop each other
function placeBar(list: readonly Plan[], next: Plan): Plan[] {
  const prev = list.find(p => p.id === next.id)
  // an update keeps its row; a new bar goes to the bottom
  const rest = prev ? list.map(p => (p.id === next.id ? next : p)) : [...list, next]
  while (rest.length > MAX_BARS) {
    const doneAt = rest.findIndex(p => p.state === 'done')
    rest.splice(doneAt >= 0 ? doneAt : 0, 1)
  }
  return rest
}

function chime($: EngineInterface, prev: PlanState | undefined, next: PlanState) {
  if (next === prev) return
  if (next === 'needs_input') play($, 'decision')
  if (next === 'error') play($, 'error')
  if (next === 'done') play($, 'done')
}

async function putPlan($: EngineInterface, next: Plan) {
  let prev: Plan | undefined
  await update($, plans, list => {
    prev = list.find(p => p.id === next.id)
    return placeBar(list, next)
  })
  chime($, prev?.state, next.state)
  if (!prev) await update($, isOpen, () => true)
}

// ---------- agents: drawn from engine events alone, no model calls ----------
// each subagent lives on a bar as one state strip: the open task bar it was started under,
// the bar of its parent agent, or the mod's own "Agents" bar when no task is open.
// Module maps: a reload forgets running agents, whose strips then stay until the bar is closed.
const agentHome = new Map<string, string>() // agentId -> bar id
const toolUses = new Map<string, string>() // tool_use_id -> agentId, to find who waits on a permission
const waiting = new Set<string>()
let foldUntil = 0 // keep ticking until finished strips have folded

// the mod's own bar mirrors its agents as steps, finished first, so percent and count read done/total
function syncAuto(p: Plan, now: number): Plan {
  const agents = p.agents ?? []
  const isOver = agents.length > 0 && agents.every(a => a.state === 'done' || a.state === 'error')
  const agentsDoneAt = isOver ? (p.agentsDoneAt ?? now) : null
  if (p.id !== AGENTS) return { ...p, agentsDoneAt }
  const rank = (a: AgentRun) => (a.state === 'done' ? 0 : a.state === 'error' ? 1 : 2)
  const steps: PlanStep[] = [...agents]
    .sort((a, b) => rank(a) - rank(b))
    .map(a => ({ title: a.title, status: a.state === 'done' ? 'done' : a.state === 'error' ? 'error' : 'active', substeps: [] }))
  const state: PlanState = isOver
    ? agents.some(a => a.state === 'error') ? 'error' : 'done'
    : agents.some(a => a.state === 'waiting') ? 'needs_input' : 'running'
  return { ...p, agentsDoneAt, stages: [{ name: 'Agents', steps }], state }
}

function addRun(p: Plan, run: AgentRun, parentId: string | undefined, now: number): Plan {
  // a batch that has finished makes room for the next one
  const list = p.agentsDoneAt ? [] : [...(p.agents ?? [])]
  let at = list.length
  const parentAt = parentId ? list.findIndex(a => a.id === parentId) : -1
  if (parentAt >= 0) {
    at = parentAt + 1
    while (at < list.length && (list[at]?.depth ?? 0) > 0) at++
  }
  list.splice(at, 0, run)
  return syncAuto({ ...p, agents: list, agentsDoneAt: null }, now)
}

// changes one agent's strip inside the latest list; sounds follow the bar's state
async function editAgent($: EngineInterface, agentId: string, change: (a: AgentRun) => AgentRun) {
  const home = agentHome.get(agentId)
  if (!home) return
  const now = await $.clock.now()
  let before: PlanState | undefined
  let after: PlanState | undefined
  let isFolding = false
  await update($, plans, list =>
    list.map(p => {
      if (p.id !== home || !p.agents?.some(a => a.id === agentId)) return p
      before = p.state
      const next = syncAuto({ ...p, agents: p.agents.map(a => (a.id === agentId ? change(a) : a)) }, now)
      after = next.state
      isFolding = !p.agentsDoneAt && next.agentsDoneAt !== null
      return next
    }),
  )
  if (isFolding) foldUntil = now + FOLD_MS + 1500
  if (before !== undefined && after !== undefined) chime($, before, after)
}

async function dropPlan($: EngineInterface, id: string) {
  lastHead.delete(id)
  for (const p of await read($, plans)) if (p.id === id) for (const a of p.agents ?? []) lastStrip.delete(a.id)
  await update($, plans, list => list.filter(p => p.id !== id))
}

const STEP_SCHEMA = {
  type: 'object',
  required: ['title', 'status'],
  properties: {
    title: { type: 'string' },
    status: { enum: STATUSES },
    substeps: {
      type: 'array',
      items: { type: 'object', required: ['title', 'status'], properties: { title: { type: 'string' }, status: { enum: STATUSES } } },
    },
  },
}

// only calls that change something count as work for the enforcement below; reading and searching are free
const WORK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])
const WORK_BEFORE_PLAN = 3 // the 4th changing call without a plan is refused once
const CALLS_BEFORE_NUDGE = 6 // working calls without a plan update before a reminder


export const register: Register = on => {
  // per-turn bookkeeping; module variables are fine here, a reload just starts a fresh count
  let workCalls = 0
  let sinceUpdate = 0
  let isPlanTouched = false
  let hasRefused = false
  let isWaitingOnBackground = false

  on('turn.start', async ($, e, next) => {
    workCalls = 0
    sinceUpdate = 0
    isPlanTouched = false
    hasRefused = false
    isWaitingOnBackground = false
    // only the main loop raises turn.start; the task chip counts from here
    const startedAt = await $.clock.now()
    await update($, timing, t => ({ ...t, turnStartedAt: startedAt }))
    // tool failures count per turn
    await update($, activity, a => (a.errors.length > 0 ? { ...a, errors: [] } : a))

    return next(e)
  })

  // Claude's own task list mirrored as a bar: TodoWrite sends the whole list, TaskCreate/TaskUpdate one item each
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const todos = list((e as unknown as Raw).todos)
      taskItems = todos.map((t, i) => ({ id: String(i + 1), title: str(t.content, 120), status: str(t.status, 20) || 'pending' }))
      await syncTasks($)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const raw = e as unknown as Raw
      // the created id is in the result ("Task #3 created"); else the next number
      const id = /#?(\d+)/.exec(ran.text ?? '')?.[1] ?? String(taskItems.length + 1)
      taskItems = [...taskItems.filter(t => t.id !== id), { id, title: str(raw.subject, 120) || str(raw.title, 120) || 'Task', status: 'pending' }]
      await syncTasks($)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const raw = e as unknown as Raw
    const id = str(raw.taskId, 20) || str(raw.id, 20)
    const status = str(raw.status, 20)
    if (ran.deny === undefined && ran.isError !== true && id && (status || raw.subject)) {
      taskItems = taskItems.map(t =>
        t.id === id ? { ...t, status: status || t.status, title: str(raw.subject, 120) || t.title } : t,
      )
      await syncTasks($)
    }

    return ran
  })

  // the rule lives in the cached system prompt; a message only carries one short line when bars are open,
  // and the person answering clears any "needs input" without a model call
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const list = await read($, plans)
    if (list.some(p => p.state === 'needs_input')) {
      await update($, plans, all => all.map(p => (p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p)))
    }
    const open = list.filter(p => p.state !== 'done' && p.id !== AGENTS)
    if (open.length === 0) return next(e)
    const line = `plan-progress-plus open bars: ${open
      .map(p => {
        const w = where(p)
        return `${p.id} (${p.stages[w.stage]?.name ?? ''} ${w.step}/${w.stageSize})`
      })
      .join(', ')}`

    return next({ ...e, context: [...(e.context ?? []), line] })
  })

  // watches the main loop's changing calls: refuses once when multi-step work starts without a bar,
  // and reminds to update the bar when it goes stale mid-turn
  on('tool.call', async ($, e, next) => {
    // a subagent's call only names its current tool on its strip; no gate, no reminders
    if (e.agentId) {
      const agentId = e.agentId
      if (!agentHome.has(agentId)) return next(e)
      await editAgent($, agentId, a => ({ ...a, state: 'running', tool: e.tool }))
      if (e.tool_use_id) toolUses.set(e.tool_use_id, agentId)
      const ran = await next(e)
      if (e.tool_use_id) toolUses.delete(e.tool_use_id)
      if (waiting.delete(agentId)) await editAgent($, agentId, a => (a.state === 'waiting' ? { ...a, state: 'running' } : a))
      return ran
    }
    // the context window grows with every response, so each main-loop call reads it again
    if (!WORK_TOOLS.has(e.tool)) {
      const startedAt = await $.clock.now()
      const ran = await next(e)
      await track($, e as unknown as Raw, ran, (await $.clock.now()) - startedAt)
      await refreshUsage($)

      return ran
    }
    isWaitingOnBackground = (e as unknown as Raw).run_in_background === true
    // Claude's own running task list counts as a live plan: no need for a second bar
    const hasLivePlan = isPlanTouched || (await read($, plans)).some(p => isOpenPlan(p) || (p.id === TASKS && p.state === 'running'))
    if (!hasLivePlan && !hasRefused && workCalls >= WORK_BEFORE_PLAN) {
      hasRefused = true

      return { deny: `plan-progress-plus: several changes ahead. Create a bar with ${TOOL} first, then retry.` }
    }
    const startedAt = await $.clock.now()
    const ran = await next(e)
    await track($, e as unknown as Raw, ran, (await $.clock.now()) - startedAt)
    refreshGitSoon($)
    await refreshUsage($)
    // a shell call that only read (ls, git status, grep) is not work
    if (ran.deny !== undefined || ran.isReadOnly) return ran
    workCalls += 1
    sinceUpdate += 1
    if (hasLivePlan && sinceUpdate >= CALLS_BEFORE_NUDGE) {
      sinceUpdate = 0

      return { ...ran, context: [...(ran.context ?? []), `plan-progress-plus: bar is stale, send {id, next:true} or {id, done, active}.`] }
    }

    return ran
  })

  // an open bar at the end of a turn: a question to the user marks it waiting on its own;
  // only a turn that did work and left the bar unexplained is sent back once
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active || result.block || isWaitingOnBackground || (e.background_tasks?.length ?? 0) > 0) return result
    const open = (await read($, plans)).filter(isOpenPlan)
    if (open.length === 0) return result
    const asks = /\?\s*$/.test(e.last_assistant_message ?? '')
    if (asks) {
      const last = open[open.length - 1]
      if (last) await putPlan($, { ...last, state: 'needs_input' })

      return result
    }
    if (workCalls === 0 && !isPlanTouched) return result

    return {
      ...result,
      block: `plan-progress-plus: ${open.map(p => p.id).join(', ')} still open. Update each with ${TOOL}: {id, next:true}, or state "done", "needs_input" or "error" with a note.`,
    }
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan_progress',
      description: 'Live progress bar above the prompt, one per id. Create with title + stages; update with short ops (next, done, active, failed) or state.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Bar id; reuse it for updates' },
          title: { type: 'string' },
          kind: { enum: ['plan', 'todo'] },
          stages: {
            type: 'array',
            description: 'Full breakdown, only when creating or restructuring',
            items: { type: 'object', required: ['name', 'steps'], properties: { name: { type: 'string' }, steps: { type: 'array', items: STEP_SCHEMA } } },
          },
          next: { type: 'boolean', description: 'Active step finished, start the next one' },
          done: { type: 'array', items: { type: 'string' }, description: 'Step titles now finished' },
          active: { type: 'string', description: 'Step title now in progress' },
          failed: { type: 'string', description: 'Step title that failed' },
          state: { enum: ['running', 'needs_input', 'error', 'done'] },
          note: { type: 'string', description: 'One line for needs_input or error' },
        },
      },
    })
    // a module variable: a reload just redraws the countdown once more
    let shownMinute = 0
    $.clock.every(1000, async () => {
      const now = await $.clock.now()
      // a "resets in" countdown moves once a minute while nothing else redraws the band
      const minute = Math.floor(now / 60_000)
      const isCountdown = minute !== shownMinute && ((await read($, usage))?.limits.some(l => l.resetsAt !== null) ?? false)
      if (isCountdown) shownMinute = minute
      // the time chips count every second while a turn runs
      const isTiming = (await read($, timing)).turnStartedAt !== null && (await read($, showUsage))
      if (agentHome.size > 0 || now < foldUntil || isCountdown || isTiming) await update($, tick, n => n + 1)
    })
    await $.command.register({ name: 'progress', description: 'Show or hide the progress bars' })
    await $.command.register({ name: 'progress-demo', description: 'Show a sample plan in the progress bars' })
    await $.command.register({ name: 'progress-sounds', description: 'Play the decision, error and done sounds' })
    await $.command.register({ name: 'progress-clear', description: 'Remove all progress bars' })
    await $.command.register({ name: 'progress-usage', description: 'Show or hide the context window and usage limit bars' })
    await $.command.register({ name: 'progress-errors', description: 'Show which tool calls failed this turn and why' })
    await refreshUsage($)
    void refreshGit($)

    return next(e)
  })

  // pushed after each turn and when a limit window moves a whole point
  on('session.measure', async ($, e, next) => {
    await setUsage($, toUsage(e))

    // one toast per window as it drops under 20% left
    const low = e.rateLimits.filter(l => 100 - l.percentUsed < 20).map(l => l.kind)
    const was = await read($, alerted)
    for (const kind of low.filter(k => !was.includes(k))) $.ui.toast(`${limitName(kind)}: under 20% left`)
    if (low.join() !== was.join()) await update($, alerted, () => low)

    return next(e)
  })

  // a compacted window reports no fill until its next response; drop the old one now
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && !r.skip) await refreshUsage($)

    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'plan-progress-plus:rules', text: RULES, scope: 'session' as const }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const raw = e as unknown as Raw
    const now = await $.clock.now()
    const list = await read($, plans)
    const id = slug(str(raw.id, 60) || str(raw.title, 80))
    const next = normalize(raw, list.find(p => p.id === id) ?? null, now, id)
    if (next.stages.length === 0) return { deny: `plan_progress: no bar "${id}" yet; create it with title and stages.` }
    isPlanTouched = true
    sinceUpdate = 0
    await putPlan($, next)
    await refreshUsage($)
    const w = where(next)

    const active = next.stages.flatMap(st => st.steps).find(st => st.status === 'active')

    return { result: `${id}: ${Math.min(w.pos, w.total)}/${w.total}, ${next.state}${active ? `, active "${active.title}"` : ''}` }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const live = (await read($, plans)).filter(p => p.state === 'running').pop()
    if (live) await update($, plans, list => list.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const } : p)))
    play($, 'decision')
    const ran = await next(e)
    if (live) await update($, plans, list => list.map(p => (p.id === live.id && p.state === 'needs_input' ? { ...p, state: 'running' as const } : p)))

    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    play($, 'decision')
    const ran = await next(e)
    const text = ran.deny === undefined && ran.isError !== true ? (ran.result as { plan?: unknown } | undefined)?.plan : undefined
    if (typeof text === 'string') {
      const parsed = parsePlan(text, await $.clock.now())
      if (parsed) await putPlan($, { ...parsed, id: slug(parsed.title) })
    }

    return ran
  })

  on('command.run', { command: 'progress' }, async $ => {
    const u = await read($, usage)
    const hasMeters = (await read($, showUsage)) && u !== null && (u.contextPercent !== null || u.limits.length > 0)
    if ((await read($, plans)).length === 0 && !hasMeters) return { text: 'No plan yet. /progress-demo shows a sample.' }
    let isShown = false
    await update($, isOpen, open => (isShown = !open))

    return { text: isShown ? 'Progress bars shown.' : 'Progress bars hidden.' }
  })

  on('command.run', { command: 'progress-demo' }, async $ => {
    await putPlan($, DEMO(await $.clock.now()))
    await update($, isOpen, () => true)

    return { text: 'Sample plan shown above the prompt.' }
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    await update($, plans, () => [])

    return { text: 'Progress bars removed.' }
  })

  on('command.run', { command: 'progress-usage' }, async $ => {
    // meters on but the band closed by the Progress button count as hidden: this shows them
    const isVisible = (await read($, showUsage)) && (await read($, isOpen))
    await update($, showUsage, () => !isVisible)
    if (!isVisible) await update($, isOpen, () => true)

    return { text: isVisible ? 'Context window and usage limit bars hidden.' : 'Context window and usage limit bars shown.' }
  })

  on('command.run', { command: 'progress-errors' }, async $ => ({ text: errorReport((await read($, activity)).errors) }))

  on('command.run', { command: 'progress-sounds' }, async $ => {
    play($, 'decision')
    $.clock.after(900, () => play($, 'error'))
    $.clock.after(1800, () => play($, 'done'))

    return { text: 'Sounds: decision, error, done.' }
  })

  // always drawn, so the person sees the mod is loaded; dim while there is nothing to show
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const count = (await read($, plans)).length
    const open = await read($, isOpen)
    const u = await read($, usage)
    const hasMeters = (await read($, showUsage)) && u !== null && (u.contextPercent !== null || u.limits.length > 0)
    const { Box, Button } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    const press = () =>
      count === 0 && !hasMeters
        ? $.ui.toast('plan-progress-plus is on. A bar appears when Claude starts a task with several steps.')
        : update($, isOpen, v => !v)

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="progress-toggle" dimColor={(count === 0 && !hasMeters) || !open} label={count > 1 ? `Progress ${count}` : 'Progress'} onPress={press} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, plans)
    const u = await read($, usage)
    const now = await $.clock.now()
    // the meters stand on their own: they show with no task bar open too
    const isShowingUsage = await read($, showUsage)
    const act = await read($, activity)
    const repo = await read($, git)
    const ms = isShowingUsage ? (u ? meters(u, now) : []) : []
    // the context row shows from the first moment of a session, waiting for its first reading
    if (isShowingUsage && !ms.some(m => m.key === 'context')) {
      ms.unshift({ key: 'context', title: 'Context window', detail: 'waiting for first reply', used: 0, color: meterColor(0), alt: 'Context window: waiting for the first reply' })
    }
    const cs = isShowingUsage ? chips(await read($, tokens), u, await read($, timing), now, act) : []
    if (e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    // the terminal's table lists Svg too but draws nothing for it: it gets the text bars
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : null
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    // every bar has the same width and is pinned to the right edge (fixed-width percent, close button),
    // so rows line up whatever their titles; the slack goes into the gap after the title.
    // Desktop reports ~8 CSS px per column; glyph, gaps, percent and the close button take ~126 px.
    const measure = (xs: string[]) => Math.min(Math.round(total * 0.3), Math.max(...xs.map(s => Math.round(textWidth(s, 6.4)))))
    // plain titles set the column; step labels and meter details only take room the track can spare
    // above NARROW, and they truncate past it. They are sized by their widest form, not the text of
    // the moment, so a step moving on or a countdown ticking does not resize every bar.
    const longest = (p: Plan) => p.stages.flatMap(s => s.steps).reduce((a, s) => (s.title.length > a.length ? s.title : a), '')
    const base = measure([...list.map(p => p.title), ...ms.map(m => m.title)])
    const full = measure([
      ...list.map(p => (p.state === 'done' ? p.title : `${p.title} › 00/00 ${longest(p)}`)),
      ...ms.map(m => `${m.title} › ${m.key === 'context' ? 'waiting for first reply' : 'resets in 00h 00m'}`),
    ])
    const titleWidth = Math.max(base, Math.min(full, total - 140 - NARROW))
    const trackW = Math.max(120, Math.min(1400, total - titleWidth - 140))
    await read($, tick)
    // a hairline between task bars, so each bar and its agent strips read as one group
    const divider = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="1"><rect width="${total}" height="1" fill="#808080" fill-opacity=".22"/></svg>`
    // the meters sit under the task bars as one group: a hairline above it, none between its rows
    // the column after each bar: the same width on every row, so all bars line up and have one length
    const TRAIL = 7
    const trail = (key: string, children?: unknown) => (
      <Box key={key} width={TRAIL} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" gap={1}>
        {children ?? null}
      </Box>
    )
    const meterRows = ms.flatMap((m, i) => {
      const line = i === 0 && list.length > 0 && Svg ? [<Svg key="div:meters" source={divider} alt="" width={total} height={1} />] : []
      // the text bar fills with what is left, as the desktop bar does
      const leftBlocks = Math.round(Math.max(0, 100 - Math.min(100, m.used)) / 4)
      const bar = `${'━'.repeat(leftBlocks)}${'─'.repeat(25 - leftBlocks)}`

      return [
        ...line,
        <Box key={`meter:${m.key}`} flexDirection="row" alignItems="center" gap={1}>
          <Text color={m.color}>{'●'}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text wrap="truncate">
              {m.title}
              {m.detail ? <Text dimColor>{` › ${m.detail}`}</Text> : ''}
            </Text>
            {m.pace ? (
              m.pace.isWarning ? (
                <Text wrap="truncate" color={STATE_COLOR.error}>{`${m.pace.icon} ${m.pace.text}`}</Text>
              ) : (
                <Text wrap="truncate" dimColor>{`${m.pace.icon} ${m.pace.text}`}</Text>
              )
            ) : null}
            {m.key === 'context' && m.used >= 85 ? (
              <Box flexDirection="row">
                <Button key="compact" label="Compact" variant="primary" onPress={() => $.session.compact()} />
              </Box>
            ) : null}
          </Box>
          <Box flexGrow={1} />
          {Svg ? (
            <Svg source={meterSvg(m, trackW)} alt={m.alt} width={trackW} height={TRACK_H} />
          ) : (
            <Text>
              <Text color={m.color}>{bar.replace(/─/g, '')}</Text>
              <Text dimColor>{bar.replace(/━/g, '')}</Text>
              <Text color={m.color}>{` ${Math.max(0, 100 - m.used)}% left`}</Text>
            </Text>
          )}
          {trail(`trail:${m.key}`)}
        </Box>,
      ]
    })
    // tokens in, out and from cache, and the spend: the last row of the usage group
    const statsRow =
      cs.length > 0
        ? [
            ...(list.length > 0 && ms.length === 0 && Svg ? [<Svg key="div:stats" source={divider} alt="" width={total} height={1} />] : []),
            <Box key="meter:stats" flexDirection="row" alignItems="center" gap={1}>
              <Text dimColor>{'●'}</Text>
              <Text wrap="truncate">{'This chat'}</Text>
              {act.errors.length > 0
                ? (b => [
                    <Text key="errors-icon" color={b.isWarnOnly ? STATE_COLOR.needs_input : STATE_COLOR.error}>
                      {'⚠'}
                    </Text>,
                    <Button
                      key="errors"
                      plain
                      label={b.label}
                      onPress={async () => {
                        const errs = (await read($, activity)).errors
                        const last = errs[errs.length - 1]
                        $.ui.toast(last ? `${last.tool}: ${last.message}${errs.length > 1 ? `  (+${errs.length - 1} more: /progress-errors)` : ''}` : 'No tool errors this turn.')
                      }}
                    />,
                  ])(errorButton(act.errors))
                : null}
              <Box flexGrow={1} />
              {Svg ? (
                <Svg source={chipsSvg(cs, trackW)} alt={cs.map(c => c.alt).join(', ')} width={trackW} height={TRACK_H} />
              ) : (
                <Text>
                  {cs.map((c, i) => (
                    <Text key={`chip:${i}`} color={c.color}>{`${i > 0 ? '  ' : ''}${c.glyph}${c.text}`}</Text>
                  ))}
                </Text>
              )}
              {trail('trail:stats')}
            </Box>,
          ]
        : []

    // the repository the session works in: name, branch, and the lines changed since the last commit
    const gitRow = repo
      ? [
          <Box key="git" flexDirection="row" alignItems="center" gap={2}>
            <Text dimColor>{repo.repo}</Text>
            <Text dimColor>{repo.branch}</Text>
            <Box flexGrow={1} />
            {repo.add > 0 || repo.del > 0 ? (
              <Text>
                <Text color={STATE_COLOR.done}>{`+${commas(repo.add)}`}</Text>
                <Text>{' '}</Text>
                <Text color={STATE_COLOR.error}>{`-${commas(repo.del)}`}</Text>
              </Text>
            ) : null}
          </Box>,
        ]
      : []

    return (
      <Box flexDirection="column" gap={1}>
        {gitRow}
        {list.flatMap((p, i) => {
          const v = visibleAgents(p, now)
          const stripsH = v ? 5 + stripsHeight(v.shown.length + (v.hidden.length > 0 ? 1 : 0)) : 0
          const source = v
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="${trackW}" height="${TRACK_H + stripsH}">${trackSvg(p, trackW)}<g transform="translate(0 ${TRACK_H + 5})">${stripsSvg(v, trackW, now)}</g></svg>`
            : trackSvg(p, trackW)
          const agentsAlt = v ? `; agents: ${(p.agents ?? []).map(a => `${a.title} ${a.state}`).join(', ')}` : ''
          const line = i > 0 && Svg ? [<Svg key={`div-${p.id}`} source={divider} alt="" width={total} height={1} />] : []
          const w = where(p)
          const pct = p.state === 'done' ? 100 : Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100)
          const color = STATE_COLOR[p.state]
          const stageName = p.stages[w.stage]?.name ?? ''
          const alt =
            p.state === 'done'
              ? `${p.title}: done, ${plural(w.total, 'step')}`
              : `${p.title}: ${stageName}, step ${w.step} of ${w.stageSize}, ${pct}%${p.note ? ` — ${p.note}` : ''}${agentsAlt}`
          const bar = `${'━'.repeat(Math.round(pct / 4))}${'─'.repeat(25 - Math.round(pct / 4))}`

          return [
            ...line,
            <Box key={`bar-${p.id}`} flexDirection="row" alignItems={v ? 'flex-start' : 'center'} gap={1}>
              <Text color={color}>{STATE_GLYPH[p.state]}</Text>
              <Text wrap="truncate">
                {p.title}
                {stepLabel(p) ? <Text dimColor>{stepLabel(p)}</Text> : ''}
              </Text>
              <Box flexGrow={1} />
              {Svg ? (
                <Svg source={source} alt={alt} width={trackW} height={TRACK_H + stripsH} />
              ) : (
                <Text>
                  <Text color={color}>{bar.replace(/─/g, '')}</Text>
                  <Text dimColor>{bar.replace(/━/g, '')}</Text>
                  <Text color={color}>{` ${Math.min(w.total, p.state === 'done' ? w.total : w.pos + 1)}/${w.total}`}</Text>
                </Text>
              )}
              {trail(`trail-${p.id}`, [
                <Text key="pct" dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>,
                <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} />,
              ])}
            </Box>,
          ]
        })}
        {meterRows}
        {statsRow}
      </Box>
    )
  }).catch(async ($, e) => {
    // a drawing that failed still leaves a line, so the board never silently disappears
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>plan-progress-plus could not draw the board this time; it retries on the next update.</Text>
      </Box>
    )
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const id = started.agentId
    const now = await $.clock.now()
    const parentHome = e.parentAgentId ? agentHome.get(e.parentAgentId) : undefined
    const home = parentHome ?? [...(await read($, plans))].reverse().find(isOpenPlan)?.id ?? AGENTS
    agentHome.set(id, home)
    const run: AgentRun = {
      id,
      title: (e.description || e.subagentType).slice(0, 60),
      state: 'running',
      tool: 'Starting',
      startedAt: now,
      endedAt: null,
      depth: parentHome ? 1 : 0,
    }
    let isNew = false
    await update($, plans, list => {
      if (list.some(p => p.id === home)) return list.map(p => (p.id === home ? addRun(p, run, e.parentAgentId, now) : p))
      isNew = true
      const auto: Plan = { id: AGENTS, title: 'Agents', kind: 'todo', stages: [], state: 'running', note: null, startedAt: now }
      return placeBar(list, addRun(auto, run, undefined, now))
    })
    if (isNew) await update($, isOpen, () => true)

    return started
  })

  // an agent waiting on a permission prompt turns its strip amber until the call goes on
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const agentId = e.tool_use_id ? toolUses.get(e.tool_use_id) : undefined
    const useId = e.tool_use_id
    // the mode often settles an ask by itself in a blink; only a call still held after a moment waits on the person
    if (agentId && useId && verdict.decision === 'ask') {
      $.clock.after(600, async () => {
        if (toolUses.get(useId) !== agentId) return
        waiting.add(agentId)
        await editAgent($, agentId, a => ({ ...a, state: 'waiting', tool: 'Needs approval' }))
      })
    }

    return verdict
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId && agentHome.has(agentId)) {
      const now = await $.clock.now()
      const isFailed = e.reason !== 'answer'
      const tool = e.reason === 'aborted' ? 'Stopped' : isFailed ? 'Failed' : 'Done'
      await editAgent($, agentId, a => ({ ...a, state: isFailed ? 'error' : 'done', tool, endedAt: now }))
      // the mod's own bar sounds through its state; a strip on a task bar sounds here
      if (isFailed && agentHome.get(agentId) !== AGENTS) play($, 'error')
      agentHome.delete(agentId)
      waiting.delete(agentId)
    }
    // a plan whose steps are all finished closes itself
    for (const p of await read($, plans)) {
      if (p.id === AGENTS) continue
      if (p.state === 'done') continue
      const steps = p.stages.flatMap(s => s.steps)
      if (steps.length > 0 && steps.every(s => isFinished(s.status))) await putPlan($, { ...p, state: 'done' })
    }

    // a main-loop turn's wall-clock time goes into the chat's total
    if (!e.agentId) await update($, timing, t => ({ totalMs: t.totalMs + e.durationMs, lastMs: e.durationMs, turnStartedAt: null }))

    // the cache countdown starts at the last main-loop response; its output speed is the tok/s chip
    if (!e.agentId) {
      const endedAt = await $.clock.now()
      const out = e.usage?.output_tokens ?? 0
      await update($, activity, a => ({
        ...a,
        lastTurnAt: endedAt,
        tokensPerSec: out > 0 && e.durationMs > 0 ? Math.round(out / (e.durationMs / 1000)) : a.tokensPerSec,
      }))
      void refreshGit($)
    }

    // every turn's tokens, main and subagent alike, as the API reported them
    const done = await next(e)
    const used = done.usage
    if (used) {
      await update($, tokens, t => ({
        input: t.input + used.input_tokens + used.cache_creation_input_tokens,
        output: t.output + used.output_tokens,
        cacheRead: t.cacheRead + used.cache_read_input_tokens,
      }))
    }

    return done
  })
}
