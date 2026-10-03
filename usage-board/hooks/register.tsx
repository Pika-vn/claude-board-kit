import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, AgentRow, Git, Limit, Task, ToolError, Usage } from '../types'

const tasks = atom({ plugin: 'usage-board', key: 'tasks' } as const, [])
const usage = atom({ plugin: 'usage-board', key: 'usage' } as const, null)
const alerted = atom({ plugin: 'usage-board', key: 'alerted' } as const, [])
const git = atom({ plugin: 'usage-board', key: 'git' } as const, null)
const agents = atom({ plugin: 'usage-board', key: 'agents' } as const, [])
const NO_ACTIVITY: Activity = {
  lastTool: '',
  lastToolMs: 0,
  errors: 0,
  errorTools: [],
  errorDetails: [],
  skills: 0,
  tokensPerSec: 0,
  lastTurnAt: 0,
}

// What a failed call was doing: the command for a shell, else the file or pattern it took
function whatOf(e: Record<string, unknown>) {
  const v = e.command ?? e.file_path ?? e.notebook_path ?? e.pattern ?? e.url ?? e.description ?? ''
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 120)
}

// The line of a failed result most worth reading: one naming an error, else a warning, else the first
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

function errorReport(details: ToolError[]) {
  if (details.length === 0) return 'No tool errors this turn.'
  return details
    .map((d, i) => `${i + 1}. ${d.tool}${d.what ? ` — ${d.what}` : ''}\n   ${d.message}`)
    .join('\n')
}

// A shell command exiting non-zero is often a deliberate check ("does this exist?"), so it only warns
const SHELL_TOOLS = ['Bash', 'PowerShell']

function errorChip(tools: string[]) {
  const names = [...new Set(tools)]
  const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '')
  return {
    text: `·  ⚠ ${tools.length} error${tools.length > 1 ? 's' : ''} · ${shown}`,
    color: names.every(n => SHELL_TOOLS.includes(n)) ? C.yellow : C.red,
  }
}
const activity = atom({ plugin: 'usage-board', key: 'activity' } as const, NO_ACTIVITY)

// Palette
const C = {
  green: 0x3ddc84,
  cyan: 0x22d3ee,
  purple: 0xa78bfa,
  slate: 0x64748b,
  yellow: 0xffd23f,
  red: 0xff4d6d,
  track: 0x1a1f26,
  tick: 0x3a414b,
  ink: 0x0b0f14,
}
const DEFAULT = 0x01000000

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

function mix(a: number, b: number, t: number) {
  const k = Math.max(0, Math.min(1, t))
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function noise(i: number, f: number) {
  let x = (i * 374761393 + f * 668265263) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967295
}

// Remaining level → color: plenty green, half yellow, exhausted red
function levelColor(left: number) {
  const t = Math.max(0, Math.min(100, left)) / 100
  return t >= 0.5 ? mix(C.yellow, C.green, (t - 0.5) * 2) : mix(C.red, C.yellow, t * 2)
}

// A row as both renderers see it
type Spec = {
  key: string
  glyph: string
  label: string
  note: string
  sub?: string // second, dim line under the label
  subColor?: number
  used: number // fill fraction 0..1
  color: number
  badge: string
  right: string
  isCritical: boolean
}

// ---------- terminal: Raster cells ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    s += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return s
}

const BRAILLE = [0x28ff, 0x28f7, 0x28ef, 0x28bf, 0x287f, 0x28fe, 0x28fd, 0x28fb]

