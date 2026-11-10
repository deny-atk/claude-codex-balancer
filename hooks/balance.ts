// Decision log and /balance text. Pure functions: no engine calls, so the engine-call scan has nothing to trace here.
import type { Inflight } from './readings'
import { effectiveWindow, runway, score, FIVE_HOUR_MS, SEVEN_DAY_MS } from './policy'
import type { Cost, Mode, ProviderReading, ReasonCode, WindowReading } from './policy'

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
    for (const d of i.recent) out.push(`  ${clock(d.t)} ${d.agentType} -> ${d.route} (${d.reason})`)
  }
  return out.join('\n')
}
