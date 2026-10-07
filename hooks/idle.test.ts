import { expect, test } from 'claude-code/testing'

import { IDLE_DEFAULTS, clearOnNotification, idleInstructions, pendingFromTool, planIdleCompact } from './idle'
import type { IdleInput, Pending } from './idle'

const T0 = 1_700_000_000_000
const MIN = 60_000
const cfg = { ...IDLE_DEFAULTS } // 200k tokens, 60 min cache, 3 min margin
const job: Pending = { id: 'a', kind: 'bash', label: 'Run the full test suite', command: 'npm test', at: T0 }
const base: IdleInput = { now: T0 + 10 * MIN, lastResponseAt: T0, tokens: 300_000, busy: false, pending: [job], quotaPhase: 'idle' }

test('waits until the cache nears expiry, then acts', () => {
  const early = planIdleCompact(cfg, base)
  expect(early.act).toBe(false)
  expect(early.at).toBe(T0 + 57 * MIN)
  expect(planIdleCompact(cfg, { ...base, now: T0 + 57 * MIN }).act).toBe(true)
  expect(planIdleCompact(cfg, { ...base, now: T0 + 59 * MIN }).act).toBe(true)
})

test('never compacts once the cache is already cold (it would save nothing)', () => {
  const d = planIdleCompact(cfg, { ...base, now: T0 + 61 * MIN })
  expect(d.act).toBe(false)
  expect(d.why).toContain('cold')
})

test('a 5-minute cache fires after about 4 minutes', () => {
  const c = { ...cfg, ttlMs: 5 * MIN, marginMs: 60_000 }
  expect(planIdleCompact(c, { ...base, now: T0 + MIN }).at).toBe(T0 + 4 * MIN)
  expect(planIdleCompact(c, { ...base, now: T0 + 4 * MIN + 1000 }).act).toBe(true)
})

test('by default any idle session qualifies; "waiting only" needs background work', () => {
  const at = { ...base, now: T0 + 58 * MIN }
  expect(planIdleCompact(cfg, { ...at, pending: [] }).act).toBe(true)
  const strict = { ...cfg, requireWaiting: true }
  expect(planIdleCompact(strict, { ...at, pending: [] }).act).toBe(false)
  expect(planIdleCompact(strict, at).act).toBe(true)
})

test('needs enough context and an idle session', () => {
  const at = { ...base, now: T0 + 58 * MIN }
  expect(planIdleCompact(cfg, { ...at, tokens: 150_000 }).act).toBe(false)
  expect(planIdleCompact(cfg, { ...at, tokens: undefined }).act).toBe(false)
  expect(planIdleCompact(cfg, { ...at, busy: true }).act).toBe(false)
  expect(planIdleCompact(cfg, { ...at, quotaPhase: 'paused' }).act).toBe(false)
  expect(planIdleCompact({ ...cfg, enabled: false }, at).act).toBe(false)
})

test('compacts at most once per response', () => {
  const at = { ...base, now: T0 + 58 * MIN }
  expect(planIdleCompact(cfg, { ...at, lastIdleCompactAt: T0 + 57 * MIN }).act).toBe(false)
  // a newer response resets the clock, so the old compaction no longer counts
  expect(planIdleCompact(cfg, { ...at, lastResponseAt: T0 + 20 * MIN, lastIdleCompactAt: T0 + 5 * MIN, now: T0 + 78 * MIN }).act).toBe(true)
})

test('stale pending entries do not count as waiting', () => {
  const old: Pending = { ...job, at: T0 - 7 * 3600_000 }
  const now = T0 + 58 * MIN
  expect(planIdleCompact({ ...cfg, requireWaiting: true }, { ...base, now, pending: [old] }).act).toBe(false)
})

test('background tool calls are recognised, foreground ones are not', () => {
  expect(pendingFromTool('Bash', { command: 'npm test', run_in_background: true, description: 'Run tests' }, 'x', T0)?.kind).toBe('bash')
  expect(pendingFromTool('Bash', { command: 'ls' }, 'x', T0)).toBe(undefined)
  expect(pendingFromTool('Monitor', { description: 'Watch the build', command: 'tail -f log', timeout_ms: 60000 }, 'x', T0)?.kind).toBe('monitor')
  expect(pendingFromTool('Agent', { description: 'Research it', prompt: 'p' }, 'x', T0)?.kind).toBe('agent')
  expect(pendingFromTool('Agent', { description: 'Research it', prompt: 'p', run_in_background: false }, 'x', T0)).toBe(undefined)
  expect(pendingFromTool('Read', { file_path: 'a' }, 'x', T0)).toBe(undefined)
})

test('a notification clears the matching job, else the oldest', () => {
  const a: Pending = { id: '1', kind: 'bash', label: 'Build the docs', at: T0 }
  const b: Pending = { id: '2', kind: 'bash', label: 'Run the full test suite', at: T0 + 1 }
  expect(clearOnNotification([a, b], 'Background task "Run the full test suite" completed').map(p => p.id)).toEqual(['1'])
  expect(clearOnNotification([a, b], 'something finished').map(p => p.id)).toEqual(['2'])
  expect(clearOnNotification([], 'x')).toEqual([])
})

test('compaction instructions lead with what is awaited', () => {
  const text = idleInstructions([job], 'make the tests pass')
  expect(text).toContain('waiting on background work')
  expect(text).toContain('npm test')
  expect(text).toContain('make the tests pass')
})

test('with nothing pending the instructions are about the task, not a wait', () => {
  const text = idleInstructions([], 'make the tests pass')
  expect(text).not.toContain('Waiting on:')
  expect(text).toContain('idle for a while')
  expect(text).toContain('make the tests pass')
})
