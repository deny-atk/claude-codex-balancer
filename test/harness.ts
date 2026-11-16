// Shared stubs for the register-level tests: a fake machine beneath the plugin.
// The kit's `$` has no host, so every op the plugin calls is answered here with hooks of the test's own `on`.
// The store and file system are plain maps so a test can seed them and read them back
// (`mock.store` has no read-back).
import { mock } from 'claude-code/testing'
import { rolloutDayDirs } from '../hooks/readings'
import { cutRecord, lines, rl, tokenCount } from './fixtures/rollout'

export const NOW = 1_790_000_000_000
export const H = 3_600_000
export const D = 24 * H
export const CWD = '/proj'
export const SID = 'sess-1'
export const HOME = '/home/t'
export const CFG = '/cfg'
export const DATA = `${CFG}/plugins/data/balancer`
export const THREAD = '01a1c5d7-d102-7d01-97b9-d84f9cb2db36'
export const CLAUDE_MARK = { status: 'claude-ran' }
export const CODEX_TEXT = 'CODEX-ANSWER-42'

export type Script = 'ok' | 'fail' | 'limit' | 'missing' | 'hang' | 'gate'

export type World = {
  store: Map<string, unknown>
  files: Map<string, string>
  writes: string[]
  toasts: string[]
  submits: string[]
  agentCalls: any[]
  agentSpawns: any[] // every agent.spawn input that reached the bottom
  agentSpawnDeny?: string // when set, agent.spawn answers { deny }
  agentSpawnThrow?: string // when set, agent.spawn throws this message
  claudeDuring?: () => void // runs when the stubbed Claude Agent call starts
  claudeResult: any
  runEntries?: any[]
  processCalls: string[][]
  stopCalls: any[]
  spawns: { argv: readonly string[]; cwd?: string }[]
  spawnFinally: number
  script: Script
  finalText: string
  failMessage: string // message of the stub's turn.failed event
  cwdExists: boolean
  root: string // what $.session.root() answers; CWD unless a test moves the cwd under another project root
  loggedIn: boolean
  loginThrows: boolean // `codex login status` cannot even start (binary missing)
  tracked: Set<string> // paths `git ls-files` knows
  diff: string // stdout of `git diff HEAD -- ...`
  partial?: string // an agent_message the stub emits before a failure or limit
  gitCalls: string[][] // every git argv
  gitCwds: (string | undefined)[] // cwd of each entry of gitCalls
  cwd: string // what $.session.cwd() answers
  toplevel: string | null // what `git rev-parse --show-toplevel` answers; null = not a repository
  commonDir: string // what `--git-common-dir` answers
  dirs: Set<string> // extra existing folders for $.fs.stat
  fileStats: Set<string> // paths $.fs.stat reports as regular files
  work: Map<string, string> // file contents the stubbed `git hash-object` hashes, by path
  during?: () => void // runs when a Codex process starts: a test edits `work` here
  gate: Promise<void> // script 'gate': the run finishes once this resolves
  openGate: () => void
  git: (string | null)[] // successive `git status --porcelain --untracked-files=all` stdouts; null = not a repository
  rollout: string | null // tail of the rollout file for THREAD
  usage: { kind: string; percentUsed: number; resetsAt?: string }[]
  loginChecks: number
  failWrites: boolean
  failStoreWrites: boolean
  statuses: (string | undefined)[] // every $.ui.status call, in order
  contexts: (readonly string[] | undefined)[] // `context` of each prompt.submit that reached the bottom
  state: Map<string, { value: unknown; version: number }> // $.state, keyed plugin/key/id
  modelCalls: string[] // model.complete / classify / fork that reached the bottom: the mod must make none
  toolOps: string[] // tool.register / tool.list that reached the bottom
  compose: number // prompt.compose calls that reached the bottom
  commands: string[] // command.register names
  clock: { advance: (ms: number) => Promise<void> }
}

