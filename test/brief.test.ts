// A brief file the prompt names is read once for worktree mentions (DW52-57): only a regular, small file inside the
// repository or one of its listed worktrees, one level deep, for workspace-write runs only.
import { test, expect } from 'claude-code/testing'
import * as codex from '../hooks/codex'
import { CODEX_AHEAD, agent, logLines, world } from './harness'

const MAIN = '/main/app'
const WT = '/main/wt-a'
const WB = '/main/wt-b'
const PORCELAIN = [
  `worktree ${MAIN}`, 'HEAD 1111', 'branch refs/heads/main', '',
  `worktree ${WT}`, 'HEAD 2222', 'branch refs/heads/feat', '',
  `worktree ${WB}`, 'HEAD 3333', 'detached', '',
].join('\n')
const GPW = { subagent_type: 'general-purpose' }
const NOTES = 'BLOCKED: sandbox refused the write\nI read the module.'
const BRIEF_FILE = `${MAIN}/notes/brief.md`
const BRIEF_TEXT = `FILE-SECRET-41 Work in the worktree at ${WT}. Edit ${WT}/src/x.py.`

/** The shell sits in the main checkout; both sibling worktrees exist. */
const repo = (on: any, over: Record<string, unknown> = {}) => {
  const w = world(on, CODEX_AHEAD, over as any)
  w.cwd = MAIN
  w.root = MAIN
  w.toplevel = MAIN
  w.commonDir = `${MAIN}/.git`
  w.worktrees = PORCELAIN
  w.dirs.add(MAIN)
  w.dirs.add(WT)
  w.dirs.add(WB)
  return w
}
const file = (w: any, path: string, text: string) => {
  w.files.set(path, text)
  w.fileStats.add(path)
}
const addDirs = (w: any): string[] => {
  const a: string[] = w.spawns[0]!.argv
  return a.flatMap((x, i) => (x === '--add-dir' ? [a[i + 1]!] : []))
}

// ---------- dw52: a brief file in the repository can name the worktree ----------

test('dw52_a_brief_file_in_the_checkout_that_names_a_sibling_worktree_adds_its_root', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  await $.tool.call(agent({ ...GPW, prompt: `Follow the brief at ${BRIEF_FILE} and report.` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads).toContain(BRIEF_FILE)
  expect(JSON.stringify(logLines(w))).not.toContain('FILE-SECRET-41')
  expect([...w.store.values()].some(v => JSON.stringify(v ?? null).includes('FILE-SECRET-41'))).toBe(false)
})

test('dw52_a_brief_path_ending_a_sentence_is_followed', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE}.` }) as any)
  expect(addDirs(w)).toEqual([WT])
})

test('dw52_a_relative_brief_path_resolves_against_the_shell_folder', async ($, on) => {
  const w = repo(on)
  w.cwd = `${MAIN}/pkg`
  file(w, `${MAIN}/pkg/notes/brief.md`, BRIEF_TEXT)
  await $.tool.call(agent({ ...GPW, prompt: 'Follow `notes/brief.md` and report.' }) as any)
  expect(addDirs(w)).toEqual([MAIN, WT])
})

test('dw52_a_brief_file_inside_a_listed_sibling_worktree_is_read', async ($, on) => {
  const w = repo(on)
  file(w, `${WB}/brief.md`, BRIEF_TEXT)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${WB}/brief.md please` }) as any)
  expect(addDirs(w)).toEqual([WB, WT])
})

