// Property tests for the parsers and the bounded lists (PRD 17).
// shortcut: hand-rolled seeded generator, the plugin test runtime cannot import fast-check; replace if it can.
import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { appendCapped, pushRecent, lastDecisions } from '../hooks/balance'
import type { DecisionEntry } from '../hooks/balance'
import { createEventParser } from '../hooks/codex'
import * as codex from '../hooks/codex'
import { listInflight, parseCodexRolloutTail, parseAppServerOutput, mergeUsage } from '../hooks/readings'
import type { WindowReading } from '../hooks/policy'
import { reading } from './harness'
import { parseAgentDef, unavailableTools } from '../hooks/agentdef'
import { MARKER, appServerOut, cutRecord, lines, rl, tokenCount } from './fixtures/rollout'

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
const forAll = (seed: number, body: (r: Rng, i: number) => void, n = CASES) => { const r = mulberry32(seed); for (let i = 0; i < n; i++) body(r, i) }

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

// ---------- second round: change check, readings, agent files, window merge (200 cases each, fixed seeds) ----------

const shuffled = <T,>(r: Rng, xs: readonly T[]): T[] => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = int(r, 0, i); [a[i], a[j]] = [a[j]!, a[i]!] }
  return a
}

test('prop_dw5_changed_since_is_exactly_the_paths_whose_presence_or_fingerprint_differs', () => {
  forAll(401, r => {
    const paths = Array.from(new Set(Array.from({ length: int(r, 0, 12) }, () => `d${int(r, 0, 3)}/f${int(r, 0, 9)}${pick(r, ['', '\tx'])}`)))
    const side = () => new Map(paths.filter(() => r() < 0.7).map(p => [p, pick(r, ['h1', 'h2', 'missing'])] as const))
    const before = side()
    const after = side()
    const text = (m: Map<string, string>) => shuffled(r, [...m].map(([p, f]) => `${p}\t${f}`))
    const expected = paths.filter(p => before.get(p) !== after.get(p)).sort()
    expect(codex.changedSince(text(before), text(after))!.sort()).toEqual(expected)
    expect(codex.changedSince(null, text(after))).toBeNull()
    expect(codex.changedSince(text(before), null)).toBeNull()
  }, 200)
})

test('prop_dw5_rollout_and_app_server_windows_give_the_same_reading', () => {
  forAll(402, r => {
    // Both shapes carry the reset in epoch seconds only; neither takes milliseconds.
    const mk = (mins: number) => r() < 0.2 ? null : { used: int(r, -40, 160), mins, resets: r() < 0.2 ? undefined : int(r, 1_700_000_000, 1_800_000_000) }
    const wins = shuffled(r, [mk(300), mk(10080)])
    const rollout = (w: ReturnType<typeof mk>) => w && { used_percent: w.used, window_minutes: w.mins, ...(w.resets !== undefined ? { resets_at: w.resets } : {}) }
    const app = (w: ReturnType<typeof mk>) => w && { usedPercent: w.used, windowDurationMins: w.mins, ...(w.resets !== undefined ? { resetsAt: w.resets } : {}) }
    const reached = r() < 0.3 ? 'primary' : null
    const a = parseCodexRolloutTail(lines(cutRecord, tokenCount(rl(rollout(wins[0]!), rollout(wins[1]!), reached))), 5)
    const b = parseAppServerOutput(appServerOut({ primary: app(wins[0]!), secondary: app(wins[1]!), rateLimitReachedType: reached }), 5)
    expect(a).toEqual(b)
    const want = (mins: number): WindowReading | null => {
      const w = wins.find(x => x?.mins === mins)
      return w ? { used: Math.min(100, Math.max(0, w.used)), resetsAt: w.resets === undefined ? null : w.resets * 1000, lengthMs: mins * 60_000 } : null
    }
    expect(a).toEqual({ fiveHour: want(300), sevenDay: want(10080), readAt: 5, limitReached: reached !== null })
  }, 200)
})

