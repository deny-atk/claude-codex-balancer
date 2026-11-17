// A brief that names a sibling linked worktree makes that worktree writable for Codex (DW45-48), and the repeat of a
// call whose Codex run ended blocked and was not redone goes to Claude (DW49-51).
import { test, expect } from 'claude-code/testing'
import * as codex from '../hooks/codex'
import { CODEX_AHEAD, D, DATA, H, NOW, SID, agent, logLines, reading, settleReal, startSession, world } from './harness'

const MAIN = '/main/app'
const WT = '/main/wt-a'
const PORCELAIN = [
  `worktree ${MAIN}`, 'HEAD 1111', 'branch refs/heads/main', '',
  `worktree ${WT}`, 'HEAD 2222', 'branch refs/heads/feat', '',
  'worktree /main/wt-b', 'HEAD 3333', 'detached', '',
  'worktree /main/bare.git', 'bare', '',
].join('\n')
const BRIEF = `Implement the change in the worktree at ${WT}. Edit ${WT}/src/x.py and run the tests there.`
const NOTES = 'BLOCKED: sandbox refused the write\nI read the module.'
const GPW = { subagent_type: 'general-purpose' }

/** The shell sits in the main checkout; the sibling worktrees exist. */
const repo = (on: any, over: Record<string, unknown> = {}) => {
  const w = world(on, CODEX_AHEAD, over as any)
  w.cwd = MAIN
  w.root = MAIN
  w.toplevel = MAIN
  w.commonDir = `${MAIN}/.git`
  w.worktrees = PORCELAIN
  w.dirs.add(WT)
  w.dirs.add('/main/wt-b')
  return w
}
const addDirs = (w: any): string[] => {
  const a: string[] = w.spawns[0]!.argv
  return a.flatMap((x, i) => (x === '--add-dir' ? [a[i + 1]!] : []))
}
const worktreeCalls = (w: any) => w.processCalls.filter((c: string[]) => c[0] === 'git' && c[1] === 'worktree')

// ---------- dw45: a named sibling worktree is writable ----------

test('dw45_a_brief_naming_a_path_in_a_sibling_worktree_adds_its_root', async ($, on) => {
  const w = repo(on)
  await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(worktreeCalls(w)).toEqual([['git', 'worktree', 'list', '--porcelain']])
})

test('dw45_a_bare_root_mention_at_the_end_of_a_sentence_counts', async ($, on) => {
  const w = repo(on)
  await $.tool.call(agent({ ...GPW, prompt: 'Work in `/main/wt-b`.' }) as any)
  expect(addDirs(w)).toEqual(['/main/wt-b'])
})

test('dw45_grants_still_follow_the_named_worktree', async ($, on) => {
  const w = repo(on)
  w.dirs.add('/opt/g')
  w.files.set(`${DATA}/writable-dirs.json`, JSON.stringify({ [MAIN]: ['/opt/g'] }))
  await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(addDirs(w)).toEqual([WT, '/opt/g'])
})

test('dw45_parse_worktrees_lists_roots_and_skips_bare_entries', () => {
  expect(codex.parseWorktrees(PORCELAIN)).toEqual([MAIN, WT, '/main/wt-b'])
  expect(codex.parseWorktrees('')).toEqual([])
})

