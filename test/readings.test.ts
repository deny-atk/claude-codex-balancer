import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import {
  addInflight, claudeFromUsage, codexAvailable, createReadingCache, currentCodexReading,
  expireLimit, listInflight, loadEstimate, loadReading, parseAppServerOutput,
  mergeUsage, parseCodexRolloutTail, pickFresher, readCodexAppServer, readCodexRollout,
  removeInflight, rolloutDayDirs, saveEstimate, saveReading, sumReserved, APP_SERVER_SCRIPT,
} from './../hooks/readings'
import { MARKER, appServerOut, cutRecord, lines, rl, tokenCount, win5h, win7d } from './fixtures/rollout'

const NOW = 1_790_000_000_000
const READING_KEYS = ['fiveHour', 'limitReached', 'readAt', 'sevenDay']

test('dw7_rollout_both_windows', () => {
  const r = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(win5h, win7d))), NOW)
  expect(r).toEqual({
    fiveHour: { used: 96, resetsAt: 1_800_000_000_000, lengthMs: 300 * 60_000 },
    sevenDay: { used: 46, resetsAt: 1_800_500_000_000, lengthMs: 10080 * 60_000 },
    readAt: NOW,
    limitReached: false,
  })
})

test('dw7_rollout_one_null_window', () => {
  const r = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(win5h, null))), NOW)
  expect(r?.fiveHour?.used).toBe(96)
  expect(r?.sevenDay).toBeNull()
})

test('dw7_rollout_windows_by_minutes_not_name', () => {
  const r = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(win7d, win5h))), NOW)
  expect(r?.fiveHour?.used).toBe(96)
  expect(r?.sevenDay?.used).toBe(46)
  const other = { used_percent: 5, window_minutes: 60, resets_at: 1 }
  const r2 = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(other, null))), NOW)
  expect(r2?.fiveHour).toBeNull()
  expect(r2?.sevenDay).toBeNull()
})

test('dw7_rollout_first_line_dropped', () => {
  // The first line is a complete token_count here: it must still be dropped.
  const r = parseCodexRolloutTail(lines(tokenCount(rl(win5h, win7d)), 'x'), NOW)
  expect(r).toBeNull()
  const r2 = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(win5h, win7d))), NOW)
  expect(r2).not.toBeNull()
})

test('dw7_rollout_last_wins_and_skips_null_limits', () => {
  const early = tokenCount(rl({ ...win5h, used_percent: 10 }, null))
  const late = tokenCount(rl({ ...win5h, used_percent: 20 }, null))
  const nul = tokenCount(null)
  const msg = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', rate_limits: rl({ ...win5h, used_percent: 99 }, null) } })
  const r = parseCodexRolloutTail(lines(cutRecord, early, late, nul, msg, '{broken'), NOW)
  expect(r?.fiveHour?.used).toBe(20)
})

test('dw7_rollout_limit_reached_and_missing_reset', () => {
  const w = { used_percent: 100, window_minutes: 300 }
  const r = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(w, null, 'primary'))), NOW)
  expect(r?.limitReached).toBe(true)
  expect(r?.fiveHour?.resetsAt).toBeNull()
})

test('dw7_rollout_malformed_is_null', () => {
  expect(parseCodexRolloutTail('', NOW)).toBeNull()
  expect(parseCodexRolloutTail('garbage', NOW)).toBeNull()
  expect(parseCodexRolloutTail(lines(cutRecord, '{"type":"event_msg"}', '[1]', 'null', '"s"'), NOW)).toBeNull()
  expect(parseCodexRolloutTail(lines(cutRecord, tokenCount(rl({ used_percent: 'x', window_minutes: 300 }, null))), NOW)?.fiveHour).toBeNull()
})

test('dw7_rollout_keeps_only_rate_limits', () => {
  const content = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      message: `hello ${MARKER}`,
      info: { text: MARKER },
      rate_limits: { ...rl(win5h, win7d), note: MARKER, primary: { ...win5h, label: MARKER } },
    },
  })
  const noise = JSON.stringify({ type: 'response_item', payload: { text: MARKER } })
  const r = parseCodexRolloutTail(lines(cutRecord, noise, content, noise), NOW)
  expect(r).not.toBeNull()
  expect(JSON.stringify(r)).not.toContain(MARKER)
  expect(Object.keys(r!).sort()).toEqual(READING_KEYS)
})

