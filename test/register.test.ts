import { test, expect } from 'claude-code/testing'
import { createState, onAgent } from '../hooks/dispatch'
import {
  CLAUDE_MARK, CODEX_AHEAD, CODEX_TEXT, CWD, DATA, H, NOW, PRD_74, SID,
  agent, THREAD, inflightKeys, logLines, reading, rolloutFor, settleReal, startSession, world,
} from './harness'

const OPTS = (o: Record<string, unknown>) => ({ options: o as any })
// The engine stamps tool_use_id on the input; everything else must arrive as sent.
const same = (got: any, sent: any) => expect(got).toEqual({ ...sent, tool_use_id: got.tool_use_id })
const cmd = ($: any, args = '') => $.command.run({ command: 'balance', args })
const sleep = (ms: number) => new Promise<void>(r => (globalThis as any).setTimeout(r, ms))

// ---------- dw3: routed to Codex ----------

test('dw3_sync_codex_answers_in_place', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  const text: string = r.result.content[0].text
  expect(text).toStartWith('[balancer] Ran on Codex (effort high')
  expect(text).toContain(CODEX_TEXT)
  expect(w.agentCalls).toHaveLength(0) // the Claude subagent never started
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.argv).toContain('read-only') // Explore
  expect(w.spawns[0]!.cwd).toBe(CWD)
  expect(inflightKeys(w)).toEqual([]) // reservation released
})

test('dw3_background_launches_at_once_then_delivers_report', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const r: any = await $.tool.call(agent({ run_in_background: undefined }) as any)
  expect(r.result.status).toBe('async_launched')
  expect(r.result.agentId).toStartWith('codex-')
  expect(r.result.outputFile).toBe(`${DATA}/runs/${r.result.agentId}.txt`)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits).toHaveLength(1)
  const msg = w.submits[0]!
  expect(msg).toStartWith(`[balancer] Background agent "DESC-SECRET-88" (${r.result.agentId}) finished on Codex.`)
  expect(msg).toContain('Ran on Codex')
  expect(msg).toContain(CODEX_TEXT)
  expect(w.files.get(r.result.outputFile)).toContain(CODEX_TEXT)
  expect(w.agentCalls).toHaveLength(0)
  expect(inflightKeys(w)).toEqual([])
})

test('dw3_post_run_reading_is_stored_and_updates_the_estimate', async ($, on) => {
  const w = world(on, { ...CODEX_AHEAD, 'estimate/Explore': { fiveHour: 5, sevenDay: 1 } }, { rollout: rolloutFor(15) })
  await $.tool.call(agent() as any)
  const stored: any = w.store.get('reading/codex')
  expect(stored.fiveHour.used).toBe(15)
  // same window instance? the seeded reading resets at NOW+4h, the rollout too: delta 10 points, alpha 0.3
  const est: any = w.store.get('estimate/Explore')
  expect(est.fiveHour).toBeGreaterThan(5)
  expect(est.fiveHour).toBeLessThan(10)
})

test('dw3_workspace_write_report_carries_git_status', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { git: ['', ' M done.py'] })
  const r: any = await $.tool.call(agent({ subagent_type: 'general-purpose' }) as any)
  expect(w.spawns[0]!.argv).toContain('workspace-write')
  const text: string = r.result.content[0].text
  expect(text).toContain('Changed or untracked files (git status):\ndone.py')
  expect(text).not.toMatch(/\bh:/) // no hash in the report
})

test('dw3_plan_mode_forces_a_read_only_sandbox', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await $.tool.call(agent({ subagent_type: 'general-purpose', mode: 'plan' }) as any)
  expect(w.spawns[0]!.argv).toContain('read-only')
})

test('dw3_a_cut_report_points_at_the_full_text', OPTS({ maxResultChars: 10 }), async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: 'x'.repeat(50) })
  const r: any = await $.tool.call(agent() as any)
  const path = `${DATA}/runs/${r.result.agentId}.txt`
  expect(r.result.content[0].text).toContain(`Full text: ${path}`)
  expect(w.files.get(path)).toBe('x'.repeat(50))
})

// ---------- dw4: ineligible calls reach next(e) untouched ----------

const INELIGIBLE: [string, Record<string, unknown>][] = [
  ['type_not_eligible', { subagent_type: 'Plan' }],
  ['fork', { subagent_type: 'fork' }],
  ['isolation', { isolation: 'worktree' }],
  ['named_agent', { name: 'helper' }],
  ['capability_mcp', { prompt: 'call mcp__github__list_prs' }],
  ['capability_skill', { prompt: 'use the Skill tool' }],
  ['capability_sendmessage', { prompt: 'then SendMessage to the lead' }],
]
for (const [name, over] of INELIGIBLE) {
  test(`dw4_${name}`, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    const input = agent(over)
    const r: any = await $.tool.call(input as any)
    expect(r.result).toEqual(CLAUDE_MARK)
    expect(w.agentCalls).toHaveLength(1)
    same(w.agentCalls[0], input)
    expect(w.spawns).toHaveLength(0)
  })
}

// Every alternative of CAPABILITY_RE reaches the bottom Agent hook; words that merely contain one do not.
const CAPS = ['mcp__x__y', 'Skill', 'SendMessage', 'AskUserQuestion', 'Artifact']
for (const word of CAPS) {
  test(`dw4_capability_alternative_${word}`, async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    const input = agent({ prompt: `please use ${word} here` })
    const r: any = await $.tool.call(input as any)
    expect(r.result).toEqual(CLAUDE_MARK)
    expect(w.agentCalls).toHaveLength(1)
    same(w.agentCalls[0], input)
    expect(w.spawns).toHaveLength(0)
  })
}

