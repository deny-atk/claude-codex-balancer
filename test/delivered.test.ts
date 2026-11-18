// A background Codex run that ended is never reported lost later (DW58-60): its record goes when Codex ends, a leftover
// record whose launch already has an outcome in the log is dropped quietly, and a run another live process of the same
// session still runs is left alone.
import { test, expect } from 'claude-code/testing'
import * as balance from '../hooks/balance'
import { CODEX_AHEAD, DATA, NOW, SID, agent, logLines, settleReal, startSession, world } from './harness'

const entry = { t: NOW - 60_000, session: SID, agentType: 'Explore', route: 'codex', reason: 'codex-ahead', claudeAfter: 1, codexAfter: 2, estimate: { fiveHour: 1, sevenDay: 1 }, mode: 'auto' }
const record = (over: Record<string, unknown> = {}) => ({ agentId: 'codex-123', sessionId: SID, description: 'synthetic task', background: true, sandbox: 'workspace-write', gitCwd: '/proj', before: [], outFile: `${DATA}/runs/codex-123.last.txt`, base: `${DATA}/runs/codex-123`, startedAt: NOW - 60_000, type: 'Explore', entry, ...over })
const LOG = `${DATA}/decisions.jsonl`
const runKeys = (w: any) => [...w.store.keys()].filter((k: string) => k.startsWith('run/'))
const kills = (w: any) => w.processCalls.filter((c: string[]) => c[0] === 'pkill')
const lostSubmits = (w: any) => w.submits.filter((s: string) => s.includes('ended without a result'))
const never = new Promise<void>(() => {})

// ---------- dw58: an ended run leaves no record and is never reported lost ----------

test('dw58_a_background_run_whose_message_has_not_entered_yet_leaves_no_record', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.submitGate = never // the session stays busy: the message waits for it
  await $.tool.call(agent({ run_in_background: true }) as any)
  await settleReal(() => w.spawnFinally > 0, 500)
  await settleReal(() => runKeys(w).length === 0, 500)
  expect(runKeys(w)).toEqual([])
  expect(logLines(w).map(l => l.outcome)).toEqual(['ok'])
})

test('dw58_a_background_run_whose_message_cannot_be_delivered_leaves_no_record', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { submitFails: true } as any)
  await $.tool.call(agent({ run_in_background: true }) as any)
  await settleReal(() => w.spawnFinally > 0, 500)
  await settleReal(() => runKeys(w).length === 0, 500)
  expect(runKeys(w)).toEqual([])
})

test('dw58_task_stop_on_an_ended_run_whose_message_waits_answers_at_once', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.submitGate = never
  const r: any = await $.tool.call(agent({ run_in_background: true }) as any)
  await settleReal(() => w.spawnFinally > 0, 500)
  await settleReal(() => runKeys(w).length === 0, 500)
  let answer: any = 'hung'
  void $.tool.call({ tool: 'TaskStop', task_id: r.result.agentId } as any).then((a: any) => { answer = a })
  await settleReal(() => answer !== 'hung', 300)
  expect(answer).not.toBe('hung')
  expect(answer.deny).toContain('is not running; it already ended')
})

for (const [id, over] of [['this_session', {}], ['another_session_past_the_bound', { sessionId: 'other', startedAt: NOW - 60 * 60_000 }]] as const) {
  test(`dw58_a_leftover_record_whose_launch_has_an_outcome_in_the_log_is_dropped_quietly_${id}`, async ($, on) => {
    const rec = record(over)
    const w = world(on, { 'run/codex-123': rec })
    w.files.set(LOG, `${JSON.stringify({ ...rec.entry, outcome: 'ok', durationMs: 36_000 })}\n`)
    await startSession($)
    await settleReal(() => runKeys(w).length === 0, 500)
    expect(runKeys(w)).toEqual([])
    expect(logLines(w).map(l => l.outcome)).toEqual(['ok'])
    expect(w.submits).toEqual([])
    expect(kills(w)).toEqual([])
  })
}

test('dw59_an_outcome_row_of_another_launch_does_not_clear_the_record', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() })
  w.files.set(LOG, [
    JSON.stringify({ ...entry, t: entry.t + 1, outcome: 'ok' }), // same session, another launch
    JSON.stringify({ ...entry, session: 'other', outcome: 'ok' }), // same moment, another session
  ].join('\n') + '\n')
  await startSession($)
  expect(logLines(w).map(l => l.outcome)).toEqual(['ok', 'ok', 'lost'])
  expect(lostSubmits(w)).toHaveLength(1)
})

test('dw58_ended_launches_are_the_session_and_time_of_rows_with_an_outcome_other_than_lost', () => {
  const row = (o: Record<string, unknown>) => JSON.stringify({ ...entry, ...o })
  const text = [
    row({ t: 1, outcome: 'ok' }), row({ t: 2, outcome: 'blocked' }), row({ t: 3, outcome: 'lost' }), row({ t: 4 }),
    row({ t: 5, session: 'other', outcome: 'failed' }), 'not json', '',
  ].join('\n')
  expect([...balance.endedLaunches(text)].sort()).toEqual(['other 5', `${SID} 1`, `${SID} 2`].sort())
})

// ---------- dw59: a run that really died is still reported once ----------

test('dw59_a_record_whose_launch_was_already_logged_lost_is_reported_again', async ($, on) => {
  // The instance that logged it died before the message entered: a duplicate beats a dropped message.
  const w = world(on, { 'run/codex-123': record() })
  w.files.set(LOG, `${JSON.stringify({ ...entry, outcome: 'lost' })}\n`)
  await startSession($)
  expect(lostSubmits(w)).toHaveLength(1)
})

// ---------- dw60: a run another live process of the session runs is left alone ----------

test('dw60_a_run_that_another_live_process_of_this_session_runs_is_not_stopped_or_reported', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { codexPids: '4242' } as any)
  w.ppids.set('4242', '777') // a live Claude process: the session is open twice (a resume keeps its id)
  await startSession($)
  expect(kills(w)).toEqual([])
  expect(logLines(w)).toEqual([])
  expect(w.submits).toEqual([])
  expect(runKeys(w)).toEqual(['run/codex-123'])
  expect(w.processCalls.find((c: string[]) => c[0] === 'pgrep')).toEqual(['pgrep', '-f', 'codex exec .* -o .*/codex-123\\.last\\.txt( |$)'])
})

test('dw60_task_stop_on_a_run_another_live_process_runs_is_refused_and_left_alone', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { codexPids: '4242' } as any)
  w.ppids.set('4242', '777')
  const r: any = await $.tool.call({ tool: 'TaskStop', task_id: 'codex-123' } as any)
  expect(r.deny).toContain('another open copy of this session')
  expect(kills(w)).toEqual([])
  expect(runKeys(w)).toEqual(['run/codex-123'])
})

test('dw60_an_orphaned_codex_child_is_still_stopped_and_reported_lost', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { codexPids: '4242', pkillFinds: true } as any)
  w.ppids.set('4242', '1') // its Claude process died: launchd adopted it
  const started = startSession($)
  await settleReal(() => kills(w).length > 0)
  await w.clock.advance(1000)
  await started
  expect(kills(w).length).toBeGreaterThan(0)
  expect(lostSubmits(w)).toHaveLength(1)
})

test('dw60_a_process_whose_parent_cannot_be_read_counts_as_not_running_elsewhere', async ($, on) => {
  const w = world(on, { 'run/codex-123': record() }, { codexPids: '4242' } as any)
  await startSession($)
  expect(lostSubmits(w)).toHaveLength(1)
})
