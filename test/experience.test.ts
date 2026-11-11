// M2 (PRD 10, 9): status entry, toasts, /codex, delegation nudge, plan mode.
import { test, expect } from 'claude-code/testing'
import { formatRowLine, formatStatus, lastDecisions } from '../hooks/balance'
import { PREAMBLE } from '../hooks/codex'
import { register } from '../hooks/register'
import {
  CFG, CODEX_AHEAD, CODEX_IDLE, CODEX_TEXT, CWD, DATA, H, NOW, SID, SECTIONS,
  agent, inflightKeys, logLines, measure, reading, rolloutFor, settleReal, startSession, world,
} from './harness'

const OPTS = (o: Record<string, unknown>) => ({ options: o as any })
const cmd = ($: any, args = '') => $.command.run({ command: 'balance', args })
const codexCmd = ($: any, args = '') => $.command.run({ command: 'codex', args })
const submit = ($: any, extra: Record<string, unknown> = {}) => $.prompt.submit({ text: 'hello', ...extra })
const NUDGE = /second subscription/
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Agent'], outputStyle: null, traits: [] }
const contextMeasure = ($: any, tokens?: number) => $.session.measure({
  context: { tokens, window: 1000 }, rateLimits: [], changed: ['context'],
})

for (const fallback of ['', 'gpt-command']) {
  test(`dw2_codex_command_uses_only_codex_model_${fallback || 'empty'}`, OPTS({ codexModel: fallback, modelMap: 'default=gpt-mapped' }), async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    const r: any = await codexCmd($, 'synthetic task')
    const argv = w.spawns[0]!.argv
    if (fallback) expect(argv[argv.indexOf('-m') + 1]).toBe(fallback)
    else expect(argv).not.toContain('-m')
    expect(logLines(w)[0].codexModel).toBe(fallback || 'default')
    expect(r.text).toContain(`Ran on Codex (model ${fallback || 'default'}, effort high`)
  })
}

test('dw13_last_decisions_keeps_the_last_valid_lines_and_skips_bad_ones', () => {
  const l = (n: number) => JSON.stringify({ t: n, agentType: 'a', route: 'claude', reason: 'r' })
  const text = [l(1), l(2), '{broken', '', '"str"', l(3), l(4)].join('\n') + '\n'
  expect(lastDecisions(text, 3).map(d => d.t)).toEqual([2, 3, 4])
  expect(lastDecisions(text, 10).map(d => d.t)).toEqual([1, 2, 3, 4])
  expect(lastDecisions('', 5)).toEqual([])
})

// ---------- status entry (PRD 10): pure formatter ----------

test('status_formatter_rounds_and_shows_a_dash_for_unknown', () => {
  const claude = reading({ fiveUsed: 61.6, sevenUsed: 55.2 })
  const codex = { ...reading({ fiveUsed: 20, sevenUsed: 46 }), sevenDay: null }
  expect(formatStatus({ now: NOW, claude, codex, last: undefined })).toBe('C 5h 62 · 7d 55 │ X 5h 20 · 7d –')
  expect(formatStatus({ now: NOW, claude: null, codex: null, last: 'claude' })).toBe('C 5h – · 7d – │ X 5h – · 7d – │ → Claude')
  expect(formatStatus({ now: NOW, claude, codex: claude, last: 'codex' })).toEndWith('│ → Codex')
})

test('status_formatter_counts_a_passed_reset_as_zero_used', () => {
  const old = reading({ fiveUsed: 90, fiveLeft: -1, sevenUsed: 10 })
  expect(formatStatus({ now: NOW, claude: old, codex: null, last: undefined })).toStartWith('C 5h 0 · 7d 10')
})

