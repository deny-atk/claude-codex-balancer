import { test, expect } from 'claude-code/testing'
import {
  FIVE_HOUR_MS, SEVEN_DAY_MS, ZERO_COST, runway, score, decide, updateEstimate, effectiveWindow,
  type ProviderReading, type WindowReading, type DecideInput, type Cost, type Mode,
} from '../hooks/policy'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 10, 14, 0, 0)
const CONFIG = { margin: 5, ceilingFiveHour: 95, ceilingSevenDay: 97, maxConcurrentCodex: 2 }

const w5 = (used: number, hoursLeft: number | null): WindowReading =>
  ({ used, resetsAt: hoursLeft === null ? null : NOW + hoursLeft * H, lengthMs: FIVE_HOUR_MS })
const w7 = (used: number, hoursLeft: number | null): WindowReading =>
  ({ used, resetsAt: hoursLeft === null ? null : NOW + hoursLeft * H, lengthMs: SEVEN_DAY_MS })
const reading = (fiveHour: WindowReading | null, sevenDay: WindowReading | null, limitReached = false): ProviderReading =>
  ({ fiveHour, sevenDay, readAt: NOW, limitReached })

const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  now: NOW, mode: 'auto', config: CONFIG,
  claude: reading(w5(10, 4), w7(10, 100)), codex: reading(w5(10, 4), w7(10, 100)),
  claudeCost: { fiveHour: 1, sevenDay: 0.2 }, codexCost: { fiveHour: 4, sevenDay: 0.8 },
  reserved: ZERO_COST, claudeReserved: ZERO_COST, inflight: 0, codexAvailable: true, ...over,
})

// Worked cases of PRD 7.1 / 7.2.
const claude71 = reading(w5(62, 1.5), w7(55, 67))
const codex71 = reading(w5(20, 4), w7(46, 120))

test('dw1_score_worked_case_71', () => {
  expect(Math.abs(score(claude71, NOW) - 113)).toBeLessThan(1)
  expect(Math.abs(score(codex71, NOW) - 76)).toBeLessThan(1)
  expect(Math.abs(runway(claude71.fiveHour, FIVE_HOUR_MS, NOW) - 127)).toBeLessThan(1)
})

test('dw26b_claude_reserved_cost_reduces_both_window_scores', () => {
  const c = reading(w5(80, 2), w7(0, 168))
  const d = decide(base({ claude: c, claudeReserved: { fiveHour: 3, sevenDay: 2 } }))
  expect(d.claudeAfter).toBe(score(c, NOW, { fiveHour: 4, sevenDay: 2.2 }))
})

test('dw26_weekly_reservation_limits_score_and_routes_to_codex', () => {
  const claude = reading(w5(0, 5), w7(80, 168))
  const d = decide(base({ claude, claudeCost: ZERO_COST, claudeReserved: { fiveHour: 0, sevenDay: 5 } }))
  expect(d.claudeAfter).toBe(15)
  expect(d.route).toBe('codex')
})

test('dw1_past_resets_at_is_a_reset_window', () => {
  const past: WindowReading = { used: 99, resetsAt: NOW - 1, lengthMs: FIVE_HOUR_MS }
  expect(effectiveWindow(past, FIVE_HOUR_MS, NOW)).toEqual({ used: 0, resetsAt: null, lengthMs: FIVE_HOUR_MS })
  expect(runway(past, FIVE_HOUR_MS, NOW)).toBe(100)
  expect(score(reading(past, w7(0, null)), NOW)).toBe(100)
})

test('dw1_null_window_is_unused', () => {
  expect(effectiveWindow(null, SEVEN_DAY_MS, NOW)).toEqual({ used: 0, resetsAt: null, lengthMs: SEVEN_DAY_MS })
  expect(runway(null, FIVE_HOUR_MS, NOW)).toBe(100)
  expect(score(reading(null, null), NOW)).toBe(100)
  expect(score(null, NOW)).toBe(100)
})

test('dw1_runway_is_capped_at_999', () => {
  expect(runway(w5(0, 0.01), FIVE_HOUR_MS, NOW)).toBeLessThan(999.01)
  expect(runway({ used: 0, resetsAt: NOW + 1, lengthMs: FIVE_HOUR_MS }, FIVE_HOUR_MS, NOW)).toBe(999)
})

test('dw2_worked_case_one_goes_to_claude', () => {
  const d = decide(base({ claude: claude71, codex: codex71 }))
  expect(d.route).toBe('claude')
  expect(d.reason).toBe('claude-ahead')
  expect(Math.abs(d.claudeAfter - 112)).toBeLessThan(1)
  expect(Math.abs(d.codexAfter - 75)).toBeLessThan(1)
  expect(d.refresh).toBe(false)
})

