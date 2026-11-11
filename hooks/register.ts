import type { Register } from 'claude-code'
import {
  createState, onAgent, onBalance, onCodexCommand, onMeasure, onPromptSubmit, onSessionEnd, onTaskStop,
} from './dispatch'
import { onToolRow } from './ui'

// Wiring only: the work is in dispatch.ts (routing, execution), balance.ts (log, /balance text).
// The engine-call scan follows `$` only into functions declared at the top of a file or imported by name, so the
// per-load state `s` is an argument and the handlers are plain exported functions.
export const register: Register = (on, options) => {
  const st = createState(options)

  on('session.measure', async ($, e, next) => {
    await onMeasure($, st, e)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'balance', description: 'Show Balancer routing state, or set its mode for this session', argumentHint: '[auto|claude|codex|off]' })
    await $.command.register({ name: 'codex', description: 'Run a task on Codex and print its report (no Claude model call)', argumentHint: '<task>' })
    return next(e)
  })

  on('command.run', { command: 'balance' }, ($, e) => onBalance($, st, e.args))

  on('command.run', { command: 'codex' }, ($, e) => onCodexCommand($, st, e.args))

  on('tool.call', { tool: 'Agent' }, ($, e, next) => onAgent($, st, e, next))

  on('tool.call', { tool: 'TaskStop' }, ($, e, next) => onTaskStop($, st, e, next))

  on('session.end', async ($, e, next) => {
    await onSessionEnd($, st, e)
    return next(e)
  })

  // PRD 9: the delegation nudge rides on a typed prompt as hidden context, never on the system prompt.
  on('prompt.submit', (_$, e, next) => onPromptSubmit(st, e, next))

  // PRD 10: a Codex run adds one line under its Agent row.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => onToolRow($, e, next))
}
