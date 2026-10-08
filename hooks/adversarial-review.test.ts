// Regression suite from an independent adversarial review of quota-guard (commit 5c841e1).
// Each failing assertion there was a real defect; they all pass now and must stay green.
import { expect, mock, test } from 'claude-code/testing'
import { DEFAULTS, FIVE, WEEK, initialState, predictedJump, step } from './core'
import type { Ev, State, Usage } from './core'

const T = 1_700_000_000_000
const MIN = 60_000
const usage = (pct: number, reset = T + MIN, week?: number): Usage => ({
  contextPercent: 10,
  windows: [{ kind: FIVE, percent: pct, resetsAt: reset }, ...(week === undefined ? [] : [{ kind: WEEK, percent: week, resetsAt: T + 3 * 24 * 60 * MIN }])],
})
const run = (state: State, ...events: Ev[]) => {
  for (const ev of events) state = step(state, ev, DEFAULTS).state
  return state
}
const paused = () => run(initialState(), { type: 'measure', now: T, usage: usage(95) })

test('stale high usage cannot verify a resumed probe', () => {
  const s = run(paused(), { type: 'tick', now: T + 2 * MIN, usage: usage(95) }, { type: 'turnStart' })
  const r = step(s, { type: 'measure', now: T + 2 * MIN + 1000, usage: usage(95) }, DEFAULTS)
  expect(r.state.rec.phase).toBe('resuming')
})

test('a missing paused window cannot verify a resumed probe', () => {
  const s = run(paused(), { type: 'tick', now: T + 2 * MIN, usage: usage(95) })
  const r = step(s, { type: 'measure', now: T + 2 * MIN, usage: { windows: [{ kind: WEEK, percent: 20, resetsAt: T + 7 * 24 * 60 * MIN }] } }, DEFAULTS)
  expect(r.state.rec.phase).toBe('resuming')
})

test('a second exhausted window must prevent resume', () => {
  let s = run(initialState(), { type: 'turnStart' }, { type: 'measure', now: T, usage: usage(95, T + MIN, 96) })
  s = run(s, { type: 'measure', now: T + 1000, usage: usage(96, T + MIN, 100) }, { type: 'turnComplete', now: T + 2000, reason: 'answer' })
  const r = step(s, { type: 'tick', now: T + 2 * MIN, usage: usage(3, T + 300 * MIN, 100) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('fresh low usage while paused must not postpone wake by another window', () => {
  const r = step(paused(), { type: 'measure', now: T + 2 * MIN, usage: usage(3, T + 300 * MIN) }, DEFAULTS)
  expect(r.state.rec.wakeAt ?? T).toBeLessThanOrEqual(T + 2 * MIN + 30_000)
})

test('burn history expires when the five-hour window changes', () => {
  let s = run(initialState(), { type: 'measure', now: T, usage: usage(40) }, { type: 'measure', now: T, usage: usage(60) })
  s = run(s, { type: 'measure', now: T + 2 * MIN, usage: usage(3, T + 300 * MIN) })
  expect(predictedJump(s, DEFAULTS)).toBe(0)
})

test('zero-growth measurements must age out an old burn spike', () => {
  let s = run(initialState(), { type: 'measure', now: T, usage: usage(40) }, { type: 'measure', now: T, usage: usage(60) })
  for (let i = 0; i < 6; i++) s = run(s, { type: 'measure', now: T + i * 1000, usage: usage(60) })
  expect(predictedJump(s, DEFAULTS)).toBe(0)
})

test('resume watchdog must not queue another probe during an active turn', () => {
  let s = run(paused(), { type: 'tick', now: T + 2 * MIN, usage: usage(95) }, { type: 'turnStart' }, { type: 'tick', now: T + 6 * MIN, usage: usage(95) })
  const r = step(s, { type: 'tick', now: T + 9 * MIN, usage: usage(95) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'submit')).toBe(false)
})

test('first simultaneous breach aborts if any window reaches abortThreshold', () => {
  const s = run(initialState(), { type: 'turnStart' })
  const r = step(s, { type: 'measure', now: T, usage: usage(95, T + MIN, 100) }, DEFAULTS)
  expect(r.fx.some(f => f.t === 'abort')).toBe(true)
})

const value = (value: unknown) => ({ value }) as any
function world(on: any, opts: { tokens?: number; surfaces?: string[]; saved?: State; failCfg?: boolean; resetAfter?: number } = {}) {
  const clock = mock.clock(on, { now: T })
  const store = new Map<string, unknown>()
  if (opts.saved) store.set('state:s1', opts.saved)
  const seen = { submits: [] as string[], compacts: [] as string[], cfgReads: 0 }
  const reset = T + (opts.resetAfter ?? 60 * MIN)
  const tokens = opts.tokens ?? 100_000
  const reading = { startedAt: T, context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [{ kind: FIVE, percentUsed: 95, resetsAt: new Date(reset).toISOString() }] }
  on('session.id', () => value('s1'))
  on('store.get', (_$: any, e: any) => {
    if (e.key === 'cfg') seen.cfgReads++
    if (opts.failCfg && e.key === 'cfg') throw new Error('cfg read failure')
    return value(store.get(e.key))
  })
  on('store.set', (_$: any, e: any) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return value(undefined) })
  on('ui.log', () => value(undefined))
  on('ui.toast', () => value(undefined))
  on('ui.status', () => value(undefined))
  on('ui.open', () => value({}))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('session.surfaces', () => value(opts.surfaces ?? ['desktop']))
  on('session.usage', () => value(reading))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as any)
  on('session.compact', (_$: any, e: any) => { seen.compacts.push(e.instructions ?? ''); return { messages: [{ role: 'user', text: 'compacted summary', toolUses: [] }] } as any })
  on('prompt.submit', (_$: any, e: any) => { seen.submits.push(e.text); return { text: e.text } as any })
  on('tool.call', () => ({ result: { text: 'ran', isError: false, isReadOnly: true } }) as any)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  return { clock, store, seen, reading }
}
const command = ($: any, args: string) => $.command.run({ command: 'quota', args } as any)
const complete = ($: any, reason = 'answer') => $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason } as any)

