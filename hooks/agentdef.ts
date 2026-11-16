// Custom agent types: `.claude/agents/<type>.md` files (YAML frontmatter, then the agent's instructions).
// Pure helpers only; dispatch.ts reads the file through `$.fs`.

export type AgentDef = { body: string; model?: string; effort?: string; tools?: string[] }

/** What Codex cannot provide: a call or an agent definition that needs one of these stays on Claude. */
export const CAPABILITY_RE = /\bmcp__|\bSkill\b|\bSendMessage\b|\bAskUserQuestion\b|\bArtifact\b/

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

/**
 * Where to look for a custom type's file, in order: each project folder given (the session's root, where Claude Code
 * loaded its agents, then the cwd, which a shell `cd` into a worktree can move away from them), then the user's config folder.
 * Empty for a plugin type (`plugin:agent`) and for anything that is not a plain file name.
 * shortcut: agent file looked up by file name only, not by the name field, subfolders or parent folders; replace if agents live there
 */
export function agentDefPaths(type: string, projectDirs: readonly string[], configDir: string): string[] {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(type)) return []
  return [...new Set([...projectDirs.map(d => `${d}/.claude/agents/${type}.md`), `${configDir}/agents/${type}.md`])]
}

export function configDirFor(configDir: string | undefined, home: string | undefined): string {
  return configDir || `${home ?? ''}/.claude`
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
const list = (s: string) => s.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)

/** Key: value lines between the first two `---` lines, and the rest as the body. Null without both fences. */
export function parseAgentDef(text: string): AgentDef | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return null
  const def: AgentDef = { body: lines.slice(end + 1).join('\n').trim() }
  let tools: string[] | null = null // collecting `- A` lines after a bare `tools:`
  for (const line of lines.slice(1, end)) {
    const dash = /^\s+-\s*(.*)$/.exec(line)
    if (tools && dash) { tools.push(...list(dash[1]!)); continue }
    tools = null
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const [, key, raw] = m
    const value = unquote(raw!.trim())
    if (key === 'model' && value) def.model = value
    else if (key === 'effort' && value) def.effort = value
    else if (key === 'tools') {
      if (value) def.tools = list(value)
      else def.tools = tools = []
    }
  }
  if (def.tools?.length === 0) delete def.tools // a bare `tools:` is the same as none: all tools
  return def
}

/** The definition names a tool Codex cannot provide. */
export const unavailableTools = (d: AgentDef): boolean => !!d.tools && CAPABILITY_RE.test(d.tools.join('\n'))

/** The frontmatter effort as a Codex effort (`max` is `xhigh`); undefined when absent or unknown. */
export function codexEffort(d: AgentDef): string | undefined {
  const e = d.effort?.toLowerCase()
  if (e === 'max') return 'xhigh'
  return e !== undefined && EFFORTS.has(e) ? e : undefined
}

/** A tools list that grants no way to edit files: the agent can only read. */
export const readOnlyTools = (tools: readonly string[]): boolean =>
  tools.length > 0 && !tools.some(t => EDIT_TOOLS.has(t.replace(/\(.*$/, '').trim()))

/** The frontmatter model, unless it is `inherit`. */
export const defModel = (d: AgentDef | undefined): string | undefined =>
  d?.model && d.model.toLowerCase() !== 'inherit' ? d.model : undefined
