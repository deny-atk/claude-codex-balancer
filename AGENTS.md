# Balancer

A Claude Code mod (function-hooks plugin). When Claude Code starts a subagent,
Balancer decides whether the task runs as a normal Claude subagent or is run by
the local Codex CLI, so the Claude and ChatGPT/Codex subscriptions are used at a
similar pace. Behaviour: `docs/balancer.md`.

## Layout

- `.claude-plugin/plugin.json`: manifest, `userConfig`, `types`.
- `hooks/register.ts`: wiring only (hooks, commands, status).
- `hooks/policy.ts`: pure routing maths. No `$` calls.
- `hooks/readings.ts`: Claude and Codex usage readers, normalisation.
- `hooks/codex.ts`: Codex process invocation, event parsing, result building.
- `types/index.d.ts`: the `$.state` / `$.store` contract.
- `test/*.test.ts`: run by `claude plugin test`.

## Rules

- API reference: the engine's types file. Grep it for the name at hand; do not
  read it whole. `claude plugin validate` is the authority on what loads.
- No runtime dependencies. No `$.model.*` calls. Never change the system prompt
  and never register or remove tools after `session.start`.
- Codex rollout files hold session content: read only the last 64 KB and keep
  only the `rate_limits` object. Never log or store any other part.
- The decision log is content-free: no brief or report text.
- Tests come first and carry the Done-when number in their names (`dw3_...`).
  Codex is a stub in tests; no test spends real quota.

## Checks

```
claude plugin validate .
tsc -p .
claude plugin test .
```

Task notes (spike results, decisions, check results) live in the untracked
`notes/` folder.

## Installing and live testing

Every install or update of a plugin reloads plugins in all open sessions
(sessions in the background apply it later). A reload kills Balancer's
in-flight Codex runs, so installs are rare and deliberate:

- The installed copy comes from a separate clean checkout of `main`, outside
  this working folder, never from a branch or a working tree. The local
  marketplace points at that checkout in two places: its entry in
  `~/.claude/plugins/known_marketplaces.json`, and its entry under
  `extraKnownMarketplaces` in `~/.claude/settings.json` if there is one. The
  engine restores the marketplace from the settings entry, so a switch made in
  the first file alone is undone. Check `claude plugin list`: it names the
  folder the plugin is read from.
- Update it only after a merge, and only when no Codex run is in flight in
  any session. The plugin's store file under `~/.claude/plugins/store/` has no
  `inflight/` or `run/` keys then, and `pgrep -f "codex exec"` finds nothing.
- Update steps:

  ```
  git -C <clean checkout> pull --ff-only
  claude plugin marketplace update <marketplace>
  claude plugin update balancer@<marketplace>
  ```

  An update to the same version changes nothing and reloads nothing. A version
  already in the plugin cache is reused as it stands, so every merge that
  changes the plugin bumps its version.

Branch builds are tested with `claude plugin test` and, live, only in
headless sessions:

- Copy the working tree outside the repository. A copy inside it is picked up
  by `claude plugin test`.
- Load the copy with `--plugin-dir <copy>` and a `--settings` file that sets
  `enabledPlugins` `"balancer@<marketplace>": false`.
- Such a session does not reload the folder when files change, and it reloads
  no other session.
- It shares the data folder, and so the decision log, with the installed copy.
- It has a store of its own, so set `mode` `codex` when a run must go to Codex.