test('dw5_row_line_with_model_and_legacy_without_model', () => {
  expect(formatRowLine({ model: 'gpt-6.1-terra', effort: 'medium', running: false, durationMs: 25_000 })).toBe('Codex · gpt-6.1-terra · medium · 25s')
  expect(formatRowLine({ model: 'default', effort: 'high', running: true })).toBe('Codex · default · high · running')
  expect(formatRowLine({ effort: 'high', running: true })).toBe('Codex · high · running')
  expect(formatRowLine({ effort: 'high', running: false, durationMs: 133_000, delta5h: 4.2 })).toBe('Codex · high · 2m13s · +4 pts 5h')
  expect(formatRowLine({ effort: 'low', running: false, durationMs: 9_000 })).toBe('Codex · low · 9s')
  expect(formatRowLine({ effort: 'low', running: false, durationMs: 9_000, delta5h: 0 })).toBe('Codex · low · 9s')
  expect(formatRowLine({ effort: 'low', running: false, durationMs: 9_000, failed: true })).toBe('Codex · low · 9s · failed')
})

test('status_entry_after_measure_has_no_route_before_the_first_decision', async ($, on) => {
  const w = world(on, { 'reading/codex': reading({ fiveUsed: 20, sevenUsed: 46 }) })
  await measure($, w, 62, 55)
  expect(w.statuses.at(-1)).toBe('C 5h 62 · 7d 55 │ X 5h 20 · 7d 46')
})

test('status_entry_shows_a_dash_where_a_window_is_unknown', async ($, on) => {
  const w = world(on)
  await ($ as any).session.measure({
    context: {}, changed: ['rateLimits'],
    rateLimits: [{ kind: 'five_hour', percentUsed: 62, resetsAt: new Date(NOW + 2 * H).toISOString() }],
  })
  expect(w.statuses.at(-1)).toBe('C 5h 62 · 7d – │ X 5h – · 7d –')
})

test('status_entry_follows_each_routing_decision', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await startSession($)
  await $.tool.call(agent() as any)
  expect(w.statuses.at(-1)).toBe('C 5h 80 · 7d 80 │ X 5h 5 · 7d 5 │ → Codex')
  await cmd($, 'claude')
  await $.tool.call(agent() as any)
  expect(w.statuses.at(-1)).toBe('C 5h 80 · 7d 80 │ X 5h 5 · 7d 5 │ → Claude')
})

test('status_entry_shows_the_codex_reading_taken_after_a_run', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { rollout: rolloutFor(15) })
  await $.tool.call(agent() as any)
  expect(w.statuses.at(-1)).toBe('C 5h 80 · 7d 80 │ X 5h 15 · 7d 20 │ → Codex')
})

// ---------- toasts (PRD 10) ----------

const ceilingToasts = (w: { toasts: string[] }) => w.toasts.filter(t => /ceiling/i.test(t))

test('toast_claude_crossing_a_ceiling_once_per_crossing', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 90, 10)
  expect(ceilingToasts(w)).toHaveLength(0)
  await measure($, w, 96, 10)
  expect(ceilingToasts(w)).toHaveLength(1)
  expect(ceilingToasts(w)[0]).toContain('Claude')
  expect(ceilingToasts(w)[0]).toContain('5h')
  await measure($, w, 97, 10) // still above: nothing new
  expect(ceilingToasts(w)).toHaveLength(1)
  await measure($, w, 50, 10) // back below ...
  await measure($, w, 96, 10) // ... and across again
  expect(ceilingToasts(w)).toHaveLength(2)
})

test('toast_weekly_ceiling_and_the_ceiling_options', OPTS({ ceilingFiveHour: 50, ceilingSevenDay: 60 }), async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 10, 61)
  expect(ceilingToasts(w)).toHaveLength(1)
  expect(ceilingToasts(w)[0]).toContain('7d')
  await measure($, w, 10, 10)
  await measure($, w, 51, 10)
  expect(ceilingToasts(w)).toHaveLength(2)
})

test('toast_codex_crossing_a_ceiling_on_measure_names_codex', async ($, on) => {
  const w = world(on, { 'reading/codex': reading({ fiveUsed: 96, sevenUsed: 10 }) })
  await measure($, w, 10, 10)
  expect(ceilingToasts(w)).toHaveLength(1)
  expect(ceilingToasts(w)[0]).toContain('Codex')
  await measure($, w, 11, 10)
  expect(ceilingToasts(w)).toHaveLength(1)
})

