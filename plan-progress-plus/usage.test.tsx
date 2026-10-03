import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__plan-progress-plus__plan_progress'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const START = Date.parse('2026-10-02T12:00:00Z')

const usageAt = (now: number) => ({
  value: {
    startedAt: 0,
    context: { tokens: 76_000, window: 200_000, percent: 38 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 29, resetsAt: new Date(now + (2 * 60 + 14) * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 92 },
    ],
    cost: { usd: 1.5 },
  },
})

const PLAN = {
  tool: TOOL,
  id: 'ticks',
  title: 'Start at zero',
  kind: 'todo',
  stages: [
    {
      name: 'Tasks',
      steps: [
        { title: 'Reset bar', status: 'done' },
        { title: 'Draw ticks', status: 'done' },
        { title: 'Fill segments', status: 'active' },
        { title: 'Add label', status: 'pending' },
      ],
    },
  ],
} as const

test('a task bar shows its step, and a bar each for the context window and the limits under it', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  on('session.usage', async () => usageAt(now))
  await $.tool.call(PLAN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: / › 3\/4 Fill segments/ })).toBeDefined()
    const context = (await ui.find({ key: 'meter:context' }))?.text ?? ''
    expect(context).toContain('Context window')
    expect(context).toContain('124k of 200k left')
    // no "% used" column: the bar itself says what is left
    const hour = (await ui.find({ key: 'meter:limit-five_hour' }))?.text ?? ''
    expect(hour).toContain('5-hour limit')
    expect(hour).toContain('resets in 2h 14m')
    const week = (await ui.find({ key: 'meter:limit-seven_day' }))?.text ?? ''
    expect(week).toContain('Weekly limit')
    expect(context).not.toContain('spent')
    if (surface === 'desktop') {
      const svg = await ui.find({ type: 'Svg', alt: /Context window: 38% used/ })
      expect(svg).toBeDefined()
    } else {
      // the terminal draws text bars, never an Svg
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      // the text bar fills with what is left and says so
      expect(context).toContain('62% left')
      expect(hour).toContain('71% left')
      expect(week).toContain('8% left')
      expect(context).not.toContain('38%')
      // the knob's place holds the count alone
      expect(await ui.find({ type: 'Text', text: /^ 3\/4$/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a meter fills with what is left, its knob says "% left", and its colour follows the level', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  on('session.usage', async () => usageAt(now))
  await $.tool.call(PLAN)
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'desktop', ...BAND })
  type Node = { type?: string; props?: { source?: string }; children?: unknown[] }
  // the Svg inside one meter row
  const svgOf = async (key: string) => {
    const row = (await ui.find({ key })) as Node | undefined
    const svg = (row?.children ?? []).find(c => (c as Node)?.type === 'Svg') as Node | undefined
    return String(svg?.props?.source ?? '')
  }
  const context = await svgOf('meter:context')
  const width = Number(/<clipPath id="fill"><rect width="([\d.]+)"/.exec(context)?.[1])
  const track = Number(/<svg[^>]* width="(\d+)"/.exec(context)?.[1])
  // 62% left of the track, not the 38% used
  expect(Math.round((width / track) * 100)).toBe(62)
  expect(context).toContain('62% left')
  // 92% of the week used: 8% left reads red and pulses fast
  const week = await svgOf('meter:limit-seven_day')
  expect(week).toContain('8% left')
  expect(week).toContain('fill="#ff')
  expect(week).toContain('dur="0.9s"')
  // the motion: a sweep and a breathing head
  expect(context).toContain('url(#sh)')
  expect(context).toContain('filter="url(#glow)"')
  await ui.unmount()
})

