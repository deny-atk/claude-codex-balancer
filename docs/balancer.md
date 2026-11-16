# Balancer

Balancer is a Claude Code mod. When Claude Code is about to start a subagent, Balancer decides whether the task runs as a normal Claude subagent or is run by the local Codex CLI. The goal is that the Claude and ChatGPT/Codex subscriptions are used at a similar pace, relative to their own caps and reset times, so neither runs out long before the other.

This guide describes what the code does now. It makes no model calls of its own, never changes the system prompt and never registers or removes tools after `session.start`.

## What it routes

Balancer only moves delegated work: a call to the Agent tool. The main conversation always runs on Claude. Workflow-script agents never reach the Agent tool hook, so they stay on Claude too.

An Agent call can run on Codex only if all of these hold. Otherwise it reaches Claude Code unchanged, with its input untouched.

- `subagent_type` is omitted or is in `eligibleAgentTypes` (default `general-purpose`, `claude`, `Explore`), or it is a custom type whose definition file is found (below).
- It is not a fork, has no `isolation` (worktree or remote) and has no `name` (a named agent can be continued with `SendMessage`, which Codex runs cannot).
- The brief does not match `/\bmcp__|\bSkill\b|\bSendMessage\b|\bAskUserQuestion\b|\bArtifact\b/`, which marks work that needs Claude-only capabilities.
- The project has not opted out (see Configuration).
- The session's working directory exists on this machine.

Custom types: a `subagent_type` that is not in `eligibleAgentTypes` and has no `:` in it is looked up as a file name only: first `.claude/agents/<type>.md` under the session's project root (where it started, and where Claude Code loaded its agents), then under the working directory, which a shell `cd` into a git worktree can move away from the root, then `<config dir>/agents/<type>.md`, where the config dir is `CLAUDE_CONFIG_DIR` or else `$HOME/.claude`. The project file wins, and the first file found decides: a project file that cannot be read as a definition does not fall through to the user file. The file must start with a `---` line and have a closing `---` line (Markdown with YAML frontmatter; Balancer reads only `key: value` lines, and `tools` as a comma-separated string, `[A, B]` or `- A` lines). Everything after the frontmatter is the agent's instructions. The call stays on Claude, unchanged, when no file is found, the type has a `:` (a plugin agent), the file has no frontmatter, or its `tools` list names anything matching `mcp__`, `Skill`, `SendMessage`, `AskUserQuestion` or `Artifact`, which Codex cannot provide. The other rules above apply as for any call. The decision log's `agentType` is the custom type. Agents in subfolders or parent folders, and the frontmatter `name` field, are not looked at.

In mode `off` the hook passes every call through at once and reads and logs nothing.

## How the decision is made

Each provider has a 5-hour and a weekly window. For one window:

```
remainingShare = clamp((resetsAt - now) / windowLength, 0.02, 1)   (1 when no reset time is known)
runway         = min(999, (100 - used) / remainingShare)
```

A runway of 100 means usage is exactly on a uniform pace. Above 100 there is slack, below 100 the window runs out before it resets. A window whose reset time has passed counts as unused, and a missing window counts as unused. A provider's score is the runway of its tighter window.

The task is added to each side as a cost in percentage points of a window. Claude's cost is fixed (`claudeTaskCostFiveHour` 1, `claudeTaskCostSevenDay` 0.2). Codex's cost is learned (see Estimates). Codex's score also includes the reservations of Codex tasks already running. The task goes to Codex when `codexAfter > claudeAfter + margin`. A tie stays on Claude.

Overrides are checked first, in this order:

1. Mode `off` or `claude`: Claude. Mode `codex`: Codex if it is usable, otherwise Claude.
2. Codex unusable: Claude. The reason is the first that applies: not installed or not logged in, `limitReached`, `maxConcurrentCodex` tasks already in flight (across all sessions), or a window at or above its ceiling once reservations and this task are added.
3. Claude at or above a ceiling (or limited), with Codex usable: Codex.
4. No Codex reading at all: Claude, and a Codex reading is refreshed in the background.