test('toast_codex_crossing_a_ceiling_after_a_run', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { rollout: rolloutFor(97) })
  await $.tool.call(agent() as any)
  expect(ceilingToasts(w)).toHaveLength(1)
  expect(ceilingToasts(w)[0]).toContain('Codex')
  await $.tool.call(agent() as any) // Codex is at the ceiling now: the next call runs on Claude, no new toast
  expect(ceilingToasts(w)).toHaveLength(1)
})

test('toast_no_toast_for_ordinary_runs_or_measures', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { rollout: rolloutFor(15) })
  await $.tool.call(agent() as any)
  await measure($, w, 40, 40)
  expect(w.toasts).toEqual([])
})

test('toast_sync_failure_that_falls_back_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  await $.tool.call(agent() as any)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/Codex failed \(exit 1\).*Claude/)
})

test('toast_background_failure_with_cooldown', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/Codex failed \(exit 1\).*Claude/)
})

// ---------- /codex <task> (dw12) ----------

test('dw12_codex_command_is_registered_at_session_start', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(w.commands).toContain('codex')
  expect(w.commands).toContain('balance')
})

test('dw12_codex_command_runs_the_task_and_returns_the_report_without_a_model_call', async ($, on) => {
  const w = world(on, { ...CODEX_AHEAD, 'estimate/command': { fiveHour: 5, sevenDay: 1 } }, { rollout: rolloutFor(15) })
  const r: any = await codexCmd($, 'find the flaky test')
  expect(r.text).toStartWith('[balancer] Ran on Codex (model default, effort high')
  expect(r.text).toContain(CODEX_TEXT)
  expect(w.modelCalls).toEqual([])
  expect(w.agentCalls).toHaveLength(0)
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.argv).toContain('workspace-write')
  expect(w.spawns[0]!.argv).toContain('model_reasoning_effort=high')
  expect(w.spawns[0]!.argv.join(' ')).toContain('find the flaky test')
  expect(w.spawns[0]!.cwd).toBe(CWD)
  expect(inflightKeys(w)).toEqual([]) // reservation released
  expect(logLines(w).at(-1)).toMatchObject({ agentType: 'command', route: 'codex' })
  expect((w.store.get('reading/codex') as any).fiveHour.used).toBe(15) // post-run reading stored
  expect((w.store.get('estimate/command') as any).fiveHour).not.toBe(5) // and the estimate updated
})

test('dw12_codex_command_makes_the_reservation_while_it_runs', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'hang' })
  const p = codexCmd($, 'long task')
  await settleReal(() => inflightKeys(w).length > 0)
  expect(inflightKeys(w)).toHaveLength(1)
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } } as any) // ends the run
  await p
  expect(inflightKeys(w)).toEqual([])
})

test('dw12_codex_command_with_no_task_prints_usage', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  expect(((await codexCmd($, '  ')) as any).text).toBe('Usage: /codex <task>')
  expect(w.spawns).toHaveLength(0)
})

test('dw12_codex_command_refuses_in_mode_off', OPTS({ mode: 'off' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  expect(((await codexCmd($, 'do it')) as any).text).toMatch(/off/)
  expect(w.spawns).toHaveLength(0)
})

test('dw12_codex_command_follows_a_session_switch_to_off', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await cmd($, 'off')
  expect(((await codexCmd($, 'do it')) as any).text).toMatch(/off/)
  expect(w.spawns).toHaveLength(0)
})