test('dw7_rollout_used_is_clamped_to_0_100_and_non_finite_windows_are_dropped', () => {
  const rec = (used: string, mins: string) => tokenCount(rl({ used_percent: 'U', window_minutes: 'M', resets_at: 1 }, null))
    .replace('"U"', used).replace('"M"', mins)
  const read = (used: string, mins: string) => parseCodexRolloutTail(lines(cutRecord, rec(used, mins)), NOW)
  expect(read('150', '300')?.fiveHour?.used).toBe(100)
  expect(read('-5', '300')?.fiveHour?.used).toBe(0)
  expect(read('42.5', '300')?.fiveHour?.used).toBe(42.5)
  expect(read('1e999', '300')?.fiveHour).toBeNull() // Infinity
  expect(read('10', '1e999')?.fiveHour).toBeNull()
  expect(read('10', '1e999')?.sevenDay).toBeNull()
  const app = (used: string, mins: string) => parseAppServerOutput(
    lines(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 'U', windowDurationMins: 'M', resetsAt: 1 } } } }).replace('"U"', used).replace('"M"', mins)), NOW)
  expect(app('250', '10080')?.sevenDay?.used).toBe(100)
  expect(app('1e999', '10080')?.sevenDay).toBeNull()
})

test('dw7_app_server_output', () => {
  const rateLimits = {
    primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
    secondary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    rateLimitReachedType: 'secondary',
  }
  const r = parseAppServerOutput(appServerOut(rateLimits), NOW)
  expect(r).toEqual({
    fiveHour: { used: 12.5, resetsAt: 1_800_000_000_000, lengthMs: 18_000_000 },
    sevenDay: { used: 30, resetsAt: 1_800_500_000_000, lengthMs: 604_800_000 },
    readAt: NOW,
    limitReached: true,
  })
  expect(parseAppServerOutput(appServerOut(null), NOW)).toBeNull()
  expect(parseAppServerOutput('', NOW)).toBeNull()
  expect(parseAppServerOutput(lines(JSON.stringify({ id: 1, result: {} })), NOW)).toBeNull()
})

test('readings_claude_from_usage', () => {
  const r = claudeFromUsage([
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-10T12:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 7 },
    { kind: 'spend_limit', percentUsed: 150 },
  ], NOW)
  expect(r).toEqual({
    fiveHour: { used: 23.5, resetsAt: Date.parse('2026-11-10T12:00:00.000Z'), lengthMs: 18_000_000 },
    sevenDay: { used: 7, resetsAt: null, lengthMs: 604_800_000 },
    readAt: NOW,
    limitReached: false,
  })
  expect(claudeFromUsage([], NOW)).toBeNull()
  expect(claudeFromUsage([{ kind: 'spend_limit', percentUsed: 1 }], NOW)).toBeNull()
})

test('readings_pick_fresher', () => {
  const a = { fiveHour: null, sevenDay: null, readAt: 1, limitReached: false }
  const b = { ...a, readAt: 2 }
  expect(pickFresher(a, b)).toBe(b)
  expect(pickFresher(b, a)).toBe(b)
  expect(pickFresher(null, a)).toBe(a)
  expect(pickFresher(a, null)).toBe(a)
  expect(pickFresher(null, null)).toBeNull()
})

test('readings_expire_limit', () => {
  const w = (resetsAt: number | null) => ({ used: 100, resetsAt, lengthMs: 1 })
  const base = { fiveHour: w(NOW + 1000), sevenDay: w(NOW + 5000), readAt: NOW - 1, limitReached: true }
  expect(expireLimit(base, NOW).limitReached).toBe(true)
  expect(expireLimit(base, NOW + 1000).limitReached).toBe(false)
  expect(expireLimit({ ...base, fiveHour: null }, NOW + 1000).limitReached).toBe(true)
  expect(expireLimit({ ...base, fiveHour: w(null), sevenDay: w(null) }, NOW + 9999).limitReached).toBe(true)
  const off = { ...base, limitReached: false }
  expect(expireLimit(off, NOW)).toEqual(off)
})

const ymd = (d: Date) =>
  `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`

