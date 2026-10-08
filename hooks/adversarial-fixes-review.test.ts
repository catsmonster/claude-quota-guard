// Regression suite from the second independent adversarial review (commit 0af0983).
// One harness change: the mock engine now answers store.keys, which migrating pre-index records needs.
import { expect, mock, test } from 'claude-code/testing'
import { DEFAULTS, FIVE, WEEK, initialState, step } from './core'
import type { Ev, State, Usage, Win } from './core'

const T = 1_700_000_000_000
const MIN = 60_000
const DAY = 24 * 60 * MIN
const five = (pct: number, reset: number | undefined = T + MIN): Win => ({ kind: FIVE, percent: pct, resetsAt: reset })
const week = (pct: number, reset: number | undefined = T + 3 * DAY): Win => ({ kind: WEEK, percent: pct, resetsAt: reset })
const u = (...windows: Win[]): Usage => ({ windows, contextPercent: 10 })
const run = (state: State, ...events: Ev[]) => {
  for (const ev of events) state = step(state, ev, DEFAULTS).state
  return state
}
const paused = () => run(initialState(), { type: 'measure', now: T, usage: u(five(95), week(40)) })
const probe = () => run(paused(), { type: 'tick', now: T + 2 * MIN, usage: u(five(95), week(40)) })

test('burn-rate pause is not released by an unchanged below-threshold reading', () => {
  let s = run(initialState(), { type: 'measure', now: T, usage: u(five(60, T + 300 * MIN)) }, { type: 'measure', now: T, usage: u(five(80, T + 300 * MIN)) })
  expect(s.rec.phase).toBe('paused')
  s = run(s, { type: 'measure', now: T + 1000, usage: u(five(80, T + 300 * MIN)) })
  const r = step(s, { type: 'tick', now: T + 30_000, usage: u(five(80, T + 300 * MIN)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('verification also requires a known previously healthy weekly window', () => {
  const r = step(probe(), { type: 'measure', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN)) }, DEFAULTS)
  expect(r.state.rec.phase).toBe('resuming')
})

for (const reset of [undefined, T + MIN]) {
  test(`new high weekly window with ${reset === undefined ? 'unknown' : 'expired'} reset is not success evidence`, () => {
    const blockedWeek: Win = { kind: WEEK, percent: 100, resetsAt: reset }
    const r = step(probe(), { type: 'measure', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN), blockedWeek) }, DEFAULTS)
    expect(r.state.rec.phase).not.toBe('idle')
  })
}

test('a probe that becomes paused by measurement cannot queue a retry while its turn still runs', () => {
  let s = run(probe(), { type: 'turnStart' }, { type: 'measure', now: T + 2 * MIN, usage: u(five(3, T + 300 * MIN), week(100, T + 3 * MIN)) })
  expect(s.busy).toBe(true)
  expect(s.rec.phase).toBe('paused')
  const r = step(s, { type: 'tick', now: (s.rec.wakeAt ?? T) + MIN, usage: u(five(3, T + 300 * MIN), week(100, T + 3 * MIN)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('manual takeover cancels a compaction in progress', () => {
  const s = run(initialState(), { type: 'measure', now: T, usage: { windows: [five(95)], contextPercent: 50 } })
  expect(s.rec.phase).toBe('compacting')
  const r = step(s, { type: 'userPrompt', now: T + 100, text: 'Work on this new task instead', isUser: true }, DEFAULTS)
  expect(r.state.rec.phase).toBe('idle')
})

const value = (value: unknown) => ({ value }) as any
const summary = { messages: [{ role: 'user', text: 'compacted summary', toolUses: [] }] } as any
function world(on: any, opts: {
  saved?: State; cfg?: Record<string, unknown>; index?: { sid: string; at: number }[];
  entries?: [string, unknown][]; percent?: number; tokens?: number;
  compact?: (call: number, instructions: string) => unknown | Promise<unknown>;
} = {}) {
  const clock = mock.clock(on, { now: T })
  const store = new Map<string, unknown>(opts.entries)
  if (opts.saved) store.set('state:s1', opts.saved)
  if (opts.cfg) store.set('cfg', opts.cfg)
  if (opts.index) store.set('index', opts.index)
  const seen = { submits: [] as string[], compacts: [] as string[], logs: [] as string[] }
  let sid = 's1'
  const tokens = opts.tokens ?? 100_000
  const reading = { startedAt: T, context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [{ kind: FIVE, percentUsed: opts.percent ?? 40, resetsAt: new Date(T + 300 * MIN).toISOString() }] }
  on('session.id', () => value(sid))
  on('store.get', (_$: any, e: any) => value(store.get(e.key)))
  on('store.set', (_$: any, e: any) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return value(undefined) })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return value(undefined) })
  on('store.keys', () => value([...store.keys()])) // added: migrating pre-index records needs the key list
  on('ui.log', (_$: any, e: any) => { seen.logs.push(JSON.stringify(e)); return value(undefined) })
  on('ui.toast', () => value(undefined))
  on('ui.status', () => value(undefined))
  on('ui.open', () => value({}))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('session.surfaces', () => value(['desktop']))
  on('session.usage', () => value(reading))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as any)
  on('session.compact', async (_$: any, e: any) => {
    seen.compacts.push(e.instructions ?? '')
    return (opts.compact ? await opts.compact(seen.compacts.length, e.instructions ?? '') : summary) as any
  })
  on('prompt.submit', (_$: any, e: any) => { seen.submits.push(e.text); return { text: e.text } as any })
  on('tool.call', () => ({ result: { text: 'ran', isError: false, isReadOnly: true } }) as any)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as any)
  return { clock, store, seen, reading, changeSession: (id: string) => { sid = id } }
}
const command = ($: any, args: string) => $.command.run({ command: 'quota', args } as any)
const composer = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
const complete = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'new', reason: 'answer' } as any)