test('dw12_codex_command_refuses_in_an_opted_out_project', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/balancer.json`, '{ "codex": false }')
  const r: any = await codexCmd($, 'do it')
  expect(r.text).toMatch(/opted out/)
  expect(r.text).toContain('.claude/balancer.json')
  expect(w.spawns).toHaveLength(0)
})

test('dw12_codex_command_says_when_codex_is_unavailable', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { loggedIn: false })
  expect(((await codexCmd($, 'do it')) as any).text).toMatch(/Codex is not available/)
  expect(w.spawns).toHaveLength(0)
})

test('dw12_codex_command_works_while_claude_is_limited', async ($, on) => {
  const w = world(on, { ...CODEX_AHEAD, 'reading/claude': reading({ fiveUsed: 100, sevenUsed: 50, limit: true }) })
  expect(((await codexCmd($, 'do it')) as any).text).toContain(CODEX_TEXT)
  expect(w.modelCalls).toEqual([])
})

test('dw12_codex_command_failure_returns_the_failure_text', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: ['', ' M half.py'] })
  const r: any = await codexCmd($, 'do it')
  expect(r.text).toContain('Codex stopped before finishing (exit 1)')
  expect(r.text).toContain('half.py')
  expect(inflightKeys(w)).toEqual([])
})

test('dw12_codex_command_failure_without_changes_says_so', async ($, on) => {
  world(on, CODEX_AHEAD, { script: 'fail' })
  const r: any = await codexCmd($, 'do it')
  expect(r.text).toBe('Codex could not run the task (exit 1). No files were changed.')
})

test('dw12_codex_command_missing_binary_marks_codex_unusable', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'missing' })
  expect(((await codexCmd($, 'do it')) as any).text).toMatch(/codex missing/)
  expect(w.toasts).toHaveLength(1)
  expect(((await codexCmd($, 'again')) as any).text).toMatch(/Codex is not available/)
  expect(w.spawns).toHaveLength(1)
})

// ---------- plan mode (closes the M1 gap) ----------

// A seated security plugin (cc-plugin-sec-default) sends classic events and prompt.attachment past user plugins,
// so Balancer hooks neither: plan mode is seen only through the Agent call's own `mode`.
test('dw15_register_hooks_no_classic_prompt_and_no_prompt_attachment', async () => {
  const names: string[] = []
  register(((name: string) => { names.push(name) }) as any, {} as any)
  expect(names).not.toContain('classic.UserPromptSubmit')
  expect(names).not.toContain('prompt.attachment')
})

test('dw3_the_agent_mode_argument_still_forces_read_only_outside_plan_mode', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await $.tool.call(agent({ subagent_type: 'general-purpose', mode: 'plan' }) as any)
  expect(w.spawns[0]!.argv).toContain('read-only')
})

// ---------- dw10: no prompt change, no tools, no model calls; the nudge (PRD 9) ----------

test('dw10_routing_both_ways_leaves_prompt_and_tools_alone_and_makes_no_model_call', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await startSession($)
  const before: any = await ($ as any).prompt.compose(COMPOSE)
  expect(((await $.tool.call(agent() as any)) as any).result.status).toBe('completed') // to Codex
  await cmd($, 'claude')
  expect(((await $.tool.call(agent() as any)) as any).result).toEqual({ status: 'claude-ran' }) // to Claude
  await measure($, w, 60, 60)
  const after: any = await ($ as any).prompt.compose(COMPOSE)
  expect(before.sections).toEqual(SECTIONS)
  expect(after.sections).toEqual(SECTIONS)
  expect(w.compose).toBe(2)
  // Tool registration and every model call that reached the bottom of the chain are counted there.
  expect(w.toolOps).toEqual([])
  expect(w.modelCalls).toEqual([])
})

test('dw10_nudge_attaches_once_per_entry_into_claude_tight', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 10, 10) // gap 10: not tight
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()

  await measure($, w, 40, 40) // gap 40 > 25: enter
  await submit($)
  expect(w.contexts.at(-1)).toHaveLength(1)
  expect(w.contexts.at(-1)![0]).toMatch(NUDGE)
  await submit($)
  await submit($)
  expect(w.contexts.slice(1)).toEqual([expect.anything(), undefined, undefined]) // once

  await measure($, w, 20, 20) // gap 20: between 10 and 25, still in the state, nothing new
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()

  await measure($, w, 5, 5) // gap 5 < 10: leave
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()

  await measure($, w, 40, 40) // enter again: one more
  await submit($)
  expect(w.contexts.at(-1)![0]).toMatch(NUDGE)
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

test('dw10_gap_between_the_thresholds_does_not_enter', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 20, 20) // gap 20 from outside: not tight
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
  await measure($, w, 24, 24) // just under 25
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

test('dw10_nudge_keeps_the_prompt_text_and_other_context', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 40, 40)
  const r: any = await submit($, { context: ['other'] })
  expect(r.text).toBe('hello')
  expect(r.context[0]).toBe('other')
  expect(r.context).toHaveLength(2)
  expect(w.submits.at(-1)).toBe('hello')
})

test('dw10_slash_command_and_meta_prompts_never_get_the_nudge', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 40, 40)
  await submit($, { command: { name: 'review', args: '' } })
  await submit($, { isMeta: true })
  expect(w.contexts).toEqual([undefined, undefined])
  await submit($) // still armed for the next real prompt
  expect(w.contexts.at(-1)).toHaveLength(1)
})

test('dw16_context_drop_while_tight_arms_one_more', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 40, 40)
  await submit($)
  await contextMeasure($, 600)
  await contextMeasure($) // missing tokens must not erase the previous measurement
  await contextMeasure($, 100)
  await submit($)
  expect(w.contexts.at(-1)).toHaveLength(1)
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

for (const [name, before, after] of [['half', 600, 300], ['under_twenty_percent', 199, 10]] as const) {
  test(`dw16_context_drop_${name}_does_not_arm`, async ($, on) => {
    const w = world(on, CODEX_IDLE)
    await measure($, w, 40, 40)
    await submit($)
    await contextMeasure($, before)
    await contextMeasure($, after)
    await submit($)
    expect(w.contexts.at(-1)).toBeUndefined()
  })
}

test('dw16_context_drop_outside_tight_does_not_arm', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 5, 5)
  await contextMeasure($, 600)
  await contextMeasure($, 100)
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

test('dw16_nudge_option_false_never_attaches_after_context_drop', OPTS({ nudge: false }), async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 40, 40)
  await submit($)
  await contextMeasure($, 600)
  await contextMeasure($, 100)
  await submit($)
  expect(w.contexts).toEqual([undefined, undefined])
})

test('dw10_no_nudge_when_codex_is_not_usable_or_unread', async ($, on) => {
  const w = world(on, CODEX_IDLE, { loggedIn: false })
  await measure($, w, 40, 40)
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

// The state needs Codex usable in the full sense: not limited, below both ceilings, no cooldown.
const entered = async ($: any, w: any, five = 40) => { await measure($, w, five, five); await submit($); return w.contexts.at(-1) }

test('dw10_no_nudge_while_codex_is_limited_and_it_ends_when_codex_becomes_limited', async ($, on) => {
  const w = world(on, { 'reading/codex': reading({ fiveUsed: 0, sevenUsed: 0, limit: true }) })
  expect(await entered($, w)).toBeUndefined()
  w.store.set('reading/codex', reading({ fiveUsed: 0, sevenUsed: 0 })) // limit lifted: enters
  expect(await entered($, w)).toHaveLength(1)
  w.store.set('reading/codex', reading({ fiveUsed: 0, sevenUsed: 0, limit: true })) // limited while in the state: leaves
  expect(await entered($, w, 45)).toBeUndefined()
  w.store.set('reading/codex', reading({ fiveUsed: 0, sevenUsed: 0 }))
  expect(await entered($, w, 50)).toHaveLength(1) // a new entry, one more reminder
})

// Codex at 96% of the 5-hour window, resetting in 6 minutes: its runway is high, but it is at its ceiling.
const CODEX_AT_CEILING = reading({ fiveUsed: 96, fiveLeft: 6 * 60_000, sevenUsed: 0 })

test('dw10_no_nudge_while_codex_is_at_a_ceiling_and_it_ends_when_codex_reaches_one', async ($, on) => {
  const w = world(on, { 'reading/codex': CODEX_AT_CEILING })
  expect(await entered($, w)).toBeUndefined()
  w.store.set('reading/codex', reading({ fiveUsed: 0, sevenUsed: 0 }))
  expect(await entered($, w)).toHaveLength(1)
  w.store.set('reading/codex', CODEX_AT_CEILING)
  expect(await entered($, w, 45)).toBeUndefined()
  w.store.set('reading/codex', reading({ fiveUsed: 0, sevenUsed: 0 }))
  expect(await entered($, w, 50)).toHaveLength(1)
})

test('dw10_nudge_ends_during_a_cooldown_and_returns_after_it', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  await startSession($)
  await $.tool.call(agent({ run_in_background: undefined }) as any) // a decision to Codex enters the state
  await settleReal(() => w.submits.length > 0) // the run failed: 15-minute cooldown
  expect(await entered($, w, 80)).toBeUndefined() // cooling down: not usable, the waiting reminder is dropped
  await w.clock.advance(16 * 60_000)
  expect(await entered($, w, 80)).toHaveLength(1)
})

test('dw10_no_nudge_without_a_codex_reading', async ($, on) => {
  const w = world(on)
  await measure($, w, 40, 40)
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

test('dw10_no_nudge_in_mode_off_or_claude', OPTS({ mode: 'off' }), async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 40, 40)
  await submit($)
  expect(w.contexts.at(-1)).toBeUndefined()
})

test('dw10_routing_decisions_enter_the_state_too', async ($, on) => {
  const w = world(on, CODEX_AHEAD) // Claude 80% used, Codex 5%: gap far over 25
  await startSession($)
  await $.tool.call(agent() as any)
  await submit($)
  expect(w.contexts.at(-1)).toHaveLength(1)
  expect(w.contexts.at(-1)![0]).toMatch(NUDGE)
})

test('dw10_the_nudge_text_is_one_short_paragraph_about_delegating', async ($, on) => {
  const w = world(on, CODEX_IDLE)
  await measure($, w, 40, 40)
  await submit($)
  const t = w.contexts.at(-1)![0]!
  expect(t.length).toBeLessThan(500)
  expect(t).not.toContain('\n')
  expect(t).toMatch(/general-purpose/)
  expect(t).toMatch(/Explore/)
  expect(t).toMatch(/self-contained/)
})

test('dw11_log_stays_content_free_with_the_command', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await codexCmd($, 'COMMAND-SECRET-99 do it')
  const text = w.files.get(`${DATA}/decisions.jsonl`) ?? ''
  expect(text).not.toContain('COMMAND-SECRET-99')
  expect(text).not.toContain(CODEX_TEXT)
})

test('dw16_hooks_exclude_security_intercepted_events', () => {
  const names: string[] = []
  register(((name: string) => { names.push(name) }) as any, {} as any)
  const intercepted = [
    'prompt.section', 'prompt.context', 'prompt.attachment', 'prompt.compose', 'skill.prompt',
    'attribution.text', 'session.append', 'session.compact', 'settings.read', 'tool.describe',
    'command.describe', 'agent.offer', 'agent.spawn', 'tool.register', 'tool.list', 'tool.check',
    'ui.log', 'env.get', 'env.set', 'plugin.register',
  ]
  expect(names.filter(name => name.startsWith('classic.') || intercepted.includes(name))).toEqual([])
})

// ---------- custom agent types (dw17-dw22) ----------

const PROJECT_FILE = `${CWD}/.claude/agents/implementer.md`
const USER_FILE = `${CFG}/agents/implementer.md`
const AGENT_BODY = 'AGENT-BODY-LINE-1\n\nAGENT-BODY-LINE-2'
const agentFile = (fm: string, body = AGENT_BODY) => `---\nname: implementer\n${fm}\n---\n${body}\n`
const custom = (over: Record<string, unknown> = {}) => agent({ subagent_type: 'implementer', ...over }) as any
const sentPrompt = (w: any): string => w.spawns[0]!.argv.at(-1)
const argAfter = (w: any, flag: string): string => { const a = w.spawns[0]!.argv; return a[a.indexOf(flag) + 1] }

test('dw17_project_file_makes_a_custom_type_eligible_and_the_log_names_it', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('tools: Read, Edit'))
  const r: any = await $.tool.call(custom())
  expect(r.result.status).toBe('completed')
  expect(w.spawns).toHaveLength(1)
  expect(w.agentCalls).toHaveLength(0)
  expect(logLines(w)[0]).toMatchObject({ agentType: 'implementer', route: 'codex' })
})

test('dw17_user_file_is_used_when_the_project_has_none', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(USER_FILE, agentFile('', 'USER-BODY'))
  await $.tool.call(custom())
  expect(w.spawns).toHaveLength(1)
  expect(sentPrompt(w)).toContain('USER-BODY')
})

test('dw17_project_file_wins_over_the_user_file', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('tools: Read', 'PROJECT-BODY'))
  w.files.set(USER_FILE, agentFile('tools: Edit', 'USER-BODY'))
  await $.tool.call(custom())
  expect(sentPrompt(w)).toContain('PROJECT-BODY')
  expect(sentPrompt(w)).not.toContain('USER-BODY')
  expect(argAfter(w, '-s')).toBe('read-only')
})

test('dw17_the_other_eligibility_rules_still_apply_to_custom_types', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile(''))
  for (const over of [{ name: 'x' }, { isolation: 'worktree' }, { prompt: 'use the Skill tool please' }]) {
    const r: any = await $.tool.call(custom(over))
    expect(r.result).toEqual({ status: 'claude-ran' })
  }
  w.cwdExists = false
  expect(((await $.tool.call(custom())) as any).result).toEqual({ status: 'claude-ran' })
  expect(w.spawns).toHaveLength(0)
})

test('dw17_opt_out_file_keeps_a_custom_type_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile(''))
  w.files.set(`${CWD}/.claude/balancer.json`, '{"codex": false}')
  const r: any = await $.tool.call(custom())
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(w.spawns).toHaveLength(0)
})

test('dw18_no_definition_file_stays_on_claude_unchanged', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const input = custom()
  await $.tool.call(input)
  expect(w.spawns).toHaveLength(0)
  expect(w.agentCalls).toHaveLength(1)
  expect(w.agentCalls[0]).toMatchObject(input) // the engine adds tool_use_id; nothing is changed
})

test('dw18_plugin_type_with_a_colon_stays_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/agents/pl:implementer.md`, agentFile(''))
  w.files.set(`${CFG}/agents/pl:implementer.md`, agentFile(''))
  await $.tool.call(custom({ subagent_type: 'pl:implementer' }))
  expect(w.spawns).toHaveLength(0)
  expect(w.agentCalls).toHaveLength(1)
})

