// Temporary adversarial review of a7c68ec. Assertions express required behavior.
import { expect, mock, test } from 'claude-code/testing'
import { DEFAULTS, FIVE, WEEK, initialState, step } from './core'
import type { Ev, State, Usage, Win } from './core'

const T = 1_700_000_000_000
const MIN = 60_000
const DAY = 24 * 60 * MIN
const five = (percent: number, resetsAt: number | undefined = T + MIN): Win => ({ kind: FIVE, percent, resetsAt })
const week = (percent: number, resetsAt: number | undefined = T + 3 * DAY): Win => ({ kind: WEEK, percent, resetsAt })
const u = (...windows: Win[]): Usage => ({ windows, contextPercent: 10 })
const run = (s: State, ...events: Ev[]) => {
  for (const ev of events) s = step(s, ev, DEFAULTS).state
  return s
}
const paused = () => run(initialState(), { type: 'measure', now: T, usage: u(five(95), week(40)) })
const probe = () => run(paused(), { type: 'tick', now: T + 2 * MIN, usage: u(five(95), week(40)) })
const predictive = () => run(initialState(),
  { type: 'measure', now: T, usage: u(five(60, T + 300 * MIN), week(40)) },
  { type: 'measure', now: T, usage: u(five(80, T + 300 * MIN), week(40)) })

test('a healthy weekly reset timestamp cannot release an unchanged five-hour burn pause', () => {
  let s = predictive()
  expect(s.rec.predictive).toBe(true)
  s = run(s, { type: 'measure', now: T + 1000, usage: u(five(80, T + 300 * MIN), week(40)) })
  const r = step(s, { type: 'tick', now: T + 30_000, usage: u(five(80, T + 300 * MIN), week(40)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('an unchanged five-hour burn window is not verified by the weekly window during delivery', () => {
  let s = run(predictive(), { type: 'resume', now: T + 1000 })
  s = run(s, { type: 'measure', now: T + 2000, usage: u(five(80, T + 300 * MIN), week(40)) })
  expect(s.rec.verified).not.toBe(true)
})

test('a newly discovered exhausted window without a reset revokes verification before delivery', () => {
  let s = run(initialState(),
    { type: 'measure', now: T, usage: u(five(95)) },
    { type: 'tick', now: T + 2 * MIN, usage: u(five(95)) },
    { type: 'measure', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN)) })
  expect(s.rec.verified).toBe(true)
  const op = s.rec.op as number
  s = run(s, { type: 'measure', now: T + 2 * MIN + 100, usage: u(five(3, T + 300 * MIN), { kind: WEEK, percent: 100 }) })
  s = run(s, { type: 'resumeDelivered', now: T + 2 * MIN + 200, op })
  expect(s.rec.phase).not.toBe('idle')
})

test('boot readings count as previously seen managed windows', () => {
  let s = run(initialState(), { type: 'boot', now: T, usage: u(five(95), week(40)) })
  s = run(s, { type: 'tick', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN)) })
  s = run(s, { type: 'resumeDelivered', now: T + 2 * MIN, op: s.rec.op as number })
  s = run(s, { type: 'measure', now: T + 2 * MIN + 1, usage: u(five(3, T + 300 * MIN)) })
  expect(s.rec.phase).toBe('resuming')
})

test('windows first observed by a heartbeat are remembered for verification', () => {
  let s = run(initialState(), { type: 'measure', now: T, usage: u(five(95)) })
  s = run(s, { type: 'tick', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN), week(40)) })
  s = run(s, { type: 'resumeDelivered', now: T + 2 * MIN, op: s.rec.op as number })
  s = run(s, { type: 'measure', now: T + 2 * MIN + 1, usage: u(five(3, T + 300 * MIN)) })
  expect(s.rec.phase).toBe('resuming')
})

