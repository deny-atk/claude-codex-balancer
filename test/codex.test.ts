import { test, expect } from 'claude-code/testing'
import {
  PREAMBLE, parseEffortMap, effortFor, sandboxFor, buildCodexArgv, createEventParser, runCodex,
  gitSnapshot, changedSince, formatDuration, buildReport, buildFailureText,
  completedRecord, asyncLaunchedRecord, taskStopRecord, newAgentId,
} from '../hooks/codex'

const sleep = (ms: number) => new Promise<void>(r => (globalThis as any).setTimeout(r, ms))


// The kit's `$` only answers calls the hooks module's scan lists, and this module is not wired yet,
// so the tests hand the module a small `$` of their own (as readings.test.ts does). Stubs are plain
// async generators: leaving the loop runs their `finally`, which stands for the killed child.
type SpawnFn = (req: any) => AsyncGenerator<any, any>
type RunFn = (argv: readonly string[], init?: any) => any
const fake$ = (spawn?: SpawnFn, run?: RunFn): any => ({
  clock: { now: async () => Date.now() },
  process: { spawn: spawn ?? (() => { throw new Error('no spawn stub') }), run: run ?? (async () => { throw new Error('no run stub') }) },
})

const THREAD = '01a1c5d7-d102-7d01-97b9-d84f9cb2db36'
const STREAM = [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'pong' } },
  { type: 'turn.completed', usage: { input_tokens: 24639, cached_input_tokens: 0, output_tokens: 5 } },
].map(e => JSON.stringify(e)).join('\n') + '\n'

// cut the text at awkward places: mid-line, and two lines in one piece
const cut = (s: string, n: number) => { const out: string[] = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out }

const ARGS = { cwd: '/w', sandbox: 'workspace-write' as const, effort: 'high', outFile: '/tmp/o.txt', prompt: 'do it' }

// ---------- argv ----------

test('argv: sandbox rules', () => {
  expect(sandboxFor('Explore', false)).toBe('read-only')
  expect(sandboxFor('general-purpose', true)).toBe('read-only')
  expect(sandboxFor(undefined, false)).toBe('workspace-write')
  expect(sandboxFor('general-purpose', false)).toBe('workspace-write')
})

test('argv: effort map', () => {
  const m = parseEffortMap('haiku=low, sonnet=medium,opus=high,default=xhigh,junk')
  expect(m).toEqual({ haiku: 'low', sonnet: 'medium', opus: 'high', default: 'xhigh' })
  expect(effortFor('haiku', m)).toBe('low')
  expect(effortFor('fable', m)).toBe('xhigh')
  expect(effortFor(undefined, m)).toBe('xhigh')
  expect(effortFor('x', {})).toBe('high')
})

test('argv: exact shape, -m only when set', () => {
  const a = buildCodexArgv(ARGS)
  expect(a.input).toBeUndefined()
  expect(a.argv).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '-C', '/w', '-s', 'workspace-write',
    '-c', 'model_reasoning_effort=high', '-o', '/tmp/o.txt', PREAMBLE + '\n\ndo it',
  ])
  expect(a.argv).not.toContain('-m')
  const b = buildCodexArgv({ ...ARGS, model: 'gpt-x' })
  const i = b.argv.indexOf('-m')
  expect(b.argv[i + 1]).toBe('gpt-x')
  expect(i).toBeLessThan(b.argv.indexOf('-o'))
})

test('argv: no danger flags, large prompt goes through input', () => {
  for (const n of [0, 10, 100_000 - PREAMBLE.length - 2, 100_000, 150_000, 300_000]) {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const brief = 'é'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2)
      const full = PREAMBLE + '\n\n' + brief
      const big = new TextEncoder().encode(full).length > 100 * 1024
      const { argv, input } = buildCodexArgv({ ...ARGS, sandbox, prompt: brief })
      const joined = argv.join(' ')
      expect(joined).not.toContain('dangerously')
      expect(joined).not.toContain('danger-full-access')
      if (big) { expect(argv[argv.length - 1]).toBe('-'); expect(input).toBe(full) }
      else { expect(argv[argv.length - 1]).toBe(full); expect(input).toBeUndefined() }
    }
  }
  expect(PREAMBLE).toMatch(/delegated/i)
})