test('cancel while waiting for the resume slot prevents the submit', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await command($, 'cancel')
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(0)
})

test('off while waiting for the resume slot prevents the submit', async ($, on) => {
  const w = world(on, { saved: paused() })
  await command($, 'resume')
  await command($, 'off')
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(0)
})

test('test mode with dry actions does not perform real idle compaction', async ($, on) => {
  const w = world(on, { tokens: 300_000 })
  await command($, 'test on')
  await complete($)
  await w.clock.advance(58 * MIN)
  expect(w.seen.compacts.length).toBe(0)
})

test('a headless restored pause does not deny tools', async ($, on) => {
  world(on, { surfaces: [], saved: paused() })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
  expect(r.deny).toBe(undefined)
})

test('a failure loading cfg continues to fail open on later calls', async ($, on) => {
  world(on, { saved: paused(), failCfg: true })
  const status: any = await command($, 'status')
  expect(status.text).toContain('not available')
  const r: any = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
  expect(r.deny).toBe(undefined)
})

test('context-only measurement does not erase failed-probe recovery', async ($, on) => {
  const w = world(on, { resetAfter: MIN })
  await $.session.measure({ ...w.reading, changed: ['rateLimits'] } as any)
  await w.clock.advance(100_000)
  await $.session.measure({ ...w.reading, changed: ['context'] } as any)
  await complete($, 'error')
  const r: any = await command($, 'status')
  expect(r.text).toContain('State: PAUSED')
})

test('automatic prompts submitted by a plugin are held during a pause', async ($, on) => {
  const w = world(on, { saved: paused() })
  const r: any = await $.prompt.submit({ text: 'automated follow-up from another plugin', wait: false, origin: { kind: 'plugin', name: 'other-plugin' } } as any)
  expect(r.drop).toBeDefined()
  expect(w.seen.submits.length).toBe(0)
})

test('an error without any API response does not refresh the cache clock', async ($, on) => {
  const w = world(on, { tokens: 300_000 })
  await complete($, 'error')
  await w.clock.advance(58 * MIN)
  expect(w.seen.compacts.length).toBe(0)
})

test('the existing prompt safety fixture reaches its intended initialization failure', async ($, on) => {
  const w = world(on, { failCfg: true })
  await $.prompt.submit({ text: 'hello there world' } as any)
  expect(w.seen.cfgReads).toBe(1)
})

test('control: fresh low usage confirms a resumed probe', () => {
  const woke = run(paused(), { type: 'tick', now: T + 2 * MIN, usage: usage(95) })
  const s = run(woke, { type: 'resumeDelivered', now: T + 2 * MIN, op: woke.rec.op as number }) // delivered first (see adversarial-fixes-review)
  const r = step(s, { type: 'measure', now: T + 2 * MIN, usage: usage(3, T + 300 * MIN) }, DEFAULTS)
  expect(r.state.rec.phase).toBe('idle')
})

test('control: a scheduled prompt with valid provenance is blocked while paused', async ($, on) => {
  const w = world(on, { saved: paused() })
  const r: any = await $.prompt.submit({ text: 'automated scheduled follow-up', wait: false, origin: { kind: 'scheduled-trigger' } } as any)
  expect(r.drop).toContain('automatic prompts are held')
  expect(w.seen.submits.length).toBe(0)
})

test('control: a composer prompt with valid provenance reaches the load failure and passes through', async ($, on) => {
  const w = world(on, { failCfg: true })
  const r: any = await $.prompt.submit({ text: 'hello there world', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.seen.cfgReads).toBe(1)
  expect(r.drop).toBe(undefined)
  expect(w.seen.submits.length).toBe(1)
})