test('dw7_rollout_day_dirs', () => {
  const now = new Date(2026, 2, 1, 0, 30).getTime() // local 1 March
  expect(rolloutDayDirs('/h', now)).toEqual(['/h/.codex/sessions/2026/03/01', '/h/.codex/sessions/2026/02/28'])
})

const TODAY = ymd(new Date(NOW))
const YESTERDAY = ymd(new Date(NOW - 86_400_000))
const tailText = lines(cutRecord, tokenCount(rl(win5h, win7d)))

// A hand-made engine `$`. The kit's `on('store.get'...)` hooks cannot stand in for
// it: a test hook may only make calls its own source names, and the readers make
// them from hooks/readings.ts. Fakes keep the real call shapes and record them.
type Opts = { files?: Record<string, { name: string; mtimeMs: number }[]>; tail?: string; tailExit?: number; throwRun?: boolean }
function wire(opts: Opts = {}) {
  const runs: string[][] = []
  const runInits: unknown[] = []
  const reads: string[] = []
  const lists: string[] = []
  const data = new Map<string, string>()
  const $ = {
    env: { get: async (n: string) => (n === 'HOME' ? '/h' : undefined) },
    fs: {
      list: async (path: string) => {
        lists.push(path)
        const f = opts.files?.[path]
        if (!f) throw new Error('ENOENT')
        return f.map((x) => ({ name: x.name, kind: 'file', size: 1, mtimeMs: x.mtimeMs, isLink: false }))
      },
      read: async (path: string) => { reads.push(path); return '' },
    },
    process: {
      run: async (argv: readonly string[], init?: unknown) => {
        runs.push([...argv])
        runInits.push(init)
        if (opts.throwRun) throw new Error('spawn ENOENT')
        return { exitCode: opts.tailExit ?? 0, stdout: opts.tail ?? tailText, stderr: '' }
      },
    },
    store: {
      get: async (k: string) => (data.has(k) ? JSON.parse(data.get(k)!) : undefined),
      set: async (k: string, v: unknown) => void data.set(k, JSON.stringify(v)),
      delete: async (k: string) => void data.delete(k),
      keys: async () => [...data.keys()],
    },
  } as unknown as EngineInterface
  return { $, runs, runInits, reads, lists }
}

test('dw7_read_rollout_newest_by_mtime_via_tail', async () => {
  const dir = `/h/.codex/sessions/${TODAY}`
  const s = wire({ files: {
    [dir]: [{ name: 'rollout-a-1111.jsonl', mtimeMs: 10 }, { name: 'rollout-b-2222.jsonl', mtimeMs: 20 }, { name: 'notes.txt', mtimeMs: 99 }],
    // yesterday's dir is missing: must be tolerated
  } })
  const r = await readCodexRollout(s.$, NOW)
  expect(r?.fiveHour?.used).toBe(96)
  expect(s.lists).toEqual([dir, `/h/.codex/sessions/${YESTERDAY}`])
  expect(s.runs).toEqual([['tail', '-c', '65536', `${dir}/rollout-b-2222.jsonl`]])
  expect(s.reads).toEqual([])
})

test('dw7_read_rollout_by_thread_id', async () => {
  const y = `/h/.codex/sessions/${YESTERDAY}`
  const s = wire({ files: {
    [`/h/.codex/sessions/${TODAY}`]: [{ name: 'rollout-x-9999.jsonl', mtimeMs: 50 }],
    [y]: [{ name: 'rollout-t-abc-123.jsonl', mtimeMs: 1 }],
  } })
  const r = await readCodexRollout(s.$, NOW, 'abc-123')
  expect(r).not.toBeNull()
  expect(s.runs).toEqual([['tail', '-c', '65536', `${y}/rollout-t-abc-123.jsonl`]])
  expect(s.reads).toEqual([])
})

test('dw7_read_rollout_failures_are_null', async () => {
  const s = wire({ files: {} })
  expect(await readCodexRollout(s.$, NOW)).toBeNull()
})

test('dw7_read_rollout_tail_failure_is_null', async () => {
  const dir = `/h/.codex/sessions/${TODAY}`
  const s = wire({ files: { [dir]: [{ name: 'rollout-a-1.jsonl', mtimeMs: 1 }] }, tailExit: 1 })
  expect(await readCodexRollout(s.$, NOW)).toBeNull()
})

