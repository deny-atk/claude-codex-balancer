// A Codex run that ends its turn saying it could not do the work is `blocked`: redone once on Claude.
import { test, expect } from 'claude-code/testing'
import * as codex from '../hooks/codex'
import { formatBalance } from '../hooks/balance'
import { createState, onAgent, onTurnComplete, readOptions } from '../hooks/dispatch'
import {
  CODEX_AHEAD, CODEX_IDLE, NOW, agent, inflightKeys, logLines, rolloutFor, settleReal, world,
} from './harness'

const NOTES = 'BLOCKED: sandbox refused the write\nI read the module and drafted the change.'
const claudeKeys = (w: { store: Map<string, unknown> }) => [...w.store.keys()].filter(k => k.startsWith('claude-inflight/'))
const bg = (over: Record<string, unknown> = {}) => agent({ run_in_background: undefined, ...over })
const done = (id: string, over: Record<string, unknown> = {}) =>
  ({ agentId: id, reason: 'answer', answer: 'REDO-ANSWER', text: '', isAborted: false, durationMs: 1, turnId: 't', ...over })

// ---------- dw31: detection ----------

const BLOCKED: [string, string][] = [
  ['blocked_prefix', 'BLOCKED: sandbox refused the write'],
  ['status_line_2_bold', '# Report\n**Status:** blocked (could not write the lock file)\nDetails follow.'],
  ['status_dash_bullet', '- Status — blocked'],
]
const NOT_BLOCKED: [string, string][] = [
  ['completed_with_blocked_test', 'Status: completed; one test was blocked by a flaky fixture'],
  ['blocked_in_line_3_prose', 'Done.\nI changed two files.\nThe request was blocked by a proxy, so I retried.'],
  ['status_blocked_only_on_line_8', 'Status: completed\n2\n3\n4\n5\n6\n7\nStatus: blocked'],
  ['unblocked_prefix', 'Unblocked: the fixture now loads'],
  ['empty', ''],
]
for (const [id, text] of BLOCKED) test(`dw31_is_blocked_${id}`, () => expect(codex.isBlocked(text)).toBe(true))
for (const [id, text] of NOT_BLOCKED) test(`dw31_is_not_blocked_${id}`, () => expect(codex.isBlocked(text)).toBe(false))

test('dw31_five_nonempty_lines_and_first_line_prefix_boundaries', () => {
  expect(codex.isBlocked('one\n\ntwo\nthree\n\nfour\nStatus: blocked')).toBe(true)
  expect(codex.isBlocked('one\ntwo\nthree\nfour\nfive\nStatus: blocked')).toBe(false)
  expect(codex.isBlocked('one\nBLOCKED: x')).toBe(false)
})

test('dw31_preamble_asks_for_a_blocked_first_line', () => {
  expect(codex.PREAMBLE).toContain('make the first line of your final message `BLOCKED: <one-line reason>`')
})

test('dw31_run_outcome_is_blocked_on_exit_0_with_a_blocked_message', async () => {
  const ev = (o: unknown) => ({ stream: 'stdout', text: JSON.stringify(o) + '\n' })
  const run = (text: string) => codex.runCodex({
    clock: { now: async () => 0 },
    process: {
      spawn: async function* () {
        yield ev({ type: 'item.completed', item: { type: 'agent_message', text } })
        return { code: 0, signal: null }
      },
    },
  } as any, { argv: ['codex'], cwd: '/w', timeoutMs: 5000 })
  expect((await run('BLOCKED: no write access')).outcome).toBe('blocked')
  expect((await run('All done.')).outcome).toBe('ok')
})

// ---------- dw32: logging ----------

test('dw32_blocked_entry_has_outcome_and_redo_entry_copies_the_numbers', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await $.tool.call(agent() as any)
  const [first, redo] = logLines(w)
  expect(first).toMatchObject({ route: 'codex', reason: 'codex-ahead', outcome: 'blocked', agentType: 'Explore' })
  expect(redo).toMatchObject({ route: 'claude', reason: 'codex-blocked', agentType: 'Explore' })
  for (const k of ['claudeAfter', 'codexAfter', 'estimate']) expect(redo[k]).toEqual(first[k])
  expect(redo.outcome).toBeUndefined()
  expect(JSON.stringify(logLines(w))).not.toContain('sandbox refused')
})