After a background Codex failure, auto mode also routes to Claude for 15 minutes (reason `codex-cooldown`).

Worked example, with made-up numbers. Claude's 5-hour window is 70% used with 2 of 5 hours left (40%), so its runway is 30 / 0.4 = 75, and 72.5 after this task's 1 point. Its weekly runway is 140. Claude after the task is 72.5. Codex's 5-hour window is 20% used with 4 hours left (80%). Codex's estimate for this agent type is 5 points (5h) and 1 point (7d). Its weekly window is 30% used with 70% left. Codex after the task: 5-hour (100 - 25) / 0.8 = 93.75, weekly (100 - 31) / 0.7 = 98.6, so 93.75. That is more than 72.5 + 5, so the first task goes to Codex.

Three eligible subagents start in one message. The second sees the first's 5-point reservation: (100 - 30) / 0.8 = 87.5, still above 77.5, so it goes to Codex. The third finds two Codex tasks in flight and `maxConcurrentCodex` is 2, so it runs on Claude (reason `codex-concurrency`). The decision and the reservation are made in one serialised step, so the second call always sees the first.

### Estimates and reservations

A reservation is one store key per running Codex task (`inflight/<id>`) holding its estimated cost. It is removed when the task ends and ignored once older than `taskTimeoutMinutes`.

Claude-routed tasks reserve the configured Claude cost under `claude-inflight/<id>`, separately from Codex concurrency and the in-flight list. Live reservations from all sessions are added to Claude's score. Foreground reservations are removed when the call settles; background reservations remain until the agent's turn completes. Session end removes this load's reservations, and listing drops reservations older than `taskTimeoutMinutes`.

The Codex estimate is an exponentially weighted average (alpha 0.3) per subagent type and window, seeded at 5 points (5h) and 1 point (7d). A sample is the change in `used` across a run. It counts only if both readings belong to the same window instance (reset times within 60 seconds), no other Balancer task overlapped, and the change is not negative. A task counts as overlapped when another Codex task was running at any moment of its run, including one that started and ended inside it. Each reservation carries an `overlapped` flag: a task that reserves while others run sets it on its own record and on every other record in flight, and at its end a run reads its own flag. Say task A starts, task B starts and finishes inside A, and A finishes with usage up 10 points: A's flag was set when B reserved, so neither run changes the estimate. An aborted run adds no sample.

## Foreground and background

Claude Code may send `run_in_background` with an Agent call. The engine's own default applies when it is absent, and Balancer treats absent like true.

Foreground (`run_in_background` is `false`): Balancer runs Codex inside the hook and the main turn waits. The model receives a normal completed subagent result whose text is one provenance line, a blank line, then Codex's final message:

```
[balancer] Ran on Codex (model gpt-6.1-sol, effort high, 2m13s, session 0193…). Treat as a subagent report; verify before relying on it.
```

The report is cut at `maxResultChars` with a note and the path of the full text under the data folder. For a `workspace-write` run, the paths that `git status` lists as changed or untracked (paths only, at most 50) are appended.

Background (true or absent): Balancer answers at once with a launched-in-background result (agent id `codex-<uuid>`, output file under the data folder) and runs Codex in a detached task. When it finishes it writes the report to the output file and delivers a message with `$.prompt.submit`: a line saying the background agent finished on Codex, then the same report. That starts a turn once the session is idle.