test('a context-only low snapshot does not cancel a queued resume before it is submitted', async ($, on) => {
  const s = run(initialState(), { type: 'measure', now: T, usage: u(five(60, T + 300 * MIN)) }, { type: 'measure', now: T, usage: u(five(80, T + 300 * MIN)) })
  const w = world(on, { saved: s, percent: 80 })
  await command($, 'resume')
  await $.session.measure({ ...w.reading, changed: ['context'] } as any)
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(1)
})

test('even a fresh reset measurement cannot finish a resume that has not yet submitted', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 3, resetsAt: new Date(T + 300 * MIN).toISOString() }], changed: ['rateLimits'] } as any)
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(1)
})

test('manual takeover stops a delayed compaction retry', async ($, on) => {
  const s = initialState(); s.ctx = 50
  const w = world(on, { saved: s, tokens: 500_000, compact: (call) => { if (call === 1) throw new Error('turn not idle yet'); return summary } })
  await command($, 'pause 2')
  await w.clock.advance(1001)
  expect(w.seen.compacts.length).toBe(1)
  await composer($, 'Please work on this different task instead')
  await w.clock.advance(2000)
  expect(w.seen.compacts.length).toBe(1)
})

test('an old compaction result cannot pause its replacement operation', async ($, on) => {
  const s = initialState(); s.ctx = 50
  const pending: ((result: any) => void)[] = []
  const w = world(on, { saved: s, tokens: 500_000, compact: () => new Promise(resolve => pending.push(resolve)) })
  await command($, 'pause 2')
  await w.clock.advance(1001)
  expect(pending.length).toBe(1)
  await command($, 'cancel')
  await composer($, 'Please work on this different task instead')
  await command($, 'pause 3')
  await w.clock.advance(1)
  expect((w.store.get('state:s1') as State).rec.phase).toBe('compacting')
  pending[0]?.(summary)
  await w.clock.advance(1)
  const observed = (w.store.get('state:s1') as State).rec.phase
  pending[1]?.(summary)
  await w.clock.advance(1)
  expect(observed).toBe('compacting')
})

test('cancel and replace within the same clock millisecond submits only the replacement', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await command($, 'cancel')
  await command($, 'resume')
  await w.clock.advance(30_000)
  expect(w.seen.submits.length).toBe(1)
})

