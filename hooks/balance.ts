// Decision log and /balance text. Pure functions: no engine calls, so the engine-call scan has nothing to trace here.
import type { Inflight } from './readings'
import { formatDuration } from './codex'
import { effectiveWindow, runway, score, FIVE_HOUR_MS, SEVEN_DAY_MS } from './policy'
import type { Cost, Mode, PolicyConfig, ProviderReading, ReasonCode, WindowReading } from './policy'

export const LOG_MAX_LINES = 2000
export const RECENT_MAX = 5

/** Content-free (PRD 13): codes, numbers, times. Never the brief, the description or the report. */
export type DecisionEntry = {
  t: number
  session: string
  agentType: string
  route: 'claude' | 'codex'
  reason: ReasonCode
  claudeAfter: number
  codexAfter: number
  estimate: Cost
  mode: Mode
  codexModel?: string
  agentId?: string // a Codex run's id: tells which launch an outcome belongs to
  durationMs?: number
  outcome?: string
  exitCode?: number
  delta?: Cost
}

export function dataDirFor(configDir: string | undefined, home: string | undefined): string {
  return `${configDir || `${home ?? ''}/.claude`}/plugins/data/balancer`
}

/** Appends one line and keeps the last `max` lines; the file ends with a newline. */
export function appendCapped(existing: string, line: string, max = LOG_MAX_LINES): string {
  const lines = existing.split('\n').filter(l => l.length > 0)
  lines.push(line)
  return lines.slice(-max).join('\n') + '\n'
}

export function pushRecent(list: DecisionEntry[], e: DecisionEntry, max = RECENT_MAX): void {
  list.push(e)
  if (list.length > max) list.splice(0, list.length - max)
}

/** The last `max` lines of the log text that parse as decision objects; blank and broken lines are skipped. */
export function lastDecisions(text: string, max = RECENT_MAX): DecisionEntry[] {
  const out: DecisionEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const d = v as Record<string, unknown>
        if (typeof d.t === 'number' && Number.isFinite(d.t) && typeof d.agentType === 'string' &&
            typeof d.reason === 'string' && (d.route === 'claude' || d.route === 'codex') &&
            typeof d.claudeAfter === 'number' && typeof d.codexAfter === 'number') out.push(d as DecisionEntry)
      }
    } catch { /* skip */ }
  }
  return out.slice(-max)
}

/**
 * Codex runs the log already gives an outcome other than `lost`: they ended. Keyed by `agentId`; a row written before
 * rows carried it (0.2.13 and earlier) is keyed by `<session> <t>` in `legacy`.
 */
export function endedLaunches(text: string): { ids: Set<string>; legacy: Set<string> } {
  const out = { ids: new Set<string>(), legacy: new Set<string>() }
  for (const d of lastDecisions(text, Infinity)) {
    if (d.outcome === undefined || d.outcome === 'lost') continue
    if (typeof d.agentId === 'string') out.ids.add(d.agentId)
    else out.legacy.add(`${d.session} ${d.t}`)
  }
  return out
}

export type BalanceArgs = { kind: 'show' } | { kind: 'set'; mode: Mode } | { kind: 'usage' }

export function parseBalanceArgs(args: string): BalanceArgs {
  const a = args.trim().toLowerCase()
  if (a === '') return { kind: 'show' }
  if (a === 'auto' || a === 'claude' || a === 'codex' || a === 'off') return { kind: 'set', mode: a }
  return { kind: 'usage' }
}

export const USAGE_LINE = 'Usage: /balance [auto|claude|codex|off]'

// ---------- /balance text ----------

function fmtIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`
}

function windowText(label: string, w: WindowReading | null, lengthMs: number, now: number): string {
  const e = effectiveWindow(w, lengthMs, now)
  const reset = e.resetsAt === null ? 'no reset known' : `resets in ${fmtIn(e.resetsAt - now)}`
  return `${label} ${Math.round(e.used)}% used (${reset}, runway ${Math.round(runway(w, lengthMs, now))})`
}

function providerLines(name: string, r: ProviderReading | null, now: number): string[] {
  if (!r) return [`${name}: no reading`]
  const head = `${name}: score ${Math.round(score(r, now))}${r.limitReached ? ', LIMIT REACHED' : ''}, read ${fmtIn(now - r.readAt)} ago`
  return [head, '  ' + windowText('5h', r.fiveHour, FIVE_HOUR_MS, now), '  ' + windowText('7d', r.sevenDay, SEVEN_DAY_MS, now)]
}

const clock = (t: number) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatBalance(i: {
  now: number; mode: Mode; modeFromCommand: boolean
  claude: ProviderReading | null; codex: ProviderReading | null
  codexAvailable: boolean; cooldownUntil: number
  inflight: readonly Inflight[]; recent: readonly DecisionEntry[]
}): string {
  const out: string[] = []
  out.push(`Balancer mode: ${i.mode}${i.modeFromCommand ? ' (set with /balance for this session)' : ''}`)
  out.push(...providerLines('Claude', i.claude, i.now))
  out.push(...providerLines('Codex', i.codex, i.now))
  const cooling = i.cooldownUntil > i.now
  out.push(`Codex: ${i.codexAvailable ? 'available' : 'not available'}${cooling ? `, cooling down ${fmtIn(i.cooldownUntil - i.now)} more (routes to Claude)` : ''}`)
  if (i.inflight.length === 0) out.push('Codex tasks in flight: 0')
  else {
    const parts = i.inflight.map(r => `${r.agentType} ${fmtIn(i.now - r.startedAt)}`)
    out.push(`Codex tasks in flight: ${i.inflight.length} (${parts.join(', ')})`)
  }
  if (i.recent.length === 0) out.push('Last decisions: none yet')
  else {
    out.push('Last decisions:')
    for (const d of i.recent) out.push(`  ${clock(d.t)} ${d.agentType} -> ${d.route} (${d.reason})${d.outcome && d.outcome !== 'ok' ? `, ${d.outcome}` : ''}`)
  }
  return out.join('\n')
}

// ---------- status entry and tool-row line (PRD 10) ----------

function usedText(w: WindowReading | null, lengthMs: number, now: number): string {
  return w === null ? '–' : String(Math.round(effectiveWindow(w, lengthMs, now).used))
}

const providerStatus = (tag: string, r: ProviderReading | null, now: number) =>
  `${tag} 5h ${usedText(r?.fiveHour ?? null, FIVE_HOUR_MS, now)} · 7d ${usedText(r?.sevenDay ?? null, SEVEN_DAY_MS, now)}`

/** `C 5h 62 · 7d 55 │ X 5h 20 · 7d 46 │ → Claude`: effective used %, `–` when unknown; the route only after a decision. */
export function formatStatus(i: {
  now: number; claude: ProviderReading | null; codex: ProviderReading | null; last: 'claude' | 'codex' | undefined
}): string {
  const parts = [providerStatus('C', i.claude, i.now), providerStatus('X', i.codex, i.now)]
  if (i.last) parts.push(`→ ${i.last === 'codex' ? 'Codex' : 'Claude'}`)
  return parts.join(' │ ')
}

/** What the mod keeps per Codex run, keyed by tool_use_id, so the row can draw (the `$.state` value of types/index.d.ts). */
export type RowRun = { model?: string; effort: string; running: boolean; durationMs?: number; delta5h?: number; failed?: boolean }

export function formatRowLine(r: RowRun): string {
  const parts = ['Codex', ...(r.model !== undefined ? [r.model] : []), r.effort]
  if (r.running) parts.push('running')
  else {
    parts.push(formatDuration(r.durationMs ?? 0))
    if (r.delta5h !== undefined && Math.round(r.delta5h) >= 1) parts.push(`+${Math.round(r.delta5h)} pts 5h`)
    if (r.failed) parts.push('failed')
  }
  return parts.join(' · ')
}

// ---------- ceilings (toasts) ----------

/** Which window of a reading is at or above its ceiling, or null. The 5-hour window is named first. */
export function ceilingHit(r: ProviderReading | null, now: number, c: Pick<PolicyConfig, 'ceilingFiveHour' | 'ceilingSevenDay'>):
  { window: '5h' | '7d'; used: number; ceiling: number } | null {
  if (!r) return null
  const five = effectiveWindow(r.fiveHour, FIVE_HOUR_MS, now).used
  if (five >= c.ceilingFiveHour) return { window: '5h', used: five, ceiling: c.ceilingFiveHour }
  const seven = effectiveWindow(r.sevenDay, SEVEN_DAY_MS, now).used
  if (seven >= c.ceilingSevenDay) return { window: '7d', used: seven, ceiling: c.ceilingSevenDay }
  return null
}

export const ceilingText = (name: string, h: { window: string; used: number; ceiling: number }) =>
  `Balancer: ${name} is at its ${h.window} ceiling (${Math.round(h.used)}% used, ceiling ${h.ceiling}%).`

// ---------- delegation nudge (PRD 9) ----------

export const NUDGE_ENTER_GAP = 25
export const NUDGE_LEAVE_GAP = 10

export const NUDGE_TEXT =
  'Balancer: delegated general-purpose and Explore subagents currently run on a second subscription with more room than this one. ' +
  'Prefer delegating self-contained searches, mechanical edits and check runs, and write each brief so it stands alone.'

/** Hysteresis: enter above 25, leave below 10, hold in between. `gap` is score(codex) - score(claude), no task costs. */
export function nextTight(tight: boolean, gap: number, codexUsable: boolean): boolean {
  if (!codexUsable) return false
  return tight ? !(gap < NUDGE_LEAVE_GAP) : gap > NUDGE_ENTER_GAP
}

export const gapOf = (claude: ProviderReading | null, codex: ProviderReading | null, now: number) => score(codex, now) - score(claude, now)

export const CODEX_USAGE = 'Usage: /codex <task>'