for (const [id, text] of [['no_frontmatter', 'You are an implementer.\n'], ['unclosed', '---\nname: x\nbody\n']] as const) {
  test(`dw18_file_with_${id}_stays_on_claude`, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    w.files.set(PROJECT_FILE, text)
    await $.tool.call(custom())
    expect(w.spawns).toHaveLength(0)
    expect(w.agentCalls).toHaveLength(1)
  })
}

test('dw18_a_broken_project_file_does_not_fall_through_to_the_user_file', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, 'no frontmatter')
  w.files.set(USER_FILE, agentFile(''))
  await $.tool.call(custom())
  expect(w.spawns).toHaveLength(0)
})

test('dw19_codex_gets_preamble_then_instructions_then_the_brief_without_frontmatter', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('tools: Read, Edit\nmodel: sonnet\neffort: high'))
  await $.tool.call(custom({ prompt: 'THE-BRIEF' }))
  expect(sentPrompt(w)).toBe(`${PREAMBLE}\n\nInstructions for the implementer agent you are acting as:\n${AGENT_BODY}\n\nTHE-BRIEF`)
})

test('dw19_a_built_in_type_gets_exactly_the_old_prompt_even_if_a_file_has_its_name', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/agents/general-purpose.md`, agentFile('', 'SHADOW-BODY'))
  await $.tool.call(agent({ subagent_type: 'general-purpose', prompt: 'THE-BRIEF' }) as any)
  expect(sentPrompt(w)).toBe(`${PREAMBLE}\n\nTHE-BRIEF`)
  expect(argAfter(w, '-s')).toBe('workspace-write')
})

const MODELS = OPTS({ modelMap: 'sonnet=gpt-sonnet,opus=gpt-opus', effortMap: 'sonnet=medium,opus=low,default=high' })

test('dw20_frontmatter_model_picks_the_codex_model_and_the_effort_map_entry', MODELS, async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('model: sonnet'))
  const r: any = await $.tool.call(custom())
  expect(argAfter(w, '-m')).toBe('gpt-sonnet')
  expect(argAfter(w, '-c')).toBe('model_reasoning_effort=medium')
  expect(r.result.content[0].text).toContain('model gpt-sonnet, effort medium')
})

test('dw20_explicit_call_model_beats_the_frontmatter_model', MODELS, async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('model: sonnet'))
  await $.tool.call(custom({ model: 'opus' }))
  expect(argAfter(w, '-m')).toBe('gpt-opus')
  expect(argAfter(w, '-c')).toBe('model_reasoning_effort=low')
})

for (const model of ['inherit', '']) {
  test(`dw20_frontmatter_model_${model || 'empty'}_is_ignored`, MODELS, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    w.files.set(PROJECT_FILE, agentFile(`model: ${model}`))
    await $.tool.call(custom())
    expect(w.spawns[0]!.argv).not.toContain('-m')
    expect(argAfter(w, '-c')).toBe('model_reasoning_effort=high')
  })
}

for (const [fm, want] of [['low', 'low'], ['xhigh', 'xhigh'], ['max', 'xhigh'], ['turbo', 'medium']] as const) {
  test(`dw20_frontmatter_effort_${fm}_gives_${want}`, MODELS, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    w.files.set(PROJECT_FILE, agentFile(`model: sonnet\neffort: ${fm}`))
    await $.tool.call(custom())
    expect(argAfter(w, '-c')).toBe(`model_reasoning_effort=${want}`) // turbo is ignored: sonnet=medium
  })
}

test('dw20_frontmatter_effort_still_applies_with_an_explicit_call_model', MODELS, async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('model: sonnet\neffort: max'))
  await $.tool.call(custom({ model: 'opus' }))
  expect(argAfter(w, '-m')).toBe('gpt-opus')
  expect(argAfter(w, '-c')).toBe('model_reasoning_effort=xhigh')
})

test('dw21_tools_without_edit_or_write_run_read_only', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('tools: Read, Grep, Bash'))
  await $.tool.call(custom())
  expect(argAfter(w, '-s')).toBe('read-only')
})

for (const tools of ['Read, Edit', 'Write', 'NotebookEdit, Read', '']) {
  test(`dw21_tools_${tools.replace(/\W+/g, '_') || 'absent'}_run_workspace_write`, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    w.files.set(PROJECT_FILE, agentFile(tools ? `tools: ${tools}` : ''))
    await $.tool.call(custom())
    expect(argAfter(w, '-s')).toBe('workspace-write')
  })
}

test('dw21_plan_mode_forces_read_only_for_a_custom_type', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PROJECT_FILE, agentFile('tools: Read, Edit'))
  await $.tool.call(custom({ mode: 'plan' }))
  expect(argAfter(w, '-s')).toBe('read-only')
})

for (const [id, tool] of [['mcp', 'mcp__srv__lookup'], ['skill', 'Skill'], ['send', 'SendMessage'], ['ask', 'AskUserQuestion'], ['artifact', 'Artifact']] as const) {
  test(`dw22_tools_naming_${id}_keep_the_type_on_claude`, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    w.files.set(PROJECT_FILE, agentFile(`tools: [Read, Edit, ${tool}]`))
    await $.tool.call(custom())
    expect(w.spawns).toHaveLength(0)
    expect(w.agentCalls).toHaveLength(1)
  })
}
