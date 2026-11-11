import type { BuiltinToolResults, EngineInterface } from 'claude-code'

// Only what this module calls, so the test kit's `$` type fits too.
type $ = Pick<EngineInterface, 'process' | 'clock'>

export const PREAMBLE = [
  "You are running as a delegated subtask of another agent's session. Do only what the brief below asks.",
  'Do not commit, push or switch branches unless the brief says so.',
  'End with a report of what you did, what you verified and what you did not verify.',
].join(' ')

export const PROMPT_ARG_LIMIT_BYTES = 100 * 1024

export type Sandbox = 'read-only' | 'workspace-write'

// ---------- argv ----------

export function parseEffortMap(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of s.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

export function effortFor(model: string | undefined, map: Record<string, string>): string {
  return (model !== undefined ? map[model] : undefined) ?? map.default ?? 'high'
}

export function codexModelFor(model: string | undefined, map: Record<string, string>, codexModel: string): string | undefined {
  return model !== undefined && Object.prototype.hasOwnProperty.call(map, model) ? map[model] : codexModel || undefined
}

export function sandboxFor(agentType: string | undefined, planMode: boolean): Sandbox {
  return agentType === 'Explore' || planMode ? 'read-only' : 'workspace-write'
}

export function buildCodexArgv(o: {
  cwd: string; sandbox: Sandbox; effort: string; model?: string; outFile: string; prompt: string
}): { argv: string[]; input?: string } {
  const full = PREAMBLE + '\n\n' + o.prompt
  const big = new TextEncoder().encode(full).length > PROMPT_ARG_LIMIT_BYTES
  const argv = [
    'codex', 'exec', '--json', '--skip-git-repo-check', '-C', o.cwd, '-s', o.sandbox,
    '-c', `model_reasoning_effort=${o.effort}`,
    ...(o.model ? ['-m', o.model] : []),
    '-o', o.outFile, big ? '-' : full,
  ]
  return big ? { argv, input: full } : { argv }
}

// ---------- event parser ----------

export type CodexUsage = Record<string, number>
export type ParserState = {
  threadId?: string; finalMessage?: string; usage?: CodexUsage; failureMessage?: string; limitHit: boolean
}

const LIMIT_RE = /usage limit|rate limit|limit reached/i

export function createEventParser() {
  const state: ParserState = { limitHit: false }
  let buf = ''
  const line = (raw: string) => {
    const t = raw.trim()
    if (!t.startsWith('{')) return
    let e: any
    try { e = JSON.parse(t) } catch { return }
    if (!e || typeof e !== 'object') return
    switch (e.type) {
      case 'thread.started':
        if (typeof e.thread_id === 'string') state.threadId = e.thread_id
        break
      case 'item.completed':
        if (e.item?.type === 'agent_message' && typeof e.item.text === 'string') state.finalMessage = e.item.text
        break
      case 'turn.completed':
        if (e.usage && typeof e.usage === 'object') state.usage = e.usage
        break
      case 'turn.failed':
      case 'error': {
        const m = e.type === 'turn.failed' ? e.error?.message : e.message
        if (typeof m === 'string') {
          state.failureMessage = m
          if (LIMIT_RE.test(m)) state.limitHit = true
        }
        break
      }
    }
  }
  return {
    state,
    feed(text: string) {
      buf += text
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const p of parts) line(p)
    },
    flush() { const b = buf; buf = ''; line(b) },
  }
}

// ---------- run ----------

export type CodexRun = {
  outcome: 'ok' | 'failed' | 'timeout' | 'aborted' | 'spawn-error'
  exitCode: number | null
  threadId?: string
  finalMessage?: string
  usage?: CodexUsage
  failureMessage?: string
  limitHit: boolean
  durationMs: number
}

const CLEANUP_MS = 5000