Codex runs with `codex exec --json --skip-git-repo-check -C <cwd> -s <sandbox> -c model_reasoning_effort=<effort> [-m <model>] -o <file> <prompt>`, started by argv, never through a shell. The prompt is a fixed preamble (a delegated subtask, do only what the brief asks, no commit, push or branch switch, end with a report) followed by the brief unchanged. For a custom type, a block `Instructions for the <type> agent you are acting as:` with the file's instructions (frontmatter removed) sits between the preamble and the brief; built-in types get no such block. A prompt over 100 KB (instructions included) goes in on stdin. The sandbox is `read-only` for `Explore` and for plan mode, `workspace-write` otherwise. For a custom type with a `tools` list that contains none of `Edit`, `Write` and `NotebookEdit` it is `read-only`; with no `tools` list, or one that has any of them, `workspace-write` (plan mode still forces `read-only`). Dangerous bypass flags and `--ephemeral` are never used. Effort comes from `effortMap` by the call's `model`, then its `default` entry, then `high`. For a custom type the model used here and for the Codex model is the call's `model`, else the file's `model` (`inherit` and empty are ignored), and a file `effort` of `low`, `medium`, `high` or `xhigh` is used as the Codex effort directly (`max` becomes `xhigh`; any other value is ignored and `effortMap` applies); the file's `effort` applies even when the call's own `model` decides the model. The Codex model comes from an exact `modelMap` match on the Agent call's `model` (by default, `opus` → `gpt-6.1-sol`, `sonnet` → `gpt-6.1-terra`), then non-empty `codexModel`, otherwise no `-m` is passed. The map has no special `default` key; malformed pairs are skipped as in `effortMap`. The provenance, tool row and decision log show the selected model, or `default` when no `-m` was passed. Plan mode is seen only through the Agent call's `mode` argument. The session's own permission mode is not visible to Balancer: where the built-in security plugin (`cc-plugin-sec-default`) is seated, it sends classic events and plan-mode reminders past installed plugins, so Balancer hooks neither. A general-purpose task routed to Codex while plan mode is on therefore runs with `workspace-write` unless the call itself says `mode: plan`.

## Failure handling

Everything fails safe toward Claude. Before answering a call, Balancer checks the binary and login (`codex login status`), so those cases fall back in both modes.

| Case | Foreground | Background |
| --- | --- | --- |
| Codex missing or not logged in, found before launch | Codex is unusable until the check passes again (re-asked after 10 minutes). One toast per session, shared with the next row. Claude runs the task through the normal path. | Same. |
| Codex cannot be started | Codex is unusable for the rest of the session, one toast, Claude runs the task. | Same toast and unusable state. A message says Codex could not run the task, nothing changed, re-delegating runs on Claude. 15-minute cooldown. |
| Run fails or times out, `read-only` sandbox | Claude runs the task. Toast with the reason. | Message as above, 15-minute cooldown, toast. |
| Run fails or times out, `workspace-write`, no files changed | Claude runs the task. Toast. | Message as above, cooldown, toast. |
| Run fails or times out, `workspace-write`, files changed | Result says Codex stopped part-way, lists the changed files, saves a patch and partial notes (see below) and says not to re-run from the top. Claude does not re-run it. | The same text is delivered as a message. No cooldown. |
| Run fails, `workspace-write`, git cannot say what changed (not a repository) | Result says Codex could not run and the check was impossible. No re-run. | Delivered as a message. No cooldown. |
| Codex reports a usage limit | Codex is marked limited until the earliest known reset, then as the rows above. | Same. |
| Claude turn fails with a `rate_limit` error | Claude is marked limited until its earliest known reset (one 5-hour window when none is known), so Codex takes tasks while usable. | Same. |
| Balancer's own hook throws | The engine skips the hook and Claude runs the subagent. There is no catch that denies. | Same. |

Work is saved when a run stops part-way (any failure, a usage limit included; not a finished or interrupted run). Balancer never reverts or commits anything, and runs only `git ls-files` and `git diff HEAD`, which touch no index or stash.

