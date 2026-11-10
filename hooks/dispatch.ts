// Agent routing and execution (PRD 8, decisions D1). All state is per load (one closure), so tests do not share it.
import type { EngineInterface, Next, PluginOptions, ToolCallInput } from 'claude-code'
import {
  appendCapped, dataDirFor, formatBalance, parseBalanceArgs, pushRecent, USAGE_LINE,
} from './balance'
import type { DecisionEntry } from './balance'
import {
  asyncLaunchedRecord, buildCodexArgv, buildFailureText, buildReport, changedSince, completedRecord,
  effortFor, gitSnapshot, newAgentId, parseEffortMap, runCodex, sandboxFor, taskStopRecord,
} from './codex'
import type { CodexRun, Sandbox } from './codex'
import { decide, score, updateEstimate, FIVE_HOUR_MS } from './policy'
import type { Cost, Decision, Mode, PolicyConfig, ProviderReading } from './policy'
import {
  addInflight, claudeFromUsage, codexAvailable, createReadingCache, currentCodexReading, expireLimit,
  listInflight, loadEstimate, loadReading, pickFresher, readCodexRollout, removeInflight, saveEstimate,
  saveReading, sumReserved,
} from './readings'

type AgentCall = Extract<ToolCallInput, { tool: 'Agent' }>
type TaskStopCall = Extract<ToolCallInput, { tool: 'TaskStop' }>

const MIN_MS = 60_000
const COOLDOWN_MS = 15 * MIN_MS
const RECHECK_UNAVAILABLE_MS = 10 * MIN_MS
const CAPABILITY_RE = /\bmcp__|\bSkill\b|\bSendMessage\b|\bAskUserQuestion\b|\bArtifact\b/

export type Opts = ReturnType<typeof readOptions>

const num = (o: PluginOptions, k: string, d: number) => (typeof o[k] === 'number' ? (o[k] as number) : d)
const str = (o: PluginOptions, k: string, d: string) => (typeof o[k] === 'string' ? (o[k] as string) : d)

export function readOptions(o: PluginOptions) {
  const mode = str(o, 'mode', 'auto')
  return {
    mode: (['auto', 'claude', 'codex', 'off'].includes(mode) ? mode : 'auto') as Mode,
    config: {
      margin: num(o, 'margin', 5),
      ceilingFiveHour: num(o, 'ceilingFiveHour', 95),
      ceilingSevenDay: num(o, 'ceilingSevenDay', 97),
      maxConcurrentCodex: num(o, 'maxConcurrentCodex', 2),
    } as PolicyConfig,
    eligible: new Set(str(o, 'eligibleAgentTypes', 'general-purpose,claude,Explore').split(',').map(s => s.trim()).filter(Boolean)),
    effortMap: parseEffortMap(str(o, 'effortMap', 'haiku=low,sonnet=medium,opus=high,default=high')),
    codexModel: str(o, 'codexModel', ''),
    taskTimeoutMs: num(o, 'taskTimeoutMinutes', 30) * MIN_MS,
    staleAfterMs: num(o, 'staleAfterMinutes', 15) * MIN_MS,
    claudeCost: { fiveHour: num(o, 'claudeTaskCostFiveHour', 1), sevenDay: num(o, 'claudeTaskCostSevenDay', 0.2) } as Cost,
    maxResultChars: num(o, 'maxResultChars', 30000),
  }
}

// One at a time, in call order. Used for the decide-and-reserve step (PRD 7.4) and for log writes.
const serial = () => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const r = tail.then(fn)
    tail = r.catch(() => {})
    return r
  }
}

const emptyReading = (now: number): ProviderReading => ({ fiveHour: null, sevenDay: null, readAt: now, limitReached: false })

// PRD 8.5: a limit stays until the earliest known reset.
// shortcut: a limit with no known reset time is assumed to last one 5-hour window; replace if a reset time becomes available.
function limited(base: ProviderReading, now: number): ProviderReading {
  const known = [base.fiveHour?.resetsAt, base.sevenDay?.resetsAt].some(t => typeof t === 'number')
  return {
    ...base,
    ...(known ? {} : { fiveHour: { used: base.fiveHour?.used ?? 100, resetsAt: now + FIVE_HOUR_MS, lengthMs: FIVE_HOUR_MS } }),
    readAt: now,
    limitReached: true,
  }
}

