// Tool-row line (PRD 10): `ui.render` on ToolUse, on the terminal and desktop surfaces.
import { test, expect } from 'claude-code/testing'
import { CODEX_AHEAD, CODEX_TEXT, agent, inflightKeys, rolloutFor, settleReal, startSession, world } from './harness'

const SURFACES = ['terminal', 'desktop'] as const
const props = (id: string) => ({ tool_use_id: id, tool: 'Agent', input: {}, isRunning: false, isErrored: false, isInterrupted: false })
const mount = ($: any, surface: (typeof SURFACES)[number], id: string, tool = 'Agent') =>
  $.ui.mount({ plugin: 'balancer', surface, component: 'ToolUse', requestId: id, props: { ...props(id), tool } })

/** The engine's own row stands beneath the mod: a Text the mod must keep. */
const engineRow = (on: any) => on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>ENGINE-ROW</Text> })

/** The tool_use_id of the one Codex run so far, as the mod keyed it in $.state. */
const runId = (w: { state: Map<string, unknown> }) => {
  const keys = [...w.state.keys()].filter(k => k.startsWith('balancer/runs/'))
  expect(keys).toHaveLength(1)
  return keys[0]!.split('/')[2]!
}
const codexLine = (ui: any) => ui.find({ type: 'Text', text: /^Codex · / })

test('row_of_a_finished_codex_run_keeps_the_row_and_adds_the_line', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { rollout: rolloutFor(15) })
  engineRow(on)
  await $.tool.call(agent() as any)
  const id = runId(w)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, id)
    expect((await ui.find({ type: 'Text', text: /ENGINE-ROW/ }))?.text).toBe('ENGINE-ROW')
    expect((await codexLine(ui))?.text).toMatch(/^Codex · high · \d+s · \+10 pts 5h$/)
    await ui.unmount()
  }
})

test('row_of_a_claude_run_gets_no_line', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  engineRow(on)
  await startSession($)
  await ($ as any).command.run({ command: 'balance', args: 'claude' })
  await $.tool.call(agent() as any)
  const id = w.agentCalls[0].tool_use_id
  expect(id).toBeTruthy()
  for (const surface of SURFACES) {
    const ui = await mount($, surface, id)
    expect((await ui.find({ type: 'Text', text: /ENGINE-ROW/ }))?.text).toBe('ENGINE-ROW')
    expect(await codexLine(ui)).toBeUndefined()
    await ui.unmount()
  }
})

test('row_of_a_tool_that_is_not_an_agent_is_left_alone', async ($, on) => {
  world(on, CODEX_AHEAD)
  engineRow(on)
  const ui = await mount($, 'terminal', 'bash-1', 'Bash')
  expect((await ui.find({ type: 'Text', text: /ENGINE-ROW/ }))?.text).toBe('ENGINE-ROW')
  expect(await codexLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('row_of_a_background_run_says_running_then_loses_the_line_when_it_is_stopped', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'hang' })
  engineRow(on)
  await startSession($)
  const r: any = await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.spawns.length > 0 && inflightKeys(w).length > 0)
  const id = runId(w)
  for (const surface of SURFACES) {
    const ui = await mount($, surface, id)
    expect((await codexLine(ui))?.text).toBe('Codex · high · running')
    await ui.unmount()
  }
  await $.tool.call({ tool: 'TaskStop', task_id: r.result.agentId } as any)
  await settleReal(() => w.spawnFinally > 0)
  // The kit has no host to redraw a row that is already mounted when a $.state value changes (the hook that reads it
  // stands in for the engine's subscription), so the changed value is checked by drawing the row again.
  expect((w.state.get(`balancer/runs/${id}`) as any).value).toBeNull()
  const ui = await mount($, 'terminal', id)
  expect(await codexLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('row_of_a_finished_background_run_shows_its_duration', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { rollout: rolloutFor(15) })
  engineRow(on)
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain(CODEX_TEXT)
  const ui = await mount($, 'desktop', runId(w))
  expect((await codexLine(ui))?.text).toMatch(/^Codex · high · \d+s · \+10 pts 5h$/)
  await ui.unmount()
})

test('row_of_a_run_that_fell_back_to_claude_gets_no_line', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  engineRow(on)
  await $.tool.call(agent() as any) // Explore: read-only failure, next(e) runs it on Claude
  const id = w.agentCalls[0].tool_use_id
  const ui = await mount($, 'terminal', id)
  expect(await codexLine(ui)).toBeUndefined()
  await ui.unmount()
})