- Patch: if files changed, `git diff HEAD -- <changed tracked paths>` is written to `runs/<agentId>.patch`. The failure text names the patch and lists the changed untracked files separately, since a diff does not hold them (they stay on disk). A failed write changes nothing else.
- Partial report: Codex's last message, if it sent one, is written to `runs/<agentId>.partial.txt` and appears in the failure text, cut at 4000 characters, with the path.
- Resume hint: when the run has a session id and hit a usage limit or timed out, the text ends with the session id and `codex exec resume <id>`, to continue after the limit resets. Balancer does not run it.
- Carry-over: when a failed run falls back to Claude (sync read-only, or no files changed) and there is a partial message, the Agent call goes on with `\n\n` and a labelled block added to its prompt: a previous Codex attempt stopped (reason), here are its notes, verify them. With no partial message the call passes through untouched. In background mode the same block is in the cooldown message, so the re-delegation can include it.

The decision log holds none of this text.

Say Codex hits its limit after editing `a.py` (tracked) and creating `new.py`, having told us "parser done, tests next". The text names `runs/<id>.patch` (the `a.py` diff), says `new.py` is untracked, quotes "parser done, tests next" and ends with the `codex exec resume` command. If the task had been read-only, Claude would instead get the original brief followed by that note.

"Files changed" is decided by content, not by status codes. Before and after a `workspace-write` run Balancer takes `git status --porcelain --untracked-files=all` and one `git hash-object` over the listed paths (a deleted path counts as `missing`). A path is reported when it is new in the list, has a different hash, or has dropped out of the list. Say `a.py` was already modified and `notes.txt` was untracked before the run, and Codex edits both again without changing their status codes: both hashes differ, so both are named and Claude does not re-run the task. A file that was modified before the run and restored by Codex is named too. Outside a git repository the check is impossible (the row above).

A failure means a non-zero exit, no final message, or a timeout (`taskTimeoutMinutes`). A background failure cannot fall back to Claude in the same call, because the call was already answered; that is why the message and cooldown exist.

## TaskStop, interrupts and session end

`TaskStop` with the id of a Balancer background run stops that run: the Codex process is killed, the reservation is released, and Balancer answers with a stopped-task result. A `TaskStop` for any other id passes through.

Interrupting a foreground run ends the hook's wait and kills the process, then releases the reservation once the process has exited (the wait for the exit is capped at 5 seconds, so a stuck cleanup cannot hang the hook); the call gets a denial saying the run was interrupted. Ending the session aborts that session's runs and delivers nothing. Unloading the module kills detached children, and their reservations expire after `taskTimeoutMinutes`. An aborted run is logged and adds no estimate sample.

## Where readings come from

Both providers are reduced to one shape: used percent, reset time and length for each window, plus a read time and a limit flag. The readings are kept in the shared store (`reading/claude`, `reading/codex`), so every Claude Code session on the machine sees the freshest one. Claude's stored and live readings are merged window by window rather than by arrival: usage inside one window only rises, so for the same window (resets less than half a window apart) the higher figure wins, and otherwise the window that resets later. This matters because the engine's first usage measurement after a session starts or resumes repeats that session's last reported figures, which can be hours old: a resumed session that last saw 36% must not replace a reading of 66% for the same window. The Codex reading is also memoised in each session for 30 seconds.

Claude: the live `$.session.usage()` figures (five-hour and seven-day windows only; spend limits are ignored), merged with the stored reading. Each `session.measure` saves the live reading; Claude's limit is read from these usage windows. A limit flag stored by an older version is carried over until its reset. Per-model weekly caps are not visible.

Balancer hooks none of the events intercepted by the built-in security plugin.

Codex, in order:

1. After a Balancer run: the last `rate_limits` in that run's rollout file, found by thread id in today's and yesterday's `~/.codex/sessions/YYYY/MM/DD` folders.
2. If the stored reading is older than `staleAfterMinutes`: a read of `account/rateLimits/read` through `codex app-server`, run as a fixed shell script with no user data in it (15-second limit).
3. If that fails: the last `rate_limits` in the newest rollout file of those two folders.

