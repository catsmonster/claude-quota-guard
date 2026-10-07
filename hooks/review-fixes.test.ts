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
  // both under their limits: verified
  expect(step(s, { type: 'measure', now: T + 3 * MIN, usage: { windows: [five(3, T + 300 * MIN), week(10)] } }, DEFAULTS).state.rec.phase).toBe('idle')
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
