// Pure routing maths: no engine calls, no imports. See PRD sections 6.3 and 7.

export const FIVE_HOUR_MS = 5 * 3_600_000
export const SEVEN_DAY_MS = 7 * 24 * 3_600_000

export type WindowReading = { used: number; resetsAt: number | null; lengthMs: number } // used 0..100, resetsAt epoch ms
export type ProviderReading = { fiveHour: WindowReading | null; sevenDay: WindowReading | null; readAt: number; limitReached: boolean }
export type Cost = { fiveHour: number; sevenDay: number }
export const ZERO_COST: Cost = { fiveHour: 0, sevenDay: 0 }
export type Mode = 'auto' | 'claude' | 'codex' | 'off'
export type PolicyConfig = { margin: number; ceilingFiveHour: number; ceilingSevenDay: number; maxConcurrentCodex: number }
export type ReasonCode =
  | 'mode-off' | 'mode-claude' | 'mode-codex' | 'codex-unavailable' | 'codex-limit' | 'codex-concurrency'
  | 'codex-ceiling' | 'claude-ceiling' | 'no-codex-reading' | 'codex-ahead' | 'claude-ahead' | 'codex-cooldown'

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** A missing window is unused; a window whose reset time has passed has reset. */
export function effectiveWindow(w: WindowReading | null, lengthMs: number, now: number): WindowReading {
  if (w === null) return { used: 0, resetsAt: null, lengthMs }
  if (w.resetsAt !== null && w.resetsAt <= now) return { used: 0, resetsAt: null, lengthMs: w.lengthMs }
  return w
}

export function runway(w: WindowReading | null, lengthMs: number, now: number, add?: number): number {
  const e = effectiveWindow(w, lengthMs, now)
  const u = e.used + (add ?? 0)
  const share = e.resetsAt === null ? 1 : clamp((e.resetsAt - now) / e.lengthMs, 0.02, 1)
  return Math.min(999, Math.max(0, 100 - u) / share)
}

export function score(r: ProviderReading | null, now: number, add?: Cost): number {
  return Math.min(
    runway(r?.fiveHour ?? null, FIVE_HOUR_MS, now, add?.fiveHour),
    runway(r?.sevenDay ?? null, SEVEN_DAY_MS, now, add?.sevenDay),
  )
}

export type DecideInput = {
  now: number; mode: Mode; config: PolicyConfig
  claude: ProviderReading | null; codex: ProviderReading | null
  claudeCost: Cost; codexCost: Cost
  reserved: Cost // sum of Codex reservations of tasks in flight
  inflight: number // Codex tasks in flight across sessions
  codexAvailable: boolean // installed and logged in
}
export type Decision = { route: 'claude' | 'codex'; reason: ReasonCode; claudeAfter: number; codexAfter: number; refresh: boolean }

/** Why Codex cannot take the task, or null when it can. First failing check wins. */
function codexBlock(i: DecideInput): ReasonCode | null {
  if (!i.codexAvailable) return 'codex-unavailable'
  if (i.codex?.limitReached) return 'codex-limit'
  if (i.inflight >= i.config.maxConcurrentCodex) return 'codex-concurrency'
  if (i.codex) {
    const five = effectiveWindow(i.codex.fiveHour, FIVE_HOUR_MS, i.now).used + i.reserved.fiveHour + i.codexCost.fiveHour
    const seven = effectiveWindow(i.codex.sevenDay, SEVEN_DAY_MS, i.now).used + i.reserved.sevenDay + i.codexCost.sevenDay
    if (five >= i.config.ceilingFiveHour || seven >= i.config.ceilingSevenDay) return 'codex-ceiling'
  }
  return null
}

function claudeAtCeiling(i: DecideInput): boolean {
  const c = i.claude
  if (!c) return false
  return c.limitReached
    || effectiveWindow(c.fiveHour, FIVE_HOUR_MS, i.now).used >= i.config.ceilingFiveHour
    || effectiveWindow(c.sevenDay, SEVEN_DAY_MS, i.now).used >= i.config.ceilingSevenDay
}

export function decide(i: DecideInput): Decision {
  const claudeAfter = score(i.claude, i.now, i.claudeCost)
  const codexAfter = score(i.codex, i.now, {
    fiveHour: i.reserved.fiveHour + i.codexCost.fiveHour,
    sevenDay: i.reserved.sevenDay + i.codexCost.sevenDay,
  })
  const out = (route: Decision['route'], reason: ReasonCode, refresh = false): Decision =>
    ({ route, reason, claudeAfter, codexAfter, refresh })

  if (i.mode === 'off') return out('claude', 'mode-off')
  if (i.mode === 'claude') return out('claude', 'mode-claude')
  const block = codexBlock(i)
  if (i.mode === 'codex') return block === null ? out('codex', 'mode-codex') : out('claude', block)
  if (block !== null) return out('claude', block)
  if (claudeAtCeiling(i)) return out('codex', 'claude-ceiling')
  if (i.codex === null) return out('claude', 'no-codex-reading', true)
  return codexAfter > claudeAfter + i.config.margin ? out('codex', 'codex-ahead') : out('claude', 'claude-ahead')
}

const SAME_WINDOW_MS = 60_000

function sample(prev: number, b: WindowReading | null, a: WindowReading | null, alpha: number): number {
  if (!b || !a || b.resetsAt === null || a.resetsAt === null) return prev
  if (Math.abs(a.resetsAt - b.resetsAt) > SAME_WINDOW_MS) return prev
  const delta = a.used - b.used
  return delta >= 0 ? prev + alpha * (delta - prev) : prev
}

export function updateEstimate(prev: Cost, before: ProviderReading | null, after: ProviderReading | null, overlapped: boolean, alpha = 0.3): Cost {
  if (overlapped || !before || !after) return prev
  return {
    fiveHour: sample(prev.fiveHour, before.fiveHour, after.fiveHour, alpha),
    sevenDay: sample(prev.sevenDay, before.sevenDay, after.sevenDay, alpha),
  }
}