Used percent is clamped to 0 to 100, and a window whose used percent or length is not a finite number is dropped. Windows are told apart by length (300 minutes is the 5-hour window, 10080 the weekly one), never by the names `primary` and `secondary`. A reader that finds nothing yields no reading, which routes to Claude.

Privacy rule for rollout files: they hold session content. Balancer reads only the last 64 KB (`tail -c 65536`), drops the first, possibly cut, line, keeps only the `rate_limits` object of `token_count` events, and never logs, stores or shows any other part of a line.

## Decision log

`decisions.jsonl` in the data folder holds one JSON line per Agent call that reached a routing decision (not mode `off`, not ineligible calls). It is content-free: no brief, description or report text. Fields: `t` (epoch ms), `session`, `agentType`, `route`, `reason`, `claudeAfter`, `codexAfter` (scores after the task), `estimate` (`fiveHour`, `sevenDay`), `mode`, and for a Codex run `codexModel`, `durationMs`, `outcome`, `exitCode` and `delta` (points used in each window, when both readings are known). A Codex-routed call is written when its run ends, a Claude-routed one at the decision.

Reason codes: `mode-off`, `mode-claude`, `mode-codex`, `codex-unavailable`, `codex-limit`, `codex-concurrency`, `codex-ceiling`, `claude-ceiling`, `no-codex-reading`, `codex-ahead`, `claude-ahead`, `codex-cooldown`.

The file keeps the last 2000 lines. The file system API has no append, so each write reads and rewrites the file. A failing write never changes routing.

## User interface

Status entry, refreshed on each `session.measure` and after each decision or run: `C 5h 62 · 7d 55 │ X 5h 20 · 7d 46 │ → Claude`. Figures are used percent (a passed reset counts as 0, `–` means unknown). The route part appears after the first decision.

Tool row: under an Agent row that ran on Codex, one dim line. While running: `Codex · gpt-6.1-sol · high · running`. After: `Codex · gpt-6.1-sol · high · 2m13s · +4 pts 5h`, with `failed` added on failure. Older stored rows without a model retain their previous format. The points show only when at least 1 and both readings were known. A task that fell back to Claude, or was stopped, has no line.

Toasts, only for: a provider crossing a ceiling (once per crossing), Codex becoming unusable (once per session, whether the binary is missing or not logged in at the check before routing, or a launch failed), and a Codex failure that fell back to Claude.

`/balance` prints the mode (and whether `/balance` set it), each provider's score, window use, reset time and runway, whether Codex is available (and any cooldown), tasks in flight, and the last 5 decisions, read from `decisions.jsonl` (so they include earlier sessions, and a Codex run shows once it has ended; blank or unparsable lines are skipped, and this session's own list is used if the file cannot be read). `/balance auto|claude|codex|off` sets the mode for this session, overriding the option.

`/codex <task>` runs the text as a Codex task (`workspace-write`, effort `high`) and prints the report or the failure text. It uses non-empty `codexModel`, otherwise no `-m`, independently of `modelMap`. It makes no Claude model call and works while Claude is limited. It makes no routing decision, but it takes a reservation, is logged, and ends with the session. It refuses in mode `off`, in an opted-out project, and when Codex is unavailable.

## The delegation nudge

The main thread always burns Claude, so when Claude is clearly the tighter side Balancer asks the model to delegate more. State `claude-tight` starts when `score(codex) - score(claude)` is above 25, Codex is usable and the mode is `auto` or `codex`; it ends when the gap falls below 10. Usable here means the same as for routing: installed and logged in, not `limitReached`, below both ceilings, and (in `auto`) not in the 15-minute cooldown. If any of these stops holding while the state is on, the state ends at once and a reminder still waiting is dropped; when they hold again and the gap is above 25, it starts again with a new reminder. Say Claude's score is 60 and Codex's is 90: the gap is 30, the state starts, and the next typed prompt carries one short reminder. At a gap of 20 the state holds without a new reminder.

