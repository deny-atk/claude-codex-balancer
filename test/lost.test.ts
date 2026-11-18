import { test, expect } from 'claude-code/testing'
const OPTS = (o: Record<string, unknown>) => ({ options: o as any })
import { CODEX_AHEAD, DATA, NOW, SID, agent, logLines, settleReal, startSession, world } from './harness'

const entry = { t: NOW, session: SID, agentType: 'Explore', route: 'codex', reason: 'codex-ahead', claudeAfter: 1, codexAfter: 2, estimate: { fiveHour: 1, sevenDay: 1 }, mode: 'auto' }
const record = (over: Record<string, unknown> = {}) => ({ agentId: 'codex-123', sessionId: SID, description: 'synthetic task', background: true, sandbox: 'workspace-write', gitCwd: '/proj', before: [], outFile: `${DATA}/runs/codex-123.last.txt`, base: `${DATA}/runs/codex-123`, startedAt: NOW, type: 'Explore', entry, ...over })

test('dw41_run_record_exists_during_spawn_and_is_removed_after_return', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  let seen: unknown
  w.during = () => { seen = [...w.store.entries()].find(([k]) => k.startsWith('run/'))?.[1] }
  await $.tool.call(agent() as any)
  expect(seen).toMatchObject({ sessionId: SID, background: false, entry: { agentType: 'Explore' } })
  expect(JSON.stringify(seen)).not.toContain('PROMPT-SECRET-77')
  expect([...w.store.keys()].filter(k => k.startsWith('run/'))).toEqual([])
})

test('dw42_start_reconciles_once_and_logs_lost', async ($, on) => {
  const w = world(on, { 'run/codex-123': record(), 'inflight/codex-123': { id: 'codex-123' } })
  await startSession($)
  await startSession($)
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]).toContain('Nothing was changed; delegate it again.')
  expect(logLines(w)[0].outcome).toBe('lost')
  expect(w.store.has('run/codex-123')).toBe(false)
  expect(w.store.has('inflight/codex-123')).toBe(false)
})

test('dw43_other_session_old_run_is_removed_without_a_message', async ($, on) => {
  const w = world(on, { 'run/codex-123': record({ sessionId: 'other', startedAt: NOW - 36 * 60_000 }) })
  await startSession($)
  expect(w.store.has('run/codex-123')).toBe(false)
  expect(logLines(w)[0].outcome).toBe('lost')
  expect(w.submits).toHaveLength(0)
})

test('dw44_unknown_codex_task_stop_explains_it_ended', async ($, on) => {
  world(on)
  const result: any = await $.tool.call({ tool: 'TaskStop', task_id: 'codex-123' } as any)
  expect(result.deny).toContain('is not running; it already ended')
})

const lostSubmits = (w: any) => w.submits.filter((s: string) => s.includes('ended without a result'))
const runKeys = (w: any) => [...w.store.keys()].filter((k: string) => k.startsWith('run/'))

test('dw41_background_record_is_marked_and_removed_after_delivery', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  let seen: any
  w.during = () => { seen = [...w.store.entries()].find(([k]) => k.startsWith('run/'))?.[1] }
  await $.tool.call(agent({ run_in_background: true }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(seen?.background).toBe(true)
  expect(w.submits).toHaveLength(1)
  expect(runKeys(w)).toEqual([])
})

test('dw41_codex_command_record_is_removed_after_its_text', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  let seen: any
  w.during = () => { seen = runKeys(w) }
  await $.command.run({ command: 'codex', args: 'list the files' } as any)
  expect(seen).toHaveLength(1)
  expect(runKeys(w)).toEqual([])
})

test('dw41_foreground_record_is_removed_when_codex_fails_and_the_call_falls_back', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' } as any)
  let seen: string[] = []
  w.during = () => { seen = runKeys(w) }
  await $.tool.call(agent() as any)
  expect(seen).toHaveLength(1)
  expect(runKeys(w)).toEqual([])
})

test('dw42_changed_files_are_listed_with_the_saved_patch', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { git: [' M a.py\n?? new.py'], diff: 'DIFF-OUTPUT-66', tracked: new Set(['a.py']) } as any)
  await startSession($)
  await settleReal(() => runKeys(w).length === 0)
  const text = lostSubmits(w)[0]
  expect(text).toContain('a.py')
  expect(text).toContain('new.py')
  expect(text).toContain('codex-123.patch')
  expect(w.files.get(`${DATA}/runs/codex-123.patch`)).toBe('DIFF-OUTPUT-66')
})

test('dw42_unknown_snapshot_says_the_change_check_is_unknown', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { git: [null] } as any)
  await startSession($)
  expect(lostSubmits(w)[0]).toContain('The change check is unknown')
})

test('dw42_notes_codex_left_are_included', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() })
  w.files.set(`${DATA}/runs/codex-123.last.txt`, 'NOTE-FROM-CODEX-31')
  await startSession($)
  expect(lostSubmits(w)[0]).toContain('NOTE-FROM-CODEX-31')
})

test('dw42_read_only_run_reports_nothing_changed_without_asking_git', async ($, on) => {
  const w = world(on, { 'run/codex-123': record({ sandbox: 'read-only' }) }, { git: [' M a.py'] } as any)
  await startSession($)
  expect(lostSubmits(w)[0]).toContain('Nothing was changed')
  expect(w.gitCalls.filter((c: string[]) => c[1] === 'status')).toEqual([])
})