function cellsFor(spec: Spec, width: number, frame: number, isWorking: boolean) {
  const view = new DataView(new ArrayBuffer(width * 12))
  const put = (i: number, glyph: number, fg: number, bg: number) => {
    view.setUint32(i * 12, glyph, true)
    view.setUint32(i * 12 + 4, fg, true)
    view.setUint32(i * 12 + 8, bg, true)
  }

  const fillEnd = Math.round(spec.used * width)
  const shimmer = isWorking ? (frame % (width + 16)) - 8 : -100
  const pulse = spec.isCritical ? 0.5 + 0.5 * Math.sin(frame / 3) : 1

  for (let i = 0; i < width; i++) {
    if (i < fillEnd) {
      const n = noise(i, isWorking ? frame >> 1 : 0)
      const ramp = 0.35 + 0.65 * ((i + 1) / Math.max(1, fillEnd)) ** 1.6
      let fg = mix(C.track, spec.color, ramp * (0.7 + 0.3 * n))
      const glow = Math.max(0, 1 - Math.abs(i - shimmer) / 4)
      fg = mix(fg, 0xffffff, glow * 0.55)
      const bg = mix(C.track, spec.color, 0.1 + 0.12 * ramp)
      put(i, BRAILLE[Math.floor(n * BRAILLE.length)], fg, bg)
    } else {
      const isTick = [0.25, 0.5, 0.75].some(t => Math.round(t * width) === i)
      if (isTick) put(i, 0x2502, C.tick, C.track)
      else put(i, noise(i, 7) > 0.82 ? 0x2802 : 0x20, mix(C.track, 0xffffff, 0.12), C.track)
    }
  }

  // Pill badge riding the fill edge, with half-block caps
  const text = ` ${spec.badge} `
  const len = text.length + 2
  const start = Math.max(0, Math.min(width - len, fillEnd - len + 2))
  const pill = mix(C.track, spec.color, pulse)
  const capBg = start === 0 || start + len - 1 >= fillEnd ? C.track : mix(C.track, spec.color, 0.2)
  put(start, 0x2590, pill, start > 0 && start <= fillEnd ? capBg : C.track)
  for (let j = 0; j < text.length; j++) put(start + 1 + j, text.charCodeAt(j), C.ink, pill)
  put(start + len - 1, 0x258c, pill, C.track)

  return b64(new Uint8Array(view.buffer))
}

// ---------- desktop: animated SVG ----------

function svgFor(spec: Spec, isWorking: boolean) {
  const W = 420
  const H = 22
  const col = hex(spec.color)
  const fw = Math.max(0, Math.round(spec.used * W))
  const bw = Math.round(spec.badge.length * 7.2 + 22)
  const bx = Math.max(0, Math.min(W - bw, fw - bw + 6))

  let pixels = ''
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 16; x++)
      pixels += `<rect x="${x * 3}" y="${y * 3}" width="2" height="2" fill="#fff" opacity="${(noise(x + y * 16, 3) * 0.28).toFixed(2)}"/>`

  const ticks = [0.25, 0.5, 0.75]
    .map(t => `<rect x="${Math.round(t * W)}" y="7" width="1.5" height="8" rx="0.75" fill="${hex(C.tick)}"/>`)
    .join('')

  const shimmer = isWorking
    ? `<rect y="0" width="70" height="${H}" fill="url(#sh)" clip-path="url(#fc)"><animate attributeName="x" from="-70" to="${fw}" dur="1.6s" repeatCount="indefinite"/></rect>`
    : ''

  const pulse = spec.isCritical
    ? `<animate attributeName="opacity" values="1;0.55;1" dur="1.2s" repeatCount="indefinite"/>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.25"/><stop offset="1" stop-color="${col}" stop-opacity="0.95"/></linearGradient>
<linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<pattern id="px" width="48" height="12" patternUnits="userSpaceOnUse">${pixels}</pattern>
<pattern id="dt" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#fff" opacity="0.05"/></pattern>
<clipPath id="tc"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>
<clipPath id="fc"><rect width="${fw}" height="${H}"/></clipPath>
<filter id="glow" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>
<g clip-path="url(#tc)">
<rect width="${W}" height="${H}" fill="${hex(C.track)}"/>
<rect width="${W}" height="${H}" fill="url(#dt)"/>
${ticks}
<rect width="${fw}" height="${H}" fill="url(#g)"/>
<rect width="${fw}" height="${H}" fill="url(#px)"/>
${shimmer}
</g>
<g>${pulse}
<rect x="${bx}" y="2" width="${bw}" height="${H - 4}" rx="${(H - 4) / 2}" fill="${col}" opacity="0.6" filter="url(#glow)"/>
<rect x="${bx}" y="2" width="${bw}" height="${H - 4}" rx="${(H - 4) / 2}" fill="${col}"/>
<text x="${bx + bw / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="Inter,Segoe UI,system-ui,sans-serif" font-size="11.5" font-weight="700" fill="${hex(C.ink)}">${spec.badge.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
</g>
</svg>`
}

