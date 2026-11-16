// Agent routing and execution (PRD 8, decisions D1). All state is per load (one closure), so tests do not share it.
import type { EngineInterface, Next, PluginOptions, PromptSubmitInput, SessionMeasureInput, ToolCallInput, TurnCompleteInput } from 'claude-code'
import { agentDefPaths, CAPABILITY_RE, codexEffort, configDirFor, defModel, parseAgentDef, unavailableTools } from './agentdef'
import type { AgentDef } from './agentdef'
import {
  appendCapped, ceilingHit, ceilingText, CODEX_USAGE, dataDirFor, formatBalance, formatStatus, gapOf, lastDecisions, NUDGE_ENTER_GAP, NUDGE_TEXT,
  nextTight, parseBalanceArgs, pushRecent, USAGE_LINE,
} from './balance'
import type { DecisionEntry, RowRun } from './balance'
import {
  asyncLaunchedRecord, buildCodexArgv, buildFailureText, buildReport, changedSince, completedRecord,
  codexModelFor, effortFor, gitSnapshot, modelExcluded, grantsFor, namedWorktrees, parseGitRoots, parseWorktrees, projectKey, safeDirSyntax, newAgentId, parseEffortMap, partialBlock, runCodex, sandboxFor, taskStopRecord,
} from './codex'
import type { CodexRun, Sandbox } from './codex'
import { decide, score, updateEstimate } from './policy'
import type { Cost, Decision, Mode, PolicyConfig, ProviderReading } from './policy'
import type { Inflight } from './readings'
import {
  addInflight, claudeFromUsage, codexAvailable, createReadingCache, currentCodexReading, expireLimit,
  listInflight, loadEstimate, loadReading, mergeUsage, readCodexRollout, removeInflight, saveEstimate,
  saveReading, sumReserved,
} from './readings'

type AgentCall = Extract<ToolCallInput, { tool: 'Agent' }>
type TaskStopCall = Extract<ToolCallInput, { tool: 'TaskStop' }>

const MIN_MS = 60_000
const COOLDOWN_MS = 15 * MIN_MS
const REPEAT_WINDOW_MS = 30 * MIN_MS // a blocked call's repeat goes to Claude within this time
const RECHECK_UNAVAILABLE_MS = 10 * MIN_MS
const CLAUDE_INFLIGHT = 'claude-inflight'
// Well beyond the task timeout, so active runs keep their files.
const RUN_FILE_MAX_AGE_MS = 7 * 24 * 60 * MIN_MS

export type Opts = ReturnType<typeof readOptions>
type Provider = 'claude' | 'codex'

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
    excluded: new Set(str(o, 'excludedAgentTypes', 'plan-reviewer').split(',').map(s => s.trim()).filter(Boolean)),
    excludedModels: new Set(str(o, 'excludedModels', 'fable').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)),
    effortMap: parseEffortMap(str(o, 'effortMap', 'haiku=low,sonnet=medium,opus=high,default=high')),
    modelMap: parseEffortMap(str(o, 'modelMap', 'opus=gpt-6.1-sol,sonnet=gpt-6.1-terra')),
    codexModel: str(o, 'codexModel', ''),
    taskTimeoutMs: num(o, 'taskTimeoutMinutes', 30) * MIN_MS,
    staleAfterMs: num(o, 'staleAfterMinutes', 15) * MIN_MS,
    claudeCost: { fiveHour: num(o, 'claudeTaskCostFiveHour', 1), sevenDay: num(o, 'claudeTaskCostSevenDay', 0.2) } as Cost,
    maxResultChars: num(o, 'maxResultChars', 30000),
    nudge: o.nudge !== false,
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

function deltaOf(b: ProviderReading | null, a: ProviderReading | null): Cost | undefined {
  if (!b || !a) return undefined
  const one = (x: ProviderReading['fiveHour'], y: ProviderReading['fiveHour']) =>
    x && y && x.resetsAt !== null && y.resetsAt !== null && Math.abs(x.resetsAt - y.resetsAt) <= MIN_MS ? y.used - x.used : 0
  return { fiveHour: one(b.fiveHour, a.fiveHour), sevenDay: one(b.sevenDay, a.sevenDay) }
}

type Task = {
  agentId: string; sessionId: string; type: string; description: string; prompt: string
  rowId?: string // the Agent call's tool_use_id: the row that shows the run's line
  cwd: string; sandbox: Sandbox; model?: string; effort: string; outFile: string
  callModel?: string // the Agent call's own `model` argument, for a Claude redo; `model` is the Codex one
  noRedo?: 'effort' | 'mode' // set by the call but not carried by $.agent.spawn, so a blocked run is not redone
  agent?: { type: string; body: string } // a custom type's instructions, carried to Codex
  base: string // `<data>/runs/<agentId>`: the patch and partial notes go beside the other run files
  estimate: Cost; codexBefore: ProviderReading | null
  entry: DecisionEntry
  gitCwd?: string // set by runTask: the repository's top folder, where git paths are relative
  worktrees?: string[] // set by runTask: sibling worktrees the brief named, writable and in the change check
}

type Settled =
  | { kind: 'ok'; report: string; durationMs: number }
  | { kind: 'aborted' }
  | { kind: 'fail'; reason: string; changed: string[] | null; sandbox: Sandbox; saved: Saved }

// What a stopped run left behind besides edited files (item: work is saved when Codex hits a limit).
type Saved = { patchPath?: string; untracked?: string[]; partial?: { text: string; path?: string }; resumeThreadId?: string }
type RunRecord = Pick<Task, 'agentId' | 'sessionId' | 'description' | 'rowId' | 'sandbox' | 'outFile' | 'base' | 'type' | 'entry'> & {
  background: boolean; gitCwd: string; before: string[] | null; startedAt: number
  worktrees?: string[] // absent in records written before 0.2.12
}

// A blocked Codex run that Balancer did not redo. The session's repeat of the call (same type, and the same description
// or brief) goes to Claude once, so the task is not sent back to the sandbox that blocked it.
type BlockedCall = { sessionId: string; type: string; description: string; prompt: string; until: number }
const sameDescription = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