// ---------- parser ----------

test('parser: chunks cut anywhere, junk lines ignored', () => {
  for (const n of [1, 3, 7, 50, 1000]) {
    const p = createEventParser()
    p.feed('Reading additional input from stdin...\nnot json {\n')
    for (const c of cut(STREAM, n)) p.feed(c)
    p.flush()
    expect(p.state.threadId).toBe(THREAD)
    expect(p.state.finalMessage).toBe('pong')
    expect(p.state.usage?.output_tokens).toBe(5)
    expect(p.state.limitHit).toBe(false)
  }
})

test('parser: failure messages and limit', () => {
  const p = createEventParser()
  p.feed(JSON.stringify({ type: 'error', message: 'boom' }) + '\n')
  expect(p.state.failureMessage).toBe('boom')
  expect(p.state.limitHit).toBe(false)
  p.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'You hit your usage limit. Try later' } }) + '\n')
  expect(p.state.failureMessage).toMatch(/usage limit/)
  expect(p.state.limitHit).toBe(true)
})

// ---------- run ----------

type Stub = { chunks: string[]; code?: number; spawnError?: boolean; slowMs?: number; endless?: boolean }
const stubSpawn = (s: Stub, seen: { finally: boolean; req?: any }): SpawnFn =>
  async function* (e: any) {
    seen.req = e
    try {
      if (s.spawnError) throw new Error('ENOENT codex')
      for (const c of s.chunks) { if (s.slowMs) await sleep(s.slowMs); yield { stream: 'stdout', text: c } }
      while (s.endless) { await sleep(s.slowMs ?? 20); yield { stream: 'stdout', text: '{"type":"turn.started"}\n' } }
    } finally { seen.finally = true }
    return { code: s.code ?? 0, signal: null }
  }

test('dw3_run ok from chunked stream, report, record', async () => {
  const seen = { finally: false } as { finally: boolean; req?: any }
  const $ = fake$(stubSpawn({ chunks: cut(STREAM, 37) }, seen))
  const { argv, input } = buildCodexArgv(ARGS)
  const r = await runCodex($, { argv, input, cwd: '/w', timeoutMs: 5000 })
  expect(r.outcome).toBe('ok')
  expect(r.exitCode).toBe(0)
  expect(r.finalMessage).toBe('pong')
  expect(r.threadId).toBe(THREAD)
  expect(r.limitHit).toBe(false)
  expect(typeof r.durationMs).toBe('number')
  expect(seen.req.argv).toEqual(argv)
  expect(seen.req.cwd).toBe('/w')

  const rep = buildReport({ finalMessage: r.finalMessage!, effort: 'high', durationMs: 133_000, threadId: r.threadId, maxResultChars: 1000, sandbox: 'read-only' })
  expect(rep.split('\n')[0]).toBe('[balancer] Ran on Codex (effort high, 2m13s, session 01a1…). Treat as a subagent report; verify before relying on it.')
  expect(rep.split('\n')[1]).toBe('')
  expect(rep.split('\n')[2]).toBe('pong')
  expect(buildReport({ finalMessage: 'x', effort: 'low', durationMs: 45_000, maxResultChars: 10, sandbox: 'read-only' }).split('\n')[0])
    .toBe('[balancer] Ran on Codex (effort low, 45s). Treat as a subagent report; verify before relying on it.')

  const rec = completedRecord({ agentId: newAgentId(), text: rep, prompt: 'p', durationMs: 5, agentType: 'general-purpose' })
  expect(rec.status).toBe('completed')
  expect(rec.agentId).toMatch(/^codex-/)
  expect(rec.content).toEqual([{ type: 'text', text: rep }])
  expect(rec.totalToolUseCount).toBe(0)
  expect(rec.totalDurationMs).toBe(5)
  expect(rec.totalTokens).toBe(0)
  expect(rec.prompt).toBe('p')
  expect(rec.agentType).toBe('general-purpose')
  expect(rec.usage).toEqual({
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null,
    server_tool_use: null, service_tier: null, cache_creation: null,
  })
  expect(newAgentId()).not.toBe(newAgentId())
})

