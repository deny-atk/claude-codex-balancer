// Property tests for the parsers and the bounded lists (PRD 17).
// shortcut: hand-rolled seeded generator, the plugin test runtime cannot import fast-check; replace if it can.
import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { appendCapped, pushRecent } from '../hooks/balance'
import type { DecisionEntry } from '../hooks/balance'
import { createEventParser } from '../hooks/codex'
import { listInflight, parseCodexRolloutTail } from '../hooks/readings'
import { MARKER, cutRecord, lines, rl, tokenCount } from './fixtures/rollout'

const CASES = 400
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
const forAll = (seed: number, body: (r: Rng, i: number) => void) => { const r = mulberry32(seed); for (let i = 0; i < CASES; i++) body(r, i) }

const TEXTS = ['pong', 'a {"b": 1} c', 'line\nbreak', 'é漢字🙂', '', 'You hit your usage limit', 'boom', '\\"quoted\\"']

// ---------- event parser ----------

function genStream(r: Rng): string {
  const out: string[] = []
  for (let n = int(r, 0, 12); n > 0; n--) {
    const k = r()
    const ev =
      k < 0.15 ? { type: 'thread.started', thread_id: pick(r, ['t-1', 't-2', 'x']) }
      : k < 0.4 ? { type: 'item.completed', item: { type: pick(r, ['agent_message', 'agent_message', 'command_execution']), text: pick(r, TEXTS) } }
      : k < 0.55 ? { type: 'turn.completed', usage: { input_tokens: int(r, 0, 99), output_tokens: int(r, 0, 99) } }
      : k < 0.7 ? { type: 'turn.failed', error: { message: pick(r, TEXTS) } }
      : k < 0.8 ? { type: 'error', message: pick(r, TEXTS) }
      : k < 0.9 ? { type: 'turn.started' }
      : null
    out.push(ev ? JSON.stringify(ev) : pick(r, ['', 'not json {', 'Reading additional input from stdin...', '{broken', '   ']))
  }
  return out.join('\n') + (r() < 0.7 ? '\n' : '')
}

const chunked = (r: Rng, s: string): string[] => {
  const out: string[] = []
  for (let i = 0; i < s.length;) { const n = int(r, 1, 40); out.push(s.slice(i, i + n)); i += n }
  return out
}

const run = (chunks: string[]) => {
  const p = createEventParser()
  for (const c of chunks) p.feed(c)
  p.flush()
  return p.state
}

test('prop_event_parser_any_chunking_gives_the_state_of_the_whole_stream', () => {
  forAll(101, r => {
    const s = genStream(r)
    const whole = run([s])
    expect(run(chunked(r, s))).toEqual(whole)
    expect(run(chunked(r, s))).toEqual(whole)
    expect(run(s.split(''))).toEqual(whole) // one character at a time
  })
})

// ---------- rollout tail ----------

const READING_KEYS = ['fiveHour', 'limitReached', 'readAt', 'sevenDay']
const NOW = 1_790_000_000_000

const genWin = (r: Rng, mins: number) => ({ used_percent: r() < 0.1 ? pick(r, [0, 100]) : Math.round(r() * 1000) / 10, window_minutes: mins, resets_at: 1_800_000_000 + int(r, 0, 9999) })
const genLimits = (r: Rng) => rl(
  r() < 0.85 ? genWin(r, pick(r, [300, 10080])) : null,
  r() < 0.85 ? genWin(r, pick(r, [300, 10080, 60])) : null,
  r() < 0.2 ? 'primary' : null,
)

const noiseLine = (r: Rng): string => pick(r, [
  () => JSON.stringify({ type: 'response_item', payload: { text: MARKER, rate_limits: genLimits(r) } }),
  () => JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: MARKER, rate_limits: genLimits(r) } }),
  () => tokenCount(null, { message: MARKER }),
  () => tokenCount('not an object'),
  () => `{"type":"event_msg","payload":{"type":"token_count"`, // cut record
  () => 'plain text ' + MARKER,
  () => '',
  () => JSON.stringify([1, 2, MARKER]),
])()

// The same valid record with unrelated content added around and inside it.
const decorate = (r: Rng, limits: ReturnType<typeof rl>): string => {
  const withExtra = r() < 0.5
    ? { ...limits, note: MARKER, primary: limits.primary && typeof limits.primary === 'object' ? { ...limits.primary, label: MARKER } : limits.primary }
    : limits
  return tokenCount(withExtra, r() < 0.5 ? { message: MARKER, text: MARKER } : {})
}