test('dw32_balance_lines_append_a_non_ok_outcome', () => {
  const entry = (outcome?: string) => ({
    t: 0, session: 's', agentType: 'impl', route: 'codex', reason: 'codex-ahead', claudeAfter: 1, codexAfter: 2,
    estimate: { fiveHour: 1, sevenDay: 1 }, mode: 'auto', ...(outcome ? { outcome } : {}),
  })
  const text = (o?: string) => formatBalance({
    now: 0, mode: 'auto', modeFromCommand: false, claude: null, codex: null, codexAvailable: true, cooldownUntil: 0,
    inflight: [], recent: [entry(o) as any],
  })
  expect(text('blocked')).toContain('impl -> codex (codex-ahead), blocked')
  expect(text('ok')).toMatch(/impl -> codex \(codex-ahead\)$/)
  expect(text()).toMatch(/impl -> codex \(codex-ahead\)$/)
})

// ---------- dw33: foreground redo ----------

test('dw33_foreground_blocked_runs_next_once_unchanged_with_a_claude_reservation', async ($, on) => {
  const w = world(on, { ...CODEX_AHEAD, 'estimate/Explore': { fiveHour: 5, sevenDay: 1 } }, { finalText: NOTES, rollout: rolloutFor(15) })
  let during: { claude: string[]; codex: string[] } | undefined
  w.claudeDuring = () => { during = { claude: claudeKeys(w), codex: inflightKeys(w) } }
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(w.spawns).toHaveLength(1)
  expect(w.agentCalls).toHaveLength(1)
  expect(w.agentCalls[0].prompt).toBe('PROMPT-SECRET-77 look around') // dw38: a rewritten prompt is refused in auto mode
  expect(during!.claude).toHaveLength(1)
  expect(during!.codex).toEqual([])
  expect(claudeKeys(w)).toEqual([])
  expect(inflightKeys(w)).toEqual([])
  expect(w.store.get('estimate/Explore')).not.toEqual({ fiveHour: 5, sevenDay: 1 }) // saved after the blocked run
})

test('dw33_every_foreground_fallback_takes_a_claude_reservation', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail' })
  let seen = 0
  w.claudeDuring = () => { seen = claudeKeys(w).length }
  await $.tool.call(agent() as any)
  expect(seen).toBe(1)
  expect(claudeKeys(w)).toEqual([])
})

test('dw33_fallback_that_launches_in_the_background_keeps_its_reservation_until_turn_complete', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES, claudeResult: { status: 'async_launched', agentId: 'bg-claude' } })
  await $.tool.call(agent() as any)
  expect(claudeKeys(w)).toHaveLength(1)
  await ($ as any).turn.complete(done('bg-claude'))
  expect(claudeKeys(w)).toEqual([])
})

test('dw33_foreground_blocked_with_files_changed_returns_the_failure_text', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES, git: ['', ' M a.py'] })
  const r: any = await $.tool.call(agent({ subagent_type: 'general-purpose' }) as any)
  const text: string = r.result.content[0].text
  expect(text).toContain('Codex stopped before finishing (blocked)')
  expect(text).toContain('a.py')
  expect(w.agentCalls).toHaveLength(0)
  expect(w.agentSpawns).toHaveLength(0)
})

// ---------- dw34: background redo ----------

const launch = async ($: any, w: any, over: Record<string, unknown> = {}) => {
  const r: any = await $.tool.call(bg(over) as any)
  await settleReal(() => w.submits.length > 0 || w.agentSpawns.length > 0)
  return r.result.agentId as string
}