test('dw3_records for async launch and task stop', () => {
  expect(asyncLaunchedRecord({ agentId: 'codex-1', description: 'd', prompt: 'p', outputFile: '/o' }))
    .toEqual({ status: 'async_launched', agentId: 'codex-1', description: 'd', prompt: 'p', outputFile: '/o', canReadOutputFile: true })
  const t = taskStopRecord({ taskId: 'codex-1', description: 'd' })
  expect(t.task_id).toBe('codex-1')
  expect(typeof t.message).toBe('string')
  expect(typeof t.task_type).toBe('string')
})

test('dw5_run non-zero exit is failed', async () => {
  const $ = fake$(stubSpawn({ chunks: cut(STREAM, 40), code: 2 }, { finally: false }))
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 5000 })
  expect(r.outcome).toBe('failed')
  expect(r.exitCode).toBe(2)
})

test('dw5_run usage limit sets limitHit', async () => {
  const ev = JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit" } }) + '\n'
  const $ = fake$(stubSpawn({ chunks: [JSON.stringify({ type: 'thread.started', thread_id: 'abc' }) + '\n', ev], code: 1 }, { finally: false }))
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 5000 })
  expect(r.outcome).toBe('failed')
  expect(r.limitHit).toBe(true)
  expect(r.failureMessage).toMatch(/usage limit/)
  expect(r.threadId).toBe('abc')
})

test('dw5_run exit 0 without agent_message is failed', async () => {
  const $ = fake$(stubSpawn({ chunks: ['{"type":"turn.started"}\n'] }, { finally: false }))
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 5000 })
  expect(r.outcome).toBe('failed')
  expect(r.finalMessage).toBeUndefined()
})

test('dw5_run spawn rejection is spawn-error', async () => {
  const $ = fake$(stubSpawn({ chunks: [], spawnError: true }, { finally: false }))
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 5000 })
  expect(r.outcome).toBe('spawn-error')
  expect(r.exitCode).toBeNull()
})

test('dw5_run timeout kills the child', async () => {
  const seen = { finally: false }
  const $ = fake$(stubSpawn({ chunks: [], endless: true, slowMs: 30 }, seen))
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 200 })
  expect(r.outcome).toBe('timeout')
  await sleep(100)
  expect(seen.finally).toBe(true)
})

test('dw5_run timeout while the child is silent', async () => {
  const seen = { finally: false }
  const $ = fake$(async function* () {
    try { await sleep(3000); yield { stream: 'stdout', text: 'x' } } finally { seen.finally = true }
    return { code: 0, signal: null }
  })
  const t0 = Date.now()
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 150 })
  expect(r.outcome).toBe('timeout')
  expect(Date.now() - t0).toBeLessThan(1500)
})

test('dw6_run abort kills the child quickly', async () => {
  const seen = { finally: false }
  const $ = fake$(stubSpawn({ chunks: [], endless: true, slowMs: 30 }, seen))
  const ac = new AbortController()
  const t0 = Date.now()
  const p = runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 60_000, signal: ac.signal })
  await sleep(100)
  ac.abort()
  const r = await p
  expect(r.outcome).toBe('aborted')
  expect(Date.now() - t0).toBeLessThan(1500)
  await sleep(100)
  expect(seen.finally).toBe(true)
})

test('dw6_run already-aborted signal', async () => {
  const $ = fake$(stubSpawn({ chunks: [], endless: true, slowMs: 30 }, { finally: false }))
  const ac = new AbortController(); ac.abort()
  const r = await runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 60_000, signal: ac.signal })
  expect(r.outcome).toBe('aborted')
})

// ---------- git ----------