test('an older running turn cannot complete a replacement resume before delivery', () => {
  let s = run(probe(), { type: 'turnStart' },
    { type: 'measure', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN), week(100, T + 4 * MIN)) })
  expect(s.busy).toBe(true)
  expect(s.rec.phase).toBe('paused')
  s = run(s, { type: 'resume', now: T + 2 * MIN + 1 })
  expect(s.rec.delivered).toBe(false)
  s = run(s, { type: 'turnComplete', now: T + 2 * MIN + 2, reason: 'answer' })
  expect(s.rec.phase).toBe('resuming')
})

test('control: verified delivery with no intervening exhaustion finishes normally', () => {
  let s = run(probe(), { type: 'measure', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN), week(40)) })
  s = run(s, { type: 'resumeDelivered', now: T + 2 * MIN, op: s.rec.op as number })
  expect(s.rec.phase).toBe('idle')
})

const value = (value: unknown) => ({ value }) as any
const summary = { messages: [{ role: 'user', text: 'compacted summary', toolUses: [] }] } as any
function world(on: any, opts: {
  saved?: State; tokens?: number; entries?: [string, unknown][];
  compact?: () => Promise<unknown>;
  get?: (key: string, store: Map<string, unknown>) => Promise<unknown> | unknown;
  set?: (key: string, data: any, store: Map<string, unknown>) => Promise<void> | void;
  remove?: (key: string, store: Map<string, unknown>) => void;
} = {}) {
  const clock = mock.clock(on, { now: T })
  const store = new Map<string, unknown>(opts.entries)
  if (opts.saved) store.set('state:s1', opts.saved)
  const seen = { submits: [] as string[], compacts: 0, aborts: [] as string[], logs: [] as string[] }
  let sid = 's1'
  const tokens = opts.tokens ?? 100_000
  const reading = { startedAt: T, context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [{ kind: FIVE, percentUsed: 40, resetsAt: new Date(T + 300 * MIN).toISOString() }] }
  on('session.id', () => value(sid))
  on('store.get', async (_$: any, e: any) => value(opts.get ? await opts.get(e.key, store) : store.get(e.key)))
  on('store.set', async (_$: any, e: any) => {
    const data = JSON.parse(JSON.stringify(e.value))
    if (opts.set) await opts.set(e.key, data, store)
    else store.set(e.key, data)
    return value(undefined)
  })
  on('store.delete', (_$: any, e: any) => { opts.remove?.(e.key, store); store.delete(e.key); return value(undefined) })
  on('store.keys', () => value([...store.keys()]))
  on('ui.log', (_$: any, e: any) => { seen.logs.push(JSON.stringify(e)); return value(undefined) })
  on('ui.toast', () => value(undefined))
  on('ui.status', () => value(undefined))
  on('ui.open', () => value({}))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('session.surfaces', () => value(['desktop']))
  on('session.usage', () => value(reading))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as any)
  on('session.compact', async () => { seen.compacts++; return (opts.compact ? await opts.compact() : summary) as any })
  on('prompt.submit', (_$: any, e: any) => { seen.submits.push(e.text); return { text: e.text } as any })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  on('turn.abort', (_$: any, e: any) => { seen.aborts.push(e.turnId); return value(undefined) })
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
  return { clock, store, seen, reading, changeSession: (id: string) => { sid = id } }
}
const command = ($: any, args: string) => $.command.run({ command: 'quota', args } as any)
const composer = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
const clear = ($: any) => $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
const start = ($: any, turnId: string) => $.turn.start({ turnId, prompt: 'task' } as any)
const complete = ($: any, turnId: string) => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as any)

test('clear followed by a new resume cannot reactivate the old session operation', async ($, on) => {
  const old = paused(); old.rec.task = 'OLD SESSION TASK'
  const w = world(on, { saved: old })
  await command($, 'resume')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  await $.session.measure({ ...w.reading, changed: ['rateLimits'] } as any)
  await command($, 'pause 2')
  await command($, 'resume')
  await w.clock.advance(30_000)
  expect(w.seen.submits.filter(text => text.includes('OLD SESSION TASK')).length).toBe(0)
})