test('dw4_capability_words_inside_other_words_do_not_match', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const r: any = await $.tool.call(agent({ prompt: 'ArtifactX Skills xmcp__y mySendMessage AskUserQuestions' }) as any)
  expect(r.result.status).toBe('completed')
  expect(w.agentCalls).toHaveLength(0)
  expect(w.spawns).toHaveLength(1)
})

test('dw4_omitted_type_is_eligible', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const { subagent_type: _t, ...input } = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result.status).toBe('completed')
  expect(w.agentCalls).toHaveLength(0)
})

test('dw4_project_opt_out_file', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/balancer.json`, '{ "codex": false }')
  const input = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.spawns).toHaveLength(0)
})

test('dw4_missing_cwd', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { cwdExists: false })
  const input = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.spawns).toHaveLength(0)
})

// ---------- dw5: failure rows ----------

test('dw5_hook_throws_claude_runs', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  // the harness's session.usage stub reads w.usage, so a throwing getter makes that op throw
  Object.defineProperty(w, 'usage', { get() { throw new Error('usage broke') } })
  const input = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  expect(w.agentCalls).toHaveLength(1)
  same(w.agentCalls[0], input)
  expect(w.spawns).toHaveLength(0)
})

test('dw5_codex_missing_falls_back_and_toasts_once', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'missing' })
  const input = agent()
  const r1: any = await $.tool.call(input as any)
  expect(r1.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.toasts).toHaveLength(1)
  const r2: any = await $.tool.call(agent() as any)
  expect(r2.result).toEqual(CLAUDE_MARK)
  expect(w.toasts).toHaveLength(1) // once
  expect(w.spawns).toHaveLength(1) // unusable for the session: no second try
})

test('dw5_sync_read_only_failure_runs_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  const input = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(inflightKeys(w)).toEqual([])
})

test('dw5_sync_workspace_write_failure_with_no_changes_runs_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: ['', ''] })
  const input = agent({ subagent_type: 'general-purpose' })
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
})

test('dw5_sync_workspace_write_failure_with_changes_names_the_files', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: ['', ' M a.py\n?? b.py'] })
  const r: any = await $.tool.call(agent({ subagent_type: 'general-purpose' }) as any)
  const text: string = r.result.content[0].text
  expect(text).toContain('Codex stopped before finishing (exit 1)')
  expect(text).toContain('a.py')
  expect(text).toContain('b.py')
  expect(w.agentCalls).toHaveLength(0)
})

test('dw5_sync_workspace_write_failure_outside_git_says_it_could_not_check', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [null] })
  const r: any = await $.tool.call(agent({ subagent_type: 'general-purpose' }) as any)
  expect(r.result.content[0].text).toContain('could not check for changed files')
  expect(w.agentCalls).toHaveLength(0)
})

test('dw5_limit_hit_stores_codex_limit_reading', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'limit' })
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual(CLAUDE_MARK) // Explore: read-only, so Claude runs it
  const stored: any = w.store.get('reading/codex')
  expect(stored.limitReached).toBe(true)
  expect(stored.fiveHour.used).toBe(5) // the earlier windows are kept
  // the next call sees the limit
  await $.tool.call(agent() as any)
  expect(w.spawns).toHaveLength(1)
  expect(logLines(w).at(-1).reason).toBe('codex-limit')
})

test('dw5_background_failure_delivers_message_and_starts_cooldown', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  const r: any = await $.tool.call(agent({ run_in_background: undefined }) as any)
  expect(r.result.status).toBe('async_launched')
  await settleReal(() => w.submits.length > 0)
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]).toContain('Codex could not run "DESC-SECRET-88"')
  expect(w.submits[0]).toContain('exit 1')
  expect(w.submits[0]).toContain('nothing was changed')
  expect(w.submits[0]).toContain('delegate it again')
  expect(inflightKeys(w)).toEqual([])
  // the re-delegation runs on Claude with reason codex-cooldown, even though Codex is far ahead
  const input = agent()
  const r2: any = await $.tool.call(input as any)
  expect(r2.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.spawns).toHaveLength(1)
  expect(logLines(w).at(-1).reason).toBe('codex-cooldown')
})

test('dw5_background_failure_with_changed_files_delivers_failure_text_and_no_cooldown', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: ['', ' M a.py'] })
  await $.tool.call(agent({ subagent_type: 'general-purpose', run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain('Codex stopped before finishing (exit 1). Files changed so far: a.py')
  w.script = 'ok'
  const r2: any = await $.tool.call(agent() as any)
  expect(r2.result.status).toBe('completed') // no cooldown
})

test('dw5_claude_rate_limit_error_marks_claude_limited', async ($, on) => {
  const w = world(on, {
    'reading/claude': reading({ fiveUsed: 10, sevenUsed: 10 }),
    'reading/codex': reading({ fiveUsed: 10, sevenUsed: 10 }),
  })
  await $.tool.call(agent() as any)
  expect(logLines(w).at(-1).reason).toBe('claude-ahead') // equal readings stay on Claude
  await ($ as any).classic.StopFailure({ error: 'rate_limit' })
  expect((w.store.get('reading/claude') as any).limitReached).toBe(true)
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  expect(logLines(w).at(-1).reason).toBe('claude-ceiling')
  // another kind of error changes nothing
  w.store.set('reading/claude', reading({ fiveUsed: 10, sevenUsed: 10 }))
  await ($ as any).classic.StopFailure({ error: 'overloaded' })
  expect((w.store.get('reading/claude') as any).limitReached).toBe(false)
})

// ---------- dw6: stopping a background run ----------

// The kit cannot abort a `$.tool.call` (no signal, no turn.abort), so the sync interrupt path
// (`next.signal`) is covered where the runner is driven directly, in test/codex.test.ts.
// Here: TaskStop and session.end abort the detached run.

const launchHanging = async ($: any, on: any) => {
  const w = world(on, CODEX_AHEAD, { script: 'hang' })
  await startSession($)
  const r: any = await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.spawns.length > 0 && inflightKeys(w).length > 0)
  return { w, id: r.result.agentId as string }
}

test('dw6_task_stop_aborts_the_codex_run_and_releases_the_reservation', async ($, on) => {
  const { w, id } = await launchHanging($, on)
  expect(inflightKeys(w)).toEqual([`inflight/${id}`])
  const r: any = await $.tool.call({ tool: 'TaskStop', task_id: id } as any)
  expect(r.result.task_id).toBe(id)
  expect(r.result.message).toContain('Successfully stopped task')
  expect(w.stopCalls).toHaveLength(0) // answered by Balancer, not passed on
  await settleReal(() => w.spawnFinally > 0)
  expect(w.spawnFinally).toBe(1) // the stub's finally ran: the child was killed
  expect(inflightKeys(w)).toEqual([])
  expect(w.submits).toEqual([]) // an aborted run delivers nothing
  expect(w.agentCalls).toHaveLength(0)
})

test('dw6_task_stop_of_another_task_passes_through', async ($, on) => {
  const { w } = await launchHanging($, on)
  const r: any = await $.tool.call({ tool: 'TaskStop', task_id: 'not-ours' } as any)
  expect(r.result.message).toBe('claude-stop')
  expect(w.stopCalls).toHaveLength(1)
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } } as any) // cleanup
})

test('dw6_session_end_aborts_runs_of_that_session', async ($, on) => {
  const { w } = await launchHanging($, on)
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } } as any)
  await settleReal(() => w.spawnFinally > 0)
  expect(w.spawnFinally).toBe(1)
  expect(inflightKeys(w)).toEqual([])
  expect(w.submits).toEqual([])
})

// ---------- dw8: reservations ----------

// Whether the kit serialises tool.call dispatch is not observable from outside; the plugin
// serialises its own decide-and-reserve step, so the result does not depend on it.
test('dw8_three_simultaneous_eligible_calls_split_as_in_prd_7_4', async ($, on) => {
  const w = world(on, PRD_74, { script: 'hang' })
  await startSession($)
  const mk = () => $.tool.call(agent({ run_in_background: undefined }) as any) as Promise<any>
  const rs = await Promise.all([mk(), mk(), mk()])
  const toCodex = rs.filter(r => r.result.status === 'async_launched')
  expect(toCodex).toHaveLength(1)
  expect(w.agentCalls).toHaveLength(2)
  expect(logLines(w).filter(l => l.route === 'codex')).toHaveLength(0) // written when the run ends
  await $.tool.call({ tool: 'TaskStop', task_id: toCodex[0].result.agentId } as any)
  await settleReal(() => w.spawnFinally > 0)
  expect(inflightKeys(w)).toEqual([])
})

// ---------- dw9: modes and opt-out ----------

test('dw9_mode_off_passes_through_without_reading_anything', OPTS({ mode: 'off' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const input = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.loginChecks).toBe(0)
  expect(w.spawns).toHaveLength(0)
  expect(logLines(w)).toEqual([]) // never reached the decision
})

test('dw9_mode_claude_keeps_everything_on_claude', OPTS({ mode: 'claude' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  expect(w.spawns).toHaveLength(0)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'mode-claude', mode: 'claude' })
})

test('dw9_mode_codex_routes_to_codex_even_when_claude_is_ahead', OPTS({ mode: 'codex' }), async ($, on) => {
  const w = world(on, {
    'reading/claude': reading({ fiveUsed: 5, sevenUsed: 5 }),
    'reading/codex': reading({ fiveUsed: 50, sevenUsed: 50 }),
  })
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  expect(logLines(w).at(-1)).toMatchObject({ route: 'codex', reason: 'mode-codex' })
})

test('dw9_balance_command_overrides_the_option', OPTS({ mode: 'codex' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await startSession($)
  await cmd($, 'claude')
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  expect(w.spawns).toHaveLength(0)
  expect(logLines(w).at(-1)).toMatchObject({ reason: 'mode-claude', mode: 'claude' })
  await cmd($, 'off')
  expect(((await $.tool.call(agent() as any)) as any).result).toEqual(CLAUDE_MARK)
  expect(logLines(w)).toHaveLength(1) // off logs nothing
})

test('dw9_opt_out_file_that_does_not_parse_or_is_missing_does_not_opt_out', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/balancer.json`, '{ not json')
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  w.files.set(`${CWD}/.claude/balancer.json`, '{ "codex": true }')
  const r2: any = await $.tool.call(agent() as any)
  expect(r2.result.status).toBe('completed')
})