The reminder fires once on entering the state. It is re-armed when a usage measurement shows the main context dropped by more than half after having been at least 20% full; after a manual `/compact`, it therefore rides on the first typed prompt after the next model response. It is attached to a typed prompt as hidden `context` on `prompt.submit`, so the model reads it after the new user message and the user never sees it. It is not attached to slash commands or prompts the user did not type; a background-result prompt from Balancer may carry it. That position sits after every cached prefix, so the system prompt and tool list are untouched. Changing either would invalidate the cache of the whole conversation and cost more Claude usage than the nudge saves. The `nudge` option turns it off.

## Configuration

Set in the manifest's `userConfig`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `claude`, `codex` or `off` |
| `margin` | 5 | Runway points Codex must lead by |
| `ceilingFiveHour` | 95 | Do not route to a provider at or above this 5-hour use |
| `ceilingSevenDay` | 97 | Same, weekly |
| `eligibleAgentTypes` | `general-purpose,claude,Explore` | Comma-separated types that may run on Codex. A custom type with a found definition file is eligible regardless of this list (see What it routes) |
| `effortMap` | `haiku=low,sonnet=medium,opus=high,default=high` | Agent `model` to Codex reasoning effort |
| `modelMap` | `opus=gpt-6.1-sol,sonnet=gpt-6.1-terra` | Agent `model` to Codex model; exact matches win |
| `codexModel` | empty | Fallback for unmapped calls and `/codex`; empty keeps Codex's default |
| `maxConcurrentCodex` | 2 | Codex tasks at once, across all sessions |
| `taskTimeoutMinutes` | 30 | Limit per Codex run; also the age at which a reservation expires |
| `staleAfterMinutes` | 15 | Age at which the stored Codex reading is refreshed |
| `claudeTaskCostFiveHour` | 1 | Points of the 5-hour window per Claude task |
| `claudeTaskCostSevenDay` | 0.2 | Points of the weekly window per Claude task |
| `maxResultChars` | 30000 | Cap on the returned report |
| `nudge` | true | Delegation nudge on or off |

Routing to Codex is on in every project. A brief sent to Codex goes to OpenAI, a different processor from Anthropic, so a project with private inputs should opt out: put `{ "codex": false }` in `.claude/balancer.json` in the project root. A missing or unparseable file does not opt out. The opt-out also stops `/codex`.

## Writable folders

A workspace-write Codex run can only write under its `-C` folder, which stays the session's shell folder so that relative paths in the brief keep their meaning. Balancer widens the writable set with `--add-dir` in these cases:

- The shell folder is inside a git repository (`git rev-parse --path-format=absolute --show-toplevel --git-common-dir`) and the repository's top folder differs from it: the top folder is added. Say the session is in `/proj/pkg/sub` and the top folder is `/proj`: Codex gets `-C /proj/pkg/sub --add-dir /proj`.
- The shell folder is not in a repository, but is strictly inside the session root: the root is added.
- Git is also asked at the top folder when there is one (the status before and after the run, and the `ls-files` and `diff` that save work from a failed run), so changed files anywhere in the repository are seen. Without a repository it is asked at the shell folder.

Further folders come from the user's grants file, `<data folder>/writable-dirs.json`, never from a file inside a repository. It maps a project key to a list of folders. The key is the main repository folder, the parent of the absolute git common dir, so every linked worktree of one repository shares one entry; with no repository the key is the session root. For a repository whose main checkout is `/Users/example/Work/app`, granting a tool cache:

```json
{ "/Users/example/Work/app": ["/Users/example/.cache/uv"] }
```

A missing or unparseable file grants nothing. A folder, granted or computed, is used only if it is an absolute path with no `.` or `..` segment, is not `/`, is not the home folder or one of its ancestors, and exists as a directory; anything else is skipped silently. Duplicates are passed once. Grants and the computed root apply to workspace-write runs only: read-only runs (Explore, plan mode, read-only agent files) get no `--add-dir`. `/codex` resolves them the same way. No danger flag is ever added. Codex's sandbox still denies process listing (for example `pgrep`), so a brief that needs it is blocked on Codex.