const ROOTS = [MAIN, WT, '/main/wt-b', '/srv/my tree']
const NAMED: [string, string, string[]][] = [
  ['path_under_root', `edit ${WT}/src/x.py now`, [WT]],
  ['root_alone', `cd ${WT}`, [WT]],
  ['root_then_period', `Work in ${WT}.`, [WT]],
  ['root_in_quotes', `"${WT}"`, [WT]],
  ['root_in_backticks_then_comma', `\`${WT}\`, then stop`, [WT]],
  ['root_with_a_space', 'Use /srv/my tree/notes.md', ['/srv/my tree']],
  ['two_roots', `${WT}/a and /main/wt-b/b`, [WT, '/main/wt-b']],
  ['prefix_sibling_then_real', `/main/wt-ab/x and later ${WT}/y`, [WT]],
]
const NOT_NAMED: [string, string][] = [
  ['prefix_sibling', '/main/wt-a2/src/x.py'],
  ['root_with_a_suffix', '/main/wt-a.old/x'],
  ['embedded_in_a_longer_path', '/backup/main/wt-a/x'],
  ['relative', 'main/wt-a/x'],
  ['non_ascii_suffix', '/main/wt-aé/x'],
  ['unlisted_path', '/elsewhere/repo/x.py'],
]
for (const [id, prompt, want] of NAMED) test(`dw45_named_${id}`, () => expect(codex.namedWorktrees(prompt, ROOTS)).toEqual(want))
for (const [id, prompt] of NOT_NAMED) test(`dw46_not_named_${id}`, () => expect(codex.namedWorktrees(prompt, ROOTS)).toEqual([]))

// shortcut: hand-rolled seeded generator as in props.test.ts (the plugin runtime cannot import fast-check).
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const FRAGMENTS = [...ROOTS, '/main/wt-a2', '/main', '/main/', 'x', '.', ',', ' ', '`', '"', '/src/f.py', '-old', '/backup', '\n']

test('prop_dw45_named_roots_are_listed_and_mentioned_and_a_spaced_mention_is_always_found', () => {
  const r = mulberry32(4501)
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(r() * 8)
    let prompt = ''
    for (let k = 0; k < n; k++) prompt += FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]
    const got = codex.namedWorktrees(prompt, ROOTS)
    for (const d of got) {
      expect(ROOTS).toContain(d)
      expect(prompt).toContain(d)
    }
    expect(new Set(got).size).toBe(got.length)
    const root = ROOTS[Math.floor(r() * ROOTS.length)]!
    expect(codex.namedWorktrees(`${prompt} ${root} ${prompt}`, ROOTS)).toContain(root)
  }
})

// ---------- dw46: nothing else is added ----------

test('dw46_a_brief_naming_only_unlisted_paths_adds_nothing', async ($, on) => {
  const w = repo(on)
  w.dirs.add('/elsewhere/repo')
  await $.tool.call(agent({ ...GPW, prompt: 'Edit /elsewhere/repo/x.py and /main/wt-a2/y.py' }) as any)
  expect(w.spawns[0]!.argv).not.toContain('--add-dir')
})

test('dw46_of_a_listed_and_an_unlisted_path_only_the_listed_worktree_is_added', async ($, on) => {
  const w = repo(on)
  w.dirs.add('/elsewhere/repo')
  await $.tool.call(agent({ ...GPW, prompt: `Edit ${WT}/src/x.py and /elsewhere/repo/x.py` }) as any)
  expect(addDirs(w)).toEqual([WT])
})

test('dw46_a_listed_worktree_whose_folder_is_missing_adds_nothing', async ($, on) => {
  const w = repo(on)
  w.dirs.delete(WT)
  await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(w.spawns[0]!.argv).not.toContain('--add-dir')
})

test('dw46_naming_the_shells_own_checkout_adds_nothing', async ($, on) => {
  const w = repo(on)
  await $.tool.call(agent({ ...GPW, prompt: `Edit ${MAIN}/src/x.py` }) as any)
  expect(w.spawns[0]!.argv).not.toContain('--add-dir')
})

// ---------- dw47: read-only runs ----------

test('dw47_a_read_only_run_gets_no_folder_from_the_brief', async ($, on) => {
  const w = repo(on)
  await $.tool.call(agent({ prompt: BRIEF }) as any) // Explore
  expect(w.spawns[0]!.argv).not.toContain('--add-dir')
  expect(worktreeCalls(w)).toEqual([])
})

// ---------- dw48: the change check covers the named worktree ----------