// ---------- dw11: decision log ----------

test('dw11_log_lines_hold_no_prompt_description_or_report_text', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await startSession($)
  await $.tool.call(agent() as any) // codex, sync
  await $.tool.call(agent({ subagent_type: 'Plan' }) as any) // ineligible: not logged
  await cmd($, 'claude')
  await $.tool.call(agent() as any) // claude
  const raw = w.files.get(`${DATA}/decisions.jsonl`)!
  for (const secret of ['PROMPT-SECRET-77', 'DESC-SECRET-88', CODEX_TEXT]) expect(raw).not.toContain(secret)
  const ls = logLines(w)
  expect(ls).toHaveLength(2)
  expect(ls[0]).toMatchObject({ t: NOW, session: SID, agentType: 'Explore', route: 'codex', reason: 'codex-ahead', mode: 'auto', outcome: 'ok', exitCode: 0 })
  expect(Object.keys(ls[0]).sort()).toEqual(
    ['agentType', 'claudeAfter', 'codexAfter', 'durationMs', 'estimate', 'exitCode', 'mode', 'outcome', 'reason', 'route', 'session', 't'])
  expect(ls[1]).toMatchObject({ route: 'claude', reason: 'mode-claude', mode: 'claude' })
})

test('dw11_log_never_exceeds_2000_lines', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const seed = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ n: i })).join('\n') + '\n'
  w.files.set(`${DATA}/decisions.jsonl`, seed)
  await $.tool.call(agent() as any)
  const ls = logLines(w)
  expect(ls).toHaveLength(2000)
  expect(ls[0]).toEqual({ n: 1 }) // the oldest line went
  expect(ls.at(-1).route).toBe('codex')
})