const failureText = (s: { reason: string; changed: string[] | null; sandbox: Sandbox; saved: Saved }) =>
  buildFailureText({ reason: s.reason, changedFiles: s.changed, sandbox: s.sandbox, ...s.saved })

const reasonOf = (r: CodexRun): string =>
  r.outcome === 'blocked' ? 'blocked'
  : r.outcome === 'spawn-error' ? 'codex missing'
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
    measureQueue: serial(), // apart from `exclusive`: a measurement never waits on a routing decision
    completedEarly: new Set<string>(), // agent ids whose turn.complete came before their reservation was mapped (at most 100)
    recent: [] as DecisionEntry[],
    runs: new Map<string, { ac: AbortController; sessionId: string; description: string; done: Promise<void> }>(),
    reconciled: false, // leftover run records are checked once per module instance
    reconciling: new Set<string>(), // agent ids this instance already reported lost
    blockedCalls: [] as BlockedCall[], // module memory: a reload forgets them
    claudeReservations: new Map<string, string>(),
    claudeAgents: new Map<string, string>(),
    sessionMode: undefined as Mode | undefined,
    cooldownUntil: 0,
    broken: false, // spawn failed: Codex is unusable for the rest of the session
    toasted: false,
    lastRoute: undefined as Provider | undefined,
    atCeiling: { claude: false, codex: false } as Record<Provider, boolean>,
    tight: false, // PRD 9 state claude-tight
    armed: false, // one reminder waits for the next prompt
    lastContextTokens: undefined as number | undefined,
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

export async function pruneRuns($: EngineInterface, st: State): Promise<void> {
  try {
    const dir = `${await dataDir($, st)}/runs`
    const now = await $.clock.now()
    const paths = (await $.fs.list(dir))
      .filter(e => e.kind === 'file' && !e.isLink && /^codex-[0-9a-f-]+\.(txt|last\.txt|full\.txt|partial\.txt|patch)$/.test(e.name) && now - e.mtimeMs > RUN_FILE_MAX_AGE_MS)
      .map(e => `${dir}/${e.name}`)
    if (paths.length) await $.process.run(['rm', '-f', '--', ...paths])
  } catch { /* Missing directories and cleanup failures do not prevent startup. */ }
}

type Lost = { agentId: string; text?: string } // text: what the calling session must be told (its own runs only)

// Releases the reservation, logs outcome lost and builds the caller's message. The record stays: the caller deletes it
// once the message is delivered (a duplicate on a crash beats a dropped message).
async function lostRun($: EngineInterface, st: State, record: RunRecord, current: boolean): Promise<Lost> {
  st.reconciling.add(record.agentId)
  await quietly(() => removeInflight($, record.agentId))
  await quietly(() => writeLog($, st, { ...record.entry, outcome: 'lost' }))
  // A reload kills the Codex child, but a killed Claude Code process leaves it running (seen live): stop it before the
  // change check. The pattern matches only a codex exec whose -o file is this run's, not a prompt naming its id.
  await quietly(async () => {
    const pattern = `codex exec .* -o .*/${record.agentId}\\.last\\.txt( |$)`
    const r = await $.process.run(['pkill', '-f', pattern])
    if (r.exitCode !== 0) return
    await $.clock.sleep(1000)
    await $.process.run(['pkill', '-KILL', '-f', pattern]) // one that ignored SIGTERM
  })
  if (!current) return { agentId: record.agentId }
  let changed: string[] | null = []
  let notes = ''
  if (record.sandbox === 'workspace-write') {
    changed = null
    await quietly(async () => { changed = changedSince(record.before, await snapshotAll($, record.gitCwd, record.worktrees ?? [])) })
  }
  await quietly(async () => { notes = await $.fs.read(record.outFile) })
  await quietly(() => setRun($, record.rowId, null))
  let detail = ' Nothing was changed; delegate it again.'
  if (changed === null) detail = ' The change check is unknown; do not re-run blindly.'
  else if (changed.length) {
    const saved = await saveWork($, { ...record, cwd: record.gitCwd }, {} as CodexRun, changed)
    detail = ` ${failureText({ reason: 'lost', changed, sandbox: record.sandbox, saved })}`
  }
  const text = `[balancer] Codex run "${record.description}" (${record.agentId}) ended without a result: Balancer was reloaded or restarted while it ran.` +
    detail + (notes.trim() ? `\n\n${partialBlock('lost', notes)}` : '')
  return { agentId: record.agentId, text }
}

async function dropRecord($: EngineInterface, agentId: string): Promise<void> {
  await quietly(() => $.store.delete(`run/${agentId}`))
}

/** Runs a fresh module instance's check of leftover run records, once: this session's records died with an earlier
 * instance (a plugin reload or a restarted process); another session's are cleared only once older than any run can be. */
async function findLost($: EngineInterface, st: State): Promise<Lost[]> {
  if (st.reconciled) return []
  st.reconciled = true
  const out: Lost[] = []
  await quietly(async () => {
    const session = await $.session.id()
    const now = await $.clock.now()
    for (const key of (await $.store.keys()).filter(k => k.startsWith('run/'))) {
      await quietly(async () => {
        const record = await $.store.get(key) as RunRecord | undefined
        if (!record?.agentId || st.runs.has(record.agentId) || st.reconciling.has(record.agentId)) return
        const current = record.sessionId === session
        if (current || now - record.startedAt > st.opts.taskTimeoutMs + 5 * MIN_MS) out.push(await lostRun($, st, record, current))
      })
    }
  })
  return out
}

/** At session start: each message is submitted as a turn of its own. Not awaited, since submit resolves only once the
 * prompt has entered; the record goes after that, so a module that dies first sends it again from the next one. */
export async function reconcileRuns($: EngineInterface, st: State): Promise<void> {
  for (const l of await findLost($, st)) {
    if (l.text === undefined) await dropRecord($, l.agentId)
    else void $.prompt.submit({ text: l.text }).then(() => dropRecord($, l.agentId), () => {})
  }
}

// ---------- readings ----------

// Preserve a previously stored limit until its reset, including readings saved by older versions.
function mergeClaude(stored: ProviderReading | null, live: ProviderReading | null, now: number): ProviderReading | null {
  const s = stored ? expireLimit(stored, now) : null
  const picked = mergeUsage(s, live)
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
  // Missing or logged out: say so once (the slot the spawn-error toast shares), then every call runs on Claude.
  if (!st.avail.ok) await toastOnce($, st)
  return st.avail.ok
}

