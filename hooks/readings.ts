import type { EngineInterface } from 'claude-code'
import type { Cost, ProviderReading, WindowReading } from './policy'

export type Provider = 'claude' | 'codex'
export type Inflight = { id: string; sessionId: string; startedAt: number; cost: Cost; agentType: string }

const MIN_MS = 60_000
const TAIL_BYTES = '65536'

// ---------- pure parsing ----------

type Windows = Pick<ProviderReading, 'fiveHour' | 'sevenDay'>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Windows are told apart by their length, never by the primary/secondary name.
function assign(w: Windows, used: unknown, mins: unknown, resetsSec: unknown): void {
  if (typeof used !== 'number' || typeof mins !== 'number') return
  const reading: WindowReading = {
    used,
    resetsAt: typeof resetsSec === 'number' ? resetsSec * 1000 : null,
    lengthMs: mins * MIN_MS,
  }
  if (mins === 300) w.fiveHour = reading
  else if (mins === 10080) w.sevenDay = reading
}

export function parseCodexRolloutTail(tail: string, now: number): ProviderReading | null {
  let found: Record<string, unknown> | null = null
  for (const line of tail.split('\n').slice(1)) {
    try {
      const rec: unknown = JSON.parse(line)
      if (!isObj(rec) || rec.type !== 'event_msg') continue
      const p = rec.payload
      if (!isObj(p) || p.type !== 'token_count' || !isObj(p.rate_limits)) continue
      found = p.rate_limits
    } catch {
      // a malformed line is skipped
    }
  }
  if (!found) return null
  const w: Windows = { fiveHour: null, sevenDay: null }
  for (const k of ['primary', 'secondary']) {
    const x = found[k]
    if (isObj(x)) assign(w, x.used_percent, x.window_minutes, x.resets_at)
  }
  return { ...w, readAt: now, limitReached: found.rate_limit_reached_type != null }
}

export function parseAppServerOutput(stdout: string, now: number): ProviderReading | null {
  for (const line of stdout.split('\n')) {
    try {
      const msg: unknown = JSON.parse(line)
      if (!isObj(msg) || msg.id !== 2 || !isObj(msg.result) || !isObj(msg.result.rateLimits)) continue
      const rl = msg.result.rateLimits
      const w: Windows = { fiveHour: null, sevenDay: null }
      for (const k of ['primary', 'secondary']) {
        const x = rl[k]
        if (isObj(x)) assign(w, x.usedPercent, x.windowDurationMins, x.resetsAt)
      }
      return { ...w, readAt: now, limitReached: rl.rateLimitReachedType != null }
    } catch {
      // not JSON: skip
    }
  }
  return null
}

export function claudeFromUsage(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  now: number,
): ProviderReading | null {
  const w: Windows = { fiveHour: null, sevenDay: null }
  for (const r of rateLimits) {
    const resetsAt = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    const reading = (lengthMs: number): WindowReading => ({
      used: r.percentUsed,
      resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
      lengthMs,
    })
    if (r.kind === 'five_hour') w.fiveHour = reading(300 * MIN_MS)
    else if (r.kind === 'seven_day') w.sevenDay = reading(10080 * MIN_MS)
  }
  if (!w.fiveHour && !w.sevenDay) return null
  return { ...w, readAt: now, limitReached: false }
}

export const pickFresher = (a: ProviderReading | null, b: ProviderReading | null): ProviderReading | null =>
  !a ? b : !b ? a : b.readAt > a.readAt ? b : a

// Limited until the earliest known reset (PRD 8.5).
export function expireLimit(r: ProviderReading, now: number): ProviderReading {
  if (!r.limitReached) return r
  const times = [r.fiveHour?.resetsAt, r.sevenDay?.resetsAt].filter((t): t is number => typeof t === 'number')
  if (times.length === 0) return r
  return Math.min(...times) <= now ? { ...r, limitReached: false } : r
}

export function rolloutDayDirs(home: string, now: number): string[] {
  const dir = (t: number) => {
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${home}/.codex/sessions/${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1) // calendar day, so DST shifts do not skip a day
  return [dir(now), dir(yesterday.getTime())]
}

// ---------- engine-facing: Codex ----------

export async function readCodexRollout($: EngineInterface, now: number, threadId?: string): Promise<ProviderReading | null> {
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    const files: { path: string; mtimeMs: number; name: string }[] = []
    for (const dir of rolloutDayDirs(home, now)) {
      try {
        for (const e of await $.fs.list(dir)) {
          if (e.kind === 'file' && e.name.endsWith('.jsonl')) files.push({ path: `${dir}/${e.name}`, mtimeMs: e.mtimeMs, name: e.name })
        }
      } catch {
        // a missing day folder is fine
      }
    }
    const pick = threadId
      ? files.find((f) => f.name.endsWith(`-${threadId}.jsonl`))
      : files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!pick) return null
    const res = await $.process.run(['tail', '-c', TAIL_BYTES, pick.path])
    return res.exitCode === 0 ? parseCodexRolloutTail(res.stdout, now) : null
  } catch {
    return null
  }
}