async function boundedCleanup(
  cleanup: Promise<unknown>, ms: number,
  g: { setTimeout?: (f: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void },
): Promise<void> {
  let h: unknown
  const cap = new Promise<void>(res => { h = g.setTimeout?.(res, ms) })
  await Promise.race([cleanup, cap])
  if (h !== undefined) g.clearTimeout?.(h)
}

export async function runCodex($: $, o: {
  argv: string[]; input?: string; cwd: string; timeoutMs: number; signal?: AbortSignal
  cleanupMs?: number // how long to wait for the child to exit after a stop (default 5 s)
}): Promise<CodexRun> {
  const t0 = await $.clock.now()
  const parser = createEventParser()
  const ac = new AbortController()
  let timedOut = false
  const onAbort = () => ac.abort()
  if (o.signal?.aborted) ac.abort()
  else o.signal?.addEventListener('abort', onAbort, { once: true })
  // $.clock.sleep would count against the hook's 10 s budget; a plain timer does not.
  const g = globalThis as unknown as {
    setTimeout?: (f: () => void, ms: number) => unknown
    clearTimeout?: (h: unknown) => void
  }
  let timer: unknown
  if (typeof g.setTimeout === 'function') timer = g.setTimeout(() => { timedOut = true; ac.abort() }, o.timeoutMs)
  else AbortSignal.timeout(o.timeoutMs).addEventListener('abort', () => { timedOut = true; ac.abort() }, { once: true })

  const ABORT = Symbol('abort')
  const aborted = new Promise<typeof ABORT>(res => {
    if (ac.signal.aborted) res(ABORT)
    else ac.signal.addEventListener('abort', () => res(ABORT), { once: true })
  })

  let exitCode: number | null = null
  let stopped: 'timeout' | 'aborted' | 'spawn-error' | undefined
  let spawnMessage: string | undefined
  let ended = false
  const it = $.process.spawn({ argv: o.argv, cwd: o.cwd, ...(o.input !== undefined ? { input: o.input } : {}) })[Symbol.asyncIterator]()
  try {
    for (;;) {
      if (ac.signal.aborted) { stopped = timedOut ? 'timeout' : 'aborted'; break }
      const next = it.next()
      next.catch(() => {}) // a rejection that loses the race below must not go unhandled
      const r = await Promise.race([next, aborted])
      if (r === ABORT) { stopped = timedOut ? 'timeout' : 'aborted'; break }
      if (r.done) { exitCode = r.value?.code ?? null; ended = true; break }
      if (r.value.stream === 'stdout') parser.feed(r.value.text)
    }
  } catch (err) {
    stopped = 'spawn-error'
    spawnMessage = String((err as { message?: unknown })?.message ?? err).slice(0, 200)
    ended = true
  } finally {
    // Kills the child. Awaited, so the caller releases its reservation only once the child is gone; bounded, so a stuck
    // cleanup cannot hang the hook.
    if (!ended) await boundedCleanup(Promise.resolve(it.return?.(undefined as never)).catch(() => {}), o.cleanupMs ?? CLEANUP_MS, g)
    if (timer !== undefined) g.clearTimeout?.(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
  parser.flush()
  const s = parser.state
  const outcome: CodexRun['outcome'] = stopped ?? (exitCode === 0 && s.finalMessage ? 'ok' : 'failed')
  return {
    outcome, exitCode, threadId: s.threadId, finalMessage: s.finalMessage, usage: s.usage,
    failureMessage: s.failureMessage ?? spawnMessage, limitHit: s.limitHit,
    durationMs: (await $.clock.now()) - t0,
  }
}

// ---------- git ----------

// One line per path git lists: `<path>\t<content hash>`. The status codes alone miss a second edit to a file that was
// already modified or untracked, so the content is compared too.
// shortcut: one `git hash-object` call over every listed path (a batch that fails is retried path by path), so a huge
// list of untracked files makes a long argv and a slow hash; replace with --stdin-paths if that shows up.
const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') && p.length >= 2 ? p.slice(1, -1).replace(/\\(["\\])/g, '$1') : p)

export async function gitSnapshot($: $, cwd: string): Promise<string[] | null> {
  try {
    const r = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd })
    if (r.exitCode !== 0) return null
    const entries = r.stdout.split('\n').filter(l => l.length > 3).map(l => {
      const rest = l.slice(3)
      const arrow = rest.indexOf(' -> ')
      return { path: unquote(arrow >= 0 ? rest.slice(arrow + 4) : rest), deleted: l[0] === 'D' || l[1] === 'D' }
    })
    const hashes = new Map<string, string>()
    const live = [...new Set(entries.filter(e => !e.deleted).map(e => e.path))]
    const hash = async (paths: string[]): Promise<string[] | null> => {
      const h = await $.process.run(['git', 'hash-object', '--', ...paths], { cwd })
      const out = h.stdout.split('\n').filter(x => x.length > 0)
      return h.exitCode === 0 && out.length === paths.length ? out : null
    }
    if (live.length > 0) {
      let all: string[] | null = null
      try { all = await hash(live) } catch { /* retried one at a time */ }
      if (all) live.forEach((p, i) => hashes.set(p, all[i]!))
      else for (const p of live) hashes.set(p, (await hash([p]).catch(() => null))?.[0] ?? 'missing')
    }
    return [...new Map(entries.map(e => [e.path, `${e.path}\t${hashes.get(e.path) ?? 'missing'}`])).values()]
  } catch { return null }
}

/** Paths whose line is new or changed, or that dropped out of the status (a file restored or deleted). */
export function changedSince(before: string[] | null, after: string[] | null): string[] | null {
  if (!before || !after) return null
  const split = (l: string) => { const i = l.indexOf('\t'); return [i < 0 ? l : l.slice(0, i), l] as const }
  const was = new Map(before.map(split))
  const now = new Map(after.map(split))
  return [
    ...[...now].filter(([p, l]) => was.get(p) !== l).map(([p]) => p),
    ...[...was.keys()].filter(p => !now.has(p)),
  ]
}

// ---------- text ----------

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

const GIT_LINES_MAX = 50

export function buildReport(o: {
  finalMessage: string; model?: string; effort: string; durationMs: number; threadId?: string; maxResultChars: number
  fullTextPath?: string; gitStatus?: string[] | null; sandbox: Sandbox
}): string {
  const session = o.threadId ? `, session ${o.threadId.slice(0, 4)}…` : ''
  const head = `[balancer] Ran on Codex (model ${o.model || 'default'}, effort ${o.effort}, ${formatDuration(o.durationMs)}${session}). Treat as a subagent report; verify before relying on it.`
  const cutIt = o.finalMessage.length > o.maxResultChars
  let out = head + '\n\n' + (cutIt ? o.finalMessage.slice(0, o.maxResultChars) : o.finalMessage)
  if (cutIt) {
    out += `\n[balancer] Report cut at ${o.maxResultChars} characters.` +
      (o.fullTextPath ? ` Full text: ${o.fullTextPath}` : '')
  }
  if (o.sandbox === 'workspace-write' && o.gitStatus) {
    out += '\n\nChanged or untracked files (git status):\n' + o.gitStatus.slice(0, GIT_LINES_MAX).map(l => l.replace(/\t.*$/, '')).join('\n')
    if (o.gitStatus.length > GIT_LINES_MAX) out += `\n… and ${o.gitStatus.length - GIT_LINES_MAX} more`
  }
  return out
}

export const PARTIAL_MAX_CHARS = 4000
const cutPartial = (t: string) => (t.length > PARTIAL_MAX_CHARS ? t.slice(0, PARTIAL_MAX_CHARS) + '\n[cut]' : t)

/** Codex's last message from a run that stopped, labelled for Claude: to be checked, not believed. */
export function partialBlock(reason: string, text: string): string {
  return `[balancer] A previous attempt at this task on Codex stopped (${reason}). Its partial notes follow. ` +
    `They are unverified: verify them before relying on them.\n\n${cutPartial(text)}`
}

export function buildFailureText(o: {
  reason: string; changedFiles: string[] | null; sandbox: Sandbox
  patchPath?: string; untracked?: string[]; partial?: { text: string; path?: string }; resumeThreadId?: string
}): string {
  let out: string
  if (o.changedFiles && o.changedFiles.length > 0) {
    out = `Codex stopped before finishing (${o.reason}). Files changed so far: ${o.changedFiles.join(', ')}. ` +
      'Do not re-run the whole task from the top: inspect those files and decide how to continue.'
    if (o.patchPath) out += ` The diff of the tracked changes is saved in ${o.patchPath}.`
    if (o.untracked && o.untracked.length > 0) {
      out += ` Untracked files (a diff does not hold them, they are still on disk): ${o.untracked.join(', ')}.`
    }
  } else if (o.changedFiles === null) out = `Codex could not run the task (${o.reason}). Balancer could not check for changed files.`
  else out = `Codex could not run the task (${o.reason}). No files were changed.`
  if (o.partial) {
    out += `\n\nCodex's last message before it stopped${o.partial.path ? ` (saved in ${o.partial.path})` : ''}, unverified:\n${cutPartial(o.partial.text)}`
  }
  if (o.resumeThreadId) {
    out += `\n\nCodex session ${o.resumeThreadId}. After the limit resets, \`codex exec resume ${o.resumeThreadId}\` continues it (Balancer does not run this).`
  }
  return out
}

// ---------- records ----------

type AgentResult = BuiltinToolResults['Agent']
type Completed = Extract<AgentResult, { status: 'completed' }>
type AsyncLaunched = Extract<AgentResult, { status: 'async_launched' }>

export function completedRecord(o: {
  agentId: string; text: string; prompt: string; durationMs: number; agentType?: string
}): Completed {
  return {
    status: 'completed',
    agentId: o.agentId,
    ...(o.agentType !== undefined ? { agentType: o.agentType } : {}),
    content: [{ type: 'text', text: o.text }],
    totalToolUseCount: 0,
    totalDurationMs: o.durationMs,
    totalTokens: 0,
    usage: {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null,
      server_tool_use: null, service_tier: null, cache_creation: null,
    },
    prompt: o.prompt,
  }
}

export function asyncLaunchedRecord(o: {
  agentId: string; description: string; prompt: string; outputFile: string
}): AsyncLaunched {
  return {
    status: 'async_launched', agentId: o.agentId, description: o.description, prompt: o.prompt,
    outputFile: o.outputFile, canReadOutputFile: true,
  }
}

export function taskStopRecord(o: { taskId: string; description: string }): BuiltinToolResults['TaskStop'] {
  return {
    message: `Successfully stopped task: ${o.taskId} (${o.description})`,
    task_id: o.taskId,
    task_type: 'codex',
    command: o.description,
  }
}

export function newAgentId(): string {
  return 'codex-' + crypto.randomUUID()
}
