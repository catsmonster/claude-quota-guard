// Temporary adversarial review of 1597412. Production files are not changed.
import { expect, mock, test } from 'claude-code/testing'
import { DEFAULTS, FIVE, WEEK, RESUME_PROMPT, initialState, step } from './core'
import { initialState as legacyInitialState, step as legacyStep } from './adversarial-legacy-core'
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
// The healthy five-hour window advances while we are waiting for the weekly limit. A burn-rate
// breach then joins the pause in that NEW window; its baseline must be the window of that breach.
const joinedNewPredictive = () => run(initialState(),
  { type: 'measure', now: T, usage: u(five(60, T + MIN), week(99, T + 10 * MIN)) },
  { type: 'measure', now: T + 2 * MIN, usage: u(five(60, T + 302 * MIN), week(99, T + 10 * MIN)) },
  { type: 'measure', now: T + 3 * MIN, usage: u(five(80, T + 302 * MIN), week(99, T + 10 * MIN)) })
const mixedPause = () => run(initialState(),
  { type: 'measure', now: T, usage: u(five(60, T + 300 * MIN), week(90, T + 10 * MIN)) },
  { type: 'measure', now: T + 1000, usage: u(five(80, T + 300 * MIN), week(99, T + 10 * MIN)) })
// This is an actual v1 record produced by the preceding release, not a current state with fields deleted.
const oldMixedPause = (): State => {
  let s = legacyStep(legacyInitialState(), { type: 'measure', now: T, usage: u(five(60, T + 300 * MIN), week(99, T + 10 * MIN)) }, DEFAULTS).state
  s = legacyStep(s, { type: 'measure', now: T + 1000, usage: u(five(80, T + 300 * MIN), week(99, T + 10 * MIN)) }, DEFAULTS).state
  return JSON.parse(JSON.stringify(s)) as State
}

