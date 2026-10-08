// Adversarial review of ce9942c + 88535d0; production files are not changed.
import { expect, mock, test } from 'claude-code/testing'
import { DEFAULTS, FIVE, WEEK, initialState, step } from './core'
import type { Ev, State, Usage, Win } from './core'
const T = 1_700_000_000_000
const MIN = 60_000
const DAY = 24 * 60 * MIN
const five = (percent: number, resetsAt = T + MIN): Win => ({ kind: FIVE, percent, resetsAt })
const week = (percent: number, resetsAt = T + 3 * DAY): Win => ({ kind: WEEK, percent, resetsAt })
const u = (...windows: Win[]): Usage => ({ windows, contextPercent: 10 })
const run = (s: State, ...events: Ev[]) => {
  for (const ev of events) s = step(s, ev, DEFAULTS).state
  return s
}
const paused = () => run(initialState(), { type: 'measure', now: T, usage: u(five(95), week(40)) })
const probe = () => run(paused(), { type: 'resume', now: T })
const burnPause = () => run(initialState(),
  { type: 'measure', now: T, usage: u(five(60, T + 300 * MIN), week(40, T + 60 * MIN)) },
  { type: 'measure', now: T, usage: u(five(80, T + 300 * MIN), week(40, T + 60 * MIN)) })
const joinedBurnPause = () => run(burnPause(),
  { type: 'measure', now: T + MIN, usage: u(five(80, T + 300 * MIN), week(100, T + 60 * MIN)) })

test('a turn starting during the stagger wait cannot finish the undelivered continuation', () => {
  let s = probe()
  expect(s.rec.olderTurnRunning).toBe(false)
  s = run(s, { type: 'userPrompt', now: T, text: 'automatic status task', isUser: false },
    { type: 'turnStart', turnId: 'automatic-turn' },
    { type: 'turnComplete', now: T + 1000, reason: 'answer', turnId: 'automatic-turn' })
  expect(s.rec.phase).toBe('resuming')
})

test('completion of an older turn must not clear the current running turn', () => {
  let s = run(paused(), { type: 'turnStart', turnId: 'older' }, { type: 'resume', now: T },
    { type: 'turnStart', turnId: 'continuation' },
    { type: 'turnComplete', now: T + 1000, reason: 'answer', turnId: 'older' })
  expect(s.busy).toBe(true)
  expect(s.turnId).toBe('continuation')
})

test('a heartbeat reporting exhaustion revokes pre-delivery verification', () => {
  let s = run(probe(), { type: 'measure', now: T + 100, usage: u(five(3, T + 300 * MIN), week(40)) })
  expect(s.rec.verified).toBe(true)
  const op = s.rec.op as number
  s = run(s, { type: 'tick', now: T + 1000, usage: u(five(3, T + 300 * MIN), week(100)) },
    { type: 'resumeDelivered', now: T + 2000, op })
  expect(s.rec.phase).not.toBe('idle')
})