test('dw7_app_server_script_is_fixed', async () => {
  const s = wire({ tail: appServerOut({ primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null, rateLimitReachedType: null }) })
  const r = await readCodexAppServer(s.$, NOW)
  expect(r?.fiveHour?.used).toBe(3)
  expect(s.runs).toEqual([['sh', '-c', APP_SERVER_SCRIPT]])
  expect(s.runInits).toEqual([{ timeoutMs: 15000 }])
  expect(APP_SERVER_SCRIPT).toContain('codex app-server')
  expect(APP_SERVER_SCRIPT).toContain('account/rateLimits/read')
  expect(APP_SERVER_SCRIPT).toContain('sleep 4')
})

test('dw7_app_server_failure_is_null', async () => {
  const s = wire({ tail: '', tailExit: 127 })
  expect(await readCodexAppServer(s.$, NOW)).toBeNull()
})

test('readings_codex_available', async () => {
  const s = wire({ tail: 'Logged in', tailExit: 0 })
  expect(await codexAvailable(s.$)).toBe(true)
  expect(s.runs).toEqual([['codex', 'login', 'status']])
  expect(s.runInits).toEqual([{ timeoutMs: 10000 }])
})

test('readings_codex_unavailable_nonzero', async () => {
  const s = wire({ tailExit: 1 })
  expect(await codexAvailable(s.$)).toBe(false)
})

test('readings_codex_unavailable_missing_binary', async () => {
  const s = wire({ throwRun: true })
  expect(await codexAvailable(s.$)).toBe(false)
})

test('readings_reading_store_roundtrip', async () => {
  const s = wire()
  const r = { fiveHour: null, sevenDay: null, readAt: 5, limitReached: false }
  expect(await loadReading(s.$, 'codex')).toBeNull()
  await saveReading(s.$, 'codex', r)
  expect(await loadReading(s.$, 'codex')).toEqual(r)
  expect(await loadReading(s.$, 'claude')).toBeNull()
  expect(await s.$.store.keys()).toEqual(['reading/codex'])
})

test('readings_estimate_seed_and_save', async () => {
  const s = wire()
  expect(await loadEstimate(s.$, 'worker')).toEqual({ fiveHour: 5, sevenDay: 1 })
  await saveEstimate(s.$, 'worker', { fiveHour: 7, sevenDay: 2 })
  expect(await loadEstimate(s.$, 'worker')).toEqual({ fiveHour: 7, sevenDay: 2 })
  expect(await s.$.store.keys()).toEqual(['estimate/worker'])
})

test('dw7_inflight_drops_stale_records', async () => {
  const s = wire()
  const cost = { fiveHour: 5, sevenDay: 1 }
  await addInflight(s.$, { id: 'old', sessionId: 's', startedAt: NOW - 60_000, cost, agentType: 'a' })
  await addInflight(s.$, { id: 'new', sessionId: 's', startedAt: NOW - 1_000, cost: { fiveHour: 2, sevenDay: 0.5 }, agentType: 'a' })
  const list = await listInflight(s.$, NOW, 30_000)
  expect(list.map((x) => x.id)).toEqual(['new'])
  expect((await s.$.store.keys()).sort()).toEqual(['inflight/new'])
  await removeInflight(s.$, 'new')
  expect(await s.$.store.keys()).toEqual([])
})

test('readings_sum_reserved', () => {
  const mk = (fiveHour: number, sevenDay: number) => ({ id: 'i', sessionId: 's', startedAt: 0, cost: { fiveHour, sevenDay }, agentType: 'a' })
  expect(sumReserved([])).toEqual({ fiveHour: 0, sevenDay: 0 })
  expect(sumReserved([mk(5, 1), mk(2, 0.5)])).toEqual({ fiveHour: 7, sevenDay: 1.5 })
})

test('readings_cache_ttl', () => {
  const c = createReadingCache(30_000)
  const r = { fiveHour: null, sevenDay: null, readAt: 1, limitReached: false }
  expect(c.get('codex', 0)).toBeUndefined()
  c.put('codex', r, 1000)
  expect(c.get('codex', 30_999)).toBe(r)
  expect(c.get('codex', 31_000)).toBeUndefined()
  expect(c.get('claude', 1000)).toBeUndefined()
  c.put('codex', null, 2000)
  expect(c.get('codex', 2001)).toBeNull()
})

