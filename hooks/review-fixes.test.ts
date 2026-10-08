import { expect, mock, test } from 'claude-code/testing'

import { DEFAULTS, FIVE, WEEK, initialState, step } from './core'
import type { Ev, State, Usage } from './core'

const T = 1_700_000_000_000
const MIN = 60_000
const DAY = 24 * 60 * MIN

const five = (pct: number, reset = T + MIN): Usage['windows'][number] => ({ kind: FIVE, percent: pct, resetsAt: reset })
const week = (pct: number, reset = T + 3 * DAY): Usage['windows'][number] => ({ kind: WEEK, percent: pct, resetsAt: reset })
const run = (state: State, ...events: Ev[]) => {
  for (const ev of events) state = step(state, ev, DEFAULTS).state
  return state
}

test('a window exhausted while the resume probe is running blocks the resume', () => {
  // paused on the five-hour window alone, then woken after its reset
  let s = run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95), week(40)], contextPercent: 10 } })
  s = run(s, { type: 'tick', now: T + 2 * MIN, usage: { windows: [five(95), week(40)] } })
  expect(s.rec.phase).toBe('resuming')
  // the five-hour window is fine again, but the weekly one has now run out
  const r = step(s, { type: 'measure', now: T + 3 * MIN, usage: { windows: [five(3, T + 300 * MIN), week(100)] } }, DEFAULTS)
  expect(r.state.rec.phase).toBe('paused')
  expect(r.state.rec.expectedReset).toBe(T + 3 * DAY)
})

test('while resuming, only readings under every limit verify the reset', () => {
  let s = run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95), week(99, T + MIN)], contextPercent: 10 } })
  s = run(s, { type: 'tick', now: T + 2 * MIN, usage: { windows: [five(95), week(99, T + MIN)] } })
  expect(s.rec.phase).toBe('resuming')
  // the five-hour window recovered, the weekly one is not known to have: not verified yet
  expect(step(s, { type: 'measure', now: T + 3 * MIN, usage: { windows: [five(3, T + 300 * MIN)] } }, DEFAULTS).state.rec.phase).toBe('resuming')
  // both under their limits, and the continuation delivered: verified
  const delivered = step(s, { type: 'resumeDelivered', now: T + 3 * MIN, op: s.rec.op as number }, DEFAULTS).state
  expect(step(delivered, { type: 'measure', now: T + 3 * MIN, usage: { windows: [five(3, T + 300 * MIN), week(10)] } }, DEFAULTS).state.rec.phase).toBe('idle')
})

test('quota verified before the prompt is delivered does not finish the resume; delivery then does', () => {
  const s = run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95)], contextPercent: 10 } })
  const woke = run(s, { type: 'tick', now: T + 2 * MIN, usage: { windows: [five(95)] } })
  expect(woke.rec.phase).toBe('resuming')
  const seen = step(woke, { type: 'measure', now: T + 3 * MIN, usage: { windows: [five(3, T + 300 * MIN)] } }, DEFAULTS).state
  expect(seen.rec.phase).toBe('resuming') // not done: the prompt has not gone out
  expect(seen.rec.verified).toBe(true)
  const done = step(seen, { type: 'resumeDelivered', now: T + 3 * MIN, op: seen.rec.op as number }, DEFAULTS).state
  expect(done.rec.phase).toBe('idle')
})

test('a delivery or failure for an old operation changes nothing', () => {
  const woke = run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95)], contextPercent: 10 } }, { type: 'tick', now: T + 2 * MIN, usage: { windows: [five(95)] } })
  const op = woke.rec.op as number
  expect(step(woke, { type: 'resumeDelivered', now: T + 3 * MIN, op: op - 1 }, DEFAULTS).state.rec.delivered).toBe(false)
  expect(step(woke, { type: 'resumeDelivered', now: T + 3 * MIN, op }, DEFAULTS).state.rec.delivered).toBe(true)
  // a failure naming an older operation does not stop the current resume either
  const stale = step(woke, { type: 'submitFailed', now: T + 3 * MIN, text: 'x', op: op - 1 }, DEFAULTS)
  expect(stale.state.rec.phase).toBe('resuming')
  expect(stale.fx.some(f => f.t === 'fill')).toBe(false)
})

// ---- verification must be right whichever order delivery and the reading arrive in ----
// (a test that measures before delivering cannot tell a correct verdict from a wrong one: the resume
// stays 'resuming' either way. These check the verified flag itself, and also deliver FIRST.)
const pausedOnFiveWithWeekKnown = () =>
  run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95), week(40)], contextPercent: 10 } })