async function toastOnce($: EngineInterface, st: State): Promise<void> {
  if (st.toasted) return
  st.toasted = true
  await quietly(() => $.ui.toast('Balancer: Codex is not available, subagents run on Claude.'))
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

// ---------- status, ceilings, nudge (PRD 10, 9) ----------

// The reading the mod already holds: no process is run. A stale one still reads right (its passed resets count as zero).
async function codexKnown($: EngineInterface, st: State, now: number): Promise<ProviderReading | null> {
  const r = st.cache.get('codex', now) ?? (await loadReading($, 'codex'))
  return r ? expireLimit(r, now) : null
}

// UI is best effort: a failing status line or toast never changes routing.
async function quietly(fn: () => unknown): Promise<void> {
  try { await fn() } catch { /* nothing to do */ }
}

/** Status line, ceiling toasts and the nudge state, from the readings as they stand. `claudeIn` is the one a measure just took. */
async function observe($: EngineInterface, st: State, claudeIn?: ProviderReading | null): Promise<void> {
  try {
    const now = await $.clock.now()
    const claude = claudeIn !== undefined ? claudeIn : await claudeReading($, st, now)
    const codex = await codexKnown($, st, now)
    await quietly(() => $.ui.status(formatStatus({ now, claude, codex, last: st.lastRoute })))
    for (const [p, r] of [['claude', claude], ['codex', codex]] as const) {
      const hit = ceilingHit(r, now, st.opts.config)
      if (hit && !st.atCeiling[p]) await quietly(() => $.ui.toast(ceilingText(p === 'claude' ? 'Claude' : 'Codex', hit)))
      st.atCeiling[p] = hit !== null
    }
    if (st.opts.nudge) {
      const m = modeNow(st)
      const gap = claude && codex ? gapOf(claude, codex, now) : 0
      // Usable in the full sense, as routing sees it: not limited, below both ceilings, not cooling down (auto only, as in
      // routing). The cheap checks come first: asking whether Codex is installed runs a process.
      const open = codex !== null && m !== 'off' && m !== 'claude' && !codex.limitReached &&
        ceilingHit(codex, now, st.opts.config) === null && !(m === 'auto' && now < st.cooldownUntil)
      const wanted = open && (st.tight || gap > NUDGE_ENTER_GAP)
      const tight = nextTight(st.tight, gap, wanted && (await codexUsable($, st, now)))
      if (tight && !st.tight) st.armed = true
      if (!tight) st.armed = false
      st.tight = tight
    }
  } catch {
    // an unreadable reading changes nothing
  }
}

// One value per run, for the row (types/index.d.ts). Written after the row's tool.call began, so a redraw follows.
async function setRun($: EngineInterface, id: string | undefined, v: RowRun | null): Promise<void> {
  if (id === undefined) return
  await quietly(() => $.state.set({ plugin: 'balancer', key: 'runs', id }, v))
}

// A task reserved while others run, and each of those others, are marked: their usage deltas mix, so none of them may
// teach the estimate, even one that starts and ends inside another.
async function reserve($: EngineInterface, rec: Inflight, others: readonly Inflight[]): Promise<void> {
  if (others.length > 0) {
    for (const o of others) await addInflight($, { ...o, overlapped: true })
    rec = { ...rec, overlapped: true }
  }
  await addInflight($, rec)
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

/** Last decisions across sessions, from the log; this session's list when the log cannot be read. */
async function recentDecisions($: EngineInterface, st: State): Promise<readonly DecisionEntry[]> {
  try {
    await st.logQueue(async () => {}) // let pending log writes land first
    const r = await $.fs.read(`${await dataDir($, st)}/decisions.jsonl`)
    if (typeof r === 'string') return lastDecisions(r)
  } catch { /* fall back */ }
  return st.recent
}

// ---------- eligibility (PRD 8.1) ----------

async function optedOut($: EngineInterface): Promise<boolean> {
  try {
    const root = await $.session.root()
    const text = await $.fs.read(`${root}/.claude/balancer.json`)
    return typeof text === 'string' && (JSON.parse(text) as { codex?: unknown } | null)?.codex === false
  } catch {
    return false // missing or unparseable: not opted out
  }
}

/** The custom type's definition: the first file that exists decides, and it must parse. Null when there is none. */
async function agentDefFor($: EngineInterface, type: string, cwd: string): Promise<AgentDef | null> {
  const configDir = configDirFor(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  for (const path of agentDefPaths(type, [await $.session.root(), cwd], configDir)) {
    let text: unknown
    try { text = await $.fs.read(path) } catch { continue }
    return typeof text === 'string' ? parseAgentDef(text) : null
  }
  return null
}

/** Null: stays on Claude. Otherwise the custom type's definition, or `{}` for a listed type. */
async function eligible($: EngineInterface, st: State, e: AgentCall): Promise<{ def?: AgentDef } | null> {
  const type = e.subagent_type
  if (type === 'fork' || e.isolation != null || e.name != null || CAPABILITY_RE.test(e.prompt)) return null
  if (await optedOut($)) return null
  let cwd: string
  try {
    cwd = await $.session.cwd()
    await $.fs.stat(cwd)
  } catch {
    return null
  }
  if (type?.includes(':')) return null // a plugin agent: its definition lives elsewhere and cannot be checked
  const listed = type === undefined || st.opts.eligible.has(type)
  if (listed && type === undefined) return {}
  const def = await agentDefFor($, type!, cwd)
  if (listed) return def && unavailableTools(def) ? null : {}
  return def && !unavailableTools(def) ? { def } : null
}

// ---------- Agent hook ----------

export async function onAgent($: EngineInterface, st: State, e: AgentCall, next: Next<'tool.call', AgentCall>) {
  const mode = modeNow(st)
  if (mode === 'off') return next(e)
  const ok = await eligible($, st, e)
  if (!ok) return next(e)
  const def = ok.def // read once: eligibility and the task share it
  const model = e.model ?? defModel(def) // the call's own model wins over its agent file's, as for the model map

  const type = e.subagent_type ?? 'general-purpose'
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd() // before the reservation: nothing after it may throw before the run owns it
  const dd = await dataDir($, st)
  // The hook cannot read the session's mode: only the Agent call's own argument. A seated security plugin
  // (cc-plugin-sec-default) sends classic events and prompt.attachment past user plugins, so neither is hooked.
  const planMode = (e as { mode?: string }).mode === 'plan'

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
    const claudeReserved = sumReserved(await listInflight($, now, st.opts.taskTimeoutMs, CLAUDE_INFLIGHT))
    const input = {
      now, mode, config: st.opts.config, claude, codex, claudeCost: st.opts.claudeCost, codexCost: estimate,
      reserved, claudeReserved, inflight: list.length, codexAvailable: usable,
    }
    let d: Decision
    const excluded = mode === 'claude' ? undefined
      : st.opts.excluded.has(type) ? 'agent-excluded' as const
      : modelExcluded(model, st.opts.excludedModels) ? 'model-excluded' as const : undefined
    const repeat = !excluded && mode !== 'claude' && takeRepeat(st, sessionId, type, e.description, e.prompt, now)
    if (excluded || repeat || (mode === 'auto' && now < st.cooldownUntil)) {
      d = {
        route: 'claude', reason: excluded ?? (repeat ? 'codex-blocked-repeat' as const : 'codex-cooldown'), refresh: false,
        claudeAfter: score(claude, now, { fiveHour: st.opts.claudeCost.fiveHour + claudeReserved.fiveHour, sevenDay: st.opts.claudeCost.sevenDay + claudeReserved.sevenDay }),
        codexAfter: score(codex, now, { fiveHour: reserved.fiveHour + estimate.fiveHour, sevenDay: reserved.sevenDay + estimate.sevenDay }),
      }
    } else d = decide(input)
    const entry: DecisionEntry = {
      t: now, session: sessionId, agentType: type, route: d.route, reason: d.reason,
      claudeAfter: Math.round(d.claudeAfter * 10) / 10, codexAfter: Math.round(d.codexAfter * 10) / 10,
      estimate, mode,
    }
    const agentId = newAgentId()
    if (d.route === 'codex') await reserve($, { id: agentId, sessionId, startedAt: now, cost: estimate, agentType: type }, list)
    else {
      await reserveClaude($, st, agentId, sessionId, type, now)
    }
    return { d, entry, agentId, codex, estimate }
  })

  pushRecent(st.recent, picked.entry)
  st.lastRoute = picked.d.route
  if (picked.d.refresh) void refreshCodex($, st)
  if (picked.d.route === 'claude') {
    return nextOnClaude($, st, picked.agentId, e, next, async () => {
      await writeLog($, st, picked.entry)
      await observe($, st)
    })
  }

  const agentId = picked.agentId
  const sandbox = sandboxFor(e.subagent_type, planMode, def?.tools)
  const task: Task = {
    agentId, sessionId, type, description: e.description, prompt: e.prompt, rowId: e.tool_use_id,
    cwd, sandbox, effort: (def && codexEffort(def)) ?? effortFor(model, st.opts.effortMap),
    outFile: `${dd}/runs/${agentId}.last.txt`, base: `${dd}/runs/${agentId}`,
    model: codexModelFor(model, st.opts.modelMap, st.opts.codexModel),
    ...(e.model !== undefined ? { callModel: e.model } : {}),
    ...((e as { effort?: string }).effort !== undefined ? { noRedo: 'effort' as const } : (e as { mode?: string }).mode !== undefined ? { noRedo: 'mode' as const } : {}),
    ...(def ? { agent: { type, body: def.body } } : {}),
    estimate: picked.estimate, codexBefore: picked.codex, entry: picked.entry,
  }

  task.entry.codexModel = task.model ?? 'default'
  await setRun($, task.rowId, { model: task.model ?? 'default', effort: task.effort, running: true })
  await observe($, st)

  // The 2.1.321 input type omits run_in_background; the model may still send it.
  if ((e as { run_in_background?: boolean }).run_in_background === false) {
    const ac = new AbortController()
    const abort = () => ac.abort()
    if (next.signal.aborted) abort()
    else next.signal.addEventListener('abort', abort, { once: true })
    const done = runTask($, st, task, ac.signal, `${dd}/runs/${agentId}.txt`, false)
    st.runs.set(agentId, { ac, sessionId, description: e.description, done: done.then(() => {}, () => {}) })
    let s: Settled
    try {
    s = await done
    await quietly(() => $.store.delete(`run/${agentId}`)) // Codex has ended; a reload during a Claude fallback is not a lost Codex run
    if (s.kind === 'ok') return { result: completedRecord({ agentId, text: s.report, prompt: e.prompt, durationMs: s.durationMs, agentType: type }) }
    if (s.kind === 'aborted') return { deny: 'Balancer: the Codex run was interrupted' }
    if (s.sandbox === 'read-only' || (s.changed !== null && s.changed.length === 0)) {
      await fellBack($, st, task, s.reason)
      if (s.reason === 'blocked') await logRedo($, st, task)
      const reservation = newAgentId()
      try { await reserveClaude($, st, reservation, sessionId, type, await $.clock.now()) } catch { return await next(e) }
      return await nextOnClaude($, st, reservation, e, next)
    }
    if (s.reason === 'blocked') await quietly(() => armRepeat($, st, task))
    return { result: completedRecord({ agentId, text: failureText(s), prompt: e.prompt, durationMs: 0, agentType: type }) }
    } finally {
      await quietly(() => $.store.delete(`run/${agentId}`))
      st.runs.delete(agentId)
      next.signal.removeEventListener('abort', abort)
    }
  }

  const outputFile = `${dd}/runs/${agentId}.txt`
  const ac = new AbortController()
  const done = (async () => {
    try {
      await deliverBackground($, st, task, await runTask($, st, task, ac.signal, `${dd}/runs/${agentId}.full.txt`, true), outputFile)
      await quietly(() => $.store.delete(`run/${agentId}`))
    } catch {
      // A detached run has nobody to throw to. Its record stays, so the next module instance reports it lost.
    } finally {
      st.runs.delete(agentId)
    }
  })()
  st.runs.set(agentId, { ac, sessionId, description: e.description, done })
  return { result: asyncLaunchedRecord({ agentId, description: e.description, prompt: e.prompt, outputFile }) }
}

// ---------- one Codex run, both modes ----------

// Where Codex may write and where git is asked, for a workspace-write run (DW29, DW30). `gitCwd` is the repository's top
// folder when there is one, since git status paths are relative to it. Grants come only from the user's data folder.
async function writableRoots($: EngineInterface, st: State, cwd: string, prompt: string): Promise<{ gitCwd: string; addDirs: string[]; worktrees: string[] }> {
  const home = await $.env.get('HOME')
  const usable = async (d: string) => {
    if (!safeDirSyntax(d, home)) return false
    try { return (await $.fs.stat(d)).kind === 'dir' } catch { return false }
  }
  let roots: { toplevel: string; commonDir: string } | null = null
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd })
    if (r.exitCode === 0) roots = parseGitRoots(r.stdout)
  } catch { /* not a repository */ }
  const root = await $.session.root()
  const dirs: string[] = []
  const worktrees: string[] = []
  if (roots) {
    const top = roots.toplevel.replace(/\/+/g, '/')
    if (top !== cwd.replace(/\/+/g, '/') && (await usable(top))) dirs.push(top)
    // A brief that names a sibling linked worktree of this repository (the shell in one checkout, the work in another)
    // makes that worktree writable. Only roots git lists for this repository qualify, never a path taken from the brief.
    try {
      const listed = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: roots.toplevel })
      if (listed.exitCode === 0) {
        for (const d of namedWorktrees(prompt, parseWorktrees(listed.stdout))) {
          if (d !== top && (await usable(d))) worktrees.push(d)
        }
      }
    } catch { /* none named */ }
    dirs.push(...worktrees)
  } else {
    const normalizedRoot = root.replace(/\/+/g, '/')
    if (cwd.replace(/\/+/g, '/').startsWith(normalizedRoot.replace(/\/+$/, '') + '/') && (await usable(normalizedRoot))) dirs.push(normalizedRoot)
  }
  let grants: string[] = []
  try { grants = grantsFor(await $.fs.read(`${await dataDir($, st)}/writable-dirs.json`), roots ? projectKey(roots.commonDir) : root) } catch { /* no file */ }
  for (const grant of grants) {
    const d = grant.replace(/\/+/g, '/')
    if (await usable(d)) dirs.push(d)
  }
  return { gitCwd: roots?.toplevel ?? cwd, addDirs: [...new Set(dirs)], worktrees }
}

