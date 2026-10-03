export type Task = { id: string; title: string; status: string }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = { contextPercent?: number; contextWindow: number; limits: Limit[] }
export type Git = { repo: string; branch: string; add: number; del: number; hasRemote: boolean }
export type AgentRow = { id: string; desc: string; tool: string; status: string; startedAt: number }
export type Activity = {
  lastTool: string
  lastToolMs: number
  errors: number
  skills: number
  tokensPerSec: number
  lastTurnAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-board': {
      tasks: Task[]
      usage: Usage | null
      alerted: string[]
      git: Git | null
      agents: AgentRow[]
      activity: Activity
    }
  }
}