// The kit cannot return a spawned agent's id (core sets it), and its `$` has no engine ops to call the hooks with, so a
// successful spawn is driven by calling the hooks directly over a small hand-made `$` (as dw6 in register.test.ts does).
const driven = (completeAtSpawn = false, finalText = NOTES) => {
  const store = new Map<string, unknown>(Object.entries(CODEX_AHEAD))
  const files = new Map<string, string>()
  const toasts: string[] = []
  const submits: string[] = []
  const spawned: any[] = []
  let codexRuns = 0
  const gone = async () => { throw new Error('ENOENT') }
  const ev = (o: unknown) => ({ stream: 'stdout', text: JSON.stringify(o) + '\n' })
  const $: any = {
    session: { cwd: async () => '/proj', root: async () => '/proj', id: async () => 'sess-1', usage: async () => ({ rateLimits: [] }) },
    fs: {
      stat: async (p: string) => (p === '/proj' ? { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : gone()),
      read: async (p: string) => files.get(p) ?? gone(), write: async (p: string, t: string) => void files.set(p, t), list: gone,
    },
    store: {
      get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k), keys: async () => [...store.keys()],
    },
    clock: { now: async () => NOW },
    env: { get: async (n: string) => ({ HOME: '/home/t', CLAUDE_CONFIG_DIR: '/cfg' } as Record<string, string>)[n] },
    process: {
      run: async (argv: string[]) => ({ exitCode: argv[0] === 'codex' ? 0 : 1, stdout: '', stderr: '' }),
      spawn: async function* () {
        codexRuns++
        yield ev({ type: 'item.completed', item: { type: 'agent_message', text: finalText } })
        return { code: 0, signal: null }
      },
    },
    ui: { status: async () => {}, toast: async (t: string) => void toasts.push(t) },
    state: { set: async () => ({ isSet: true, version: 1 }) },
    prompt: { submit: async (i: { text: string }) => void submits.push(i.text) },
    agent: { spawn: async (a: any) => { spawned.push(a); if (completeAtSpawn) void onTurnComplete($, st, done('redo-1') as any, (async (e: any) => ({ text: e.text })) as any); return { model: 'sonnet', agentId: 'redo-1' } } },
  }
  const st = createState({})
  const claude = () => [...store.keys()].filter(k => k.startsWith('claude-inflight/'))
  const log = () => (files.get('/cfg/plugins/data/balancer/decisions.jsonl') ?? '').split('\n').filter(l => l).map(l => JSON.parse(l))
  return {
    spawned, st, toasts, submits, claude, log, codexRuns: () => codexRuns,
    launch: async (over: Record<string, unknown> = {}) => {
      const r: any = await onAgent($, st, bg(over) as any, (async () => ({ result: { status: 'claude-ran' } })) as any)
      await settleReal(() => toasts.length > 0 || submits.length > 0)
      return r.result.agentId as string
    },
    complete: (over: Record<string, unknown> = {}) => onTurnComplete($, st, done('redo-1', over) as any, (async (e: any) => ({ text: e.text })) as any),
  }
}

test('dw34_blocked_background_spawns_one_redo_with_the_original_fields', async () => {
  const d = driven()
  await d.launch({ model: 'opus' })
  expect(d.spawned).toEqual([{
    prompt: `PROMPT-SECRET-77 look around\n\n${codex.partialBlock('blocked', NOTES)}`,
    description: 'DESC-SECRET-88', subagentType: 'Explore', model: 'opus', cwd: '/proj', // dw39: the call's folder
  }])
  expect(d.codexRuns()).toBe(1) // Codex ran once; the redo did not go back to it
  expect(d.toasts).toContain('Balancer: Codex reported blocked, redoing the task on Claude.')
  expect(d.log().map(l => l.reason)).toEqual(['codex-ahead', 'codex-blocked'])
})

test('dw34_the_redo_has_no_model_key_when_the_call_had_none', async () => {
  const d = driven()
  await d.launch()
  expect(d.spawned).toHaveLength(1)
  expect('model' in d.spawned[0]).toBe(false)
})

test('dw34_a_redo_that_completes_before_it_is_mapped_releases_its_reservation', async () => {
  const d = driven(true)
  await d.launch()
  expect(d.claude()).toEqual([])
})

test('dw38_no_cooldown_a_reservation_through_the_redo_and_one_message_at_spawn_only', async () => {
  const d = driven()
  const codexId = await d.launch()
  expect(d.submits).toEqual([
    `[balancer] Codex reported "DESC-SECRET-88" (${codexId}) blocked, nothing was changed. Codex's reason: "sandbox refused the write". ` +
    'Balancer is redoing it once on Claude as background agent redo-1; its report will come from that agent.',
  ])
  expect(d.claude()).toHaveLength(1)
  expect(d.st.cooldownUntil).toBe(0)
  await d.complete()
  expect(d.claude()).toEqual([])
  expect(d.submits).toHaveLength(1) // the engine delivers the redo's own report; Balancer adds nothing at its end
})