test('every row ends in the same fixed-width column, so all bars line up at one length', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  on('session.usage', async () => usageAt(now))
  on('turn.complete', async () => ({ text: 'ok', usage: { model: 'm', input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 0 } }))
  await $.tool.call(PLAN)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface, ...BAND })
    // cells on the terminal, columns on the desktop: room for a task bar's close button and nothing else
    for (const key of ['trail-ticks', 'trail:context', 'trail:limit-five_hour', 'trail:limit-seven_day', 'trail:stats']) {
      const box = (await ui.find({ key })) as { props?: { width?: number } } | undefined
      expect(box?.props?.width).toBe(surface === 'terminal' ? 2 : 3)
    }
    if (surface === 'desktop') {
      // every bar is drawn at one width, and wide: the band is 160 columns, about 1280 px
      const widths = new Set<number>()
      for (const key of ['bar-ticks', 'meter:context', 'meter:limit-five_hour', 'meter:limit-seven_day']) {
        const row = (await ui.find({ key })) as { children?: { type?: string; props?: { width?: number } }[] } | undefined
        widths.add(Number(row?.children?.find(c => c?.type === 'Svg')?.props?.width))
      }
      expect(widths.size).toBe(1)
      expect([...widths][0]).toBeGreaterThan(800)
    }
    // a task bar's end column holds its close button only, no %
    expect((await ui.find({ key: 'trail-ticks' }) as { text?: string } | undefined)?.text ?? '').not.toContain('%')
    // the meters carry no number after the bar
    expect((await ui.find({ key: 'trail:context' }) as { text?: string } | undefined)?.text ?? '').toBe('')
    await ui.unmount()
  }
})

test('the meters show with no task open and have no close button: they stay up', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  on('session.usage', async () => usageAt(now))
  // a bar update reads the usage; closing the bar leaves only the meters
  await $.tool.call(PLAN)
  await $.command.run({ command: 'progress-clear' })
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'meter:context' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / › 3\/4/ })).toBeUndefined()
  expect(await ui.find({ key: 'close-meter:context' })).toBeUndefined()
  expect(await ui.find({ key: 'close-meter:stats' })).toBeUndefined()
  await ui.unmount()
})

test('a limit burning faster than its clock says so, and when it runs out', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  // 29% of the 5-hour window used with 2h 14m to go is behind the clock; 92% of the week with 6 days to go is far ahead
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      context: { tokens: 76_000, window: 200_000, percent: 38 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 29, resetsAt: new Date(now + (2 * 60 + 14) * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 92, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
      ],
    },
  }))
  await $.tool.call(PLAN)
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
  expect((await ui.find({ key: 'meter:limit-five_hour' }))?.text ?? '').toContain('🍃 relaxed')
  const week = (await ui.find({ key: 'meter:limit-seven_day' }))?.text ?? ''
  expect(week).toContain('🔥 burning fast · runs out in')
  await ui.unmount()
})

test('Claude\'s own task list shows as a bar, "Phase: step" titles grouped into stages', async ($, on) => {
  mock.clock(on, { now: START })
  on('session.usage', async () => usageAt(START))
  let n = 0
  // the engine's task tools, as the bottom of the chain answers them
  on('tool.call', { tool: 'TaskCreate' }, async () => ({ result: {}, text: `Task #${++n} created successfully` }))
  on('tool.call', { tool: 'TaskUpdate' }, async () => ({ result: {}, text: 'Updated task' }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Build: Write code', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Build: Run tests', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship: Release', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
  const bar = (await ui.find({ key: 'bar-tasks:auto' }))?.text ?? ''
  expect(bar).toContain('Tasks')
  expect(bar).toContain('› 2/3 Run tests')
  // no % number after the bar: only its close button
  expect(bar).not.toContain('33%')
  await ui.unmount()
})

test('a failed tool call shows an error button naming the tool; a turn starts it over', async ($, on) => {
  mock.clock(on, { now: START })
  on('session.usage', async () => usageAt(START))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Read' }, async () => ({ result: {}, text: '<tool_use_error>File does not exist.</tool_use_error>', isError: true }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/nope.txt' })
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'errors', label: '1 error · Read' })).toBeDefined()
  await ui.unmount()
  const report = await $.command.run({ command: 'progress-errors' })
  expect(report.text).toContain('Read — /nope.txt')
  expect(report.text).toContain('File does not exist.')
  await $.turn.start({ text: 'again', turnId: 't2' })
  const after = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
  expect(await after.find({ key: 'errors' })).toBeUndefined()
  await after.unmount()
})

test('the git row names the repository, the branch and the lines changed', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  on('session.usage', async () => usageAt(START))
  on('process.run', async ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const stdout = args.startsWith('rev-parse') ? '/work/contentbrowser\n' : args.startsWith('branch') ? 'codex/134-blender-previews\n' : ' 12 files changed, 62181 insertions(+), 959 deletions(-)\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Edit' }, async () => ({ result: {}, text: 'ok' }))
  // an edit refreshes the git row once the burst settles
  await $.tool.call(PLAN)
  await $.tool.call({ tool: 'Edit', file_path: '/work/contentbrowser/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
  const row = (await ui.find({ key: 'git' }))?.text ?? ''
  expect(row).toContain('contentbrowser')
  expect(row).toContain('codex/134-blender-previews')
  expect(row).toContain('+62,181 -959')
  await ui.unmount()
})

