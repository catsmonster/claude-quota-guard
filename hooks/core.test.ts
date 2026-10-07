import { expect, test } from 'claude-code/testing'

import { DEFAULTS, FIVE, WEEK, initialState, step } from './core'
import type { Ev, Fx, State, Usage } from './core'

const T0 = 1_700_000_000_000
const MIN = 60_000
const cfg = { ...DEFAULTS }
const u = (pct: number, resetsAt = T0 + 90 * MIN, extra: Usage['windows'] = []): Usage => ({
  windows: [{ kind: FIVE, percent: pct, resetsAt }, ...extra],
})

function run(s: State, ...evs: Ev[]) {
  let state = s
  const fx: Fx[] = []
  for (const ev of evs) {
    const r = step(state, ev, cfg)
    state = r.state
    fx.push(...r.fx)
  }
  return { state, fx }
}
const has = (fx: Fx[], t: Fx['t']) => fx.some(f => f.t === t)

function pausedState(reset = T0 + 90 * MIN) {
  const s0 = run(initialState(), { type: 'userPrompt', now: T0, text: 'refactor the parser module', isUser: true }).state
  return run(s0, { type: 'measure', now: T0, usage: u(95, reset) }, { type: 'compactDone', now: T0 + 5000, ok: true }).state
}

test('80% only notifies once, 94% compacts then pauses', () => {
  let r = run(initialState(), { type: 'measure', now: T0, usage: u(81) }, { type: 'measure', now: T0, usage: u(82) })
  expect(r.fx.filter(f => f.t === 'toast').length).toBe(1)
  expect(r.state.rec.phase).toBe('idle')
  r = run(r.state, { type: 'measure', now: T0, usage: u(94) })
  expect(r.state.rec.phase).toBe('compacting')
  expect(has(r.fx, 'compact')).toBe(true)
  r = run(r.state, { type: 'compactDone', now: T0 + 1000, ok: true })
  expect(r.state.rec.phase).toBe('paused')
  expect(r.state.rec.wakeAt).toBe(T0 + 90 * MIN + 30_000)
})

test('busy turn: finishes first unless past abort threshold', () => {
  let r = run(initialState(), { type: 'turnStart' }, { type: 'measure', now: T0, usage: u(95) })
  expect(r.state.rec.phase).toBe('armed')
  expect(has(r.fx, 'abort')).toBe(false)
  r = run(r.state, { type: 'measure', now: T0, usage: u(98.5) })
  expect(has(r.fx, 'abort')).toBe(true)
  r = run(r.state, { type: 'turnComplete', now: T0, reason: 'aborted' })
  expect(r.state.rec.phase).toBe('compacting')
})

test('burn rate lowers the effective trigger', () => {
  const r = run(
    initialState(),
    { type: 'measure', now: T0, usage: u(60) },
    { type: 'measure', now: T0, usage: u(75) }, // 15-point jump
    { type: 'measure', now: T0, usage: u(80) },
  )
  expect(r.state.rec.phase).toBe('compacting') // 80 + 22.5 >= 99
})

test('context pressure never pauses (no rate-limit window)', () => {
  const r = run(initialState(), { type: 'measure', now: T0, usage: { windows: [], contextPercent: 97 } })
  expect(r.state.rec.phase).toBe('idle')
})

test('compaction failure still pauses', () => {
  const r = run(initialState(), { type: 'measure', now: T0, usage: u(100) }, { type: 'compactDone', now: T0, ok: false })
  expect(r.state.rec.phase).toBe('paused')
  expect(r.state.rec.compactFailed).toBe(true)
})

test('external compaction while armed counts', () => {
  const r = run(initialState(), { type: 'turnStart' }, { type: 'measure', now: T0, usage: u(95) }, { type: 'compactDone', now: T0, ok: true, external: true })
  expect(r.state.rec.phase).toBe('armed')
  const done = run(r.state, { type: 'turnComplete', now: T0, reason: 'answer' })
  expect(done.state.rec.phase).toBe('paused')
  expect(has(done.fx, 'compact')).toBe(false)
})

test('too early: no resume; after reset with fresh low reading: confirmed resume', () => {
  const p = pausedState()
  expect(has(run(p, { type: 'tick', now: T0 + 60 * MIN, usage: u(95) }).fx, 'submit')).toBe(false)
  const r = run(p, { type: 'tick', now: T0 + 91 * MIN, usage: u(2, T0 + 300 * MIN) })
  expect(r.state.rec.phase).toBe('resuming')
  const sub = r.fx.find(f => f.t === 'submit') as Extract<Fx, { t: 'submit' }>
  expect(sub.text).toContain('Do not restart completed work')
  expect(sub.text).toContain('refactor the parser module')
})

test('stale reading after reset resumes as a probe; probe failure goes back to paused', () => {
  const p = pausedState()
  let r = run(p, { type: 'tick', now: T0 + 91 * MIN, usage: u(95) })
  expect(r.state.rec.phase).toBe('resuming')
  r = run(r.state, { type: 'measure', now: T0 + 92 * MIN, usage: u(100, T0 + 94 * MIN) })
  expect(r.state.rec.phase).toBe('paused')
  expect(r.state.rec.wakeAt).toBeGreaterThanOrEqual(T0 + 94 * MIN)
})

test('reset time moved later while limited: keeps waiting', () => {
  const p = pausedState()
  const r = run(p, { type: 'tick', now: T0 + 91 * MIN, usage: u(100, T0 + 100 * MIN) })
  expect(r.state.rec.phase).toBe('paused')
  expect(r.state.rec.expectedReset).toBe(T0 + 100 * MIN)
})