## Data folders

- Data folder: `$CLAUDE_CONFIG_DIR/plugins/data/balancer/`, or `$HOME/.claude/plugins/data/balancer/` when that variable is unset. It holds `decisions.jsonl`, the optional `writable-dirs.json` (see Writable folders) and `runs/` with, per run, `<agentId>.txt` (the background output file, or the full text of a cut foreground report), `<agentId>.full.txt` (full text of a cut background report) and `<agentId>.last.txt` (Codex's own last-message file; Balancer writes it empty first, because Codex does not create the `runs/` folder).
- On session start, matching Codex run files older than seven days are pruned from `runs/`; missing folders and cleanup failures are ignored.
- Shared store (the engine's per-plugin JSON file): `reading/claude`, `reading/codex`, `estimate/<agent type>`, `inflight/<id>`, `claude-inflight/<id>`. Writes are last-write-wins, one key per item.

## Developing and checking

Run the mod from the folder with `claude --plugin-dir <folder>`. A copy installed through a marketplace is a snapshot of the folder at install time, kept under its version. To bring a code change into installed sessions, raise `version` in `.claude-plugin/plugin.json`, run `claude plugin marketplace update <marketplace>` and `claude plugin update balancer@<marketplace>`, then restart the sessions. The checks, from the repository root:

```
claude plugin validate .
tsc -p .
claude plugin test .
```

`tsc` needs the engine's own types laid in `.claude-plugin/types/claude-code/index.d.ts` (untracked, copied from the Claude Code build in use). The API reference is that file; grep it for the name at hand. `plugin validate` is the authority on what loads, and it follows `$` calls through imported functions as long as `$` and `on` are spelled literally.

Tests are `test/*.test.ts(x)`, with the Done-when number in the name (`dw3_...`). The test kit has no host processes, so Codex is stubbed with the tests' own `process.run` and `process.spawn` hooks that emit canned `codex exec --json` events and a canned rollout tail. No test spends quota. Property tests use a small seeded generator.

## Current limitations

- Codex's sandbox denies process listing (for example `pgrep`) even with extra writable folders, so a brief that needs it is blocked on Codex.
- Plan mode is seen at the next prompt: a hook cannot read the session mode, so a mode changed mid-turn is missed until the next prompt, or an Agent `mode` argument.
- The decision log is read and rewritten on each write, so concurrent sessions may lose a line.
- Decide-and-reserve is serialised per process only. Two sessions deciding at the same instant may both take the last Codex slot.
- Custom agent files are found by file name only (not the `name` field, not subfolders). No `SendMessage` continuation of a Codex-run task. Forks, worktree or remote isolation, named agents and workflow agents stay on Claude.
- A background Codex failure cannot fall back inside the call. It is reported in a message and followed by a 15-minute cooldown.
- A Claude limit with no known reset time is assumed to last one 5-hour window.
- Claude's task cost is a fixed constant, with no learning.
- Codex readings are whole points and can be minutes old. Margin, reservations and ceilings absorb this, so balance is approximate.
- Codex's rollout format and app-server protocol are internal to Codex and may change. A reader that no longer parses yields no reading and routes to Claude.
- Built and checked against Claude Code 2.1.321. `claude plugin validate` accepted the manifest and hooks on 2.1.301 too, but the mod was not run live there, and the manifest states no minimum version.
- Not covered by automated tests: real Codex, live command registration, a row redrawing when its state changes. The foreground interrupt is covered by calling the Agent hook directly with an abort signal over a hand-made `$` (the kit cannot abort a tool call), not through the kit's own tool-call path.
- The test kit cannot import fast-check, so property tests use a hand-written seeded generator.