// The change check: the shell's repository plus each brief-named worktree, whose lines carry its root so the paths name
// the right folder. One unreadable status makes the whole check unknown, never "nothing changed".
async function snapshotAll($: EngineInterface, gitCwd: string, worktrees: readonly string[]): Promise<string[] | null> {
  const all = await gitSnapshot($, gitCwd)
  for (const wt of worktrees) {
    if (!all) return null
    const s = await gitSnapshot($, wt)
    if (!s) return null
    all.push(...s.map(l => `${wt}/${l}`))
  }
  return all
}

async function runTask($: EngineInterface, st: State, c: Task, signal: AbortSignal, fullTextPath: string, background: boolean): Promise<Settled> {
  const git = c.sandbox === 'workspace-write'
  // nothing here may throw before the run owns its reservation
  const none = { gitCwd: c.cwd, addDirs: [] as string[], worktrees: [] as string[] }
  const roots = git ? await writableRoots($, st, c.cwd, c.prompt).catch(() => none) : none
  c.gitCwd = roots.gitCwd
  c.worktrees = roots.worktrees
  let run: CodexRun
  let before: string[] | null = null
  let overlapped = false
  try {
    if (git) before = await snapshotAll($, roots.gitCwd, roots.worktrees)
    const record: RunRecord = { agentId: c.agentId, sessionId: c.sessionId, description: c.description, background, ...(c.rowId ? { rowId: c.rowId } : {}), sandbox: c.sandbox, gitCwd: roots.gitCwd, worktrees: roots.worktrees, before, outFile: c.outFile, base: c.base, startedAt: await $.clock.now(), type: c.type, entry: c.entry }
    await quietly(() => $.store.set(`run/${c.agentId}`, record))
    // Codex does not create the folder of its -o file; $.fs.write makes missing parents.
    try { await $.fs.write(c.outFile, '') } catch { /* best effort */ }
    const built = buildCodexArgv({
      cwd: c.cwd, sandbox: c.sandbox, effort: c.effort, model: c.model,
      outFile: c.outFile, prompt: c.prompt, addDirs: roots.addDirs, ...(c.agent ? { agent: c.agent } : {}),
    })
    run = await runCodex($, {
      argv: built.argv, ...(built.input !== undefined ? { input: built.input } : {}),
      cwd: c.cwd, timeoutMs: st.opts.taskTimeoutMs, signal,
    })
  } finally {
    try {
      // A task that started while another ran (or had another start under it) was marked when it reserved.
      overlapped = ((await $.store.get(`inflight/${c.agentId}`)) as Partial<Inflight> | undefined)?.overlapped === true
      await removeInflight($, c.agentId)
    } catch { /* expires by age */ }
  }

  const now = await $.clock.now()
  let after: ProviderReading | null = null
  if (run.threadId) {
    try { after = await readCodexRollout($, now, run.threadId) } catch { /* best effort */ }
    if (after) {
      await quietly(() => saveReading($, 'codex', after!))
      await quietly(() => st.cache.put('codex', after!, now))
      if (run.outcome !== 'aborted') {
        await quietly(async () => {
          const others = (await listInflight($, now, st.opts.taskTimeoutMs)).length > 0
          await saveEstimate($, c.type, updateEstimate(c.estimate, c.codexBefore, after!, overlapped || others))
        })
      }
    }
  }
  if (run.limitHit) {
    const limit: ProviderReading = { ...(after ?? c.codexBefore ?? emptyReading(now)), readAt: now, limitReached: true }
    await quietly(() => saveReading($, 'codex', limit))
    await quietly(() => st.cache.put('codex', limit, now))
  }
  if (run.outcome === 'spawn-error') {
    st.broken = true
    await quietly(() => toastOnce($, st))
  }

  c.entry.durationMs = run.durationMs
  c.entry.outcome = run.outcome
  if (run.exitCode !== null) c.entry.exitCode = run.exitCode
  const delta = deltaOf(c.codexBefore, after)
  if (delta) c.entry.delta = delta
  await quietly(() => writeLog($, st, c.entry))

  await quietly(() => setRun($, c.rowId, run.outcome === 'aborted' ? null : {
    model: c.model ?? 'default', effort: c.effort, running: false, durationMs: run.durationMs, ...(delta ? { delta5h: delta.fiveHour } : {}),
    ...(run.outcome === 'ok' && run.finalMessage !== undefined ? {} : { failed: true }),
  }))
  await quietly(() => observe($, st))

  if (run.outcome === 'aborted') return { kind: 'aborted' }
  const afterGit = git ? await snapshotAll($, roots.gitCwd, roots.worktrees) : null
  if (run.outcome === 'ok' && run.finalMessage !== undefined) {
    const cut = run.finalMessage.length > st.opts.maxResultChars
    if (cut) { try { await $.fs.write(fullTextPath, run.finalMessage) } catch { /* the report still says it was cut */ } }
    return {
      kind: 'ok', durationMs: run.durationMs,
      report: buildReport({
        finalMessage: run.finalMessage, model: c.model, effort: c.effort, durationMs: run.durationMs, threadId: run.threadId,
        maxResultChars: st.opts.maxResultChars, ...(cut ? { fullTextPath } : {}), gitStatus: afterGit, sandbox: c.sandbox,
      }),
    }
  }
  const reason = reasonOf(run)
  const changed = git ? changedSince(before, afterGit) : []
  return { kind: 'fail', reason, changed, sandbox: c.sandbox, saved: await saveWork($, c, run, changed) }
}