for (const [id, over] of [['effort', { effort: 'high' }], ['mode', { mode: 'acceptEdits' }]] as const) {
  test(`dw39_a_call_with_${id}_is_not_redone_since_a_spawn_cannot_carry_it`, async () => {
    const d = driven()
    const codexId = await d.launch(over)
    expect(d.spawned).toEqual([])
    expect(d.claude()).toEqual([])
    expect(d.st.cooldownUntil).toBe(0)
    expect(d.submits).toHaveLength(1)
    expect(d.submits[0]).toStartWith(
      `[balancer] Codex reported "DESC-SECRET-88" (${codexId}) blocked, nothing was changed. Codex's reason: "sandbox refused the write". It was not redone on Claude ` +
      `because the call set ${id}, which a redo started by Balancer cannot carry. Delegate it again with the same description; that call will run on Claude.`,
    )
    expect(d.submits[0]).toContain(codex.partialBlock('blocked', NOTES))
    expect(d.log().map(l => l.reason)).toEqual(['codex-ahead'])
  })
}

for (const [id, over, why] of [['deny', { agentSpawnDeny: 'no agents' }, 'no agents'], ['throw', { agentSpawnThrow: 'boom' }, undefined]] as const) {
  test(`dw34_redo_that_cannot_start_${id}_releases_and_tells_the_model`, async ($, on) => {
    const w = world(on, CODEX_AHEAD, { finalText: NOTES, ...over })
    const codexId = await launch($, w)
    expect(claudeKeys(w)).toEqual([])
    expect(w.submits).toHaveLength(1)
    const head = `[balancer] Codex reported "DESC-SECRET-88" (${codexId}) blocked, nothing was changed, and the Claude redo could not start (`
    const tail = `). Codex's reason: "sandbox refused the write". Delegate it again with the same description; that call will run on Claude.\n\n${codex.partialBlock('blocked', NOTES)}`
    expect(w.submits[0]!.startsWith(head) && w.submits[0]!.endsWith(tail)).toBe(true)
    if (why) expect(w.submits[0]).toBe(head + why + tail)
    expect(logLines(w).map(l => l.reason)).toEqual(['codex-ahead'])
    w.finalText = 'fine'
    const r2: any = await $.tool.call(agent({ description: 'another task', prompt: 'another brief' }) as any) // dw49: the same call would be a repeat
    expect(r2.result.status).toBe('completed') // no cooldown
  })
}

// ---------- dw61: the blocked message carries Codex's one-line reason; dw62: the log does not ----------

const REASONS: [string, string, string | undefined][] = [
  ['plain', 'BLOCKED: sandbox refused the write\nmore', 'sandbox refused the write'],
  ['bold_marker', '**BLOCKED:** the plan reads the wrong JSON path', 'the plan reads the wrong JSON path'],
  ['heading_and_blank_lines', '\n\n## Blocked:   two   spaces\tand a tab\n', 'two spaces and a tab'],
  ['keeps_its_own_underscores_and_backticks', 'BLOCKED: missing `required_key` in *config*', 'missing `required_key` in *config*'],
  ['bold_word_then_colon', '**BLOCKED**: the fixture is outside my files', 'the fixture is outside my files'],
  ['status_line_only', '# Report\nStatus: blocked\nDetails.', undefined],
  ['empty_reason', 'BLOCKED:\nI stopped.', undefined],
  ['not_blocked', 'All done.', undefined],
]
for (const [id, text, want] of REASONS) test(`dw61_blocked_reason_${id}`, () => expect(codex.blockedReason(text)).toBe(want))

test('dw61_a_long_reason_is_cut_to_200_characters_by_code_point', () => {
  const long = codex.blockedReason(`BLOCKED: ${'𐐀'.repeat(250)}`)!
  expect([...long]).toHaveLength(201)
  expect(long.endsWith('𐐀…')).toBe(true)
  expect(codex.blockedReason(`BLOCKED: ${'a'.repeat(200)}`)).toBe('a'.repeat(200))
})

test('dw61_a_status_blocked_run_gets_the_message_without_a_reason', async () => {
  const d = driven(false, '# Report\nStatus: blocked\nI stopped.')
  const codexId = await d.launch()
  expect(d.submits).toEqual([
    `[balancer] Codex reported "DESC-SECRET-88" (${codexId}) blocked, nothing was changed. ` +
    'Balancer is redoing it once on Claude as background agent redo-1; its report will come from that agent.',
  ])
})