function deltaOf(b: ProviderReading | null, a: ProviderReading | null): Cost | undefined {
  if (!b || !a) return undefined
  const one = (x: ProviderReading['fiveHour'], y: ProviderReading['fiveHour']) =>
    x && y && x.resetsAt !== null && y.resetsAt !== null && Math.abs(x.resetsAt - y.resetsAt) <= MIN_MS ? y.used - x.used : 0
  return { fiveHour: one(b.fiveHour, a.fiveHour), sevenDay: one(b.sevenDay, a.sevenDay) }
}

type Task = {
  agentId: string; sessionId: string; type: string; description: string; prompt: string
  cwd: string; sandbox: Sandbox; effort: string; outFile: string
  estimate: Cost; codexBefore: ProviderReading | null; overlappedStart: boolean
  entry: DecisionEntry
}

type Settled =
  | { kind: 'ok'; report: string; durationMs: number }
  | { kind: 'aborted' }
  | { kind: 'fail'; reason: string; changed: string[] | null; sandbox: Sandbox }

const reasonOf = (r: CodexRun): string =>
  r.outcome === 'spawn-error' ? 'codex missing'
  : r.limitHit ? 'limit reached'
  : r.outcome === 'timeout' ? 'timeout'
  : r.exitCode !== null && r.exitCode !== 0 ? `exit ${r.exitCode}`
  : 'no report'

export type State = ReturnType<typeof createState>

export function createState(options: PluginOptions) {
  return {
    opts: readOptions(options),
    cache: createReadingCache(),
    exclusive: serial(),
    logQueue: serial(),
    recent: [] as DecisionEntry[],
    runs: new Map<string, { ac: AbortController; sessionId: string; description: string; done: Promise<void> }>(),
    sessionMode: undefined as Mode | undefined,
    cooldownUntil: 0,
    broken: false, // spawn failed: Codex is unusable for the rest of the session
    toasted: false,
    avail: undefined as { ok: boolean; at: number } | undefined,
    refreshing: false,
    dir: undefined as string | undefined,
  }
}

const modeNow = (st: State): Mode => st.sessionMode ?? st.opts.mode