test('dw11_a_failing_log_write_never_changes_routing', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { failWrites: true })
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  expect(w.spawns).toHaveLength(1)
  expect(w.files.size).toBe(0)
  await startSession($)
  await cmd($, 'claude')
  expect((await $.tool.call(agent() as any) as any).result).toEqual(CLAUDE_MARK)
})

// ---------- dw12: /balance ----------

test('dw12_balance_shows_windows_scores_mode_tasks_and_last_decisions', async ($, on) => {
  const w = world(on, {
    ...CODEX_AHEAD,
    'inflight/other': { id: 'other', sessionId: 's2', startedAt: NOW - 120_000, cost: { fiveHour: 5, sevenDay: 1 }, agentType: 'general-purpose' },
  })
  await startSession($)
  await $.tool.call(agent() as any)
  await $.tool.call(agent({ subagent_type: 'general-purpose' }) as any)
  const { text }: any = await cmd($)
  expect(text).toContain('mode: auto')
  expect(text).toMatch(/Claude: score \d+/)
  expect(text).toMatch(/Codex: score \d+/)
  expect(text).toContain('5h 80% used')
  expect(text).toContain('7d 5% used')
  expect(text).toContain('runway')
  expect(text).toContain('resets in')
  expect(text).toContain('in flight: 1 (general-purpose 2m)')
  expect(text).toMatch(/Explore -> codex \(codex-ahead\)/)
  expect(text).toMatch(/general-purpose -> /)
  expect(text).toContain('Codex: available')
  expect(w.loginChecks).toBeGreaterThan(0)
})

test('dw12_balance_shows_last_five', async ($, on) => {
  world(on, CODEX_AHEAD)
  await startSession($)
  const types = ['Explore', 'general-purpose']
  for (let i = 0; i < 7; i++) await $.tool.call(agent({ subagent_type: types[i % 2] }) as any)
  const { text }: any = await cmd($)
  const rows = text.split('\n').filter((l: string) => / -> /.test(l)).map((l: string) => l.trim().split(' ')[1])
  expect(rows).toEqual(['Explore', 'general-purpose', 'Explore', 'general-purpose', 'Explore'])
})

test('dw12_balance_with_a_mode_sets_it_and_a_bad_argument_prints_usage', async ($, on) => {
  world(on, CODEX_AHEAD)
  await startSession($)
  const a: any = await cmd($, 'codex')
  expect(a.text).toContain('codex')
  expect(((await cmd($)) as any).text).toContain('mode: codex')
  const b: any = await cmd($, 'bogus')
  expect(b.text).toBe('Usage: /balance [auto|claude|codex|off]')
  expect(((await cmd($)) as any).text).toContain('mode: codex') // unchanged
})

test('dw12_balance_shows_the_cooldown_after_a_background_failure', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  await startSession($)
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(((await cmd($)) as any).text).toMatch(/cooling down 1[45]m/)
})

// ---------- inputs: session.measure ----------

test('dw2_session_measure_saves_the_claude_reading', async ($, on) => {
  const w = world(on)
  const resetsAt = new Date(NOW + 2 * H).toISOString()
  await ($ as any).session.measure({
    context: { window: 1000 }, changed: ['rateLimits'],
    rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt }, { kind: 'spend_limit', percentUsed: 1 }],
  })
  const s: any = w.store.get('reading/claude')
  expect(s.fiveHour).toEqual({ used: 42.5, resetsAt: NOW + 2 * H, lengthMs: 5 * H })
  expect(s.sevenDay).toBeNull()
  expect(s.readAt).toBe(NOW)
})