test('a limit window past its reset is drawn empty, not at its old fill', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(now - 60_000).toISOString() }],
    },
  }))
  await $.tool.call(PLAN)
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'desktop', ...BAND })
  // a fresh window has no context fill yet: its row waits rather than vanishing
  expect((await ui.find({ key: 'meter:context' }))?.text ?? '').toContain('waiting for first reply')
  const hour = (await ui.find({ key: 'meter:limit-five_hour' }))?.text ?? ''
  expect(hour).toContain('5-hour limit › reset')
  // a fresh window is all left: the bar is full, not at its old 8%
  const row = (await ui.find({ key: 'meter:limit-five_hour' })) as { children?: { type?: string; props?: { source?: string } }[] } | undefined
  const svg = String(row?.children?.find(c => c?.type === 'Svg')?.props?.source ?? '')
  expect(svg).toContain('100% left')
  expect(svg).not.toContain('8% left')
  await ui.unmount()
})

test('a row of chips counts this chat\'s tokens and spend', async ($, on) => {
  mock.clock(on, { now: START })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 4.713 } } }))
  on('turn.complete', async () => ({
    text: 'ok',
    usage: { model: 'm', input_tokens: 1_300, cache_creation_input_tokens: 213_000, output_tokens: 61_200, cache_read_input_tokens: 8_580_000 },
  }))
  await $.tool.call(PLAN)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface, ...BAND })
    const row = await ui.find({ key: 'meter:stats' })
    expect(row?.text).toContain('This chat')
    if (surface === 'terminal') expect(row?.text).toContain('↑214.3k  ↓61.2k  ≋8.58M  $4.71')
    else expect(await ui.find({ type: 'Svg', alt: /214\.3k tokens in, 61\.2k tokens out, 8\.58M tokens read from cache, \$4\.71 at API prices/ })).toBeDefined()
    await ui.unmount()
  }
})

test('two time chips: the chat\'s compute time and the task under way, live', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: 'ok' }))
  const timesOf = async () => {
    const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
    const text = (await ui.find({ key: 'meter:stats' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(75_000)
  expect(await timesOf()).toContain('◷1m 15s  ▸1m 15s')
  await $.turn.complete({ answer: 'ok', durationMs: 75_000, isAborted: false, turnId: 't1', reason: 'answer' })
  // between turns the task chip keeps the last task's length
  await clock.advance(600_000)
  expect(await timesOf()).toContain('◷1m 15s  ▸1m 15s')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.advance(5_000)
  expect(await timesOf()).toContain('◷1m 20s  ▸5s')
})

test('titles keep their room: on a Code-tab-wide band the bars leave the titles their measured width', async ($, on) => {
  const now = mock.clock(on, { now: START }).now()
  on('session.usage', async () => usageAt(now))
  await $.tool.call(PLAN)
  const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 98 } })
  const row = (await ui.find({ key: 'meter:context' })) as { children?: { type?: string; props?: { width?: number } }[] } | undefined
  const bar = Number(row?.children?.find(c => c?.type === 'Svg')?.props?.width)
  // the context title ("Context window › 124k of 200k left", 34 characters at ~7.4 px) and the glyph, gaps and close column (~88 px)
  expect(98 * 8 - bar).toBeGreaterThanOrEqual(34 * 7.4 + 88)
  await ui.unmount()
})

test('a finished bar folds away a minute after it finishes, so the band stays short', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  on('session.usage', async () => usageAt(START))
  await $.tool.call(PLAN)
  await $.tool.call({ tool: 'mcp__plan-progress-plus__plan_progress', id: 'ticks', state: 'done' })
  const shown = async () => {
    const ui = await $.ui.mount({ plugin: 'plan-progress-plus', surface: 'terminal', ...BAND })
    const bar = await ui.find({ key: 'bar-ticks' })
    await ui.unmount()
    return bar !== undefined
  }
  expect(await shown()).toBe(true)
  await clock.advance(30_000)
  expect(await shown()).toBe(true)
  await clock.advance(31_000)
  expect(await shown()).toBe(false)
})