test('dw42_first_prompt_reconciles_when_session_start_did_not_and_carries_the_message_as_context', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() })
  await $.prompt.submit({ text: 'hello' } as any)
  await $.prompt.submit({ text: 'again' } as any)
  expect(w.submits).toEqual(['hello', 'again'])
  expect(w.contexts[0]?.join('\n')).toContain('ended without a result')
  expect(w.contexts[1]).toBeUndefined()
  expect(logLines(w).filter((l: any) => l.outcome === 'lost')).toHaveLength(1)
  expect(runKeys(w)).toEqual([])
})

test('dw42_a_slash_command_does_not_take_the_message_the_next_typed_prompt_does', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() })
  await $.prompt.submit({ text: '/balance', command: { name: 'balance', args: '' } } as any)
  expect(w.contexts[0]).toBeUndefined()
  expect(w.store.has('run/codex-123')).toBe(true)
  await $.prompt.submit({ text: 'hello' } as any)
  expect(w.contexts[1]?.join('\n')).toContain('ended without a result')
})

test('dw42_a_broken_record_does_not_stop_the_others', async ($, on) => {
  const w = world(on, { 'run/codex-000': 'garbage', 'run/codex-123': record() })
  await startSession($)
  expect(lostSubmits(w)).toHaveLength(1)
})

test('dw42_record_stays_until_the_message_has_entered', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() })
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  w.submitGate = gate
  await startSession($)
  expect(w.store.has('run/codex-123')).toBe(true)
  release()
  await settleReal(() => !w.store.has('run/codex-123'))
  expect(w.store.has('run/codex-123')).toBe(false)
})

test('dw43_young_record_of_another_session_is_left_alone', async ($, on) => {
  const w = world(on, { 'run/codex-123': record({ sessionId: 'other' }), 'inflight/codex-123': { id: 'codex-123' } })
  await startSession($)
  expect(w.store.has('run/codex-123')).toBe(true)
  expect(w.store.has('inflight/codex-123')).toBe(true)
  expect(logLines(w)).toEqual([])
})

test('dw44_task_stop_on_a_leftover_record_answers_with_the_lost_run_message', async ($, on) => {
  const w = world(on, { 'run/codex-123': record(), 'inflight/codex-123': { id: 'codex-123' } })
  const result: any = await $.tool.call({ tool: 'TaskStop', task_id: 'codex-123' } as any)
  expect(result.result.message).toContain('ended without a result')
  expect(w.stopCalls).toEqual([])
  expect(w.submits).toEqual([])
  expect(logLines(w)[0].outcome).toBe('lost')
  expect(w.store.has('inflight/codex-123')).toBe(false)
  expect(runKeys(w)).toEqual([])
})

test('dw44_task_stop_on_a_record_of_another_session_is_refused_and_left_alone', async ($, on) => {
  const w = world(on, { 'run/codex-123': record({ sessionId: 'other' }) })
  const result: any = await $.tool.call({ tool: 'TaskStop', task_id: 'codex-123' } as any)
  expect(result.deny).toContain('another session')
  expect(w.store.has('run/codex-123')).toBe(true)
  expect(logLines(w)).toEqual([])
})

test('dw44_task_stop_on_another_id_goes_to_the_engine', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'TaskStop', task_id: 'b12345' } as any)
  expect(w.stopCalls).toHaveLength(1)
})

test('dw42_a_codex_child_that_outlived_its_process_is_stopped_before_the_change_check', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { pkillFinds: true } as any)
  const started = startSession($)
  await settleReal(() => w.processCalls.some((c: string[]) => c[0] === 'pkill'))
  await w.clock.advance(1000) // the wait for the stopped child to exit
  await started
  const kill = w.processCalls.findIndex((c: string[]) => c[0] === 'pkill')
  const status = w.processCalls.findIndex((c: string[]) => c[0] === 'git' && c[1] === 'status')
  const pattern = 'codex exec .* -o .*/codex-123\\.last\\.txt( |$)'
  expect(w.processCalls[kill]).toEqual(['pkill', '-f', pattern])
  expect(w.processCalls[kill + 1]).toEqual(['pkill', '-KILL', '-f', pattern]) // one that ignored SIGTERM
  expect(kill + 1).toBeLessThan(status)
  expect(new RegExp(pattern).test('codex exec --json -o /d/runs/codex-123.last.txt -')).toBe(true)
  expect(new RegExp(pattern).test('codex exec --json -o /Data Dir/runs/codex-123.last.txt -')).toBe(true)
  expect(new RegExp(pattern).test('codex exec --json -o /d/runs/codex-456.last.txt continue the work of codex-123')).toBe(false)
  expect(lostSubmits(w)).toHaveLength(1)
})

test('dw42_reconcile_does_not_redo_or_start_a_cooldown', async ($, on) => {
  const w = world(on, { ...CODEX_AHEAD, 'run/codex-123': record() })
  await startSession($)
  expect(w.agentSpawns).toEqual([])
  await $.tool.call(agent() as any)
  expect(w.spawns).toHaveLength(1) // the next call still goes to Codex
})

test('dw43_another_sessions_record_is_kept_until_the_timeout_plus_five_minutes', OPTS({ taskTimeoutMinutes: 10 }), async ($, on) => {
  const w = world(on, { 'run/codex-123': record({ sessionId: 'other', startedAt: NOW - 15 * 60_000 + 1000 }) })
  await startSession($)
  expect(w.store.has('run/codex-123')).toBe(true)
})

test('dw43_another_sessions_record_past_the_timeout_plus_five_minutes_is_cleared', OPTS({ taskTimeoutMinutes: 10 }), async ($, on) => {
  const w = world(on, { 'run/codex-123': record({ sessionId: 'other', startedAt: NOW - 15 * 60_000 - 1000 }) })
  await startSession($)
  expect(w.store.has('run/codex-123')).toBe(false)
})
