// Synthetic Codex rollout lines. Shapes follow PRD 6.2; no real content.
export const MARKER = 'SECRET-CONTENT-XYZ'

export const rl = (primary: unknown, secondary: unknown, reached: unknown = null) => ({
  limit_id: 'codex',
  primary,
  secondary,
  plan_type: 'plus',
  rate_limit_reached_type: reached,
  credits: { has_credits: false, unlimited: false, balance: '0' },
})

export const win5h = { used_percent: 96, window_minutes: 300, resets_at: 1_800_000_000 }
export const win7d = { used_percent: 46, window_minutes: 10080, resets_at: 1_800_500_000 }

export const tokenCount = (rate_limits: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp: 't',
    type: 'event_msg',
    payload: { type: 'token_count', info: { total: 1 }, rate_limits, ...extra },
  })

export const cutRecord = '"tail of a record cut by tail -c","n":1}}'
export const lines = (...l: string[]) => l.join('\n') + '\n'

export const appServerOut = (rateLimits: unknown) =>
  lines(
    JSON.stringify({ id: 1, result: { userAgent: 'codex' } }),
    JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 5 } } } }),
    'not json at all',
    JSON.stringify({ id: 2, result: { rateLimits } }),
    JSON.stringify({ method: 'other/notification', params: {} }),
  )
