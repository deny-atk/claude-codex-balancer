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
    try { await sleep(600); yield { stream: 'stdout', text: 'x' } } finally { seen.finally = true }
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

test('dw6_run resolves only after the child cleanup finished', async () => {
  const seen = { cleaned: false }
  const $ = fake$(async function* () {
    try { for (;;) { await sleep(20); yield { stream: 'stdout', text: '{"type":"turn.started"}\n' } } }
    finally { await sleep(300); seen.cleaned = true }
    return { code: 0, signal: null }
  })
  const ac = new AbortController()
  const p = runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 60_000, signal: ac.signal })
  await sleep(100)
  ac.abort()
  const r = await p
  expect(r.outcome).toBe('aborted')
  expect(seen.cleaned).toBe(true) // the reservation may be released only now
})

test('dw6_run does not hang on a cleanup that never finishes', async () => {
  const $ = fake$(async function* () {
    try { for (;;) { await sleep(20); yield { stream: 'stdout', text: '{"type":"turn.started"}\n' } } }
    finally { await new Promise<void>(() => {}) }
    return { code: 0, signal: null }
  })
  const ac = new AbortController()
  const p = runCodex($, { argv: ['codex'], cwd: '/w', timeoutMs: 60_000, signal: ac.signal, cleanupMs: 200 })
  await sleep(100)
  ac.abort()
  const t0 = Date.now()
  expect((await p).outcome).toBe('aborted')
  expect(Date.now() - t0).toBeLessThan(1500)
})

// ---------- git ----------

test('dw5_gitSnapshot hashes every listed path and changedSince compares content', async () => {
  const calls: { argv: readonly string[]; init: any }[] = []
  const status = ' M a.py\n?? b.py\nR  old.py -> new.py\n D gone.py\n?? "q\\"x.py"\n'
  const $ = fake$(undefined, async (argv, init) => {
    calls.push({ argv, init })
    if (argv[1] === 'status') return calls.filter(c => c.argv[1] === 'status').length === 1
      ? { exitCode: 0, stdout: status, stderr: '' } : { exitCode: 128, stdout: '', stderr: 'not a git repository' }
    return { exitCode: 0, stdout: argv.slice(3).map(p => `H${p.length}`).join('\n') + '\n', stderr: '' }
  })
  expect(await gitSnapshot($, '/w')).toEqual(['a.py\tH4', 'b.py\tH4', 'new.py\tH6', 'gone.py\tmissing', 'q"x.py\tH6'])
  expect(calls[0]!.argv).toEqual(['git', 'status', '--porcelain', '--untracked-files=all'])
  expect(calls[0]!.init).toEqual({ cwd: '/w' })
  expect(calls[1]!.argv).toEqual(['git', 'hash-object', '--', 'a.py', 'b.py', 'new.py', 'q"x.py']) // the deleted path is not hashed
  expect(calls[1]!.init).toEqual({ cwd: '/w' })
  expect(await gitSnapshot($, '/w')).toBeNull()
})

test('dw5_gitSnapshot with nothing listed runs no hash and a failed hash marks the path missing', async () => {
  const runs: string[][] = []
  const $ = fake$(undefined, async (argv) => {
    runs.push([...argv])
    if (argv[1] === 'status') return { exitCode: 0, stdout: runs.length === 1 ? '' : '?? ok.py\n?? dir\n', stderr: '' }
    const paths = argv.slice(3)
    return paths.includes('dir') ? { exitCode: 128, stdout: '', stderr: 'fatal' } : { exitCode: 0, stdout: 'HH\n', stderr: '' }
  })
  expect(await gitSnapshot($, '/w')).toEqual([])
  expect(runs).toHaveLength(1)
  expect(await gitSnapshot($, '/w')).toEqual(['ok.py\tHH', 'dir\tmissing']) // batch failed, then one path at a time
})

test('dw5_changedSince reports new, edited and vanished paths as plain paths', () => {
  expect(changedSince(['a.py\t1', 'b.py\t1'], ['a.py\t2', 'b.py\t1', 'c.py\t1'])).toEqual(['a.py', 'c.py'])
  expect(changedSince(['a.py\t1'], [])).toEqual(['a.py']) // a dirty file that was reverted
  expect(changedSince(['a.py\t1', 'b.py\t2'], ['b.py\t2', 'a.py\t1'])).toEqual([])
  expect(changedSince(null, ['x\t1'])).toBeNull()
  expect(changedSince(['x\t1'], null)).toBeNull()
  expect(changedSince([], [])).toEqual([])
})

test('dw5_buildFailureText with and without changed files', () => {
  const a = buildFailureText({ reason: 'limit reached', changedFiles: ['a.py', 'b.py'], sandbox: 'workspace-write' })
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

  const st = Array.from({ length: 80 }, (_, i) => `f${i}.txt\tH${i}`)
  const w = buildReport({ finalMessage: 'done', effort: 'high', durationMs: 1000, maxResultChars: 100, gitStatus: st, sandbox: 'workspace-write' })
  expect(w).toContain('Changed or untracked files (git status):')
  expect(w).toContain('f49.txt')
  expect(w).not.toContain('\tH') // the hashes stay out of the report
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

test('dw5_buildFailureText carries patch, untracked files, partial notes and the resume hint', () => {
  const t = buildFailureText({
    reason: 'limit reached', changedFiles: ['a.py', 'new.py'], sandbox: 'workspace-write',
    patchPath: '/d/x.patch', untracked: ['new.py'], partial: { text: 'NOTES', path: '/d/x.partial.txt' }, resumeThreadId: 'thr-1',
  })
  expect(t).toContain('/d/x.patch')
  expect(t).toMatch(/untracked.*new\.py/i)
  expect(t).toContain('NOTES')
  expect(t).toContain('/d/x.partial.txt')
  expect(t.trimEnd()).toMatch(/thr-1.*codex exec resume thr-1.*$/s)
  const bare = buildFailureText({ reason: 'x', changedFiles: [], sandbox: 'workspace-write', partial: { text: 'N'.repeat(5000), path: '/p' } })
  expect(bare).toContain('N'.repeat(4000))
  expect(bare).not.toContain('N'.repeat(4001))
  expect(bare).toContain('No files were changed')
  expect(buildFailureText({ reason: 'x', changedFiles: null, sandbox: 'workspace-write' })).not.toContain('resume')
})