// Best effort, never throws: a failed write or git call changes nothing but what the text can name.
async function saveWork($: EngineInterface, c: Pick<Task, 'base' | 'gitCwd' | 'cwd' | 'worktrees'>, run: CodexRun, changed: string[] | null): Promise<Saved> {
  const saved: Saved = {}
  if (run.finalMessage) {
    saved.partial = { text: run.finalMessage }
    try {
      await $.fs.write(`${c.base}.partial.txt`, run.finalMessage)
      saved.partial.path = `${c.base}.partial.txt`
    } catch { /* the text is still given, without a path */ }
  }
  if (run.threadId && (run.limitHit || run.outcome === 'timeout')) saved.resumeThreadId = run.threadId
  if (changed && changed.length > 0) {
    // A path in a brief-named worktree carries its root: git is asked in that worktree, about the path relative to it.
    const groups = new Map<string, string[]>()
    for (const p of changed) {
      const wt = (c.worktrees ?? []).find(d => p.startsWith(d + '/')) ?? ''
      groups.set(wt, [...(groups.get(wt) ?? []), p])
    }
    const patches: string[] = []
    for (const [wt, paths] of groups) {
      try {
        const cwd = wt || (c.gitCwd ?? c.cwd)
        const rel = wt ? paths.map(p => p.slice(wt.length + 1)) : paths
        const ls = await $.process.run(['git', 'ls-files', '-z', '--', ...rel], { cwd })
        if (ls.exitCode !== 0) continue
        const tracked = ls.stdout.split('\0').filter(Boolean)
        saved.untracked = [...(saved.untracked ?? []), ...paths.filter((_, i) => !tracked.includes(rel[i]!))]
        if (tracked.length > 0) {
          const prefix = wt ? [`--src-prefix=a${wt}/`, `--dst-prefix=b${wt}/`] : []
          const d = await $.process.run(['git', 'diff', 'HEAD', ...prefix, '--', ...tracked], { cwd })
          if (d.exitCode === 0 && d.stdout.length > 0) patches.push(d.stdout)
        }
      } catch { /* no patch for this folder */ }
    }
    if (patches.length > 0) {
      try {
        await $.fs.write(`${c.base}.patch`, patches.join(''))
        saved.patchPath = `${c.base}.patch`
      } catch { /* no patch */ }
    }
  }
  return saved
}