test('prop_dw18_agent_file_round_trips_model_effort_tools_and_trimmed_body', () => {
  // Not covered, by design of the parser: CR-only line ends, a dash list at column 0, a comma inside one quoted tool,
  // and an unbracketed inline list whose first and last items share a quote (`tools: "A", "B"` loses both outer quotes wrongly).
  forAll(403, r => {
    const word = () => pick(r, ['opus', 'sonnet', 'haiku', 'inherit', 'high', 'low', 'max', 'x-1'])
    const quote = (v: string) => pick(r, [v, `"${v}"`, `'${v}'`])
    const model = r() < 0.7 ? word() : undefined
    const effort = r() < 0.7 ? word() : undefined
    const tools = r() < 0.7 ? Array.from({ length: int(r, 1, 4) }, () => pick(r, ['Read', 'Grep', 'Edit', 'Bash(git:*)', 'Task'])) : undefined
    const body = Array.from({ length: int(r, 1, 4) }, () => pick(r, ['Do the work.', '  indented', 'é漢 text', 'a: b', 'x -- y'])).join('\n')
    const fm = [
      'name: t',
      ...(model !== undefined ? [`model: ${quote(model)}`] : []),
      ...(effort !== undefined ? [`effort: ${quote(effort)}`] : []),
      ...(tools ? [pick(r, [0, 1, 2]) === 0 ? `tools: ${tools.join(', ')}` : pick(r, [0, 1]) === 0 ? `tools: [${tools.map(quote).join(', ')}]` : `tools:\n${tools.map(t => `  - ${quote(t)}`).join('\n')}`] : []),
    ]
    const eol = pick(r, ['\n', '\r\n'])
    const text = pick(r, ['', '\ufeff']) + `---${eol}${fm.join('\n').replace(/\n/g, eol)}${eol}---${eol}${'\n\n'.slice(0, int(r, 0, 2)).replace(/\n/g, eol)}${body.replace(/\n/g, eol)}${eol}`
    const def = parseAgentDef(text)
    expect(def).not.toBeNull()
    expect(def!.model).toBe(model)
    expect(def!.effort).toBe(effort)
    expect(def!.tools).toEqual(tools)
    expect(def!.body).toBe(body.trim())
  }, 200)
})

test('prop_dw25_merge_window_keeps_the_higher_use_in_one_window_and_the_later_window_across_windows', () => {
  const LEN = 5 * 3_600_000
  forAll(404, r => {
    const win = (resetsAt: number | null): WindowReading | null => r() < 0.15 ? null : { used: int(r, 0, 100), resetsAt, lengthMs: LEN }
    const base = 1_790_000_000_000
    const ra = r() < 0.15 ? null : base
    // offsets around the half-window boundary: strictly inside is one window, exactly half or more is another
    const offset = pick(r, [0, 1, LEN / 2 - 1, LEN / 2, LEN / 2 + 1, LEN, 3 * LEN]) * pick(r, [-1, 1])
    const rb = r() < 0.15 ? null : base + offset
    const a = win(ra)
    const b = win(rb)
    const out = mergeUsage({ fiveHour: a, sevenDay: null, readAt: 1, limitReached: false }, { fiveHour: b, sevenDay: null, readAt: 2, limitReached: false })!.fiveHour
    if (!a || !b) expect(out).toBe(a ?? b)
    else if (a.resetsAt === null && b.resetsAt === null) expect([a, b]).toContain(out!)
    else if (a.resetsAt === null) expect(out).toBe(b)
    else if (b.resetsAt === null) expect(out).toBe(a)
    else if (Math.abs(a.resetsAt - b.resetsAt) < LEN / 2) expect(out!.used).toBe(Math.max(a.used, b.used))
    else expect(out!.resetsAt).toBe(Math.max(a.resetsAt, b.resetsAt))
  }, 200)
})