async function dataDir($: EngineInterface, st: State): Promise<string> {
  if (st.dir === undefined) st.dir = dataDirFor(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return st.dir
}

// ---------- readings ----------

// The live Claude reading is stamped `now`, so pickFresher always takes it; a stored limit
// (PRD 8.5, set by a rate_limit error) must therefore be carried over by hand.
function mergeClaude(stored: ProviderReading | null, live: ProviderReading | null, now: number): ProviderReading | null {
  const s = stored ? expireLimit(stored, now) : null
  const picked = pickFresher(s, live)
  return picked && s?.limitReached && !picked.limitReached ? { ...picked, limitReached: true } : picked
}

async function claudeReading($: EngineInterface, st: State, now: number): Promise<ProviderReading | null> {
  const live = claudeFromUsage((await $.session.usage()).rateLimits, now)
  return mergeClaude(await loadReading($, 'claude'), live, now)
}

async function codexReading($: EngineInterface, st: State, now: number): Promise<ProviderReading | null> {
  let r = st.cache.get('codex', now)
  if (r === undefined) {
    r = await currentCodexReading($, now, st.opts.staleAfterMs)
    st.cache.put('codex', r, now)
  }
  return r ? expireLimit(r, now) : null
}

async function codexUsable($: EngineInterface, st: State, now: number): Promise<boolean> {
  if (st.broken) return false
  if (st.avail && (st.avail.ok || now - st.avail.at < RECHECK_UNAVAILABLE_MS)) return st.avail.ok
  st.avail = { ok: await codexAvailable($), at: now }
  return st.avail.ok
}

async function refreshCodex($: EngineInterface, st: State): Promise<void> {
  if (st.refreshing) return
  st.refreshing = true
  try {
    const now = await $.clock.now()
    st.cache.put('codex', await currentCodexReading($, now, 0), now)
  } catch {
    // a failed refresh changes nothing
  } finally {
    st.refreshing = false
  }
}

// ---------- decision log ----------

function writeLog($: EngineInterface, st: State, entry: DecisionEntry): Promise<void> {
  return st.logQueue(async () => {
    try {
      const path = `${await dataDir($, st)}/decisions.jsonl`
      let text = ''
      try {
        const r = await $.fs.read(path)
        text = typeof r === 'string' ? r : ''
      } catch {
        // no log yet
      }
      // shortcut: $.fs has no append, so the whole file (at most 2000 short lines) is rewritten; replace if $.fs gains append.
      await $.fs.write(path, appendCapped(text, JSON.stringify(entry)))
    } catch {
      // best effort: the log never changes routing
    }
  })
}

// ---------- eligibility (PRD 8.1) ----------

async function eligible($: EngineInterface, st: State, e: AgentCall): Promise<boolean> {
  const type = e.subagent_type
  if (type !== undefined && !st.opts.eligible.has(type)) return false
  if (type === 'fork' || e.isolation != null || e.name != null || CAPABILITY_RE.test(e.prompt)) return false
  try {
    const root = await $.session.root()
    const text = await $.fs.read(`${root}/.claude/balancer.json`)
    if (typeof text === 'string' && (JSON.parse(text) as { codex?: unknown } | null)?.codex === false) return false
  } catch {
    // missing or unparseable: not opted out
  }
  try {
    await $.fs.stat(await $.session.cwd())
  } catch {
    return false
  }
  return true
}

// ---------- Agent hook ----------

export async function onAgent($: EngineInterface, st: State, e: AgentCall, next: Next<'tool.call', AgentCall>) {
  const mode = modeNow(st)
  if (mode === 'off') return next(e)
  if (!(await eligible($, st, e))) return next(e)

  const type = e.subagent_type ?? 'general-purpose'
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd() // before the reservation: nothing after it may throw before the run owns it
  const dd = await dataDir($, st)
  const planMode = (e as { mode?: string }).mode === 'plan' // the hook cannot read the session's mode: only the Agent argument

  // Decide and reserve in one step: a second call starting now must see this call's reservation.
  const picked = await st.exclusive(async () => {
    const now = await $.clock.now()
    const wantCodex = mode !== 'claude'
    const claude = await claudeReading($, st, now)
    const codex = wantCodex ? await codexReading($, st, now) : null
    const usable = wantCodex && (await codexUsable($, st, now))
    const list = wantCodex ? await listInflight($, now, st.opts.taskTimeoutMs) : []
    const estimate = await loadEstimate($, type)
    const reserved = sumReserved(list)
    const input = {
      now, mode, config: st.opts.config, claude, codex, claudeCost: st.opts.claudeCost, codexCost: estimate,
      reserved, inflight: list.length, codexAvailable: usable,
    }
    let d: Decision
    if (mode === 'auto' && now < st.cooldownUntil) {
      d = {
        route: 'claude', reason: 'codex-cooldown', refresh: false,
        claudeAfter: score(claude, now, st.opts.claudeCost),
        codexAfter: score(codex, now, { fiveHour: reserved.fiveHour + estimate.fiveHour, sevenDay: reserved.sevenDay + estimate.sevenDay }),
      }
    } else d = decide(input)
    const entry: DecisionEntry = {
      t: now, session: sessionId, agentType: type, route: d.route, reason: d.reason,
      claudeAfter: Math.round(d.claudeAfter * 10) / 10, codexAfter: Math.round(d.codexAfter * 10) / 10,
      estimate, mode,
    }
    const agentId = d.route === 'codex' ? newAgentId() : undefined
    if (agentId) await addInflight($, { id: agentId, sessionId, startedAt: now, cost: estimate, agentType: type })
    return { d, entry, agentId, codex, estimate, overlapped: list.length > 0 }
  })

  pushRecent(st.recent, picked.entry)
  if (picked.d.refresh) void refreshCodex($, st)
  if (picked.d.route === 'claude' || !picked.agentId) {
    await writeLog($, st, picked.entry)
    return next(e)
  }

  const agentId = picked.agentId
  const sandbox = sandboxFor(e.subagent_type, planMode)
  const task: Task = {
    agentId, sessionId, type, description: e.description, prompt: e.prompt,
    cwd, sandbox, effort: effortFor(e.model, st.opts.effortMap), outFile: `${dd}/runs/${agentId}.last.txt`,
    estimate: picked.estimate, codexBefore: picked.codex, overlappedStart: picked.overlapped, entry: picked.entry,
  }

  // The 2.1.321 input type omits run_in_background; the model may still send it.
  if ((e as { run_in_background?: boolean }).run_in_background === false) {
    const s = await runTask($, st, task, next.signal, `${dd}/runs/${agentId}.txt`)
    if (s.kind === 'ok') {
      return { result: completedRecord({ agentId, text: s.report, prompt: e.prompt, durationMs: s.durationMs, agentType: type }) }
    }
    if (s.kind === 'aborted') return { deny: 'Balancer: the Codex run was interrupted' }
    if (s.sandbox === 'read-only' || (s.changed !== null && s.changed.length === 0)) return next(e)
    return { result: completedRecord({ agentId, text: buildFailureText({ reason: s.reason, changedFiles: s.changed, sandbox: s.sandbox }), prompt: e.prompt, durationMs: 0, agentType: type }) }
  }

  const outputFile = `${dd}/runs/${agentId}.txt`
  const ac = new AbortController()
  const done = (async () => {
    try {
      await deliverBackground($, st, task, await runTask($, st, task, ac.signal, `${dd}/runs/${agentId}.full.txt`), outputFile)
    } catch {
      // a detached run has nobody to throw to
    } finally {
      st.runs.delete(agentId)
    }
  })()
  st.runs.set(agentId, { ac, sessionId, description: e.description, done })
  return { result: asyncLaunchedRecord({ agentId, description: e.description, prompt: e.prompt, outputFile }) }
}

// ---------- one Codex run, both modes ----------

async function runTask($: EngineInterface, st: State, c: Task, signal: AbortSignal, fullTextPath: string): Promise<Settled> {
  const git = c.sandbox === 'workspace-write'
  let run: CodexRun
  let before: string[] | null = null
  try {
    if (git) before = await gitSnapshot($, c.cwd)
    const built = buildCodexArgv({
      cwd: c.cwd, sandbox: c.sandbox, effort: c.effort, ...(st.opts.codexModel ? { model: st.opts.codexModel } : {}),
      outFile: c.outFile, prompt: c.prompt,
    })
    run = await runCodex($, {
      argv: built.argv, ...(built.input !== undefined ? { input: built.input } : {}),
      cwd: c.cwd, timeoutMs: st.opts.taskTimeoutMs, signal,
    })
  } finally {
    try { await removeInflight($, c.agentId) } catch { /* expires by age */ }
  }

  const now = await $.clock.now()
  let after: ProviderReading | null = null
  if (run.threadId) {
    after = await readCodexRollout($, now, run.threadId)
    if (after) {
      await saveReading($, 'codex', after)
      st.cache.put('codex', after, now)
      if (run.outcome !== 'aborted') {
        const others = (await listInflight($, now, st.opts.taskTimeoutMs)).length > 0
        await saveEstimate($, c.type, updateEstimate(c.estimate, c.codexBefore, after, c.overlappedStart || others))
      }
    }
  }
  if (run.limitHit) {
    const limit: ProviderReading = { ...(after ?? c.codexBefore ?? emptyReading(now)), readAt: now, limitReached: true }
    await saveReading($, 'codex', limit)
    st.cache.put('codex', limit, now)
  }
  if (run.outcome === 'spawn-error') {
    st.broken = true
    if (!st.toasted) {
      st.toasted = true
      await $.ui.toast('Balancer: Codex is not available, subagents run on Claude.')
    }
  }

  c.entry.durationMs = run.durationMs
  c.entry.outcome = run.outcome
  if (run.exitCode !== null) c.entry.exitCode = run.exitCode
  const delta = deltaOf(c.codexBefore, after)
  if (delta) c.entry.delta = delta
  await writeLog($, st, c.entry)

  if (run.outcome === 'aborted') return { kind: 'aborted' }
  const afterGit = git ? await gitSnapshot($, c.cwd) : null
  if (run.outcome === 'ok' && run.finalMessage !== undefined) {
    const cut = run.finalMessage.length > st.opts.maxResultChars
    if (cut) { try { await $.fs.write(fullTextPath, run.finalMessage) } catch { /* the report still says it was cut */ } }
    return {
      kind: 'ok', durationMs: run.durationMs,
      report: buildReport({
        finalMessage: run.finalMessage, effort: c.effort, durationMs: run.durationMs, threadId: run.threadId,
        maxResultChars: st.opts.maxResultChars, ...(cut ? { fullTextPath } : {}), gitStatus: afterGit, sandbox: c.sandbox,
      }),
    }
  }
  return { kind: 'fail', reason: reasonOf(run), changed: git ? changedSince(before, afterGit) : [], sandbox: c.sandbox }
}

async function deliverBackground($: EngineInterface, st: State, c: Task, s: Settled, outputFile: string): Promise<void> {
  if (s.kind === 'aborted') return
  let text: string
  if (s.kind === 'ok') {
    await $.fs.write(outputFile, s.report)
    text = `[balancer] Background agent "${c.description}" (${c.agentId}) finished on Codex.\n\n${s.report}`
  } else if (s.sandbox === 'read-only' || (s.changed !== null && s.changed.length === 0)) {
    st.cooldownUntil = (await $.clock.now()) + COOLDOWN_MS
    text = `[balancer] Codex could not run "${c.description}" (${s.reason}), nothing was changed, ` +
      'delegate it again and it will run on Claude.'
  } else {
    text = `[balancer] Background agent "${c.description}" (${c.agentId}): ` +
      buildFailureText({ reason: s.reason, changedFiles: s.changed, sandbox: s.sandbox })
  }
  await $.prompt.submit({ text })
}

// ---------- other hooks ----------

export async function onTaskStop($: EngineInterface, st: State, e: TaskStopCall, next: Next<'tool.call', TaskStopCall>) {
  const id = e.task_id ?? e.shell_id
  const run = id === undefined ? undefined : st.runs.get(id)
  if (id === undefined || !run) return next(e)
  run.ac.abort()
  await run.done // the child is killed and the reservation released before the model hears back
  return { result: taskStopRecord({ taskId: id, description: run.description }) }
}

export async function onSessionEnd($: EngineInterface, st: State, e: { sessionId: string }) {
  const mine = [...st.runs.values()].filter(r => r.sessionId === e.sessionId)
  for (const r of mine) r.ac.abort()
  await Promise.allSettled(mine.map(r => r.done))
}

export async function onMeasure($: EngineInterface, st: State, e: { rateLimits: Parameters<typeof claudeFromUsage>[0] }) {
  const now = await $.clock.now()
  const live = claudeFromUsage(e.rateLimits, now)
  if (live) await saveReading($, 'claude', mergeClaude(await loadReading($, 'claude'), live, now) ?? live)
}

export async function onRateLimitError($: EngineInterface, st: State) {
  try {
    const now = await $.clock.now()
    const base = (await claudeReading($, st, now)) ?? emptyReading(now)
    await saveReading($, 'claude', limited(base, now))
  } catch {
    // nothing to record
  }
}

export async function onBalance($: EngineInterface, st: State, args: string): Promise<{ text: string }> {
  const a = parseBalanceArgs(args)
  if (a.kind === 'usage') return { text: USAGE_LINE }
  if (a.kind === 'set') {
    st.sessionMode = a.mode
    return { text: `Balancer mode is now ${a.mode} for this session.` }
  }
  const now = await $.clock.now()
  return {
    text: formatBalance({
      now, mode: modeNow(st), modeFromCommand: st.sessionMode !== undefined,
      claude: await claudeReading($, st, now), codex: await codexReading($, st, now),
      codexAvailable: await codexUsable($, st, now), cooldownUntil: st.cooldownUntil,
      inflight: await listInflight($, now, st.opts.taskTimeoutMs), recent: st.recent,
    }),
  }
}