// ---------- data ----------

const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
const CACHE_TTL_MS = 5 * 60_000 // estimate: the default prompt-cache lifetime
const GIT_FALLBACK = 'C:/Program Files/Git/cmd/git.exe'

function duration(ms: number) {
  if (!(ms > 0)) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m % 60}m`
}

function commas(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function resetIn(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  return ms > 0 ? `resets in ${duration(ms).replace(/ \d+s$/, '')}` : ''
}

// Burn rate: share used vs share of the window elapsed, and when it runs out at this pace
function pace(l: Limit, now: number) {
  const win = WINDOW_MS[l.kind]
  const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  if (!win || !(reset > now) || l.percentUsed <= 0) return null
  const elapsed = Math.max(60_000, win - (reset - now))
  const ratio = l.percentUsed / 100 / (elapsed / win)
  const runsOutIn = ((100 - l.percentUsed) / l.percentUsed) * elapsed
  const runsOutFirst = now + runsOutIn < reset
  const icon = ratio > 1.15 ? '🔥' : ratio < 0.85 ? '🍃' : '⚡'
  const word = ratio > 1.15 ? 'burning fast' : ratio < 0.85 ? 'relaxed' : 'on pace'
  return {
    text: runsOutFirst ? `${icon} ${word} · runs out in ${duration(runsOutIn).replace(/ \d+s$/, '')}` : `${icon} ${word} · lasts to reset`,
    isWarning: runsOutFirst,
  }
}

function toUsage(context: { window: number; percent?: number }, limits: Limit[]): Usage {
  return { contextPercent: context.percent, contextWindow: context.window, limits }
}

function limitName(kind: string) {
  return kind === 'five_hour' ? '5-hour limit' : kind === 'seven_day' ? 'Weekly limit' : kind
}

// Tasks titled "Group: step" form one row per group; the rest fall under "Tasks"
type Group = { name: string; items: Task[] }

function groupsOf(list: Task[]): Group[] {
  const groups: Group[] = []
  for (const t of list) {
    const m = /^(.{2,40}?):\s+\S/.exec(t.title)
    const name = m ? m[1] : 'Tasks'
    let g = groups.find(x => x.name === name)
    if (!g) groups.push((g = { name, items: [] }))
    g.items.push(t)
  }
  return groups
}

function stepTitle(t: Task) {
  return t.title.replace(/^(.{2,40}?):\s+/, '')
}

function specsFor(list: Task[], u: Usage | null, crew: AgentRow[], now: number): Spec[] {
  const specs: Spec[] = []
  const running = crew.filter(a => a.status === 'running').length

  for (const g of groupsOf(list)) {
    const total = g.items.length
    const done = g.items.filter(t => t.status === 'completed').length
    const current = g.items.find(t => t.status === 'in_progress')
    const isDone = done === total
    const crewNote = crew.length > 0 ? ` · ${running}/${crew.length} agents` : ''
    specs.push({
      key: `group:${g.name}`,
      glyph: isDone ? '✓' : '●',
      label: clip(g.name, 24),
      note: isDone ? '' : `${done}/${total}`,
      sub: current ? clip(stepTitle(current), 32) : undefined,
      used: isDone ? 1 : Math.max(current ? 0.3 : 0, done / total),
      color: isDone ? C.green : current ? C.purple : C.slate,
      badge: isDone
        ? `✓ Done ${done}/${total}`
        : current
          ? `${clip(stepTitle(current), 14)} ${done + 1}/${total}${crewNote}`
          : `${done}/${total}`,
      right: `${Math.round((done / total) * 100)}%`,
      isCritical: false,
    })
  }

  // Always shown: before the first response the window reads as untouched
  if (u) {
    const usedPct = u.contextPercent ?? 0
    const left = 100 - usedPct
    const leftK = Math.round((u.contextWindow * left) / 100 / 1000)
    const total = u.contextWindow >= 1_000_000 ? `${u.contextWindow / 1_000_000}M` : `${Math.round(u.contextWindow / 1000)}k`
    specs.push({
      key: 'ctx',
      glyph: '●',
      label: 'Context window',
      note: `${leftK}k of ${total} left`,
      sub: usedPct >= 85 ? '⚠ nearly full: compact soon' : undefined,
      subColor: C.red,
      used: left / 100,
      color: levelColor(left),
      badge: `${left}% left`,
      right: `${usedPct}%`,
      isCritical: left < 20,
    })
  }

  for (const l of u?.limits ?? []) {
    const left = Math.max(0, Math.round(100 - l.percentUsed))
    const p = pace(l, now)
    specs.push({
      key: l.kind,
      glyph: '●',
      label: limitName(l.kind),
      note: resetIn(l.resetsAt, now),
      sub: p?.text,
      subColor: p?.isWarning ? C.red : undefined,
      used: left / 100,
      color: levelColor(left),
      badge: `${left}% left`,
      right: `${Math.round(l.percentUsed)}%`,
      isCritical: left < 20,
    })
  }

  return specs
}

// ---------- git ----------

let gitExe = 'git'
let gitPending: (() => void) | null = null

async function runGit($: any, args: string[]) {
  try {
    return await $.process.run([gitExe, ...args], { timeoutMs: 5000 })
  } catch {
    if (gitExe === GIT_FALLBACK) return null
    gitExe = GIT_FALLBACK
    try {
      return await $.process.run([gitExe, ...args], { timeoutMs: 5000 })
    } catch {
      return null
    }
  }
}

async function refreshGit($: any) {
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
  const add = Number(/(\d+) insertion/.exec(out)?.[1] ?? 0)
  const del = Number(/(\d+) deletion/.exec(out)?.[1] ?? 0)
  await update($, git, () => ({ repo, branch, add, del }))
}

function refreshGitSoon($: any) {
  gitPending?.()
  gitPending = $.clock.after(1500, () => {
    gitPending = null
    void refreshGit($)
  })
}

// ---------- timers (module-local, rebuilt by every render) ----------

let bandId = ''
let barWidth = 0
let drawn: Spec[] = []
let working = false
let frame = 0
let stopTimer: (() => void) | null = null
let stopTick: (() => void) | null = null

// Animates the terminal bars (shimmer while working, pulse when critical) by blitting the Rasters
function syncTimer($: any) {
  const shouldRun = drawn.length > 0 && (working || drawn.some(s => s.isCritical))
  if (shouldRun && !stopTimer) {
    stopTimer = $.clock.every(90, () => {
      frame += 1
      for (const s of drawn) {
        void $.ui.blit({ requestId: bandId, key: `bar:${s.key}`, cells: cellsFor(s, barWidth, frame, working) })
      }
    })
  } else if (!shouldRun && stopTimer) {
    stopTimer()
    stopTimer = null
  }
}

// Redraws once a second while something counts: agent timers, the cache countdown
function syncTick($: any, isNeeded: boolean) {
  if (isNeeded && !stopTick) {
    stopTick = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
  } else if (!isNeeded && stopTick) {
    stopTick()
    stopTick = null
  }
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.command.register({ name: 'board', description: 'Refresh the usage board (git, limits)' })
    $.command.register({ name: 'board-errors', description: 'Show which tool calls failed this turn and why' })
    const u = await $.session.usage()
    await update($, usage, () => toUsage(u.context, u.rateLimits))
    void refreshGit($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e.context, e.rateLimits))

    const low = e.rateLimits.filter(l => 100 - l.percentUsed < 20).map(l => l.kind)
    const was: string[] = await read($, alerted)
    for (const kind of low.filter(k => !was.includes(k))) {
      $.ui.toast(`${limitName(kind)}: under 20% left`)
    }
    if (low.join() !== was.join()) await update($, alerted, () => low)

    return next(e)
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const todos = (e.todos ?? []) as { content?: string; status?: string }[]
    await update($, tasks, () =>
      todos.map((t, i) => ({ id: String(i + 1), title: t.content ?? '', status: t.status ?? 'pending' })),
    )
    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const title = String(e.subject ?? e.title ?? 'Task')
    await update($, tasks, list => [...list, { id: String(list.length + 1), title, status: 'pending' }])
    return next(e)
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const id = String(e.taskId ?? e.id ?? '')
    const status = e.status as string | undefined
    if (id && status) {
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(t => t.id !== id)
          : list.map(t => (t.id === id ? { ...t, status } : t)),
      )
    }
    return next(e)
  })

  // Every tool call: the subagent's current tool, or the main loop's last tool, time and errors
  on('tool.call', async ($, e, next) => {
    const loop = (e as { agentId?: string }).agentId
    if (loop) {
      await update($, agents, list => list.map(a => (a.id === loop ? { ...a, tool: e.tool } : a)))
      return next(e)
    }

    const startedAt = await $.clock.now()
    const result = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const failed = (result as { isError?: boolean }).isError === true
    await update($, activity, a => ({
      ...a,
      lastTool: e.tool,
      lastToolMs: ms,
      errors: a.errors + (failed ? 1 : 0),
      errorTools: failed ? [...(a.errorTools ?? []), e.tool] : (a.errorTools ?? []),
      errorDetails: failed
        ? [
            ...(a.errorDetails ?? []),
            {
              tool: e.tool,
              what: whatOf(e as Record<string, unknown>),
              message: messageOf((result as { text?: string }).text),
            },
          ].slice(-10)
        : (a.errorDetails ?? []),
      skills: a.skills + (e.tool === 'Skill' ? 1 : 0),
    }))
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'].includes(e.tool)) refreshGitSoon($)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) {
      const id = result.agentId
      const startedAt = await $.clock.now()
      await update($, agents, list => [
        ...list.filter(a => a.status === 'running').slice(-12),
        { id, desc: e.description, tool: '', status: 'running', startedAt },
      ])
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, activity, a => ({ ...a, errors: 0, errorTools: [], errorDetails: [] }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, status: 'completed' } : a)))
      return next(e)
    }
    const now = await $.clock.now()
    const out = e.usage?.output_tokens ?? 0
    await update($, activity, a => ({
      ...a,
      lastTurnAt: now,
      tokensPerSec: out > 0 && e.durationMs > 0 ? Math.round(out / (e.durationMs / 1000)) : a.tokensPerSec,
    }))
    void refreshGit($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const now = await $.clock.now()
    const crew: AgentRow[] = await read($, agents)
    const act: Activity = await read($, activity)
    const repo: Git | null = await read($, git)
    const specs = specsFor(await read($, tasks), await read($, usage), crew, now)
    const live = crew.filter(a => a.status === 'running')
    const cacheLeft = act.lastTurnAt > 0 ? CACHE_TTL_MS - (now - act.lastTurnAt) : 0
    const showHeader = repo !== null

    syncTick($, live.length > 0 || cacheLeft > 0)

    if (specs.length === 0 && !showHeader) {
      drawn = []
      syncTimer($)
      return next(e)
    }

    working = e.props.isWorking
    const compact = () => $.session.compact()
    const activeKey = specs.find(s => s.color === C.purple)?.key ?? specs.find(s => s.key.startsWith('group:'))?.key

    const isTerminal = e.surface === 'terminal'
    const els = $.ui.resolve(e) as Record<string, any>
    const { Box, Button, Text } = els
    const Raster = els.Raster
    const Svg = els.Svg

    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? 100
    const width = Math.max(12, Math.min(64, columns - 34 - 6 - 3 - 6))
    const labelWidth = isTerminal ? 34 : '34%'

    if (isTerminal) {
      bandId = e.requestId
      barWidth = width
      drawn = specs
    } else {
      drawn = []
    }
    syncTimer($)

    const bar = (s: Spec) =>
      isTerminal && Raster ? (
        <Raster key={`bar:${s.key}`} columns={width} rows={1} cells={cellsFor(s, width, frame, working)} />
      ) : Svg ? (
        <Svg source={svgFor(s, working)} alt={`${s.label}: ${s.badge}`} isInteractive={working || s.isCritical} />
      ) : (
        <Text color={hex(s.color)}>{s.badge}</Text>
      )

    const agentRows = live.map(a => (
      <Box key={`agent:${a.id}`} flexDirection="row" gap={1}>
        <Box width={labelWidth} flexShrink={0} />
        <Box flexDirection="row" justifyContent="space-between" width={isTerminal ? width : undefined} flexGrow={isTerminal ? 0 : 1} backgroundColor="#221d36" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={hex(C.purple)}>▪</Text>
            <Text>{clip(a.desc, isTerminal ? Math.max(8, width - 26) : 48)}</Text>
            <Text color="#8b7fd4">{a.tool || 'starting'}</Text>
          </Box>
          <Text dimColor>{duration(now - a.startedAt)}</Text>
        </Box>
      </Box>
    ))

    const chips: string[] = []
    if (act.lastTurnAt > 0) chips.push(cacheLeft > 0 ? `cache ≈${duration(cacheLeft)}` : 'cache cold')
    if (act.lastTool) chips.push(`last ${act.lastTool} ${duration(act.lastToolMs)}`)
    if (crew.length > 0) chips.push(`${live.length}/${crew.length} agents`)
    if (act.skills > 0) chips.push(`${act.skills} skills`)
    if (act.tokensPerSec > 0) chips.push(`${act.tokensPerSec} tok/s`)

    return (
      <Box flexDirection="column" paddingX={1} gap={isTerminal ? 0 : 1}>
        {showHeader && repo ? (
          <Box key="git" flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={2}>
              <Text dimColor>{repo.repo}</Text>
              <Text dimColor>{repo.branch}</Text>
            </Box>
            <Box flexDirection="row" gap={1}>
              {repo.add > 0 || repo.del > 0 ? (
                <Box flexDirection="row" backgroundColor="#161b22" paddingX={1}>
                  <Text color={hex(C.green)}>+{commas(repo.add)} </Text>
                  <Text color={hex(C.red)}>-{commas(repo.del)}</Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        ) : null}
        {specs.map(s => [
          <Box key={s.key} flexDirection="row" gap={1}>
            <Box width={labelWidth} flexShrink={0} flexDirection="column">
              <Box flexDirection="row">
                <Text color={hex(s.color)}>{s.glyph} </Text>
                <Text bold>{s.label}</Text>
                <Text dimColor>{s.note ? ` › ${s.note}` : ''}</Text>
              </Box>
              {s.sub ? (
                s.subColor !== undefined ? (
                  <Text color={hex(s.subColor)}>{'  '}{s.sub}</Text>
                ) : (
                  <Text dimColor>{'  '}{s.sub}</Text>
                )
              ) : null}
            </Box>
            <Box flexGrow={isTerminal ? 0 : 1}>{bar(s)}</Box>
            <Box width={5} justifyContent="flex-end" flexShrink={0}>
              <Text dimColor>{s.right}</Text>
            </Box>
            {s.key === 'ctx' && s.used <= 0.15 ? (
              <Button key="compact" label="Compact" variant="primary" onPress={compact} />
            ) : null}
          </Box>,
          s.key === activeKey ? agentRows : null,
        ])}
        {!activeKey ? agentRows : null}
        {chips.length > 0 ? (
          <Box key="chips" flexDirection="row" justifyContent="flex-end" gap={1}>
            <Text dimColor>{chips.join('  ·  ')}</Text>
            {(act.errorTools?.length ?? 0) > 0
              ? (chip => (
                  <Button
                    key="errors"
                    plain
                    label={chip.text}
                    onPress={async () => {
                      const d = (await read($, activity)).errorDetails ?? []
                      const first = d[d.length - 1]
                      $.ui.toast(
                        first
                          ? `${first.tool}: ${first.message}${d.length > 1 ? `  (+${d.length - 1} more: /board-errors)` : ''}`
                          : 'Run /board-errors for details',
                      )
                    }}
                  />
                ))(errorChip(act.errorTools))
              : null}
          </Box>
        ) : null}
      </Box>
    )
  })

  on('command.run', { name: 'board-errors' }, async ($, e, next) => {
    const a: Activity = await read($, activity)
    return { text: errorReport(a.errorDetails ?? []) }
  })

  on('command.run', { name: 'board' }, async ($, e, next) => {
    const u = await $.session.usage()
    await update($, usage, () => toUsage(u.context, u.rateLimits))
    await refreshGit($)
    return { text: 'Usage board refreshed.' }
  })
}