test('a newly joined predictive window cannot be cleared by its earlier healthy-window baseline', () => {
  let s = joinedNewPredictive()
  s = run(s, { type: 'measure', now: T + 11 * MIN, usage: u(five(80, T + 302 * MIN), week(3, T + 7 * DAY)) })
  const r = step(s, { type: 'tick', now: T + 11 * MIN + 1, usage: u(five(80, T + 302 * MIN), week(3, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('an unchanged newly joined predictive window cannot verify a manual resume', () => {
  let s = run(joinedNewPredictive(), { type: 'resume', now: T + 11 * MIN })
  s = run(s, { type: 'measure', now: T + 11 * MIN + 1, usage: u(five(80, T + 302 * MIN), week(3, T + 7 * DAY)) })
  expect(s.rec.verified).not.toBe(true)
})

test('a recovered static window can acquire a new predictive cause while another window holds the pause', () => {
  let s = run(initialState(),
    { type: 'measure', now: T, usage: u(five(95, T + MIN), week(99, T + 10 * MIN)) },
    { type: 'measure', now: T + 2 * MIN, usage: u(five(60, T + 302 * MIN), week(99, T + 10 * MIN)) },
    { type: 'measure', now: T + 3 * MIN, usage: u(five(80, T + 302 * MIN), week(99, T + 10 * MIN)) },
    { type: 'measure', now: T + 11 * MIN, usage: u(five(80, T + 302 * MIN), week(3, T + 7 * DAY)) })
  const r = step(s, { type: 'tick', now: T + 11 * MIN + 1, usage: u(five(80, T + 302 * MIN), week(3, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('a v1 mixed pause saved before causes existed keeps its predictive cause on restore', () => {
  const s = oldMixedPause()
  expect(s.v).toBe(1)
  expect(s.rec.predictive).toBe(false) // the old aggregate flag was false because weekly was static
  const r = step(s, { type: 'boot', now: T + 11 * MIN, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('a v1 mixed pause without causes cannot verify an unchanged predictive window', () => {
  let s = run(oldMixedPause(), { type: 'resume', now: T + 11 * MIN })
  s = run(s, { type: 'measure', now: T + 11 * MIN + 1, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) })
  expect(s.rec.verified).not.toBe(true)
})

test('control: a fresh mixed pause with causes keeps the predictive window blocked', () => {
  let s = mixedPause()
  s = run(s, { type: 'measure', now: T + 11 * MIN, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) })
  const r = step(s, { type: 'tick', now: T + 11 * MIN + 1, usage: u(five(80, T + 300 * MIN), week(3, T + 7 * DAY)) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

const value = (value: unknown) => ({ value }) as any
const summary = { messages: [{ role: 'user', text: 'compacted summary', toolUses: [] }] } as any
function world(on: any, opts: {
  saved?: State; tokens?: number; entries?: [string, unknown][];
  set?: (key: string, data: any, store: Map<string, unknown>) => Promise<void> | void;
  now?: (now: number) => Promise<number> | number;
} = {}) {
  const clock = mock.clock(((...args: any[]) => {
    if (args[0] === 'clock.now' && opts.now) on('clock.now', async () => value(await opts.now?.(clock.now())))
    else on(...args)
  }) as any, { now: T })
  const store = new Map<string, unknown>(opts.entries)
  if (opts.saved) store.set('state:s1', opts.saved)
  const seen = { submits: [] as string[], compacts: 0, logs: [] as string[] }
  let sid = 's1'
  const tokens = opts.tokens ?? 100_000
  const reading = { startedAt: T, context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [{ kind: FIVE, percentUsed: 40, resetsAt: new Date(T + 300 * MIN).toISOString() }] }
  on('session.id', () => value(sid))
  on('store.get', (_$: any, e: any) => value(store.get(e.key)))
  on('store.set', async (_$: any, e: any) => {
    const data = JSON.parse(JSON.stringify(e.value))
    store.set(e.key, data)
    if (opts.set) await opts.set(e.key, data, store)
    return value(undefined)
  })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return value(undefined) })
  on('store.keys', () => value([...store.keys()]))
  on('ui.log', (_$: any, e: any) => { seen.logs.push(JSON.stringify(e)); return value(undefined) })
  on('ui.toast', () => value(undefined))
  on('ui.status', () => value(undefined))
  on('ui.open', () => value({}))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('session.surfaces', () => value(['desktop']))
  on('session.usage', () => value(reading))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as any)
  on('session.compact', () => { seen.compacts++; return summary })
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
const start = ($: any, turnId: string, text = 'unrelated running task') => $.turn.start({ turnId, text } as any)
const complete = ($: any, turnId: string, reason = 'answer') => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: reason === 'aborted', turnId, reason } as any)

test('a queued continuation from a cancelled operation cannot own its replacement', async ($, on) => {
  const w = world(on, { saved: paused() })
  await start($, 'already-running')
  await command($, 'resume')
  await w.clock.advance(5000)
  expect(w.seen.submits.length).toBe(1) // accepted, queued behind the older turn
  const oldText = w.seen.submits[0] as string
  await command($, 'cancel')
  await command($, 'resume')
  await complete($, 'already-running')
  await w.clock.advance(0)
  await start($, 'cancelled-operation-turn', 'The quota-guard plugin sent a message: ' + oldText)
  await complete($, 'cancelled-operation-turn')
  await w.clock.advance(30_000)
  expect(w.seen.submits.length).toBe(2)
})

test('a foreign turn quoting the recovery instruction is not the current continuation', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await w.clock.advance(5000)
  await $.prompt.submit({ text: 'Explain this recovery instruction: ' + RESUME_PROMPT, wait: false, origin: { kind: 'plugin', name: 'other-plugin' } } as any)
  await start($, 'other-plugin-turn', 'Explain this recovery instruction: ' + RESUME_PROMPT)
  await complete($, 'other-plugin-turn')
  await w.clock.advance(0)
  expect((w.store.get('state:s1') as State).rec.phase).toBe('resuming')
})

test('explicit resume with management off is not vetoed by a heartbeat during its longer slot wait', async ($, on) => {
  const w = world(on, { saved: paused(), entries: [['lastResume', T + 40_000]] })
  w.reading.rateLimits[0]!.percentUsed = 100
  await command($, 'off')
  await command($, 'resume')
  await w.clock.advance(61_000)
  expect(w.seen.submits.length).toBe(1)
})

test('restoring a v1 mixed pause without causes does not release the five-hour prediction', async ($, on) => {
  const w = world(on, { saved: oldMixedPause() })
  w.reading.rateLimits = [{ kind: FIVE, percentUsed: 80, resetsAt: new Date(T + 300 * MIN).toISOString() }, { kind: WEEK, percentUsed: 3, resetsAt: new Date(T + 7 * DAY).toISOString() }]
  await w.clock.advance(11 * MIN)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-1' } as any)
  await w.clock.advance(5000)
  expect(w.seen.submits.length).toBe(0)
})

test('a stale completion must not cancel the new session idle timer before checking generation', async ($, on) => {
  let release: (() => void) | undefined
  let hold = false
  let held = false
  const w = world(on, { tokens: 300_000, set: async (key, data) => {
    if (hold && !held && key === 'state:s1' && data.rec?.phase === 'idle') {
      held = true
      await new Promise<void>(resolve => { release = resolve })
    }
  } })
  await command($, 'idle ttl 2')
  await command($, 'idle margin 60')
  hold = true
  await complete($, 'old-turn')
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  await complete($, 'new-turn')
  await w.clock.advance(0) // the new session's idle timer is armed
  release?.()
  await w.clock.advance(0)
  await w.clock.advance(MIN + 1)
  expect(w.seen.compacts).toBe(1)
})

test('a command overtaken at its clock read cannot overwrite newer session settings', async ($, on) => {
  let release: ((now: number) => void) | undefined
  let hold = false
  let held = false
  const w = world(on, { now: now => {
    if (hold && !held) { held = true; return new Promise<number>(resolve => { release = resolve }) }
    return now
  } })
  await command($, 'status')
  hold = true
  const oldCommand = command($, 'threshold 50')
  await w.clock.advance(0)
  expect(typeof release).toBe('function')
  await clear($)
  w.changeSession('s2')
  await composer($, 'NEW SESSION TASK')
  await command($, 'threshold 90')
  release?.(w.clock.now())
  await oldCommand
  expect((w.store.get('cfg') as any).threshold).toBe(90)
})

test('control: an unchanged operation recognises and completes its own framed continuation', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await w.clock.advance(5000)
  await start($, 'own-turn', 'The quota-guard plugin sent a message: ' + w.seen.submits[0])
  await complete($, 'own-turn')
  await w.clock.advance(0)
  expect((w.store.get('state:s1') as State).rec.phase).toBe('idle')
})

test('control: explicit resume with management off and a short slot wait does submit', async ($, on) => {
  const w = world(on, { saved: paused() })
  w.reading.rateLimits[0]!.percentUsed = 100
  await command($, 'off')
  await command($, 'resume')
  await w.clock.advance(5000)
  expect(w.seen.submits.length).toBe(1)
})

test('control: the current session idle timer still compacts normally', async ($, on) => {
  const w = world(on, { tokens: 300_000 })
  await command($, 'idle ttl 2')
  await command($, 'idle margin 60')
  await complete($, 'current-turn')
  await w.clock.advance(MIN + 1)
  expect(w.seen.compacts).toBe(1)
})

test('control: the current command updates its threshold normally', async ($, on) => {
  const w = world(on, { now: now => now })
  await command($, 'threshold 90')
  expect((w.store.get('cfg') as any).threshold).toBe(90)
})