test('dw48_foreground_blocked_run_that_changed_files_only_in_the_worktree_is_not_redone', async ($, on) => {
  const w = repo(on, { finalText: NOTES, git: ['', ''] })
  w.gitAt.set(WT, ['', ' M src/x.py\n'])
  w.work.set('src/x.py', 'NEW')
  w.tracked.add('src/x.py')
  w.diff = 'WT-DIFF'
  const r: any = await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  const text: string = r.result.content[0].text
  expect(text).toContain(`Codex stopped before finishing (blocked). Files changed so far: ${WT}/src/x.py.`)
  expect(w.agentCalls).toHaveLength(0)
  const at = (k: string) => w.gitCalls.map((c, i) => [c, w.gitCwds[i]] as const).filter(x => x[0][1] === k)
  expect(at('ls-files').map(([c, cwd]) => [cwd, c.slice(c.indexOf('--') + 1)])).toEqual([[WT, ['src/x.py']]])
  expect(at('diff').map(([, cwd]) => cwd)).toEqual([WT])
  expect(w.files.get(`${DATA}/runs/${r.result.agentId}.patch`)).toBe('WT-DIFF')
})

test('dw48_background_blocked_run_that_changed_files_only_in_the_worktree_lists_them', async ($, on) => {
  const w = repo(on, { finalText: NOTES, git: ['', ''] })
  w.gitAt.set(WT, ['', '?? src/new.py\n'])
  await $.tool.call(agent({ ...GPW, prompt: BRIEF, run_in_background: true }) as any)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]).toContain(`Files changed so far: ${WT}/src/new.py.`)
  expect(w.submits[0]).toContain(`Untracked files (a diff does not hold them, they are still on disk): ${WT}/src/new.py.`)
  expect(w.agentSpawns).toHaveLength(0)
})

test('dw48_an_unreadable_worktree_status_makes_the_change_check_unknown', async ($, on) => {
  const w = repo(on, { finalText: NOTES, git: ['', ''] })
  w.gitAt.set(WT, ['', null])
  const r: any = await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(r.result.content[0].text).toContain('Balancer could not check for changed files')
  expect(w.agentCalls).toHaveLength(0)
})

test('dw48_a_lost_run_reports_files_changed_in_the_named_worktree', async ($, on) => {
  const entry = { t: NOW, session: SID, agentType: 'general-purpose', route: 'codex', reason: 'codex-ahead', claudeAfter: 1, codexAfter: 2, estimate: { fiveHour: 1, sevenDay: 1 }, mode: 'auto' }
  const record = {
    agentId: 'codex-123', sessionId: SID, description: 'synthetic task', background: true, sandbox: 'workspace-write', gitCwd: MAIN,
    worktrees: [WT], before: [], outFile: `${DATA}/runs/codex-123.last.txt`, base: `${DATA}/runs/codex-123`, startedAt: NOW, type: 'general-purpose', entry,
  }
  const w = world(on, { 'run/codex-123': record }, { git: [''] } as any)
  w.gitAt.set(WT, [' M src/x.py\n'])
  await startSession($)
  await settleReal(() => w.submits.length > 0)
  expect(w.submits[0]).toContain(`${WT}/src/x.py`)
  expect(w.submits[0]).not.toContain('Nothing was changed')
})

test('dw48_a_saved_patch_holds_both_checkouts_with_the_worktree_root_in_its_names', async ($, on) => {
  const w = repo(on, { finalText: NOTES, git: ['', ' M a.py\n'] })
  w.gitAt.set(WT, ['', ' M src/x.py\n'])
  w.work.set('a.py', 'A2')
  w.work.set('src/x.py', 'X2')
  w.tracked.add('a.py')
  w.tracked.add('src/x.py')
  w.diff = 'PART;'
  const r: any = await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(r.result.content[0].text).toContain(`Files changed so far: a.py, ${WT}/src/x.py.`)
  const diffs = w.gitCalls.map((c, i) => [c, w.gitCwds[i]] as const).filter(([c]) => c[1] === 'diff')
  expect(diffs).toEqual([
    [['git', 'diff', 'HEAD', '--', 'a.py'], MAIN],
    [['git', 'diff', 'HEAD', `--src-prefix=a${WT}/`, `--dst-prefix=b${WT}/`, '--', 'src/x.py'], WT],
  ])
  expect(w.files.get(`${DATA}/runs/${r.result.agentId}.patch`)).toBe('PART;PART;')
})