test('dw2_worked_case_two_goes_to_codex', () => {
  const claude = reading(w5(0, null), w7(88, 30))
  const codex = reading(w5(0, null), w7(46, 72))
  const d = decide(base({ claude, codex }))
  expect(d.route).toBe('codex')
  expect(d.reason).toBe('codex-ahead')
  expect(Math.abs(d.codexAfter - 96)).toBeLessThan(1)
  expect(Math.abs(d.claudeAfter - 66)).toBeLessThan(1)
})

test('dw2_mode_codex_with_no_codex_reading_still_goes_to_codex_when_usable', () => {
  const d = decide(base({ mode: 'codex', codex: null, codexAvailable: true }))
  expect([d.route, d.reason]).toEqual(['codex', 'mode-codex'])
})

const codexAhead = { claude: reading(w5(0, null), w7(88, 30)), codex: reading(w5(0, null), w7(46, 72)) }

test('dw2_mode_off_forces_claude', () => {
  const d = decide(base({ ...codexAhead, mode: 'off' }))
  expect([d.route, d.reason]).toEqual(['claude', 'mode-off'])
})

test('dw2_mode_claude_forces_claude', () => {
  const d = decide(base({ ...codexAhead, mode: 'claude' }))
  expect([d.route, d.reason]).toEqual(['claude', 'mode-claude'])
})

test('dw2_mode_codex_forces_codex_when_usable', () => {
  const d = decide(base({ mode: 'codex' })) // Claude would win on score
  expect([d.route, d.reason]).toEqual(['codex', 'mode-codex'])
})