export const SECTIONS = [{ id: 'core:one', text: 'ONE', scope: 'shared' }, { id: 'core:two', text: 'TWO', scope: 'session' }]

type Rd = { fiveUsed: number; fiveLeft?: number; sevenUsed: number; sevenLeft?: number; readAt?: number; limit?: boolean }
export const reading = (r: Rd) => ({
  fiveHour: { used: r.fiveUsed, resetsAt: NOW + (r.fiveLeft ?? 5 * H), lengthMs: 5 * H },
  sevenDay: { used: r.sevenUsed, resetsAt: NOW + (r.sevenLeft ?? 7 * D), lengthMs: 7 * D },
  readAt: r.readAt ?? NOW,
  limitReached: r.limit ?? false,
})

/** Claude clearly behind (little left, much time to go), Codex clearly ahead: auto routes to Codex. */
export const CODEX_AHEAD = {
  'reading/claude': reading({ fiveUsed: 80, fiveLeft: 2 * H, sevenUsed: 80, sevenLeft: 2 * D }),
  'reading/codex': reading({ fiveUsed: 5, fiveLeft: 4 * H, sevenUsed: 5, sevenLeft: 5 * D }),
}
/** PRD 7.4: Codex 60% with the whole window left, Claude scores 27 after one task. */
export const PRD_74 = {
  'reading/claude': reading({ fiveUsed: 72, sevenUsed: 10 }),
  'reading/codex': reading({ fiveUsed: 60, sevenUsed: 10 }),
  'estimate/Explore': { fiveHour: 5, sevenDay: 0.5 },
}

export const rolloutFor = (fiveUsed: number) =>
  lines(cutRecord, tokenCount(rl(
    { used_percent: fiveUsed, window_minutes: 300, resets_at: (NOW + 4 * H) / 1000 },
    { used_percent: 20, window_minutes: 10080, resets_at: (NOW + 5 * D) / 1000 },
  )))