test('explicit resume works when automatic management is disabled', async ($, on) => {
  const w = world(on, { saved: paused(), cfg: { enabled: false } })
  await command($, 'resume')
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(1)
})

test('ending the session cancels a queued resume', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(0)
})

test('clear uses the new session id for subsequent persisted state', async ($, on) => {
  const w = world(on)
  await command($, 'status')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
  w.changeSession('s2')
  await composer($, 'This is the task in the new session')
  expect(w.store.has('state:s2')).toBe(true)
})

test('forced pauses in dry-run mode can finish their simulated resume', async ($, on) => {
  const s = initialState(); s.ctx = 10
  const w = world(on, { saved: s })
  await command($, 'test on')
  await command($, 'sim clear')
  await command($, 'pause 0.1')
  await w.clock.advance(65_000)
  const r: any = await command($, 'status')
  expect(r.text).toContain('State: IDLE')
})

test('pruning migrates records written before the index existed', async ($, on) => {
  const entries: [string, unknown][] = Array.from({ length: 30 }, (_, i) => ['state:legacy' + i, initialState()])
  const w = world(on, { entries })
  await command($, 'status')
  expect([...w.store.keys()].filter(k => k.startsWith('state:')).length).toBeLessThanOrEqual(25)
})

test('pruning does not discard an unresolved quota pause', async ($, on) => {
  const index = Array.from({ length: 25 }, (_, i) => ({ sid: 'other' + i, at: T - (i + 1) * MIN }))
  index[24] = { sid: 'waiting', at: T - DAY }
  const w = world(on, { index, entries: [['state:waiting', paused()]] })
  await command($, 'status')
  expect(w.store.has('state:waiting')).toBe(true)
})

test('control: subagent compaction does not count as main conversation compaction', async ($, on) => {
  const s = run(initialState(), { type: 'turnStart' }, { type: 'measure', now: T, usage: { windows: [five(95)], contextPercent: 50 } })
  const w = world(on, { saved: s })
  await command($, 'status')
  await $.session.compact({ trigger: 'auto', agentId: 'child', messages: summary.messages } as any)
  expect((w.store.get('state:s1') as State).rec.compactedAt).toBe(undefined)
})

test('control: a main conversation compaction does count while armed', async ($, on) => {
  const s = run(initialState(), { type: 'turnStart' }, { type: 'measure', now: T, usage: { windows: [five(95)], contextPercent: 50 } })
  const w = world(on, { saved: s })
  await command($, 'status')
  await $.session.compact({ trigger: 'auto', messages: summary.messages } as any)
  expect((w.store.get('state:s1') as State).rec.compactedAt).toBe(T)
})

test('control: explicit cancel stops a compaction retry', async ($, on) => {
  const s = initialState(); s.ctx = 50
  const w = world(on, { saved: s, tokens: 500_000, compact: (call) => { if (call === 1) throw new Error('turn not idle yet'); return summary } })
  await command($, 'pause 2')
  await w.clock.advance(1001)
  expect(w.seen.compacts.length).toBe(1)
  await command($, 'cancel')
  await w.clock.advance(2000)
  expect(w.seen.compacts.length).toBe(1)
})

test('control: a dropped notification retains its pending-task entry', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'Bash', command: 'sleep 999', run_in_background: true } as any)
  await $.session.measure({ ...w.reading, rateLimits: [{ kind: FIVE, percentUsed: 95, resetsAt: new Date(T + 300 * MIN).toISOString() }], changed: ['rateLimits'] } as any)
  const r: any = await $.prompt.submit({ text: 'sleep 999 completed', wait: false, origin: { kind: 'task-notification' } } as any)
  expect(r.drop).toBeDefined()
  expect((await command($, 'idle') as any).text).toContain('waiting on 1 background task')
})

test('control: a normal resume emits one submission', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(1)
})

test('control: a completed answer can arm idle compaction', async ($, on) => {
  const w = world(on, { tokens: 300_000 })
  await complete($)
  await w.clock.advance(58 * MIN)
  expect(w.seen.compacts.length).toBe(1)
})