test('dw48_the_run_record_carries_the_named_worktree_for_a_restart', async ($, on) => {
  const w = repo(on)
  let seen: any
  w.during = () => { seen = [...w.store.entries()].find(([k]) => k.startsWith('run/'))?.[1] }
  await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(seen.worktrees).toEqual([WT])
})

test('dw48_a_finished_run_reports_files_changed_in_the_worktree', async ($, on) => {
  const w = repo(on, { git: ['', ''] })
  w.gitAt.set(WT, ['', ' M src/x.py\n'])
  w.work.set('src/x.py', 'NEW')
  const r: any = await $.tool.call(agent({ ...GPW, prompt: BRIEF }) as any)
  expect(r.result.content[0].text).toContain(`Changed or untracked files (git status):\n${WT}/src/x.py`)
})

// ---------- dw49: the repeat of a blocked call that was not redone goes to Claude ----------

const bgLaunch = async ($: any, w: any, over: Record<string, unknown> = {}) => {
  await $.tool.call(agent({ run_in_background: true, ...over }) as any)
  await settleReal(() => w.submits.length > 0)
}

test('dw49_a_background_run_not_redone_for_effort_sends_its_repeat_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  expect(w.submits[0]).toContain('Delegate it again with the same description; that call will run on Claude.')
  w.finalText = 'fine'
  const r: any = await $.tool.call(agent() as any) // same type and description, no effort
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(w.spawns).toHaveLength(1)
  expect(logLines(w).map(l => l.reason)).toEqual(['codex-ahead', 'codex-blocked-repeat'])
  expect(logLines(w)[1]).toMatchObject({ route: 'claude', agentType: 'Explore' })
})

test('dw49_a_redo_that_could_not_start_sends_the_repeat_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES, agentSpawnDeny: 'no agents' })
  await bgLaunch($, w)
  expect(w.submits[0]).toContain('Delegate it again with the same description; that call will run on Claude.')
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'codex-blocked-repeat' })
})

test('dw49_a_foreground_blocked_run_with_changed_files_sends_the_repeat_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES, git: ['', ' M a.py'] })
  await $.tool.call(agent(GPW) as any)
  const r: any = await $.tool.call(agent(GPW) as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(w.spawns).toHaveLength(1)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'codex-blocked-repeat', agentType: 'general-purpose' })
})

test('dw49_the_same_brief_under_a_new_description_is_a_repeat', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  const r: any = await $.tool.call(agent({ description: 'reworded title' }) as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
})

test('dw49_a_description_differing_only_in_case_and_spaces_is_a_repeat', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  const r: any = await $.tool.call(agent({ description: '  desc-secret-88 ', prompt: 'a new brief' }) as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
})

test('dw49_only_the_first_repeat_is_moved', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  await $.tool.call(agent() as any)
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  expect(w.spawns).toHaveLength(2)
})

test('dw49_a_repeat_after_thirty_minutes_routes_normally', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  await w.clock.advance(30 * 60_000 + 1000)
  const later = NOW + 30 * 60_000 + 1000 // fresh readings, so only the window can change the route
  w.store.set('reading/claude', reading({ fiveUsed: 80, fiveLeft: 2 * H, sevenUsed: 80, sevenLeft: 2 * D, readAt: later }))
  w.store.set('reading/codex', reading({ fiveUsed: 5, fiveLeft: 4 * H, sevenUsed: 5, sevenLeft: 5 * D, readAt: later }))
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
})