test('dw2_a_stored_claude_limit_survives_the_next_measure_until_its_reset', async ($, on) => {
  const w = world(on, { 'reading/claude': reading({ fiveUsed: 99, sevenUsed: 50, limit: true }) })
  const rateLimits = [{ kind: 'five_hour', percentUsed: 99, resetsAt: new Date(NOW + 5 * H).toISOString() }]
  await ($ as any).session.measure({ context: {}, changed: ['rateLimits'], rateLimits })
  expect((w.store.get('reading/claude') as any).limitReached).toBe(true)
  w.store.set('reading/claude', { ...reading({ fiveUsed: 99, sevenUsed: 50, limit: true }), fiveHour: { used: 99, resetsAt: NOW - 1, lengthMs: 5 * H }, sevenDay: null })
  await ($ as any).session.measure({ context: {}, changed: ['rateLimits'], rateLimits })
  expect((w.store.get('reading/claude') as any).limitReached).toBe(false) // its reset time has passed
})

test('dw2_the_live_claude_reading_beats_an_older_stored_one', async ($, on) => {
  const w = world(on, {
    'reading/claude': reading({ fiveUsed: 10, sevenUsed: 10, readAt: NOW - 5 * H }),
    'reading/codex': reading({ fiveUsed: 70, sevenUsed: 70 }),
  }, { usage: [{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(NOW + 2 * H).toISOString() }] })
  await $.tool.call(agent() as any)
  // live 97% is at the ceiling of 95: Codex takes it
  expect(logLines(w).at(-1)).toMatchObject({ route: 'codex', reason: 'claude-ceiling' })
})

test('dw2_no_codex_reading_routes_to_claude_and_refreshes_in_the_background', async ($, on) => {
  const w = world(on, { 'reading/claude': reading({ fiveUsed: 10, sevenUsed: 10 }) })
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  expect(logLines(w).at(-1).reason).toBe('no-codex-reading')
})

// ---------- dw5: changed files are found by content, not by status code ----------

const DIRTY = ' M a.py\n?? b.py'
const GP = { subagent_type: 'general-purpose' }

test('dw5_sync_failure_names_dirty_and_untracked_files_edited_during_the_run', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [DIRTY, DIRTY] }) // same status codes before and after
  w.work.set('a.py', 'v1'); w.work.set('b.py', 'v1'); w.work.set('c.py', 'v1')
  w.during = () => { w.work.set('a.py', 'v2'); w.work.set('b.py', 'v2') }
  const r: any = await $.tool.call(agent(GP) as any)
  expect(r.result.content[0].text).toContain('Files changed so far: a.py, b.py.')
  expect(w.agentCalls).toHaveLength(0) // Claude does not re-run it
})

test('dw5_a_dirty_file_the_run_did_not_touch_is_not_reported', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [' M a.py\n M c.py', ' M a.py\n M c.py'] })
  w.work.set('a.py', 'v1'); w.work.set('c.py', 'v1')
  w.during = () => { w.work.set('a.py', 'v2') }
  const r: any = await $.tool.call(agent(GP) as any)
  const text: string = r.result.content[0].text
  expect(text).toContain('Files changed so far: a.py.')
  expect(text).not.toContain('c.py')
})

test('dw5_sync_failure_with_untouched_dirty_files_runs_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [DIRTY, DIRTY] })
  w.work.set('a.py', 'v1'); w.work.set('b.py', 'v1')
  const input = agent(GP)
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
})

test('dw5_background_failure_with_edited_dirty_files_delivers_failure_text', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [DIRTY, DIRTY] })
  w.work.set('a.py', 'v1'); w.work.set('b.py', 'v1')
  w.during = () => { w.work.set('b.py', 'v2') }
  await $.tool.call(agent({ ...GP, run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain('Files changed so far: b.py.')
  w.script = 'ok'
  expect(((await $.tool.call(agent() as any)) as any).result.status).toBe('completed') // no cooldown
})

test('dw5_a_dirty_file_that_was_reverted_is_reported', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: [' M a.py', ''] })
  w.work.set('a.py', 'dirty')
  const r: any = await $.tool.call(agent(GP) as any)
  expect(r.result.content[0].text).toContain('Files changed so far: a.py.')
  expect(w.agentCalls).toHaveLength(0)
})

// ---------- dw5: Codex missing or logged out at the pre-launch check ----------

test('dw5_login_check_that_cannot_start_toasts_once_and_both_calls_run_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { loginThrows: true })
  const a = agent(), b = agent()
  const r1: any = await $.tool.call(a as any)
  const r2: any = await $.tool.call(b as any)
  expect(r1.result).toEqual(CLAUDE_MARK)
  expect(r2.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], a)
  same(w.agentCalls[1], b)
  expect(w.spawns).toHaveLength(0)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/Codex is not available/)
})

test('dw5_codex_logged_out_toasts_once_and_both_calls_run_on_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { loggedIn: false })
  const r1: any = await $.tool.call(agent() as any)
  const r2: any = await $.tool.call(agent() as any)
  expect(r1.result).toEqual(CLAUDE_MARK)
  expect(r2.result).toEqual(CLAUDE_MARK)
  expect(w.spawns).toHaveLength(0)
  expect(w.toasts).toHaveLength(1)
  expect(logLines(w).at(-1).reason).toBe('codex-unavailable')
})

test('dw5_the_unavailable_toast_and_the_spawn_error_toast_share_one_slot', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'missing' })
  await $.tool.call(agent() as any) // login ok, spawn fails: one toast
  w.loggedIn = false
  await $.tool.call(agent() as any)
  expect(w.toasts).toHaveLength(1)
})