async function deliverBackground($: EngineInterface, st: State, c: Task, s: Settled, outputFile: string): Promise<void> {
  if (s.kind === 'aborted') return
  let text: string
  if (s.kind === 'ok') {
    await quietly(() => $.fs.write(outputFile, s.report)) // the message below is the report's delivery
    text = `[balancer] Background agent "${c.description}" (${c.agentId}) finished on Codex.\n\n${s.report}`
  } else if (s.reason === 'blocked' && (s.sandbox === 'read-only' || (s.changed !== null && s.changed.length === 0))) {
    // Nothing was changed, so the task is redone once on Claude: no cooldown, since Codex itself worked.
    const notes = s.saved.partial ? partialBlock('blocked', s.saved.partial.text) : undefined
    const r = c.noRedo ? { failed: c.noRedo } : await startRedo($, st, c, notes)
    if (!('agentId' in r)) await quietly(() => armRepeat($, st, c))
    // The engine delivers the redo's own report as its notification; this message only links it to the Codex id the model holds.
    text = 'agentId' in r
      ? `[balancer] Codex reported "${c.description}" (${c.agentId}) blocked, nothing was changed. ` +
        `Balancer is redoing it once on Claude as background agent ${r.agentId}; its report will come from that agent.`
      : c.noRedo
      ? `[balancer] Codex reported "${c.description}" (${c.agentId}) blocked, nothing was changed. It was not redone on Claude ` +
        `because the call set ${c.noRedo}, which a redo started by Balancer cannot carry. ${AGAIN}` + (notes ? `\n\n${notes}` : '')
      : `[balancer] Codex reported "${c.description}" (${c.agentId}) blocked, nothing was changed, and the Claude redo could not start (${r.failed}). ${AGAIN}` +
        (notes ? `\n\n${notes}` : '')
  } else if (s.sandbox === 'read-only' || (s.changed !== null && s.changed.length === 0)) {
    st.cooldownUntil = (await $.clock.now()) + COOLDOWN_MS
    await fellBack($, st, c, s.reason, true)
    text = `[balancer] Codex could not run "${c.description}" (${s.reason}), nothing was changed, ` +
      'delegate it again and it will run on Claude.' +
      (s.saved.partial ? `\n\n${partialBlock(s.reason, s.saved.partial.text)}\nPut them in the new brief if they help.` : '')
  } else {
    if (s.reason === 'blocked') await quietly(() => armRepeat($, st, c))
    text = `[balancer] Background agent "${c.description}" (${c.agentId}): ` +
      failureText(s)
  }
  await $.prompt.submit({ text })
}