test('usage unavailable retries, then assumes reset after repeated blindness', () => {
  let s = pausedState()
  let t = T0 + 91 * MIN
  for (let i = 0; i < 2; i++) {
    s = run(s, { type: 'tick', now: t, usage: null }).state
    expect(s.rec.phase).toBe('paused')
    t = s.rec.wakeAt as number
  }
  const r = run(s, { type: 'tick', now: t, usage: null })
  expect(r.state.rec.phase).toBe('resuming')
})

test('never loops forever: gives up after maxResumeAttempts', () => {
  let s = pausedState()
  let t = T0 + 91 * MIN
  for (let i = 0; i < cfg.maxResumeAttempts + 1 && s.rec.phase !== 'stopped'; i++) {
    s = run(s, { type: 'tick', now: t, usage: u(95) }).state
    if (s.rec.phase === 'resuming') s = run(s, { type: 'turnComplete', now: t, reason: 'error' }).state
    t = (s.rec.wakeAt ?? t) + 1000
  }
  expect(s.rec.phase).toBe('stopped')
})

test('successful resume is confirmed by next measurement and clears the record', () => {
  const r = run(pausedState(), { type: 'tick', now: T0 + 91 * MIN, usage: u(2, T0 + 300 * MIN) }, { type: 'measure', now: T0 + 92 * MIN, usage: u(3, T0 + 300 * MIN) })
  expect(r.state.rec.phase).toBe('idle')
  expect(r.state.rec.task).toBe('refactor the parser module')
})

test('weekly exhausted pauses until the weekly reset', () => {
  const week = { kind: WEEK, percent: 100, resetsAt: T0 + 3 * 24 * 60 * MIN }
  const r = run(initialState(), { type: 'measure', now: T0, usage: u(10, T0 + 200 * MIN, [week]) }, { type: 'compactDone', now: T0, ok: true })
  expect(r.state.rec.phase).toBe('paused')
  expect(r.state.rec.expectedReset).toBe(week.resetsAt)
})

test('weekly notify policy does not pause', () => {
  const week = { kind: WEEK, percent: 100, resetsAt: T0 + 1000 * MIN }
  const r = step(initialState(), { type: 'measure', now: T0, usage: u(10, T0 + 200 * MIN, [week]) }, { ...cfg, weeklyPolicy: 'notify' })
  expect(r.state.rec.phase).toBe('idle')
})

test('restart while paused: boot restores and resumes once the time has passed', () => {
  const p = JSON.parse(JSON.stringify(pausedState())) as State // as read back from the store
  expect(run(p, { type: 'boot', now: T0 + 10 * MIN, usage: u(95) }).state.rec.phase).toBe('paused')
  const r = run(p, { type: 'boot', now: T0 + 95 * MIN, usage: u(2, T0 + 400 * MIN) })
  expect(r.state.rec.phase).toBe('resuming')
})

test('manual prompt while paused cancels auto-resume; non-user prompts are held', () => {
  const p = pausedState()
  const r = run(p, { type: 'userPrompt', now: T0 + MIN, text: 'continue please, I am back', isUser: true })
  expect(r.state.rec.phase).toBe('idle')
})

test('cancel holds without re-arming; resume forces a resume', () => {
  let r = run(pausedState(), { type: 'cancel', now: T0 + MIN })
  expect(r.state.rec.phase).toBe('stopped')
  r = run(r.state, { type: 'measure', now: T0 + 2 * MIN, usage: u(99) })
  expect(r.state.rec.phase).toBe('stopped')
  r = run(r.state, { type: 'resume', now: T0 + 3 * MIN })
  expect(r.state.rec.phase).toBe('resuming')
})

test('submit failure falls back to the prompt box', () => {
  const r = run(pausedState(), { type: 'submitFailed', now: T0, text: 'continue' })
  expect(has(r.fx, 'fill')).toBe(true)
})

test('already near the limit at load arms immediately', () => {
  const r = run(initialState(), { type: 'boot', now: T0, usage: u(97) })
  expect(r.state.rec.phase).toBe('compacting')
})

test('disabled does nothing', () => {
  const r = step(initialState(), { type: 'measure', now: T0, usage: u(99) }, { ...cfg, enabled: false })
  expect(r.state.rec.phase).toBe('idle')
})

test('small context: pause without compacting; large context compacts first', () => {
  const small = run(initialState(), { type: 'measure', now: T0, usage: { ...u(95), contextPercent: 22 } })
  expect(small.state.rec.phase).toBe('paused')
  expect(has(small.fx, 'compact')).toBe(false)
  expect(small.state.rec.wakeAt).toBe(T0 + 90 * MIN + 30_000)
  const big = run(initialState(), { type: 'measure', now: T0, usage: { ...u(95), contextPercent: 45 } })
  expect(big.state.rec.phase).toBe('compacting')
  expect(has(big.fx, 'compact')).toBe(true)
})

test('small context while a turn runs: pauses at turn end without compacting', () => {
  const r = run(
    initialState(),
    { type: 'turnStart' },
    { type: 'measure', now: T0, usage: { ...u(95), contextPercent: 10 } },
    { type: 'turnComplete', now: T0, reason: 'answer' },
  )
  expect(r.state.rec.phase).toBe('paused')
  expect(has(r.fx, 'compact')).toBe(false)
})

test('forced pause respects the context rule', () => {
  const r = run(initialState(), { type: 'measure', now: T0, usage: { windows: [], contextPercent: 5 } }, { type: 'forcePause', now: T0, minutes: 2 })
  expect(r.state.rec.phase).toBe('paused')
})