// ---------- dw6: foreground interrupt at hook level ----------

// The kit cannot hand a hook a `next.signal` (it cannot abort a `$.tool.call`), and its `$` has no engine ops to call
// `onAgent` with, so the hook is driven directly over a small hand-made `$`. Its spawned child hangs until `return()`
// is called on the iterator, and takes 150 ms to exit: the reservation must outlive that.
test('dw6_sync_abort_through_next_signal_kills_the_run_then_releases_and_answers_interrupted', async () => {
  const store = new Map<string, unknown>(Object.entries(CODEX_AHEAD))
  const files = new Map<string, string>()
  const kept = () => [...store.keys()].filter(k => k.startsWith('inflight/'))
  const seen = { cleaned: false, reservedAtExit: -1, returns: 0 }
  let release!: () => void
  const hung = new Promise<void>(r => { release = r })
  let sent = false
  const it = {
    async next() {
      if (!sent) { sent = true; return { done: false, value: { stream: 'stdout', text: '{"type":"thread.started","thread_id":"t-1"}\n' } } }
      await hung
      return { done: true, value: { code: null, signal: null } }
    },
    async return() {
      seen.returns++
      release()
      await sleep(150)
      seen.cleaned = true
      seen.reservedAtExit = kept().length
      return { done: true, value: undefined }
    },
  }
  const gone = async () => { throw new Error('ENOENT') }
  const $: any = {
    session: { cwd: async () => CWD, root: async () => CWD, id: async () => SID, usage: async () => ({ rateLimits: [] }) },
    fs: {
      stat: async (p: string) => (p === CWD ? { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : gone()),
      read: async (p: string) => files.get(p) ?? gone(), write: async (p: string, t: string) => void files.set(p, t), list: gone,
    },
    store: {
      get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k), keys: async () => [...store.keys()],
    },
    clock: { now: async () => NOW },
    env: { get: async (n: string) => ({ HOME: '/home/t', CLAUDE_CONFIG_DIR: '/cfg' } as Record<string, string>)[n] },
    process: {
      run: async (argv: string[]) => ({ exitCode: argv[0] === 'codex' ? 0 : 1, stdout: '', stderr: '' }),
      spawn: () => ({ [Symbol.asyncIterator]: () => it }),
    },
    ui: { status: async () => {}, toast: async () => {} },
    state: { set: async () => ({ isSet: true, version: 1 }) },
    prompt: { submit: async () => ({}) },
  }
  const ac = new AbortController()
  const next: any = Object.assign(async () => ({ result: CLAUDE_MARK }), { signal: ac.signal })
  const p = onAgent($, createState({}), { ...agent(), tool_use_id: 'tu-1' } as any, next)
  await settleReal(() => kept().length > 0 && sent)
  expect(kept()).toHaveLength(1)
  ac.abort()
  const r: any = await p
  expect(r).toEqual({ deny: 'Balancer: the Codex run was interrupted' })
  expect(seen.returns).toBe(1)
  expect(seen.cleaned).toBe(true) // the child was gone before the hook answered
  expect(seen.reservedAtExit).toBe(1) // and the reservation was still held while it exited
  expect(kept()).toEqual([])
  expect(files.get('/cfg/plugins/data/balancer/decisions.jsonl')).toContain('"outcome":"aborted"')
})

// ---------- dw4: overlap rule for the estimate ----------

test('dw4_a_task_that_starts_and_ends_inside_another_leaves_both_estimates_alone', async ($, on) => {
  const seed = { fiveHour: 5, sevenDay: 1 }
  const w = world(on, { ...CODEX_AHEAD, 'estimate/Explore': seed }, { script: 'gate', rollout: rolloutFor(15) })
  const a: any = await $.tool.call(agent({ run_in_background: undefined }) as any) // A
  expect(a.result.status).toBe('async_launched')
  await settleReal(() => w.spawns.length > 0 && inflightKeys(w).length > 0)
  await sleep(30) // A's stub has read its script
  w.script = 'ok'
  const b: any = await $.tool.call(agent() as any) // B starts and finishes while A runs
  expect(b.result.status).toBe('completed')
  expect(inflightKeys(w)).toHaveLength(1)
  w.openGate() // A finishes with usage up by 10 points
  await settleReal(() => w.submits.length > 0)
  expect(w.submits).toHaveLength(1)
  expect(inflightKeys(w)).toEqual([])
  expect(w.store.get('estimate/Explore')).toEqual(seed)
})

// ---------- dw5: cooldown boundary ----------

test('dw5_cooldown_ends_at_fifteen_minutes', OPTS({ staleAfterMinutes: 600 }), async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  w.script = 'ok'
  await w.clock.advance(15 * 60_000 - 1000)
  const input = agent()
  const r1: any = await $.tool.call(input as any)
  expect(r1.result).toEqual(CLAUDE_MARK)
  expect(logLines(w).at(-1).reason).toBe('codex-cooldown')
  await w.clock.advance(1000) // expiry
  const r2: any = await $.tool.call(agent() as any)
  expect(r2.result.status).toBe('completed')
  expect(logLines(w).at(-1)).toMatchObject({ route: 'codex', reason: 'codex-ahead' })
})

// ---------- dw12: /balance ----------