const INIT = JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'balancer', version: '0.1.0' } } })
// Fixed text, no runtime value is interpolated. The sleep keeps stdin open until id 2 is answered (spike S2).
export const APP_SERVER_SCRIPT =
  `(printf '%s\\n%s\\n%s\\n' '${INIT}' '{"method":"initialized"}' '{"id":2,"method":"account/rateLimits/read"}'; sleep 4) | codex app-server`

export async function readCodexAppServer($: EngineInterface, now: number): Promise<ProviderReading | null> {
  try {
    const res = await $.process.run(['sh', '-c', APP_SERVER_SCRIPT], { timeoutMs: 15000 })
    return parseAppServerOutput(res.stdout, now)
  } catch {
    return null
  }
}

export async function codexAvailable($: EngineInterface): Promise<boolean> {
  try {
    return (await $.process.run(['codex', 'login', 'status'], { timeoutMs: 10000 })).exitCode === 0
  } catch {
    return false
  }
}

// ---------- store layer ----------

const isReading = (v: unknown): v is ProviderReading => isObj(v) && typeof v.readAt === 'number' && typeof v.limitReached === 'boolean'
const isCost = (v: unknown): v is Cost => isObj(v) && typeof v.fiveHour === 'number' && typeof v.sevenDay === 'number'

export async function loadReading($: EngineInterface, provider: Provider): Promise<ProviderReading | null> {
  const v = await $.store.get(`reading/${provider}`)
  return isReading(v) ? v : null
}
export function saveReading($: EngineInterface, provider: Provider, r: ProviderReading) {
  return $.store.set(`reading/${provider}`, r)
}

export async function loadEstimate($: EngineInterface, agentType: string): Promise<Cost> {
  const v = await $.store.get(`estimate/${agentType}`)
  return isCost(v) ? v : { fiveHour: 5, sevenDay: 1 }
}
export function saveEstimate($: EngineInterface, agentType: string, c: Cost) {
  return $.store.set(`estimate/${agentType}`, c)
}

export function addInflight($: EngineInterface, rec: Inflight) {
  return $.store.set(`inflight/${rec.id}`, rec)
}
export function removeInflight($: EngineInterface, id: string) {
  return $.store.delete(`inflight/${id}`)
}

export async function listInflight($: EngineInterface, now: number, timeoutMs: number): Promise<Inflight[]> {
  const out: Inflight[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('inflight/')) continue
    const v = await $.store.get(key)
    if (isObj(v) && typeof v.startedAt === 'number' && isCost(v.cost) && now - v.startedAt <= timeoutMs) out.push(v as Inflight)
    else await $.store.delete(key)
  }
  return out
}

export const sumReserved = (list: readonly Inflight[]): Cost =>
  list.reduce((s, r) => ({ fiveHour: s.fiveHour + r.cost.fiveHour, sevenDay: s.sevenDay + r.cost.sevenDay }), { fiveHour: 0, sevenDay: 0 })

// ---------- in-memory memo (PRD 13) ----------

export function createReadingCache(ttlMs = 30_000) {
  const m = new Map<Provider, { value: ProviderReading | null; at: number }>()
  return {
    get: (p: Provider, now: number): ProviderReading | null | undefined => {
      const e = m.get(p)
      return e && now - e.at < ttlMs ? e.value : undefined
    },
    put: (p: Provider, value: ProviderReading | null, now: number): void => void m.set(p, { value, at: now }),
  }
}

// ---------- Codex reading order (PRD 6.2, steps 2 and 3) ----------

export async function currentCodexReading($: EngineInterface, now: number, staleAfterMs: number): Promise<ProviderReading | null> {
  const stored = await loadReading($, 'codex')
  if (stored && now - stored.readAt < staleAfterMs) return stored
  const r = (await readCodexAppServer($, now)) ?? (await readCodexRollout($, now))
  if (r) await saveReading($, 'codex', r)
  return r
}