test('readings_current_codex_reading_order', async () => {
  const dir = `/h/.codex/sessions/${TODAY}`
  const s = wire({ files: { [dir]: [{ name: 'rollout-a-1.jsonl', mtimeMs: 1 }] }, tail: tailText })
  const fresh = { fiveHour: null, sevenDay: null, readAt: NOW - 1000, limitReached: false }
  await saveReading(s.$, 'codex', fresh)
  // 1. stored reading younger than staleAfterMs: no process
  expect(await currentCodexReading(s.$, NOW, 60_000)).toEqual(fresh)
  expect(s.runs).toEqual([])
  // 2. stale + app-server failure (tail stub is not app-server output) -> rollout, and saved
  const r = await currentCodexReading(s.$, NOW, 500)
  expect(r?.fiveHour?.used).toBe(96)
  expect(s.runs.map((a) => a[0])).toEqual(['sh', 'tail'])
  expect((await loadReading(s.$, 'codex'))?.fiveHour?.used).toBe(96)
})

test('readings_current_codex_reading_app_server_first', async () => {
  const s = wire({ tail: appServerOut({ primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null, rateLimitReachedType: null }) })
  const r = await currentCodexReading(s.$, NOW, 1000)
  expect(r?.fiveHour?.used).toBe(8)
  expect(s.runs.map((a) => a[0])).toEqual(['sh'])
})

test('readings_current_codex_reading_all_fail', async () => {
  const s = wire({ files: {}, tail: '', tailExit: 1 })
  expect(await currentCodexReading(s.$, NOW, 1000)).toBeNull()
})

// ---------- same-window merge (dw25) ----------
// Usage inside one window only rises, so a reading that arrives later but reports less for the same window is old news:
// the engine's first measurement after a session resumes repeats that session's last, possibly hours-old, figures.

const H5 = 300 * 60_000
const D7 = 10080 * 60_000
const rd = (five: [number, number] | null, seven: [number, number] | null, readAt: number) => ({
  fiveHour: five && { used: five[0], resetsAt: five[1], lengthMs: H5 },
  sevenDay: seven && { used: seven[0], resetsAt: seven[1], lengthMs: D7 },
  readAt, limitReached: false,
})

test('dw25_same_window_keeps_the_higher_used_whatever_arrived_last', () => {
  const fresh = rd([66, NOW + H5], [10, NOW + D7], NOW)
  const stale = rd([36, NOW + H5], [6, NOW + D7], NOW + 60_000)
  for (const m of [mergeUsage(fresh, stale), mergeUsage(stale, fresh)]) {
    expect(m!.fiveHour!.used).toBe(66)
    expect(m!.sevenDay!.used).toBe(10)
    expect(m!.readAt).toBe(NOW + 60_000)
  }
})

test('dw25_a_later_window_wins_even_with_less_used', () => {
  const old = rd([90, NOW], [10, NOW + D7], NOW)
  const reset = rd([5, NOW + H5], [10, NOW + D7], NOW + 60_000)
  expect(mergeUsage(old, reset)!.fiveHour).toEqual({ used: 5, resetsAt: NOW + H5, lengthMs: H5 })
  expect(mergeUsage(reset, old)!.fiveHour).toEqual({ used: 5, resetsAt: NOW + H5, lengthMs: H5 })
})

test('dw25_an_earlier_window_loses_even_when_read_later', () => {
  const current = rd([20, NOW + H5], [10, NOW + D7], NOW)
  const stale = rd([36, NOW - H5], [6, NOW + D7 - D7], NOW + 60_000)
  const m = mergeUsage(current, stale)!
  expect(m.fiveHour!.used).toBe(20)
  expect(m.sevenDay!.used).toBe(10)
})

test('dw25_a_missing_window_takes_the_other_reading\'s', () => {
  const m = mergeUsage(rd([20, NOW + H5], null, NOW), rd(null, [7, NOW + D7], NOW))!
  expect(m.fiveHour!.used).toBe(20)
  expect(m.sevenDay!.used).toBe(7)
  expect(mergeUsage(null, null)).toBeNull()
})