test('an old compaction completion after clear cannot finish the new session compaction', async ($, on) => {
  const s = initialState(); s.ctx = 50
  const pending: ((data: unknown) => void)[] = []
  const w = world(on, { saved: s, tokens: 500_000, compact: () => new Promise(resolve => pending.push(resolve)) })
  await command($, 'pause 2')
  await w.clock.advance(1001)
  expect(pending.length).toBe(1)
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  await $.session.measure({ ...w.reading, changed: ['context'] } as any)
  await command($, 'pause 3')
  await w.clock.advance(1001)
  expect(pending.length).toBe(2)
  pending[0]?.(summary)
  await w.clock.advance(1)
  const observed = (w.store.get('state:s2') as State).rec.phase
  pending[1]?.(summary)
  await w.clock.advance(1)
  expect(observed).toBe('compacting')
})

test('a load that began before clear cannot overwrite the new session globals', async ($, on) => {
  let release: ((data: unknown) => void) | undefined
  let held = false
  const w = world(on, { get: (key, store) => {
    if (key === 'cfg' && !held) { held = true; return new Promise(resolve => { release = resolve }) }
    return store.get(key)
  } })
  const loading = command($, 'status')
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'FIRST NEW SESSION TASK')
  release?.({})
  await loading
  await composer($, 'SECOND NEW SESSION TASK')
  expect((w.store.get('state:s2') as State).rec.task).toBe('SECOND NEW SESSION TASK')
})

test('delayed abort from a cancelled pause cannot target the replacement turn', async ($, on) => {
  let release: (() => void) | undefined
  let held = false
  const w = world(on, { set: async (key, data, store) => {
    store.set(key, data)
    if (key === 'state:s1' && data.rec?.phase === 'armed' && data.rec.abortRequested && !held) {
      held = true
      await new Promise<void>(resolve => { release = resolve })
    }
  } })
  await start($, 'old-turn')
  const measuring = $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 100, resetsAt: new Date(T + 300 * MIN).toISOString() }], changed: ['rateLimits'] } as any)
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await composer($, 'Please work on the replacement task')
  await complete($, 'old-turn')
  await w.clock.advance(0)
  await start($, 'replacement-turn')
  release?.()
  await measuring
  await w.clock.advance(0)
  expect(w.seen.aborts.includes('replacement-turn')).toBe(false)
})

test('a running earlier turn cannot swallow a manual resume during the stagger wait', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await w.clock.advance(10_000)
  await start($, 'old-probe')
  await $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 100, resetsAt: new Date(T + 300 * MIN).toISOString() }], changed: ['rateLimits'] } as any)
  await command($, 'resume')
  await complete($, 'old-probe')
  await w.clock.advance(30_000)
  expect(w.seen.submits.length).toBe(2)
})

test('pruning cannot delete a pause written after its stale idle snapshot was read', async ($, on) => {
  const index = Array.from({ length: 25 }, (_, i) => ({ sid: 'other' + i, at: T - (i + 1) * MIN }))
  const entries: [string, unknown][] = [['index', index], ...index.map(x => ['state:' + x.sid, initialState()] as [string, unknown])]
  let concurrentPause = false
  const w = world(on, { entries, get: (key, store) => {
    if (key === 'state:other24' && !concurrentPause) {
      const stale = store.get(key)
      store.set(key, paused()) // another session persists while this read is in flight
      concurrentPause = true
      return stale
    }
    return store.get(key)
  } })
  await command($, 'status')
  expect(concurrentPause).toBe(true)
  expect(w.store.has('state:other24')).toBe(true)
})

test('control: clear without a replacement operation cancels the delayed resume', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await clear($)
  await w.clock.advance(30_000)
  expect(w.seen.submits.length).toBe(0)
})

test('control: an uncontested high quota abort targets the original running turn', async ($, on) => {
  const w = world(on)
  await start($, 'original-turn')
  await $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 100, resetsAt: new Date(T + 300 * MIN).toISOString() }], changed: ['rateLimits'] } as any)
  await w.clock.advance(0)
  expect(w.seen.aborts).toEqual(['original-turn'])
})