const AGAIN = 'Delegate it again with the same description; that call will run on Claude.'

async function armRepeat($: EngineInterface, st: State, c: Task): Promise<void> {
  const now = await $.clock.now()
  st.blockedCalls = st.blockedCalls.filter(b => b.until > now)
  st.blockedCalls.push({ sessionId: c.sessionId, type: c.type, description: sameDescription(c.description), prompt: c.prompt, until: now + REPEAT_WINDOW_MS })
}

/** True, once, for the session's repeat of a blocked call that was not redone. */
function takeRepeat(st: State, sessionId: string, type: string, description: string, prompt: string, now: number): boolean {
  const i = st.blockedCalls.findIndex(b => b.until > now && b.sessionId === sessionId && b.type === type &&
    (b.description === sameDescription(description) || b.prompt === prompt))
  if (i < 0) return false
  st.blockedCalls.splice(i, 1)
  return true
}

// The decision log's line for a redo: the Codex entry's numbers, now routed to Claude.
async function logRedo($: EngineInterface, st: State, c: Task): Promise<void> {
  const { session, agentType, claudeAfter, codexAfter, estimate, mode } = c.entry
  const entry: DecisionEntry = { t: await $.clock.now(), session, agentType, route: 'claude', reason: 'codex-blocked', claudeAfter, codexAfter, estimate, mode }
  pushRecent(st.recent, entry)
  await writeLog($, st, entry)
}

/** Spawns the one Claude redo of a blocked background run: its agent id, or why it could not start. */
async function startRedo($: EngineInterface, st: State, c: Task, notes: string | undefined): Promise<{ agentId: string } | { failed: string }> {
  const reservation = newAgentId()
  let agentId: string
  try {
    await reserveClaude($, st, reservation, c.sessionId, c.type, await $.clock.now())
    const r = await $.agent.spawn({
      prompt: notes ? `${c.prompt}\n\n${notes}` : c.prompt, description: c.description, subagentType: c.type, cwd: c.cwd,
      ...(c.callModel !== undefined ? { model: c.callModel } : {}),
    })
    const deny = (r as { deny?: string }).deny
    if (deny !== undefined || !r.agentId) throw new Error(deny ?? 'no agent id')
    const mapped = mapAgent(st, r.agentId, reservation)
    agentId = r.agentId
    if (!mapped) await quietly(() => releaseClaude($, st, reservation))
  } catch (err) {
    await quietly(() => releaseClaude($, st, reservation))
    return { failed: String((err as { message?: unknown })?.message ?? err).slice(0, 200) }
  }
  await logRedo($, st, c)
  await quietly(() => $.ui.toast('Balancer: Codex reported blocked, redoing the task on Claude.'))
  return { agentId }
}

// A failure that put the task back on Claude: the row loses its Codex line, and the person is told (once, spawn errors already were).
async function fellBack($: EngineInterface, st: State, c: Task, reason: string, cooling = false): Promise<void> {
  await setRun($, c.rowId, null)
  if (reason === 'codex missing') return
  await quietly(() => $.ui.toast(
    `Balancer: Codex failed (${reason}), ${cooling ? 'subagents run on Claude for the next 15 minutes.' : 'the task ran on Claude.'}`,
  ))
}

// ---------- other hooks ----------

export async function onTaskStop($: EngineInterface, st: State, e: TaskStopCall, next: Next<'tool.call', TaskStopCall>) {
  const id = e.task_id ?? e.shell_id
  const run = id === undefined ? undefined : st.runs.get(id)
  if (id === undefined) return next(e)
  if (!run) {
    const record = await $.store.get(`run/${id}`) as RunRecord | undefined
    if (record?.agentId === id && record.sessionId !== await $.session.id()) {
      return { deny: `Balancer: Codex run ${id} belongs to another session; only that session can stop it.` }
    }
    if (record?.agentId === id && !st.reconciling.has(id)) {
      // The run died with an earlier module instance; the answer itself tells the model, so no prompt is submitted.
      const lost = await lostRun($, st, record, true)
      await dropRecord($, id)
      const stopped = taskStopRecord({ taskId: id, description: record.description })
      return { result: lost.text ? { ...stopped, message: lost.text } : stopped }
    }
    if (id.startsWith('codex-')) return { deny: `Balancer: Codex run ${id} is not running; it already ended. Its result, if any, was delivered as a message.` }
    return next(e)
  }
  run.ac.abort()
  await run.done // the child is killed and the reservation released before the model hears back
  return { result: taskStopRecord({ taskId: id, description: run.description }) }
}

export async function onSessionEnd($: EngineInterface, st: State, e: { sessionId: string }) {
  const mine = [...st.runs.values()].filter(r => r.sessionId === e.sessionId)
  for (const r of mine) r.ac.abort()
  await Promise.allSettled(mine.map(r => r.done))
  for (const [id, sessionId] of st.claudeReservations) {
    if (sessionId === e.sessionId) await releaseClaude($, st, id)
  }
}

async function reserveClaude($: EngineInterface, st: State, id: string, sessionId: string, type: string, startedAt: number): Promise<void> {
  await addInflight($, { id, sessionId, startedAt, cost: st.opts.claudeCost, agentType: type }, CLAUDE_INFLIGHT)
  st.claudeReservations.set(id, sessionId)
}

/** `next(e)` under a Claude reservation: released when the call ends, or, for a background launch, at the agent's turn.complete. */
async function nextOnClaude(
  $: EngineInterface, st: State, reservation: string, e: AgentCall, next: Next<'tool.call', AgentCall>, before?: () => Promise<void>,
) {
  let background = false
  try {
    await before?.()
    const result = await next(e)
    const value = 'result' in result ? result.result : undefined
    if (st.claudeReservations.has(reservation) && value && typeof value === 'object' && 'status' in value && value.status === 'async_launched' && 'agentId' in value && typeof value.agentId === 'string') {
      background = mapAgent(st, value.agentId, reservation)
    }
    return result
  } finally {
    if (!background) await quietly(() => releaseClaude($, st, reservation)) // a store error must not replace the call's result
  }
}

