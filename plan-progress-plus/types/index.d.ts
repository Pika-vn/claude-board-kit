export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
export type PlanSubstep = { title: string; status: StepStatus }
export type PlanStep = { title: string; status: StepStatus; substeps: PlanSubstep[] }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
// one subagent shown as a state strip under a bar; depth 1 sits under its parent agent
export type AgentRun = {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'error'
  tool: string
  startedAt: number
  endedAt: number | null
  depth: number
}
export type Plan = {
  id: string
  title: string
  kind: 'plan' | 'todo'
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  agents?: AgentRun[]
  // when the current batch of agents all finished; their strips fold a few seconds later
  agentsDoneAt?: number | null
}
// the session's figures as the status line has them, drawn in the row under the bars
export type UsageLimit = { kind: string; percentUsed: number; resetsAt: string | null }
export type Usage = {
  contextTokens: number | null
  contextWindow: number
  contextPercent: number | null
  limits: UsageLimit[]
  costUsd: number | null
}

// input counts cache writes too; cache reads are their own figure
export type Tokens = { input: number; output: number; cacheRead: number }
// main-loop turns only: subagents run inside them, so their time is already counted
export type Timing = { totalMs: number; turnStartedAt: number | null; lastMs: number }
// the repository row above the bars
export type Git = { repo: string; branch: string; add: number; del: number }
// one failed tool call of this turn, for the error button and /progress-errors
export type ToolError = { tool: string; what: string; message: string }
// the main loop's last tool, this turn's failures, and the figures behind the extra chips
export type Activity = {
  lastTool: string
  lastToolMs: number
  errors: ToolError[]
  skills: number
  tokensPerSec: number
  lastTurnAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'plan-progress-plus': {
      plans: Plan[]
      isOpen: boolean
      // bumped every second while agents run, so elapsed times and folding redraw
      tick: number
      usage: Usage | null
      // the context and limit meters under the task bars; /progress-usage or their ✕ turns them off
      showUsage: boolean
      // tokens summed over every turn since the mod loaded, subagents' included
      tokens: Tokens
      // compute time since the mod loaded, and the turn under way
      timing: Timing
      git: Git | null
      activity: Activity
      // limit windows already warned about (under 20% left), so the toast fires once
      alerted: string[]
    }
  }
}