test('dw12_balance_shows_four_distinct_window_values_under_the_right_provider', async ($, on) => {
  world(on, { 'reading/claude': reading({ fiveUsed: 11, sevenUsed: 22 }), 'reading/codex': reading({ fiveUsed: 33, sevenUsed: 44 }) })
  const { text }: any = await cmd($)
  const ls: string[] = text.split('\n')
  const at = (head: RegExp) => ls.findIndex(l => head.test(l))
  const c = at(/^Claude: score/), x = at(/^Codex: score/)
  expect(c).toBeGreaterThanOrEqual(0)
  expect(x).toBeGreaterThan(c)
  expect(ls[c + 1]).toContain('5h 11% used')
  expect(ls[c + 2]).toContain('7d 22% used')
  expect(ls[x + 1]).toContain('5h 33% used')
  expect(ls[x + 2]).toContain('7d 44% used')
})

test('dw13_balance_shows_decisions_from_earlier_sessions_in_the_log', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const e = (n: number, agentType: string) => JSON.stringify({ t: NOW - n * 1000, session: 'old', agentType, route: 'claude', reason: 'mode-claude' })
  w.files.set(`${DATA}/decisions.jsonl`, [e(3, 'Old1'), 'not json', '', e(2, 'Old2'), e(1, 'Old3')].join('\n') + '\n')
  await startSession($)
  const { text }: any = await cmd($)
  const rows = text.split('\n').filter((l: string) => / -> /.test(l)).map((l: string) => l.trim().split(' ')[1])
  expect(rows).toEqual(['Old1', 'Old2', 'Old3'])
})

test('dw13_balance_falls_back_to_this_sessions_decisions_when_the_log_is_unreadable', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { failWrites: true })
  await startSession($)
  await $.tool.call(agent() as any)
  expect(w.files.size).toBe(0)
  const { text }: any = await cmd($)
  expect(text).toMatch(/Explore -> codex/)
})

test('dw14_codex_last_message_folder_is_created_before_spawn', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  let seen: string[] | undefined
  w.during = () => { seen = w.writes.filter(p => p.endsWith('.last.txt')) }
  await $.tool.call(agent() as any)
  expect(w.spawns).toHaveLength(1)
  const argv = w.spawns[0]!.argv
  const out = argv[argv.indexOf('-o') + 1]
  expect(seen).toEqual([out])
})

const SEVEN_TYPES = ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
test('dw12_balance_lists_exactly_the_last_five_of_seven_unique_decisions', OPTS({ mode: 'claude', eligibleAgentTypes: SEVEN_TYPES.join(',') }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  for (const t of SEVEN_TYPES) {
    await $.tool.call(agent({ subagent_type: t }) as any)
    await w.clock.advance(1000) // a distinct time for each
  }
  const { text }: any = await cmd($)
  const rows = text.split('\n').filter((l: string) => / -> /.test(l)).map((l: string) => l.trim().split(' ')[1])
  expect(rows).toEqual(['t3', 't4', 't5', 't6', 't7'])
  const times = text.split('\n').filter((l: string) => / -> /.test(l)).map((l: string) => l.trim().split(' ')[0])
  expect(new Set(times).size).toBe(5)
})

// ---------- dw4, dw9: more eligibility ----------

test('dw4_fork_stays_on_claude_even_when_listed_as_eligible', OPTS({ eligibleAgentTypes: 'Explore,fork' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const input = agent({ subagent_type: 'fork' })
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.spawns).toHaveLength(0)
})

test('dw9_project_opt_out_also_holds_in_mode_codex', OPTS({ mode: 'codex' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(`${CWD}/.claude/balancer.json`, '{ "codex": false }')
  const input = agent()
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  same(w.agentCalls[0], input)
  expect(w.spawns).toHaveLength(0)
})

test('dw3_explicit_run_in_background_true_runs_in_the_background', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  const r: any = await $.tool.call(agent({ run_in_background: true }) as any)
  expect(r.result.status).toBe('async_launched')
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain(CODEX_TEXT)
  expect(w.agentCalls).toHaveLength(0)
})

// ---------- dw11: a failed run is logged without text ----------

test('dw11_a_failed_run_logs_no_prompt_description_or_failure_message', async ($, on) => {
  const FAIL = 'FAILMSG-SECRET-99'
  const w = world(on, CODEX_AHEAD, { script: 'fail', failMessage: FAIL, git: ['', ''] })
  await $.tool.call(agent(GP) as any) // sync, falls back
  await $.tool.call(agent({ ...GP, run_in_background: undefined }) as any) // a sync failure starts no cooldown
  await settleReal(() => logLines(w).length >= 2)
  const raw = w.files.get(`${DATA}/decisions.jsonl`)!
  for (const secret of ['PROMPT-SECRET-77', 'DESC-SECRET-88', FAIL]) expect(raw).not.toContain(secret)
  expect(logLines(w)).toHaveLength(2)
  for (const l of logLines(w)) expect(l).toMatchObject({ route: 'codex', outcome: 'failed', exitCode: 1 })
})

// ---------- work is saved when Codex stops part-way ----------

const PARTIAL = 'PARTIAL-NOTES-55'
const RESUME = `codex exec resume ${THREAD}`
const LIMIT_WORLD = (on: any, over: Record<string, unknown> = {}) => {
  const w = world(on, CODEX_AHEAD, { script: 'limit', partial: PARTIAL, git: ['', ' M a.py\n?? new.py'], diff: 'DIFF-OUTPUT-66', tracked: new Set(['a.py']), ...over } as any)
  w.work.set('a.py', 'v1'); w.work.set('new.py', 'v1')
  return w
}

