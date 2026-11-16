// Contract for $.state: one value per Codex run, keyed by the Agent call's tool_use_id.
// The mod writes it from `tool.call` and when a run ends; the ToolUse render hook reads it, so a row
// is drawn again when a background run finishes. Null: no line (the task ran on Claude).
export type BalancerRun = {
  model?: string
  effort: string
  running: boolean
  durationMs?: number
  delta5h?: number // Codex 5-hour points the run used, when both readings were known
  failed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    balancer: { runs: StateFamily<BalancerRun | null> }
  }
}