test('dw62_the_reason_is_not_in_the_decision_log_or_the_store', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: 'BLOCKED: REASON-SECRET-55 refused\nnotes', agentSpawnDeny: 'no agents' } as any)
  await launch($, w)
  expect(w.submits[0]).toContain('Codex\'s reason: "REASON-SECRET-55 refused".')
  expect(JSON.stringify(logLines(w))).not.toContain('REASON-SECRET-55')
  expect(JSON.stringify([...w.store.values()])).not.toContain('REASON-SECRET-55')
})

test('dw34_background_blocked_with_files_changed_delivers_the_failure_text_and_does_not_spawn', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES, git: ['', ' M a.py'] })
  await launch($, w, { subagent_type: 'general-purpose' })
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]).toContain('Codex stopped before finishing (blocked). Files changed so far: a.py')
  expect(w.agentSpawns).toHaveLength(0)
})

// ---------- dw35: /codex ----------

test('dw35_codex_command_reports_a_blocked_run_as_a_failure_without_a_redo', async ($, on) => {
  const w = world(on, CODEX_IDLE, { finalText: NOTES, git: ['', ''] })
  const r: any = await ($ as any).command.run({ command: 'codex', args: 'do the thing' })
  expect(r.text).toContain('Codex could not run the task (blocked)')
  expect(r.text).toContain('I read the module and drafted the change.')
  expect(w.agentSpawns).toHaveLength(0)
  expect(w.agentCalls).toHaveLength(0)
})

// ---------- dw37: excluded agent types ----------

const PLAN_FILE = '/proj/.claude/agents/plan-reviewer.md'
const PLAN_DEF = '---\nname: plan-reviewer\ntools: Read\n---\nREVIEW-BODY\n'
const plan = () => agent({ subagent_type: 'plan-reviewer' }) as any
const EXCL = (o: Record<string, unknown>) => ({ options: o as any })

for (const mode of ['auto', 'codex']) {
  test(`dw37_plan_reviewer_stays_on_claude_in_${mode}_mode`, EXCL({ mode }), async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    w.files.set(PLAN_FILE, PLAN_DEF)
    const input = plan()
    const r: any = await $.tool.call(input)
    expect(r.result).toEqual({ status: 'claude-ran' })
    expect(w.spawns).toHaveLength(0)
    expect(w.agentCalls).toHaveLength(1)
    expect(w.agentCalls[0]).toEqual({ ...input, tool_use_id: w.agentCalls[0].tool_use_id })
    expect(logLines(w)).toHaveLength(1)
    expect(logLines(w)[0]).toMatchObject({ route: 'claude', reason: 'agent-excluded', agentType: 'plan-reviewer' })
    expect(claudeKeys(w)).toEqual([])
  })
}

test('dw37_claude_mode_keeps_mode_claude', EXCL({ mode: 'claude' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PLAN_FILE, PLAN_DEF)
  await $.tool.call(plan())
  expect(logLines(w)[0]!.reason).toBe('mode-claude')
})

test('dw37_a_call_that_was_never_eligible_is_not_logged', async ($, on) => {
  const w = world(on, CODEX_AHEAD) // no agent file: not eligible
  await $.tool.call(plan())
  expect(logLines(w)).toEqual([])
  expect(w.agentCalls).toHaveLength(1)
})

test('dw37_an_empty_option_lets_plan_reviewer_route_normally', EXCL({ excludedAgentTypes: '' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PLAN_FILE, PLAN_DEF)
  await $.tool.call(plan())
  expect(w.spawns).toHaveLength(1)
  expect(logLines(w)[0]).toMatchObject({ route: 'codex', reason: 'codex-ahead' })
})

test('dw37_option_default_and_parsing', () => {
  expect([...readOptions({}).excluded]).toEqual(['plan-reviewer'])
  expect([...readOptions({ excludedAgentTypes: ' a , b,,' }).excluded]).toEqual(['a', 'b'])
})