test('dw49_a_repeat_just_inside_thirty_minutes_still_goes_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  await w.clock.advance(30 * 60_000 - 1000)
  const later = NOW + 30 * 60_000 - 1000 // fresh readings, as in the test after the window
  w.store.set('reading/claude', reading({ fiveUsed: 80, fiveLeft: 2 * H, sevenUsed: 80, sevenLeft: 2 * D, readAt: later }))
  w.store.set('reading/codex', reading({ fiveUsed: 5, fiveLeft: 4 * H, sevenUsed: 5, sevenLeft: 5 * D, readAt: later }))
  await $.tool.call(agent() as any)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'codex-blocked-repeat' })
})

test('dw49_an_excluded_model_keeps_its_own_reason', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  await $.tool.call(agent({ model: 'fable' }) as any)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'model-excluded' })
})

test('dw49_a_background_blocked_run_with_changed_files_sends_the_repeat_to_claude', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES, git: ['', ' M a.py'] })
  await bgLaunch($, w, GPW)
  expect(w.submits[0]).toContain('Codex stopped before finishing (blocked)')
  const r: any = await $.tool.call(agent(GPW) as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'codex-blocked-repeat' })
})

test('dw49_in_mode_codex_the_repeat_still_goes_to_claude', { options: { mode: 'codex' } as any }, async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'codex-blocked-repeat', mode: 'codex' })
})

test('dw49_mode_claude_keeps_its_reason_and_does_not_use_up_the_repeat', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  await $.command.run({ command: 'balance', args: 'claude' } as any)
  await $.tool.call(agent() as any)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'mode-claude' })
  await $.command.run({ command: 'balance', args: 'auto' } as any)
  await $.tool.call(agent() as any)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'claude', reason: 'codex-blocked-repeat' })
})

test('dw49_a_repeat_from_another_session_routes_normally', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  w.sid = 'sess-2'
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  w.sid = SID
  const r2: any = await $.tool.call(agent() as any)
  expect(r2.result).toEqual({ status: 'claude-ran' })
})

// ---------- dw50: other calls route normally ----------

test('dw50_a_different_call_does_not_use_up_the_repeat', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  await $.tool.call(agent({ description: 'another task', prompt: 'another brief' }) as any)
  const r: any = await $.tool.call(agent() as any)
  expect(r.result).toEqual({ status: 'claude-ran' })
  expect(logLines(w).map(l => l.reason)).toEqual(['codex-ahead', 'codex-ahead', 'codex-blocked-repeat'])
})


test('dw50_a_different_call_right_after_routes_normally', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  const r: any = await $.tool.call(agent({ description: 'another task', prompt: 'another brief' }) as any)
  expect(r.result.status).toBe('completed')
  expect(logLines(w).at(-1)).toMatchObject({ route: 'codex', reason: 'codex-ahead' })
})

test('dw50_the_same_description_under_another_agent_type_routes_normally', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await bgLaunch($, w, { effort: 'high' })
  w.finalText = 'fine'
  await $.tool.call(agent(GPW) as any)
  expect(logLines(w).at(-1)).toMatchObject({ route: 'codex', reason: 'codex-ahead', agentType: 'general-purpose' })
})

// ---------- dw51: guards ----------

test('dw51_a_blocked_run_that_was_redone_does_not_move_its_repeat', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { finalText: NOTES })
  await $.tool.call(agent() as any) // foreground, nothing changed: redone on Claude by the call itself
  w.finalText = 'fine'
  const r: any = await $.tool.call(agent() as any)
  expect(r.result.status).toBe('completed')
  expect(logLines(w).map(l => l.reason)).toEqual(['codex-ahead', 'codex-blocked', 'codex-ahead'])
})

test('dw51_a_failed_run_that_was_not_blocked_does_not_move_its_repeat_past_the_cooldown_rule', async ($, on) => {
  const w = world(on, CODEX_AHEAD, { script: 'fail', git: ['', ' M a.py'] })
  await $.tool.call(agent(GPW) as any)
  w.script = 'ok'
  const r: any = await $.tool.call(agent(GPW) as any)
  expect(r.result.status).toBe('completed')
})