test('dw2_mode_codex_with_codex_unusable_goes_to_claude_with_rule2_reason', () => {
  expect(decide(base({ mode: 'codex', codexAvailable: false })).reason).toBe('codex-unavailable')
  const d = decide(base({ mode: 'codex', inflight: 2 }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-concurrency'])
})

test('dw2_mode_off_beats_rule2_reasons', () => {
  expect(decide(base({ mode: 'off', codexAvailable: false })).reason).toBe('mode-off')
})

test('dw2_codex_unavailable', () => {
  const d = decide(base({ ...codexAhead, codexAvailable: false }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-unavailable'])
})

test('dw2_codex_limit', () => {
  const d = decide(base({ ...codexAhead, codex: reading(w5(0, null), w7(46, 72), true) }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-limit'])
})

test('dw2_codex_concurrency', () => {
  const d = decide(base({ ...codexAhead, inflight: 2 }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-concurrency'])
})

test('dw2_codex_ceiling_five_hour_includes_cost_and_reservation', () => {
  // 90 + 4 < 95 is fine; with 1 reserved it reaches 95.
  const codex = reading(w5(90, 4), w7(0, null))
  expect(decide(base({ ...codexAhead, codex })).reason).not.toBe('codex-ceiling')
  const d = decide(base({ ...codexAhead, codex, reserved: { fiveHour: 1, sevenDay: 0 } }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-ceiling'])
})

test('dw2_codex_ceiling_seven_day', () => {
  const d = decide(base({ ...codexAhead, codex: reading(w5(0, null), w7(96.5, 72)) }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-ceiling'])
})

test('dw2_rule2_reason_order', () => {
  const codex = reading(w5(99, 4), w7(0, null), true)
  expect(decide(base({ codex, codexAvailable: false, inflight: 5 })).reason).toBe('codex-unavailable')
  expect(decide(base({ codex, inflight: 5 })).reason).toBe('codex-limit')
  expect(decide(base({ codex: { ...codex, limitReached: false }, inflight: 5 })).reason).toBe('codex-concurrency')
  expect(decide(base({ codex: { ...codex, limitReached: false } })).reason).toBe('codex-ceiling')
})

test('dw2_claude_ceiling_beats_score', () => {
  // Claude has the better score here, but its 5h window is at the ceiling.
  const claude = reading(w5(95, 0.1), w7(0, null))
  const d = decide(base({ claude, codex: reading(w5(50, 4), w7(50, 100)) }))
  expect([d.route, d.reason]).toEqual(['codex', 'claude-ceiling'])
  expect(decide(base({ claude: reading(null, null, true) })).reason).toBe('claude-ceiling')
  expect(decide(base({ claude: reading(w5(0, null), w7(97, 50)) })).reason).toBe('claude-ceiling')
})

test('dw2_claude_ceiling_does_not_apply_when_codex_unusable', () => {
  const claude = reading(w5(96, 4), w7(0, null))
  const d = decide(base({ claude, codexAvailable: false }))
  expect([d.route, d.reason]).toEqual(['claude', 'codex-unavailable'])
})

test('dw2_no_codex_reading_sets_refresh', () => {
  const d = decide(base({ codex: null }))
  expect([d.route, d.reason, d.refresh]).toEqual(['claude', 'no-codex-reading', true])
})

test('dw2_claude_ceiling_beats_no_codex_reading', () => {
  const d = decide(base({ codex: null, claude: reading(w5(96, 4), null) }))
  expect([d.route, d.reason, d.refresh]).toEqual(['codex', 'claude-ceiling', false])
})

test('dw2_stale_claude_window_is_not_at_ceiling', () => {
  const claude = reading({ used: 99, resetsAt: NOW - 5, lengthMs: FIVE_HOUR_MS }, null)
  expect(decide(base({ claude })).reason).not.toBe('claude-ceiling')
})

// PRD 7.4
const s74 = () => base({
  config: { ...CONFIG, maxConcurrentCodex: 10 },
  codex: reading(w5(60, 5), w7(0, null)),
  claude: reading(w5(72, null), w7(0, null)),
  claudeCost: { fiveHour: 1, sevenDay: 0.2 }, codexCost: { fiveHour: 5, sevenDay: 1 },
})

test('dw8_reservations_split_three_spawns_codex_claude_claude', () => {
  let reserved: Cost = ZERO_COST
  let inflight = 0
  const routes: string[] = []
  for (let i = 0; i < 3; i++) {
    const input = { ...s74(), reserved, inflight }
    const d = decide(input)
    routes.push(d.route)
    if (d.route === 'codex') {
      reserved = { fiveHour: reserved.fiveHour + 5, sevenDay: reserved.sevenDay + 1 }
      inflight++
    }
  }
  expect(routes).toEqual(['codex', 'claude', 'claude'])
})

test('dw8_without_reservations_all_three_go_to_codex', () => {
  const routes = [0, 1, 2].map(() => decide(s74()).route)
  expect(routes).toEqual(['codex', 'codex', 'codex'])
})

test('updateestimate_same_instance_moves_30_percent_toward_delta', () => {
  const before = reading(w5(10, 3), w7(20, 100))
  const after = reading(w5(16, 3), w7(21, 100))
  const next = updateEstimate({ fiveHour: 5, sevenDay: 1 }, before, after, false)
  expect(Math.abs((next.fiveHour) - (5 + 0.3 * (6 - 5)))).toBeLessThan(1e-9)
  expect(Math.abs((next.sevenDay) - (1 + 0.3 * (1 - 1)))).toBeLessThan(1e-9)
  expect(Math.abs((updateEstimate({ fiveHour: 5, sevenDay: 1 }, before, after, false, 0.5).fiveHour) - (5.5))).toBeLessThan(1e-9)
})

test('updateestimate_resets_at_within_60s_is_same_instance', () => {
  const before = reading(w5(10, 3), null)
  const after = reading({ ...w5(12, 3), resetsAt: NOW + 3 * H + 60_000 }, null)
  expect(Math.abs((updateEstimate({ fiveHour: 5, sevenDay: 1 }, before, after, false).fiveHour) - (5 + 0.3 * (2 - 5)))).toBeLessThan(1e-9)
})

test('updateestimate_different_window_or_overlap_or_negative_or_null_keeps_prev', () => {
  const prev = { fiveHour: 5, sevenDay: 1 }
  const before = reading(w5(10, 3), w7(20, 100))
  expect(updateEstimate(prev, before, reading(w5(16, 8), w7(21, 100)), false).fiveHour).toBe(5) // new window
  expect(updateEstimate(prev, before, reading(w5(16, 3), w7(21, 100)), true)).toEqual(prev)
  expect(updateEstimate(prev, before, reading(w5(5, 3), w7(15, 100)), false)).toEqual(prev)
  expect(updateEstimate(prev, null, before, false)).toEqual(prev)
  expect(updateEstimate(prev, before, null, false)).toEqual(prev)
  expect(updateEstimate(prev, reading(w5(10, null), null), reading(w5(16, null), null), false)).toEqual(prev) // null resetsAt
})

test('updateestimate_windows_are_independent', () => {
  const before = reading(w5(10, 3), w7(20, 100))
  const after = reading(w5(16, 3), w7(21, 50)) // weekly window rolled over
  const next = updateEstimate({ fiveHour: 5, sevenDay: 1 }, before, after, false)
  expect(Math.abs((next.fiveHour) - (5.3))).toBeLessThan(1e-9)
  expect(next.sevenDay).toBe(1)
})

// Property tests (PRD 17).
// shortcut: hand-rolled generator, the plugin test runtime cannot import fast-check; replace if it can.
const CASES = 500
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
const genWindow = (r: Rng, lengthMs: number): WindowReading | null => {
  const k = r()
  if (k < 0.1) return null
  const used = r() < 0.1 ? pick(r, [0, 100]) : r() * 100
  const resetsAt = k < 0.2 ? null : NOW + Math.floor((r() * 1.2 - 0.1) * lengthMs) // some in the past
  return { used, resetsAt, lengthMs }
}
const genReading = (r: Rng): ProviderReading =>
  ({ fiveHour: genWindow(r, FIVE_HOUR_MS), sevenDay: genWindow(r, SEVEN_DAY_MS), readAt: NOW, limitReached: r() < 0.05 })
const genCost = (r: Rng): Cost => ({ fiveHour: r() * 10, sevenDay: r() * 3 })
const genInput = (r: Rng): DecideInput => ({
  now: NOW, mode: pick<Mode>(r, ['auto', 'auto', 'auto', 'claude', 'codex', 'off']),
  config: { margin: r() * 20, ceilingFiveHour: 80 + r() * 20, ceilingSevenDay: 80 + r() * 20, maxConcurrentCodex: 1 + Math.floor(r() * 4) },
  claude: r() < 0.9 ? genReading(r) : null, codex: r() < 0.9 ? genReading(r) : null,
  claudeCost: genCost(r), codexCost: genCost(r), reserved: r() < 0.5 ? ZERO_COST : genCost(r), claudeReserved: ZERO_COST,
  inflight: Math.floor(r() * 4), codexAvailable: r() < 0.9,
})
const forAll = (seed: number, body: (r: Rng) => void) => { const r = mulberry32(seed); for (let i = 0; i < CASES; i++) body(r) }

test('prop_dw26_claude_reservation_equals_increased_cost', () => {
  forAll(306, r => {
    const input = genInput(r)
    input.mode = 'auto'
    input.claudeReserved = genCost(r)
    const withCost = { ...input, claudeCost: {
      fiveHour: input.claudeCost.fiveHour + input.claudeReserved.fiveHour,
      sevenDay: input.claudeCost.sevenDay + input.claudeReserved.sevenDay,
    }, claudeReserved: ZERO_COST }
    expect(decide(input)).toEqual(decide(withCost))
  })
})

test('prop_runway_never_increases_when_used_increases', () => {
  forAll(1, r => {
    const w = genWindow(r, FIVE_HOUR_MS)
    const a = r() * 100, b = r() * 100
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const mk = (u: number) => w === null ? null : { ...w, used: u }
    expect(runway(mk(hi), FIVE_HOUR_MS, NOW)).toBeLessThanOrEqual(runway(mk(lo), FIVE_HOUR_MS, NOW) + 1e-9)
    const add = r() * 20
    expect(runway(w, FIVE_HOUR_MS, NOW, add)).toBeLessThanOrEqual(runway(w, FIVE_HOUR_MS, NOW) + 1e-9)
  })
})

test('prop_score_within_0_and_999', () => {
  forAll(2, r => {
    const s = score(r() < 0.1 ? null : genReading(r), NOW, r() < 0.5 ? undefined : genCost(r))
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(999)
  })
})

test('prop_adding_a_reservation_never_moves_claude_to_codex', () => {
  forAll(3, r => {
    const input = genInput(r)
    if (decide(input).route !== 'claude') return
    const extra = genCost(r)
    const more = decide({ ...input, reserved: { fiveHour: input.reserved.fiveHour + extra.fiveHour, sevenDay: input.reserved.sevenDay + extra.sevenDay } })
    expect(more.route).toBe('claude')
  })
})

test('prop_decide_is_deterministic', () => {
  forAll(4, r => {
    const input = genInput(r)
    expect(decide(input)).toEqual(decide(structuredClone(input)))
  })
})

test('prop_equal_readings_and_costs_route_to_claude', () => {
  forAll(5, r => {
    const rd = genReading(r)
    const cost = genCost(r)
    const input: DecideInput = {
      ...genInput(r), mode: 'auto', claude: rd, codex: rd, claudeCost: cost, codexCost: cost,
      reserved: ZERO_COST, inflight: 0, codexAvailable: true,
    }
    input.config.margin = r() * 10
    const d = decide(input)
    // Equal readings can still hit the Claude ceiling, which is the one override that sends work to Codex.
    if (d.reason === 'claude-ceiling') return
    expect(d.route).toBe('claude')
  })
})