test('a newly joining weekly breach cannot release the original predictive five-hour pause', () => {
  let s = joinedBurnPause()
  expect(s.rec.predictive).toBe(true)
  expect(s.rec.kinds).toContain(WEEK)
  s = run(s, { type: 'measure', now: T + 61 * MIN, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) })
  const r = step(s, { type: 'tick', now: T + 61 * MIN + 1, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('a joining weekly window resetting does not verify an unchanged predictive five-hour window', () => {
  let s = run(joinedBurnPause(), { type: 'resume', now: T + 61 * MIN })
  s = run(s, { type: 'measure', now: T + 61 * MIN + 1, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) })
  expect(s.rec.verified).not.toBe(true)
})

test('a shorter joining weekly reset cannot shorten the original predictive pause at wake', () => {
  const s = joinedBurnPause()
  const r = step(s, { type: 'tick', now: T + 61 * MIN, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('control: a predictive pause can release when its five-hour window actually advances', () => {
  let s = burnPause()
  s = run(s, { type: 'measure', now: T + 301 * MIN, usage: u(five(3, T + 600 * MIN), week(40, T + 7 * DAY)) })
  const r = step(s, { type: 'tick', now: T + 301 * MIN + 1, usage: u(five(3, T + 600 * MIN), week(40, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(true)
})

test('control: completion of the turn already running at resume leaves the continuation pending', () => {
  let s = run(paused(), { type: 'turnStart', turnId: 'older' }, { type: 'resume', now: T },
    { type: 'turnComplete', now: T + 1000, reason: 'answer', turnId: 'older' })
  expect(s.rec.phase).toBe('resuming')
  expect(s.rec.olderTurnRunning).toBe(false)
})

const value = (value: unknown) => ({ value }) as any
const summary = { messages: [{ role: 'user', text: 'compacted summary', toolUses: [] }] } as any
function world(on: any, opts: {
  saved?: State; tokens?: number; entries?: [string, unknown][];
  compact?: () => Promise<unknown>;
  get?: (key: string, store: Map<string, unknown>) => Promise<unknown> | unknown;
  usage?: (request: any, reading: any) => Promise<unknown> | unknown;
} = {}) {
  const clock = mock.clock(on, { now: T })
  const store = new Map<string, unknown>(opts.entries)
  if (opts.saved) store.set('state:s1', opts.saved)
  const seen = { submits: [] as string[], compacts: 0, logs: [] as string[] }
  let sid = 's1'
  const tokens = opts.tokens ?? 100_000
  const reading = { startedAt: T, context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [{ kind: FIVE, percentUsed: 40, resetsAt: new Date(T + 300 * MIN).toISOString() }] }
  on('session.id', () => value(sid))
  on('store.get', async (_$: any, e: any) => value(opts.get ? await opts.get(e.key, store) : store.get(e.key)))
  on('store.set', (_$: any, e: any) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return value(undefined) })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return value(undefined) })
  on('store.keys', () => value([...store.keys()]))
  on('ui.log', (_$: any, e: any) => { seen.logs.push(JSON.stringify(e)); return value(undefined) })
  on('ui.toast', () => value(undefined))
  on('ui.status', () => value(undefined))
  on('ui.open', () => value({}))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('session.surfaces', () => value(['desktop']))
  on('session.usage', async (_$: any, e: any) => value(opts.usage ? await opts.usage(e, reading) : reading))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as any)
  on('session.compact', async () => { seen.compacts++; return (opts.compact ? await opts.compact() : summary) as any })
  on('prompt.submit', (_$: any, e: any) => { seen.submits.push(e.text); return { text: e.text } as any })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
  on('session.attach', (_$: any, e: any) => ({ clientId: e.clientId ?? 'desktop-1' }) as any)
  return { clock, store, seen, reading, changeSession: (id: string) => { sid = id } }
}
const command = ($: any, args: string) => $.command.run({ command: 'quota', args } as any)
const composer = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
const clear = ($: any) => $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
const start = ($: any, turnId: string) => $.turn.start({ turnId, prompt: 'task' } as any)
const complete = ($: any, turnId: string) => $.turn.complete({ answer: 'Earlier turn completed', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as any)

test('an automatic turn during the stagger wait cannot swallow the queued continuation', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await $.prompt.submit({ text: 'automatic status task', wait: false, origin: { kind: 'plugin', name: 'other-plugin' } } as any)
  await start($, 'automatic-turn')
  await complete($, 'automatic-turn')
  await w.clock.advance(10_000)
  expect(w.seen.submits.filter(text => text.startsWith('Usage window has reset.')).length).toBe(1)
})

test('heartbeat exhaustion prevents a previously verified delayed continuation from settling', async ($, on) => {
  const w = world(on, { saved: paused(), entries: [['lastResume', T + 40_000]] })
  await command($, 'resume')
  await $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 3, resetsAt: new Date(T + 300 * MIN).toISOString() }, { kind: WEEK, percentUsed: 40, resetsAt: new Date(T + 3 * DAY).toISOString() }], changed: ['rateLimits'] } as any)
  w.reading.rateLimits = [{ kind: FIVE, percentUsed: 3, resetsAt: new Date(T + 300 * MIN).toISOString() }, { kind: WEEK, percentUsed: 100, resetsAt: new Date(T + 3 * DAY).toISOString() }]
  await w.clock.advance(61_000)
  expect((w.store.get('state:s1') as State).rec.phase).not.toBe('idle')
})

test('an old prompt waiting for load cannot overwrite a newly loaded session task', async ($, on) => {
  let release: ((data: unknown) => void) | undefined
  let held = false
  const w = world(on, { get: (key, store) => {
    if (key === 'cfg' && !held) { held = true; return new Promise(resolve => { release = resolve }) }
    return store.get(key)
  } })
  const oldPrompt = composer($, 'OLD SESSION TASK')
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  release?.({})
  await oldPrompt
  await w.clock.advance(0)
  expect((w.store.get('state:s2') as State).rec.task).toBe('NEW SESSION TASK')
})

test('an old external compact hook cannot mark a new armed pause as compacted', async ($, on) => {
  const s = initialState(); s.ctx = 50
  let release: ((data: unknown) => void) | undefined
  const w = world(on, { saved: s, tokens: 500_000, compact: () => new Promise(resolve => { release = resolve }) })
  const compacting = $.session.compact({ trigger: 'manual', messages: summary.messages } as any)
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  await start($, 'new-turn')
  await $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 95, resetsAt: new Date(T + 300 * MIN).toISOString() }], changed: ['rateLimits'] } as any)
  expect((w.store.get('state:s2') as State).rec.phase).toBe('armed')
  release?.(summary)
  await compacting
  await w.clock.advance(1)
  expect((w.store.get('state:s2') as State).rec.compactedAt).toBe(undefined)
})