test('prop_rollout_tail_noise_keeps_the_last_valid_reading_and_adds_no_keys', () => {
  forAll(202, r => {
    const limits = Array.from({ length: int(r, 0, 4) }, () => genLimits(r))
    const clean = lines(cutRecord, ...limits.map(l => tokenCount(l)))
    const noisy: string[] = [cutRecord]
    for (const l of limits) {
      for (let n = int(r, 0, 2); n > 0; n--) noisy.push(noiseLine(r))
      noisy.push(decorate(r, l))
    }
    for (let n = int(r, 0, 2); n > 0; n--) noisy.push(noiseLine(r))
    const want = parseCodexRolloutTail(clean, NOW)
    const got = parseCodexRolloutTail(lines(...noisy), NOW)
    expect(got).toEqual(want)
    if (got) {
      expect(Object.keys(got).sort()).toEqual(READING_KEYS)
      expect(JSON.stringify(got)).not.toContain(MARKER)
      for (const w of [got.fiveHour, got.sevenDay]) if (w) expect(Object.keys(w).sort()).toEqual(['lengthMs', 'resetsAt', 'used'])
    }
  })
})

// ---------- listInflight ----------

const COST = { fiveHour: 1, sevenDay: 0.1 }
const TIMEOUT = 30 * 60_000

test('prop_list_inflight_returns_exactly_the_valid_unexpired_and_deletes_exactly_the_rest', async () => {
  const r = mulberry32(303)
  for (let i = 0; i < CASES; i++) {
    const data = new Map<string, unknown>()
    const expectKeep: string[] = []
    const expectDrop: string[] = []
    const others: string[] = []
    for (let n = int(r, 0, 8); n > 0; n--) {
      const id = `i${n}`
      const k = r()
      let v: unknown
      let good = false
      if (k < 0.5) { const age = int(r, 0, 2 * TIMEOUT); v = { id, sessionId: 's', startedAt: NOW - age, cost: COST, agentType: 'a' }; good = age <= TIMEOUT }
      else if (k < 0.6) v = { id, sessionId: 's', cost: COST }
      else if (k < 0.7) v = { id, startedAt: 'now', cost: COST }
      else if (k < 0.8) v = { id, startedAt: NOW, cost: { fiveHour: '1', sevenDay: 0 } }
      else if (k < 0.9) v = pick(r, [null, 7, 'x', [1]])
      else v = { id, startedAt: NOW, cost: null }
      data.set(`inflight/${id}`, v)
      ;(good ? expectKeep : expectDrop).push(`inflight/${id}`)
    }
    for (const k of ['reading/codex', 'estimate/Explore', 'inflightish']) if (r() < 0.5) { data.set(k, { x: 1 }); others.push(k) }
    const $ = { store: {
      get: async (k: string) => data.get(k),
      set: async (k: string, v: unknown) => void data.set(k, v),
      delete: async (k: string) => void data.delete(k),
      keys: async () => [...data.keys()],
    } } as unknown as EngineInterface
    const got = await listInflight($, NOW, TIMEOUT)
    expect(got.map(x => `inflight/${x.id}`).sort()).toEqual([...expectKeep].sort())
    expect([...data.keys()].sort()).toEqual([...expectKeep, ...others].sort())
    expect(expectDrop.every(k => !data.has(k))).toBe(true)
  }
})

// ---------- bounded lists ----------

test('prop_append_capped_equals_the_suffix_of_an_unbounded_list', () => {
  forAll(404, r => {
    const max = int(r, 1, 12)
    const ref: string[] = []
    let text = ''
    for (let n = int(r, 1, 30); n > 0; n--) {
      const line = JSON.stringify({ n: ref.length, s: pick(r, TEXTS) })
      ref.push(line)
      text = appendCapped(text, line, max)
      expect(text).toBe(ref.slice(-max).join('\n') + '\n')
    }
  })
})

test('prop_push_recent_equals_the_suffix_of_an_unbounded_list', () => {
  forAll(505, r => {
    const max = int(r, 1, 8)
    const ref: DecisionEntry[] = []
    const list: DecisionEntry[] = []
    for (let n = int(r, 1, 30); n > 0; n--) {
      const e = { t: ref.length, agentType: pick(r, ['a', 'b']) } as unknown as DecisionEntry
      ref.push(e)
      pushRecent(list, e, max)
      expect(list).toEqual(ref.slice(-max))
    }
  })
})