/** Maps a launched agent to its reservation. False when its turn.complete already came: the caller releases at once. */
function mapAgent(st: State, agentId: string, reservation: string): boolean {
  if (st.completedEarly.delete(agentId)) return false
  st.claudeAgents.set(agentId, reservation)
  return true
}

async function releaseClaude($: EngineInterface, st: State, id: string): Promise<void> {
  st.claudeReservations.delete(id)
  for (const [agentId, reservationId] of st.claudeAgents) if (reservationId === id) st.claudeAgents.delete(agentId)
  await removeInflight($, id, CLAUDE_INFLIGHT)
}

export async function onTurnComplete($: EngineInterface, st: State, e: TurnCompleteInput, next: Next<'turn.complete'>) {
  const id = e.agentId === undefined ? undefined : st.claudeAgents.get(e.agentId)
  if (e.agentId !== undefined && !id) {
    st.completedEarly.add(e.agentId)
    if (st.completedEarly.size > 100) st.completedEarly.delete(st.completedEarly.values().next().value!)
  }
  if (id) await quietly(() => releaseClaude($, st, id))
  return next(e)
}

export async function onMeasure($: EngineInterface, st: State, e: SessionMeasureInput) {
  const { tokens, window } = e.context
  if (tokens !== undefined) {
    if (st.tight && st.lastContextTokens !== undefined && st.lastContextTokens >= window * 0.2 && tokens < st.lastContextTokens / 2) st.armed = true
    st.lastContextTokens = tokens
  }
  const now = await $.clock.now()
  const live = claudeFromUsage(e.rateLimits, now)
  // read, merge and write as one step: a lower reading that read the old value must not land after a higher one
  const merged = await st.measureQueue(async () => {
    const stored = await loadReading($, 'claude')
    const m = live ? (mergeClaude(stored, live, now) ?? live) : mergeClaude(stored, null, now)
    if (live) await saveReading($, 'claude', m ?? live)
    return m
  })
  await observe($, st, merged)
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
      inflight: await listInflight($, now, st.opts.taskTimeoutMs), recent: await recentDecisions($, st),
    }),
  }
}

// ---------- nudge (PRD 9) ----------

/** Attaches the armed reminder to a typed prompt, once. Not to a slash command or a prompt the person did not type.
 * When session.start did not check leftover run records, the first typed prompt does, and carries their messages as
 * context: a prompt submitted from inside this hook would wait for an idle session. */
export async function onPromptSubmit($: EngineInterface, st: State, e: PromptSubmitInput, next: Next<'prompt.submit'>) {
  const typed = !e.command && !e.isMeta
  const lost = typed ? await findLost($, st) : []
  const notes = lost.flatMap(l => l.text === undefined ? [] : [l.text])
  const nudge = typed && modeNow(st) !== 'off' && modeNow(st) !== 'claude' && st.tight && st.armed
  if (nudge) st.armed = false
  const r = notes.length || nudge ? await next({ ...e, context: [...(e.context ?? []), ...notes, ...(nudge ? [NUDGE_TEXT] : [])] }) : await next(e)
  for (const l of lost) await dropRecord($, l.agentId)
  return r
}

// ---------- /codex <task> (PRD 10) ----------

// Same runner, reservation and post-run reading as an Agent run, but asked for by the person: no routing decision,
// no Claude call. A failed run is reported in the answer; nothing falls back, since no Claude task waits.
export async function onCodexCommand($: EngineInterface, st: State, args: string): Promise<{ text: string }> {
  const task = args.trim()
  if (task === '') return { text: CODEX_USAGE }
  if (modeNow(st) === 'off') return { text: 'Balancer is off for this session (mode off), so /codex will not run. Use /balance auto to turn it on.' }
  if (await optedOut($)) return { text: 'This project opted out of Codex (.claude/balancer.json has "codex": false), so /codex will not run here.' }
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()
  const dd = await dataDir($, st)
  const type = 'command'
  const picked = await st.exclusive(async () => {
    const now = await $.clock.now()
    if (!(await codexUsable($, st, now))) return null
    const claude = await claudeReading($, st, now)
    const codex = await codexReading($, st, now)
    const estimate = await loadEstimate($, type)
    const agentId = newAgentId()
    await reserve($, { id: agentId, sessionId, startedAt: now, cost: estimate, agentType: type }, await listInflight($, now, st.opts.taskTimeoutMs))
    const entry: DecisionEntry = {
      t: now, session: sessionId, agentType: type, route: 'codex', reason: 'mode-codex',
      codexModel: st.opts.codexModel || 'default',
      claudeAfter: Math.round(score(claude, now, st.opts.claudeCost) * 10) / 10,
      codexAfter: Math.round(score(codex, now, estimate) * 10) / 10, estimate, mode: modeNow(st),
    }
    return { agentId, estimate, codex, entry }
  })
  if (!picked) return { text: 'Codex is not available (not installed or not logged in), so /codex cannot run.' }

  const { agentId } = picked
  const c: Task = {
    agentId, sessionId, type, description: '/codex', prompt: task, cwd, sandbox: 'workspace-write', effort: 'high',
    model: st.opts.codexModel || undefined,
    outFile: `${dd}/runs/${agentId}.last.txt`, base: `${dd}/runs/${agentId}`, estimate: picked.estimate, codexBefore: picked.codex,
    entry: picked.entry,
  }
  // Registered like a background run so that ending the session stops it.
  const ac = new AbortController()
  let finish = () => {}
  const done = new Promise<void>(r => { finish = r })
  st.runs.set(agentId, { ac, sessionId, description: '/codex', done })
  let s: Settled
  try {
    s = await runTask($, st, c, ac.signal, `${dd}/runs/${agentId}.full.txt`, false)
    if (s.kind === 'ok') return { text: s.report }
    if (s.kind === 'aborted') return { text: 'The Codex run was interrupted.' }
    return { text: failureText(s) }
  } finally {
    await quietly(() => $.store.delete(`run/${agentId}`))
    st.runs.delete(agentId)
    finish()
  }
}
