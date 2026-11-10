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
