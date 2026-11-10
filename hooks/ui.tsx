// The tool-row line (PRD 10). The row stays as the engine draws it; a Codex run adds one dim line under it.
import type { EngineInterface, Next, RenderInputOf } from 'claude-code'
import { formatRowLine } from './balance'

type ToolRow = RenderInputOf<'ToolUse', 'terminal'> | RenderInputOf<'ToolUse', 'desktop'> | RenderInputOf<'ToolUse', 'vscode'> | RenderInputOf<'ToolUse', 'mobile'>

export async function onToolRow($: EngineInterface, e: ToolRow, next: Next<'ui.render', ToolRow>) {
  if (e.props.tool !== 'Agent') return next(e)
  // Read while drawing: a later write of this value draws the row again.
  const { value } = await $.state.get({ plugin: 'balancer', key: 'runs', id: e.requestId })
  if (!value) return next(e)
  const row = await next(e)
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {row}
      <Text dimColor>{formatRowLine(value)}</Text>
    </Box>
  )
}