test('dw37_custom_exclusion_replaces_default', EXCL({ excludedAgentTypes: 'reviewer-x' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set('/proj/.claude/agents/reviewer-x.md', PLAN_DEF)
  w.files.set(PLAN_FILE, PLAN_DEF)
  await $.tool.call(agent({ subagent_type: 'reviewer-x' }) as any)
  expect(logLines(w)[0]).toMatchObject({ route: 'claude', reason: 'agent-excluded' })
  await $.tool.call(plan())
  expect(logLines(w)[1]).toMatchObject({ route: 'codex', reason: 'codex-ahead' })
})

// ---------- dw40: excluded models ----------

test('dw40_model_matching_alias_and_full_id_forms', () => {
  const set = new Set(['fable'])
  const cases: [string | undefined, boolean][] = [
    ['fable', true], ['Fable', true], ['claude-fable-5-2', true], ['claude-fable-5-2[1m]', true], ['us.anthropic.claude-fable-5-2', true],
    ['claude-fable', true], ['sonnet', false], ['claude-sonnet-5-5', false], ['fabled', false], ['claude-fabled-1', false], [undefined, false],
  ]
  for (const [m, want] of cases) expect([m, codex.modelExcluded(m, set)]).toEqual([m, want])
  expect(codex.modelExcluded('fable', new Set())).toBe(false)
})

test('dw40_custom_model_exclusion_replaces_default', EXCL({ excludedModels: 'opus' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await $.tool.call(agent({ model: 'opus' }) as any)
  expect(logLines(w)[0]).toMatchObject({ route: 'claude', reason: 'model-excluded' })
  await $.tool.call(agent({ model: 'fable' }) as any)
  expect(logLines(w)[1]).toMatchObject({ route: 'codex', reason: 'codex-ahead' })
})

const GP_DEF_FILE = '/proj/.claude/agents/deep-thinker.md'
const fableDef = (model: string) => `---\nname: deep-thinker\nmodel: ${model}\ntools: Read, Edit\n---\nBODY\n`

for (const mode of ['auto', 'codex']) {
  test(`dw40_a_call_setting_fable_stays_on_claude_in_${mode}_mode`, EXCL({ mode }), async ($, on) => {
    const w = world(on, CODEX_AHEAD)
    const input = agent({ subagent_type: 'general-purpose', model: 'fable' }) as any
    const r: any = await $.tool.call(input)
    expect(r.result).toEqual({ status: 'claude-ran' })
    expect(w.spawns).toHaveLength(0)
    expect(w.agentCalls[0]).toEqual({ ...input, tool_use_id: w.agentCalls[0].tool_use_id })
    expect(logLines(w)).toHaveLength(1)
    expect(logLines(w)[0]).toMatchObject({ route: 'claude', reason: 'model-excluded', agentType: 'general-purpose' })
  })
}

test('dw40_an_agent_file_model_of_fable_counts_when_the_call_sets_none', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(GP_DEF_FILE, fableDef('claude-fable-5-2'))
  await $.tool.call(agent({ subagent_type: 'deep-thinker' }) as any)
  expect(w.spawns).toHaveLength(0)
  expect(logLines(w)[0]).toMatchObject({ route: 'claude', reason: 'model-excluded', agentType: 'deep-thinker' })
})

test('dw40_the_calls_own_model_wins_over_the_agent_file', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(GP_DEF_FILE, fableDef('fable'))
  await $.tool.call(agent({ subagent_type: 'deep-thinker', model: 'sonnet' }) as any)
  expect(w.spawns).toHaveLength(1)
  expect(logLines(w)[0]).toMatchObject({ route: 'codex', reason: 'codex-ahead' })
})

test('dw40_an_excluded_type_keeps_agent_excluded_and_claude_mode_keeps_mode_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  w.files.set(PLAN_FILE, PLAN_DEF)
  await $.tool.call(agent({ subagent_type: 'plan-reviewer', model: 'fable' }) as any)
  expect(logLines(w)[0]!.reason).toBe('agent-excluded')
})

test('dw40_claude_mode_keeps_mode_claude', EXCL({ mode: 'claude' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await $.tool.call(agent({ subagent_type: 'general-purpose', model: 'fable' }) as any)
  expect(logLines(w)[0]!.reason).toBe('mode-claude')
})

test('dw40_an_empty_option_lets_fable_route_normally', EXCL({ excludedModels: '' }), async ($, on) => {
  const w = world(on, CODEX_AHEAD)
  await $.tool.call(agent({ subagent_type: 'general-purpose', model: 'fable' }) as any)
  expect(w.spawns).toHaveLength(1)
})

test('dw40_option_default_and_parsing', () => {
  expect([...readOptions({}).excludedModels]).toEqual(['fable'])
  expect([...readOptions({ excludedModels: ' Fable , opus,,' }).excludedModels]).toEqual(['fable', 'opus'])
})
