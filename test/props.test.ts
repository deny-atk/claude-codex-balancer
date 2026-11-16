// Property tests for the parsers and the bounded lists (PRD 17).
// shortcut: hand-rolled seeded generator, the plugin test runtime cannot import fast-check; replace if it can.
import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { appendCapped, pushRecent, lastDecisions } from '../hooks/balance'
import type { DecisionEntry } from '../hooks/balance'
import { createEventParser } from '../hooks/codex'
import * as codex from '../hooks/codex'
import { listInflight, parseCodexRolloutTail, mergeUsage } from '../hooks/readings'
import { reading } from './harness'
import { parseAgentDef, unavailableTools } from '../hooks/agentdef'
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

test('prop_dw30_redundant_separators_preserve_safety', () => {
  forAll(301, r => {
    const path = pick(r, ['/home/t', '/home', '/', '/srv/data', '/srv', '/home/t/data'])
    const repeated = path.replace(/\//g, () => '/'.repeat(1 + int(r, 0, 3)))
    expect(codex.safeDirSyntax(repeated, '/home/t')).toBe(codex.safeDirSyntax(path, '/home/t'))
  })
})

test('prop_dw5_git_c_quoted_paths_round_trip', () => {
  forAll(302, r => {
    const chars = ['a', 'é', '漢', '\t', '\n', '"', '\\', ' -> ']
    const path = Array.from({ length: 1 + int(r, 0, 12) }, () => pick(r, chars)).join('')
    const quoted = '"' + Array.from(new TextEncoder().encode(path)).map(b => {
      if (b === 34 || b === 92) return '\\' + String.fromCharCode(b)
      if (b < 32 || b >= 127) return '\\' + b.toString(8).padStart(3, '0')
      return String.fromCharCode(b)
    }).join('') + '"'
    expect(codex.unquoteGitPath(quoted)).toBe(path)
  })
})

test('prop_dw13_last_decisions_selects_the_valid_suffix', () => {
  forAll(303, r => {
    const entries = Array.from({ length: 20 }, (_, t) => r() < 0.5
      ? { t, agentType: 'a', reason: 'r', route: 'claude', claudeAfter: 1, codexAfter: 2 }
      : { t, route: 'invalid' })
    const n = int(r, 1, 8)
    expect(lastDecisions(entries.map(x => JSON.stringify(x)).join('\n'), n).map(x => x.t))
      .toEqual(entries.filter(x => x.route === 'claude').slice(-n).map(x => x.t))
  })
})

test('prop_dw40_model_family_matching', () => {
  forAll(304, r => {
    const family = pick(r, ['opus', 'sonnet', 'fable'])
    const excluded = new Set([family])
    const id = `${r() < 0.5 ? 'us.anthropic.' : ''}claude-${family}-${int(r, 1, 9)}${r() < 0.5 ? '[1m]' : ''}`
    expect(codex.modelExcluded(r() < 0.5 ? family.toUpperCase() : family, excluded)).toBe(true)
    expect(codex.modelExcluded(id.toUpperCase(), excluded)).toBe(true)
    expect(codex.modelExcluded(`claude-${family}x-1`, excluded)).toBe(false)
  })
})

test('prop_dw_reading_merge_uses_max_and_is_idempotent', () => {
  forAll(305, r => {
    const a = reading({ fiveUsed: int(r, 0, 100), sevenUsed: int(r, 0, 100) })
    const b = reading({ fiveUsed: int(r, 0, 100), sevenUsed: int(r, 0, 100) })
    const merged = mergeUsage(a, b)!
    expect(merged.fiveHour!.used).toBe(Math.max(a.fiveHour.used, b.fiveHour.used))
    expect(merged.sevenDay!.used).toBe(Math.max(a.sevenDay.used, b.sevenDay.used))
    expect(mergeUsage(merged, merged)).toEqual(merged)
  })
})

test('prop_dw_agent_tools_list_forms_have_the_same_decisions', () => {
  forAll(307, r => {
    const pool = ['Read', 'Edit', 'Write', 'Skill', 'Bash']
    const tools = pool.filter(() => r() < 0.5)
    if (tools.length === 0) tools.push('Read')
    const forms = [tools.join(', '), `[${tools.join(', ')}]`, `\n${tools.map(t => `  - ${t}`).join('\n')}`]
    const defs = forms.map(form => parseAgentDef(`---\ntools: ${form}\n---\nbody`)!)
    for (const def of defs) {
      expect(def.tools).toEqual(tools)
      expect(codex.sandboxFor('custom', false, def.tools)).toBe(codex.sandboxFor('custom', false, tools))
      expect(unavailableTools(def)).toBe(unavailableTools(defs[0]!))
    }
  })
})

test('prop_dw31_blocked_matches_reference', () => {
  forAll(308, r => {
    const pool = ['', '  ', 'BLOCKED: x', 'Status: blocked', '**Status:** completed', 'A blocked sentence']
    const lines = Array.from({ length: int(r, 0, 10) }, () => pick(r, pool))
    const nonempty = lines.filter(line => line.trim()).slice(0, 5)
    const expected = nonempty[0] === 'BLOCKED: x' || nonempty.includes('Status: blocked')
    expect(codex.isBlocked(lines.join('\n'))).toBe(expected)
  })
})

test('dw3_prop_model_selection_agrees_with_exact_entry_or_fallback', () => {
  forAll(106, r => {
    const keys = ['opus', 'sonnet', 'default', 'constructor', 'toString']
    const entries = keys.filter(() => r() < 0.5).map(key => [key, pick(r, ['gpt-a', 'gpt-b'])] as const)
    const map = codex.parseEffortMap(entries.map(([key, value]) => `${key}=${value}`).join(','))
    const model = pick(r, [...keys, 'haiku', undefined])
    const fallback = pick(r, ['', 'gpt-fallback'])
    const matching = entries.find(([key]) => key === model)
    expect(codex.codexModelFor(model, map, fallback)).toBe(matching ? matching[1] : fallback || undefined)
  })
})

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