const woken = () => run(pausedOnFiveWithWeekKnown(), { type: 'tick', now: T + 2 * MIN, usage: { windows: [five(95), week(40)] } })
const deliveredFirst = () => {
  const s = woken()
  return run(s, { type: 'resumeDelivered', now: T + 2 * MIN, op: s.rec.op as number })
}
const readings: [string, Usage['windows']][] = [
  ['the known weekly window is missing', [five(3, T + 300 * MIN)]],
  ['a newly exhausted weekly window has no reset time', [five(3, T + 300 * MIN), { kind: WEEK, percent: 100 }]],
  ['a newly exhausted weekly window has an expired reset time', [five(3, T + 300 * MIN), { kind: WEEK, percent: 100, resetsAt: T + MIN }]],
]
for (const [why, windows] of readings) {
  test(`not verified when ${why} (measure first, then deliver)`, () => {
    let s = step(woken(), { type: 'measure', now: T + 3 * MIN, usage: { windows } }, DEFAULTS).state
    expect(s.rec.verified).not.toBe(true)
    s = step(s, { type: 'resumeDelivered', now: T + 3 * MIN, op: s.rec.op as number }, DEFAULTS).state
    expect(s.rec.phase).toBe('resuming')
  })
  test(`not verified when ${why} (deliver first, then measure)`, () => {
    const s = step(deliveredFirst(), { type: 'measure', now: T + 3 * MIN, usage: { windows } }, DEFAULTS).state
    expect(s.rec.phase).toBe('resuming')
  })
}

test('both windows healthy verifies in either order', () => {
  const healthy = { windows: [five(3, T + 300 * MIN), week(40)] }
  const measureFirst = step(woken(), { type: 'measure', now: T + 3 * MIN, usage: healthy }, DEFAULTS).state
  expect(measureFirst.rec.verified).toBe(true)
  expect(step(measureFirst, { type: 'resumeDelivered', now: T + 3 * MIN, op: measureFirst.rec.op as number }, DEFAULTS).state.rec.phase).toBe('idle')
  expect(step(deliveredFirst(), { type: 'measure', now: T + 3 * MIN, usage: healthy }, DEFAULTS).state.rec.phase).toBe('idle')
})

test('verification is withdrawn when a later reading contradicts it, then delivery cannot finish the resume', () => {
  const verified = step(woken(), { type: 'measure', now: T + 3 * MIN, usage: { windows: [five(3, T + 300 * MIN), week(40)] } }, DEFAULTS).state
  expect(verified.rec.verified).toBe(true)
  const contradicted = step(verified, { type: 'measure', now: T + 3 * MIN + 1, usage: { windows: [five(3, T + 300 * MIN), { kind: WEEK, percent: 100 }] } }, DEFAULTS).state
  expect(contradicted.rec.verified).toBe(false)
  const delivered = step(contradicted, { type: 'resumeDelivered', now: T + 4 * MIN, op: contradicted.rec.op as number }, DEFAULTS).state
  expect(delivered.rec.phase).toBe('resuming')
})

test('a window first seen by boot or by a heartbeat is remembered for verification', () => {
  const viaBoot = run(initialState(), { type: 'boot', now: T, usage: { windows: [five(95), week(40)], contextPercent: 10 } })
  expect(viaBoot.known).toContain(WEEK)
  const viaTick = run(
    run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95)], contextPercent: 10 } }),
    { type: 'tick', now: T + 2 * MIN, usage: { windows: [five(3, T + 300 * MIN), week(40)] } },
  )
  expect(viaTick.known).toContain(WEEK)
})

test('a pause is released early by a fresh reading under the limit', () => {
  const s = run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95, T + 60 * MIN)], contextPercent: 10 } })
  expect(s.rec.phase).toBe('paused')
  const r = step(s, { type: 'measure', now: T + 5 * MIN, usage: { windows: [five(4, T + 300 * MIN)] } }, DEFAULTS)
  expect(r.state.rec.wakeAt).toBe(T + 5 * MIN) // checked at the very next heartbeat, not an hour later
})

const v = (value: unknown) => ({ value }) as any

test('the shared store keeps only the most recent sessions', async ($, on) => {
  mock.clock(on, { now: T })
  const store = new Map<string, unknown>()
  const index = Array.from({ length: 30 }, (_, i) => ({ sid: 'old' + i, at: T - (i + 1) * MIN }))
  store.set('index', index)
  for (const e of index) store.set('state:' + e.sid, { v: 1 })
  on('session.id', () => v('now'))
  on('store.get', (_$: any, e: any) => v(store.get(e.key)))
  on('store.set', (_$: any, e: any) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), v(undefined)))
  on('store.delete', (_$: any, e: any) => (store.delete(e.key), v(undefined)))
  on('ui.log', () => v(undefined))
  on('ui.toast', () => v(undefined))
  on('ui.status', () => v(undefined))
  on('ui.open', () => v({}))
  on('command.register', (_$: any, e: any) => v({ command: e.name }))
  on('session.surfaces', () => v(['desktop']))
  on('session.usage', () => v({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] }))

  await $.command.run({ command: 'quota', args: 'status' } as any)

  const kept = (store.get('index') as { sid: string }[]).map(x => x.sid)
  expect(kept.length).toBe(25)
  expect(kept[0]).toBe('now') // this session is the most recent
  expect(store.has('state:old0')).toBe(true) // recent ones stay
  expect(store.has('state:old29')).toBe(false) // the oldest are forgotten
})