test('dw5_limit_hit_with_edits_saves_a_patch_and_the_failure_text_names_everything', async ($, on) => {
  const w = LIMIT_WORLD(on)
  const r: any = await $.tool.call(agent(GP) as any)
  const id = r.result.agentId
  const text: string = r.result.content[0].text
  expect(w.files.get(`${DATA}/runs/${id}.patch`)).toBe('DIFF-OUTPUT-66')
  expect(text).toContain(`${DATA}/runs/${id}.patch`)
  expect(text).toContain('Untracked')
  expect(text).toContain('new.py')
  expect(text).toContain(PARTIAL)
  expect(w.files.get(`${DATA}/runs/${id}.partial.txt`)).toBe(PARTIAL)
  expect(text).toContain(`${DATA}/runs/${id}.partial.txt`)
  expect(text).toContain(RESUME)
  expect(w.gitCalls).toContainEqual(['git', 'diff', 'HEAD', '--', 'a.py'])
  for (const c of w.gitCalls) expect(['status', 'hash-object', 'ls-files', 'diff']).toContain(c[1]!) // no index, stash or commit
  expect(w.agentCalls).toHaveLength(0)
})

test('dw5_a_plain_failure_with_edits_has_a_patch_but_no_resume_hint', async ($, on) => {
  const w = LIMIT_WORLD(on, { script: 'fail' })
  const r: any = await $.tool.call(agent(GP) as any)
  expect(w.files.get(`${DATA}/runs/${r.result.agentId}.patch`)).toBe('DIFF-OUTPUT-66')
  expect(r.result.content[0].text).not.toContain('codex exec resume')
})

test('dw5_a_failing_patch_write_never_changes_the_answer', async ($, on) => {
  const w = LIMIT_WORLD(on, { failWrites: true })
  const r: any = await $.tool.call(agent(GP) as any)
  const text: string = r.result.content[0].text
  expect(text).toContain('Files changed so far: a.py, new.py.')
  expect(text).not.toContain('.patch')
  expect(w.agentCalls).toHaveLength(0)
})

test('dw5_background_limit_hit_with_edits_delivers_patch_untracked_partial_and_resume', async ($, on) => {
  const w = LIMIT_WORLD(on)
  const r: any = await $.tool.call(agent({ ...GP, run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  const id = r.result.agentId
  expect(w.files.get(`${DATA}/runs/${id}.patch`)).toBe('DIFF-OUTPUT-66')
  for (const part of [`${id}.patch`, 'new.py', PARTIAL, `${id}.partial.txt`, RESUME]) expect(w.submits[0]).toContain(part)
})

test('dw5_read_only_limit_hit_with_partial_notes_carries_them_into_the_claude_prompt', async ($, on) => {
  const w = LIMIT_WORLD(on)
  const input = agent() // Explore: read-only, falls back to Claude
  const r: any = await $.tool.call(input as any)
  expect(r.result).toEqual(CLAUDE_MARK)
  const got = w.agentCalls[0]
  expect(got).toEqual({ ...input, prompt: got.prompt, tool_use_id: got.tool_use_id })
  expect(got.prompt).toStartWith(input.prompt + '\n\n')
  expect(got.prompt).toContain('limit reached')
  expect(got.prompt).toContain(PARTIAL)
  expect(got.prompt).toMatch(/verify/i)
})

test('dw5_sync_failure_with_no_changes_and_partial_notes_carries_them_too', async ($, on) => {
  const w = LIMIT_WORLD(on, { git: ['', ''] })
  await $.tool.call(agent(GP) as any)
  expect(w.agentCalls[0].prompt).toContain(PARTIAL)
  expect(w.files.size).toBeGreaterThan(0)
  expect([...w.files.keys()].some(k => k.endsWith('.patch'))).toBe(false)
})

test('dw5_a_fallback_without_partial_notes_leaves_the_input_untouched', async ($, on) => {
  const w = LIMIT_WORLD(on, { partial: undefined })
  const input = agent()
  await $.tool.call(input as any)
  same(w.agentCalls[0], input)
})

test('dw5_partial_notes_are_cut_at_4000_characters', async ($, on) => {
  const w = LIMIT_WORLD(on, { partial: 'p'.repeat(6000) })
  await $.tool.call(agent() as any)
  const prompt: string = w.agentCalls[0].prompt
  expect(prompt).toContain('p'.repeat(4000))
  expect(prompt).not.toContain('p'.repeat(4001))
})

test('dw5_background_read_only_limit_hit_puts_the_partial_notes_in_the_cooldown_message', async ($, on) => {
  const w = LIMIT_WORLD(on)
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain('delegate it again')
  expect(w.submits[0]).toContain(PARTIAL)
})

test('dw5_background_read_only_limit_hit_without_notes_adds_none', async ($, on) => {
  const w = LIMIT_WORLD(on, { partial: undefined })
  await $.tool.call(agent({ run_in_background: undefined }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).not.toMatch(/partial/i)
})

test('dw11_the_log_holds_no_partial_text_or_patch', async ($, on) => {
  const w = LIMIT_WORLD(on)
  await $.tool.call(agent(GP) as any)
  const raw = w.files.get(`${DATA}/decisions.jsonl`)!
  for (const secret of [PARTIAL, 'DIFF-OUTPUT-66']) expect(raw).not.toContain(secret)
})