export function world(on: any, seed: Record<string, unknown> = {}, over: Partial<World> = {}): World {
  const w: World = {
    store: new Map(Object.entries(seed)), files: new Map(), writes: [], toasts: [], submits: [], agentCalls: [], agentSpawns: [], stopCalls: [],
    claudeResult: CLAUDE_MARK, processCalls: [], spawns: [], spawnFinally: 0, script: 'ok', finalText: CODEX_TEXT, failMessage: 'boom', cwdExists: true, root: CWD, loggedIn: true, loginThrows: false, work: new Map(), tracked: new Set(), diff: '', gitCalls: [], gitCwds: [], cwd: CWD, toplevel: CWD, commonDir: `${CWD}/.git`, dirs: new Set(), fileStats: new Set(),
    gate: undefined as any, openGate: () => {},
    git: [''], rollout: null, usage: [], loginChecks: 0, failWrites: false, failStoreWrites: false,
    statuses: [], contexts: [], state: new Map(), modelCalls: [], toolOps: [], compose: 0, commands: [], clock: undefined as any, ...over,
  }
  w.gate = new Promise<void>(r => { w.openGate = r })
  w.clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: CFG })

  on('session.cwd', () => ({ value: w.cwd }))
  on('session.root', () => ({ value: w.root }))
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({ value: { rateLimits: w.usage } }))

  on('store.get', (_$: any, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { if (w.failStoreWrites) throw new Error('store failed'); w.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { w.store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...w.store.keys()] }))

  on('fs.stat', (_$: any, e: any) => {
    if (e.path === w.cwd && w.cwdExists) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    if (w.dirs.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    if (w.fileStats.has(e.path)) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('fs.read', (_$: any, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_$: any, e: any) => { if (w.failWrites) throw new Error('disk full'); w.files.set(e.path, e.text); w.writes.push(e.path); return { value: undefined } })
  on('fs.list', (_$: any, e: any) => {
    if (e.path === `${DATA}/runs` && w.runEntries) return { value: w.runEntries }
    const day = rolloutDayDirs(HOME, NOW)
    if (w.rollout !== null && day.includes(e.path)) {
      return { value: e.path === day[0] ? [{ name: `rollout-x-${THREAD}.jsonl`, kind: 'file', size: 1, mtimeMs: NOW, isLink: false }] : [] }
    }
    throw new Error('ENOENT')
  })

  on('process.run', (_$: any, e: any) => {
    const [a, b] = e.argv as string[]
    w.processCalls.push([...e.argv])
    if (a === 'rm') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (a === 'codex' && b === 'login') { w.loginChecks++; if (w.loginThrows) throw new Error('spawn codex ENOENT'); return { value: { exitCode: w.loggedIn ? 0 : 1, stdout: '', stderr: '' } } }
    if (a === 'git' && b === 'rev-parse') {
      return { value: w.toplevel === null ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : { exitCode: 0, stdout: `${w.toplevel}\n${w.commonDir}\n`, stderr: '' } }
    }
    if (a === 'git') { w.gitCalls.push([...(e.argv as string[])]); w.gitCwds.push(e.init?.cwd) }
    if (a === 'git' && b === 'ls-files') {
      const paths = (e.argv as string[]).slice((e.argv as string[]).indexOf('--') + 1)
      return { value: { exitCode: 0, stdout: paths.filter(p => w.tracked.has(p)).map(p => p + '\0').join(''), stderr: '' } }
    }
    if (a === 'git' && b === 'diff') return { value: { exitCode: 0, stdout: w.diff, stderr: '' } }
    if (a === 'git' && b === 'hash-object') {
      const paths = (e.argv as string[]).slice((e.argv as string[]).indexOf('--') + 1)
      return { value: { exitCode: 0, stdout: paths.map(p => 'h:' + (w.work.get(p) ?? '')).join('\n') + '\n', stderr: '' } }
    }
    if (a === 'git') {
      const out = w.git.length > 1 ? w.git.shift()! : w.git[0]!
      return { value: { exitCode: out === null ? 128 : 0, stdout: out ?? '', stderr: '' } }
    }
    if (a === 'tail') return { value: { exitCode: w.rollout === null ? 1 : 0, stdout: w.rollout ?? '', stderr: '' } }
    if (a === 'sh') return { value: { exitCode: 1, stdout: '', stderr: '' } } // app server: no answer
    throw new Error('unexpected process.run ' + String(a))
  })

  on('process.spawn', async function* (_$: any, e: any, next: any) {
    w.spawns.push({ argv: e.argv, cwd: e.cwd })
    w.during?.()
    if (w.script === 'missing') throw new Error('spawn codex ENOENT')
    const ev = (o: unknown) => ({ stream: 'stdout', text: JSON.stringify(o) + '\n' })
    let code = 0
    try {
      yield ev({ type: 'thread.started', thread_id: THREAD })
      if (w.script === 'hang') await new Promise<void>(res => next.signal.addEventListener('abort', () => res(), { once: true }))
      else if (w.script === 'ok' || w.script === 'gate') {
        if (w.script === 'gate') await w.gate
        yield ev({ type: 'item.completed', item: { type: 'agent_message', text: w.finalText } })
        yield ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
      } else if (w.script === 'limit') { if (w.partial) yield ev({ type: 'item.completed', item: { type: 'agent_message', text: w.partial } }); yield ev({ type: 'error', message: 'You have hit your usage limit' }); code = 1 }
      else { if (w.partial) yield ev({ type: 'item.completed', item: { type: 'agent_message', text: w.partial } }); yield ev({ type: 'turn.failed', error: { message: w.failMessage } }); code = 1 }
    } finally {
      w.spawnFinally++
    }
    return { value: { code, signal: null } }
  })

  on('ui.toast', (_$: any, e: any) => { w.toasts.push(e.text); return { value: undefined } })
  on('command.register', (_$: any, e: any) => { w.commands.push(e.name); return { value: { command: e.name } } })
  on('ui.status', (_$: any, e: any) => { w.statuses.push(e.text); return { value: undefined } })
  const sk = (e: any) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$: any, e: any) => ({ value: w.state.get(sk(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$: any, e: any) => {
    const version = (w.state.get(sk(e))?.version ?? 0) + 1
    w.state.set(sk(e), { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  for (const n of ['model.complete', 'model.classify', 'model.fork'] as const) on(n, () => { w.modelCalls.push(n); throw new Error('model call') })
  on('tool.register', (_$: any, e: any) => { w.toolOps.push(`register ${e.name}`); return { value: { name: e.name } } })
  on('tool.list', () => { w.toolOps.push('list'); return { value: [] } })
  on('prompt.compose', () => { w.compose++; return { sections: SECTIONS } })
  on('prompt.submit', (_$: any, e: any) => { w.submits.push(e.text); w.contexts.push(e.context); return { text: e.text, ...(e.context ? { context: e.context } : {}) } })
  on('session.compact', (_$: any, e: any) => ({ messages: e.messages }))
  on('tool.call', { tool: 'Agent' }, (_$: any, e: any) => { w.agentCalls.push(e); w.claudeDuring?.(); if (w.claudeResult instanceof Error) throw w.claudeResult; return { result: w.claudeResult } })
  // The kit cannot mint a spawned agent's id (core sets it), so a success is driven in test/blocked.test.ts; this answers deny and throw.
  on('agent.spawn', (_$: any, e: any) => {
    w.agentSpawns.push(e)
    if (w.agentSpawnThrow !== undefined) throw new Error(w.agentSpawnThrow)
    return w.agentSpawnDeny !== undefined ? { deny: w.agentSpawnDeny } : { model: 'sonnet', agentId: 'redo-1' }
  })
  on('turn.complete', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', { tool: 'TaskStop' }, (_$: any, e: any) => { w.stopCalls.push(e); return { result: { message: 'claude-stop', task_id: e.task_id, task_type: 'x' } } })
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  return w
}

export const agent = (over: Record<string, unknown> = {}) => ({
  tool: 'Agent', prompt: 'PROMPT-SECRET-77 look around', description: 'DESC-SECRET-88',
  subagent_type: 'Explore', run_in_background: false, ...over,
})

export const startSession = ($: any) => $.session.start({ source: 'startup', cwd: CWD })

/** Lets detached work (a background run, a voided refresh) finish: a few turns of the event loop. */
export const settleReal = async (until: () => boolean = () => false, ms = 1000) => {
  const t0 = Date.now()
  while (!until() && Date.now() - t0 < ms) await new Promise<void>(r => (globalThis as any).setTimeout(r, 5))
}

export const inflightKeys = (w: World) => [...w.store.keys()].filter(k => k.startsWith('inflight/'))
export const logLines = (w: World): any[] =>
  (w.files.get(`${DATA}/decisions.jsonl`) ?? '').split('\n').filter(l => l).map(l => JSON.parse(l))

const iso = (t: number) => new Date(t).toISOString()
/** Raises session.measure with live Claude windows at `five` and `seven` percent used, full windows ahead. */
/** `later` moves both resets on: a later window, where usage may be lower (within one window it only rises). */
export const measure = async ($: any, w: World, five: number, seven: number, later = 0) => {
  await w.clock.advance(60_000) // a measure at the same instant as the stored reading would lose the tie
  return $.session.measure({
    context: {}, changed: ['rateLimits'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: five, resetsAt: iso(NOW + 5 * H + later) },
      { kind: 'seven_day', percentUsed: seven, resetsAt: iso(NOW + 7 * D + later) },
    ],
  })
}
/** Codex at 0% with full windows: Claude at u% used then has gap u. */
export const CODEX_IDLE = { 'reading/codex': reading({ fiveUsed: 0, sevenUsed: 0 }) }
