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

export type Script = 'ok' | 'fail' | 'limit' | 'missing' | 'hang'

export type World = {
  store: Map<string, unknown>
  files: Map<string, string>
  writes: string[]
  toasts: string[]
  submits: string[]
  agentCalls: any[]
  stopCalls: any[]
  spawns: { argv: readonly string[]; cwd?: string }[]
  spawnFinally: number
  script: Script
  finalText: string
  cwdExists: boolean
  loggedIn: boolean
  git: (string | null)[] // successive `git status --porcelain` stdouts; null = not a repository
  rollout: string | null // tail of the rollout file for THREAD
  usage: { kind: string; percentUsed: number; resetsAt?: string }[]
  loginChecks: number
  failWrites: boolean
}

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
    store: new Map(Object.entries(seed)), files: new Map(), writes: [], toasts: [], submits: [], agentCalls: [], stopCalls: [],
    spawns: [], spawnFinally: 0, script: 'ok', finalText: CODEX_TEXT, cwdExists: true, loggedIn: true,
    git: [''], rollout: null, usage: [], loginChecks: 0, failWrites: false, ...over,
  }
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: CFG })

  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({ value: { rateLimits: w.usage } }))

  on('store.get', (_$: any, e: any) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { w.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { w.store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...w.store.keys()] }))

  on('fs.stat', (_$: any, e: any) => {
    if (e.path === CWD && w.cwdExists) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('fs.read', (_$: any, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_$: any, e: any) => { if (w.failWrites) throw new Error('disk full'); w.files.set(e.path, e.text); w.writes.push(e.path); return { value: undefined } })
  on('fs.list', (_$: any, e: any) => {
    const day = rolloutDayDirs(HOME, NOW)
    if (w.rollout !== null && day.includes(e.path)) {
      return { value: e.path === day[0] ? [{ name: `rollout-x-${THREAD}.jsonl`, kind: 'file', size: 1, mtimeMs: NOW, isLink: false }] : [] }
    }
    throw new Error('ENOENT')
  })

  on('process.run', (_$: any, e: any) => {
    const [a, b] = e.argv as string[]
    if (a === 'codex' && b === 'login') { w.loginChecks++; return { value: { exitCode: w.loggedIn ? 0 : 1, stdout: '', stderr: '' } } }
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
    if (w.script === 'missing') throw new Error('spawn codex ENOENT')
    const ev = (o: unknown) => ({ stream: 'stdout', text: JSON.stringify(o) + '\n' })
    let code = 0
    try {
      yield ev({ type: 'thread.started', thread_id: THREAD })
      if (w.script === 'hang') await new Promise<void>(res => next.signal.addEventListener('abort', () => res(), { once: true }))
      else if (w.script === 'ok') {
        yield ev({ type: 'item.completed', item: { type: 'agent_message', text: w.finalText } })
        yield ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
      } else if (w.script === 'limit') { yield ev({ type: 'error', message: 'You have hit your usage limit' }); code = 1 }
      else { yield ev({ type: 'turn.failed', error: { message: 'boom' } }); code = 1 }
    } finally {
      w.spawnFinally++
    }
    return { value: { code, signal: null } }
  })

  on('ui.toast', (_$: any, e: any) => { w.toasts.push(e.text); return { value: undefined } })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$: any, e: any) => { w.submits.push(e.text); return { text: e.text } })
  on('tool.call', { tool: 'Agent' }, (_$: any, e: any) => { w.agentCalls.push(e); return { result: CLAUDE_MARK } })
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