test('dw5_gitSnapshot and changedSince', async () => {
  let n = 0
  const $ = fake$(undefined, async (argv, init) => {
    expect(argv).toEqual(['git', 'status', '--porcelain'])
    expect(init).toEqual({ cwd: '/w' })
    return ++n === 1 ? { exitCode: 0, stdout: ' M a.py\n?? b.py\n', stderr: '' }
      : { exitCode: 128, stdout: '', stderr: 'not a git repository' }
  })
  expect(await gitSnapshot($, '/w')).toEqual([' M a.py', '?? b.py'])
  expect(await gitSnapshot($, '/w')).toBeNull()
  expect(changedSince([' M a.py'], [' M a.py', '?? b.py'])).toEqual(['?? b.py'])
  expect(changedSince(null, ['x'])).toBeNull()
  expect(changedSince(['x'], null)).toBeNull()
  expect(changedSince([], [])).toEqual([])
})

test('dw5_buildFailureText with and without changed files', () => {
  const a = buildFailureText({ reason: 'limit reached', changedFiles: ['?? a.py', ' M b.py'], sandbox: 'workspace-write' })
  expect(a).toContain('Codex stopped before finishing (limit reached). Files changed so far: ')
  expect(a).toContain('a.py')
  expect(a).toContain('b.py')
  expect(a).toMatch(/not re-?run|do not (re-?run|start over)/i)
  const b = buildFailureText({ reason: 'timeout', changedFiles: [], sandbox: 'workspace-write' })
  expect(b).toContain('Codex could not run the task (timeout)')
  expect(b).toMatch(/no files were changed/i)
  expect(buildFailureText({ reason: 'x', changedFiles: null, sandbox: 'read-only' })).toContain('could not run')
})

test('dw5_buildFailureText does not claim no files changed when git cannot tell', () => {
  const t = buildFailureText({ reason: 'exit 1', changedFiles: null, sandbox: 'workspace-write' })
  expect(t).toContain('could not check for changed files')
  expect(t).not.toMatch(/no files were changed/i)
})

// ---------- report ----------

test('report: cap with note and path; git status limited to 50', () => {
  const long = 'a'.repeat(500)
  const r = buildReport({ finalMessage: long, effort: 'high', durationMs: 1000, maxResultChars: 100, fullTextPath: '/tmp/full.txt', sandbox: 'read-only' })
  const lines = r.split('\n')
  expect(lines[2]).toBe('a'.repeat(100))
  expect(r).not.toContain('a'.repeat(101))
  expect(r).toMatch(/cut/i)
  expect(r).toContain('/tmp/full.txt')

  const uncut = buildReport({ finalMessage: 'short', effort: 'high', durationMs: 1000, maxResultChars: 100, fullTextPath: '/tmp/full.txt', sandbox: 'read-only' })
  expect(uncut).not.toContain('/tmp/full.txt')

  const st = Array.from({ length: 80 }, (_, i) => `?? f${i}.txt`)
  const w = buildReport({ finalMessage: 'done', effort: 'high', durationMs: 1000, maxResultChars: 100, gitStatus: st, sandbox: 'workspace-write' })
  expect(w).toContain('git status --porcelain:')
  expect(w).toContain('f49.txt')
  expect(w).not.toContain('f50.txt')
  const ro = buildReport({ finalMessage: 'done', effort: 'high', durationMs: 1000, maxResultChars: 100, gitStatus: st, sandbox: 'read-only' })
  expect(ro).not.toContain('git status')
  const nul = buildReport({ finalMessage: 'done', effort: 'high', durationMs: 1000, maxResultChars: 100, gitStatus: null, sandbox: 'workspace-write' })
  expect(nul).not.toContain('git status')
})

test('formatDuration', () => {
  expect(formatDuration(133_000)).toBe('2m13s')
  expect(formatDuration(45_000)).toBe('45s')
  expect(formatDuration(0)).toBe('0s')
  expect(formatDuration(60_000)).toBe('1m0s')
})