test('completion of an old idle compaction cannot write statistics into the new session', async ($, on) => {
  let release: ((data: unknown) => void) | undefined
  const w = world(on, { tokens: 300_000, compact: () => new Promise(resolve => { release = resolve }) })
  await command($, 'idle ttl 2')
  await command($, 'idle margin 60')
  await complete($, 'old-turn')
  await w.clock.advance(MIN + 1)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  release?.(summary)
  await w.clock.advance(1)
  expect(w.store.has('idle:s2')).toBe(false)
})

test('a scheduled synthetic measurement cannot recreate state after clear', async ($, on) => {
  const s = initialState(); s.ctx = 10
  const w = world(on, { saved: s })
  await command($, 'test on')
  await command($, 'sim clear')
  await command($, 'pause 2')
  await command($, 'resume')
  await w.clock.advance(0)
  await clear($)
  w.changeSession('s2')
  await w.clock.advance(2000)
  expect(w.store.has('state:s2')).toBe(false)
})

test('a startup usage read from an old session cannot arm the new session', async ($, on) => {
  let release: ((data: unknown) => void) | undefined
  let held = false
  const w = world(on, { usage: (e, reading) => {
    if (!e.breakdown && !held) { held = true; return new Promise(resolve => { release = resolve }) }
    return reading
  } })
  const attaching = $.session.attach({ surface: 'desktop' } as any)
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  release?.({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 100, resetsAt: new Date(T + 300 * MIN).toISOString() }] })
  await attaching
  await w.clock.advance(0)
  expect((w.store.get('state:s2') as State).rec.phase).toBe('idle')
})

test('control: a normal delayed continuation is submitted exactly once', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(1)
})

test('control: idle compaction records statistics in its original session', async ($, on) => {
  let release: ((data: unknown) => void) | undefined
  const w = world(on, { tokens: 300_000, compact: () => new Promise(resolve => { release = resolve }) })
  await command($, 'idle ttl 2')
  await command($, 'idle margin 60')
  await complete($, 'old-turn')
  await w.clock.advance(MIN + 1)
  expect(typeof release).toBe('function')
  release?.(summary)
  await w.clock.advance(1)
  expect(w.store.has('idle:s1')).toBe(true)
})

test('control: an old prompt cannot publish state if no new session has loaded', async ($, on) => {
  let release: ((data: unknown) => void) | undefined
  let held = false
  const w = world(on, { get: (key, store) => {
    if (key === 'cfg' && !held) { held = true; return new Promise(resolve => { release = resolve }) }
    return store.get(key)
  } })
  const oldPrompt = composer($, 'OLD SESSION TASK')
  await w.clock.advance(0)
  await clear($)
  w.changeSession('s2')
  release?.({})
  await oldPrompt
  await w.clock.advance(0)
  expect(w.store.has('state:s2')).toBe(false)
})
