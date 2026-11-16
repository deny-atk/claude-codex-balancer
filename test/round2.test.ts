// Second-round review fixes: best-effort report file, unknown change check, serialized measures, eligibility, early turn.complete.
import { test, expect } from 'claude-code/testing'
import { CLAUDE_MARK, CODEX_AHEAD, CODEX_TEXT, CWD, agent, inflightKeys, reading, settleReal, world } from './harness'

const OPTS = (o: Record<string, unknown>) => ({ options: o as any })
const claudeKeys = (w: { store: Map<string, unknown> }) => [...w.store.keys()].filter(k => k.startsWith('claude-inflight/'))
const GPW = { subagent_type: 'general-purpose' }
const done = (id: string) => ({ agentId: id, reason: 'answer', answer: 'A', text: '', isAborted: false, durationMs: 1, turnId: 't' })

test('dw3_a_failing_output_file_write_still_submits_the_finished_message', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { failWriteRe: /\/runs\/codex-[^./]*\.txt$/ })
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]).toContain('finished on Codex.')
  expect(w.submits[0]).toContain(CODEX_TEXT)
  expect(inflightKeys(w)).toEqual([])
})

test('dw5_a_failed_run_whose_dirty_path_cannot_be_hashed_does_not_fall_back_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [' M sub\n'], hashFail: new Set(['sub']) })
  const r: any = await $.tool.call(agent(GPW) as any)
  expect(w.agentCalls).toHaveLength(0)
  expect(w.agentSpawns).toHaveLength(0)
  expect(r.result.content[0].text).toContain('could not check for changed files')
})

test('dw5_a_background_failure_with_an_unknown_change_check_is_reported_not_redone', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [' M sub\n'], hashFail: new Set(['sub']) })
  await $.tool.call(agent({ ...GPW, run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain('could not check for changed files')
  expect(w.agentSpawns).toHaveLength(0)
})

test('dw25_concurrent_measures_keep_the_higher_reading_whatever_order_the_store_answers', async ($, on) => {
  const old = reading({ fiveUsed: 10, sevenUsed: 10 })
  const w = world(on, { 'reading/claude': old })
  let open!: () => void
  w.holdSecondRead = { key: 'reading/claude', seen: 0, gate: new Promise<void>(r => { open = r }) }
  const m = (five: number) => ($ as any).session.measure({
    context: {}, changed: ['rateLimits'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: five, resetsAt: new Date(old.fiveHour.resetsAt).toISOString() },
      { kind: 'seven_day', percentUsed: 10, resetsAt: new Date(old.sevenDay.resetsAt).toISOString() },
    ],
  })
  await Promise.all([m(60).then(open), m(40)])
  expect((w.store.get('reading/claude') as any).fiveHour.used).toBe(60)
})

test('dw18_a_plugin_type_is_never_eligible_even_when_listed', OPTS({ eligibleAgentTypes: 'general-purpose,plug:agent' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const input = agent({ subagent_type: 'plug:agent' })
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  expect(w.agentCalls[0]).toEqual({ ...input, tool_use_id: w.agentCalls[0].tool_use_id })
  expect(w.spawns).toHaveLength(0)
})

test('dw22_a_listed_type_whose_agent_file_needs_an_unavailable_tool_stays_on_claude', OPTS({ eligibleAgentTypes: 'tool-user' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/agents/tool-user.md`, '---\nname: tool-user\ntools: [Read, Skill]\n---\nBODY\n')
  const r: any = await $.tool.call(agent({ subagent_type: 'tool-user' }) as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  expect(w.spawns).toHaveLength(0)
})

test('dw22_a_listed_type_without_an_agent_file_still_routes', OPTS({ eligibleAgentTypes: 'tool-user' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await $.tool.call(agent({ subagent_type: 'tool-user' }) as any)
  expect(w.spawns).toHaveLength(1)
})

// A blocked foreground run falls back to a background Claude launch; its turn.complete may come before the launch result is mapped.
const early = (n: number) => async ($: any, on: any) => {
  const w = world(on, CODEX_AHEAD, { finalText: 'BLOCKED: no', claudeResult: { status: 'async_launched', agentId: 'bg-early' } })
  w.claudeDuring = () => {
    void $.turn.complete(done('bg-early'))
    for (let i = 0; i < n; i++) void $.turn.complete(done(`other-${i}`))
  }
  await $.tool.call(agent() as any)
  return w
}

test('dw26_turn_complete_before_the_launch_result_is_mapped_leaves_no_reservation', async ($, on) => {
  const w = await early(0)($, on)
  expect(claudeKeys(w)).toEqual([])
})

test('dw26_a_duplicate_turn_complete_changes_nothing', async ($, on) => {
  const w = await early(0)($, on)
  const before = [...w.store.keys()].sort()
  const r: any = await ($ as any).turn.complete(done('bg-early'))
  expect(r.text).toBe('')
  expect([...w.store.keys()].sort()).toEqual(before)
})

test('dw26_100_unmapped_completions_are_remembered', async ($, on) => {
  expect(claudeKeys(await early(99)($, on))).toEqual([])
})

test('dw26_the_101st_unmapped_completion_drops_the_oldest', async ($, on) => {
  expect(claudeKeys(await early(100)($, on))).toHaveLength(1)
})