test('dw52_a_worktree_named_only_in_the_brief_file_is_in_the_change_check', async ($, on) => {
  const w = repo(on, { finalText: NOTES, git: ['', ''] })
  file(w, BRIEF_FILE, BRIEF_TEXT)
  w.gitAt.set(WT, ['', ' M src/x.py\n'])
  w.work.set('src/x.py', 'NEW')
  w.tracked.add('src/x.py')
  const r: any = await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE}` }) as any)
  expect(r.result.content[0].text).toContain(`Files changed so far: ${WT}/src/x.py.`)
  expect(w.agentCalls).toHaveLength(0)
})

test('dw52_brief_paths_are_split_stripped_resolved_and_capped', () => {
  expect(codex.briefPaths('Read /a/b.md, then `c/d.md`: done. Also ~/e/f and x.md and https://h/p', '/cwd')).toEqual([
    '/a/b.md', '/cwd/c/d.md', '/h/p',
  ])
  expect(codex.briefPaths('Follow /a/b.md.', '/cwd')).toEqual(['/a/b.md.', '/a/b.md'])
  expect(codex.briefPaths('see ./x/y and /a//b', '/cwd/')).toEqual(['/cwd/x/y', '/a/b'])
  expect(codex.briefPaths('no paths here', '/cwd')).toEqual([])
  const many = Array.from({ length: 40 }, (_, i) => `/p/${i}.md`).join(' ')
  expect(codex.briefPaths(many, '/cwd')).toEqual(Array.from({ length: codex.BRIEF_MAX_PATHS }, (_, i) => `/p/${i}.md`))
})

// ---------- dw53: a file outside the repository is not read ----------

test('dw53_a_brief_file_outside_the_repository_and_its_worktrees_is_not_read', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  file(w, '/elsewhere/brief.md', `Work in ${WB}.`)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE} and /elsewhere/brief.md` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads).not.toContain('/elsewhere/brief.md')
})

test('dw53_a_relative_path_climbing_out_of_the_repository_is_not_read', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  file(w, '/main/outside.md', `Work in ${WB}.`)
  w.links.set(`${MAIN}/../outside.md`, '/main/outside.md')
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE} and ../outside.md` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads).not.toContain('/main/outside.md')
})

// ---------- dw54: oversized, missing and escaping files are skipped ----------

test('dw54_a_brief_file_over_the_size_cap_is_skipped', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  file(w, `${MAIN}/notes/big.md`, `Work in ${WB}.`)
  w.sizes.set(`${MAIN}/notes/big.md`, codex.BRIEF_MAX_BYTES + 1)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE} and ${MAIN}/notes/big.md` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads).not.toContain(`${MAIN}/notes/big.md`)
})

test('dw54_a_brief_file_at_the_size_cap_is_read', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  w.sizes.set(BRIEF_FILE, codex.BRIEF_MAX_BYTES)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE}` }) as any)
  expect(addDirs(w)).toEqual([WT])
})

test('dw54_a_missing_or_unreadable_brief_file_is_skipped_and_the_run_goes_on', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  w.fileStats.add(`${MAIN}/notes/gone.md`) // stats as a file, but the read fails
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${MAIN}/notes/missing.md, ${MAIN}/notes/gone.md and ${BRIEF_FILE}` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.spawns).toHaveLength(1)
})

test('dw54_a_symlink_in_the_checkout_that_points_outside_is_skipped', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  file(w, '/elsewhere/target.md', `Work in ${WB}.`)
  w.links.set(`${MAIN}/notes/link.md`, '/elsewhere/target.md')
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE} and ${MAIN}/notes/link.md` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads).not.toContain('/elsewhere/target.md')
  expect(w.reads).not.toContain(`${MAIN}/notes/link.md`)
})

test('dw54_a_named_folder_is_not_read', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE} in ${MAIN}/notes` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads.filter((p: string) => p.startsWith(`${MAIN}/notes`))).toEqual([BRIEF_FILE])
})

// ---------- dw55: one level deep ----------

test('dw55_a_file_named_inside_the_brief_file_is_not_followed', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, `${BRIEF_TEXT} See also ${MAIN}/notes/second.md.`)
  file(w, `${MAIN}/notes/second.md`, `Work in ${WB}.`)
  await $.tool.call(agent({ ...GPW, prompt: `Follow ${BRIEF_FILE}` }) as any)
  expect(addDirs(w)).toEqual([WT])
  expect(w.reads.filter((p: string) => p.startsWith(`${MAIN}/notes`))).toEqual([BRIEF_FILE])
})

// ---------- dw56: read-only runs ----------

test('dw56_a_read_only_run_reads_no_brief_file', async ($, on) => {
  const w = repo(on)
  file(w, BRIEF_FILE, BRIEF_TEXT)
  await $.tool.call(agent({ prompt: `Follow ${BRIEF_FILE}` }) as any) // Explore
  expect(w.spawns[0]!.argv).not.toContain('--add-dir')
  expect(w.reads).not.toContain(BRIEF_FILE)
})
