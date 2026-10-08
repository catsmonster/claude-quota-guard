import { expect, mock, test } from 'claude-code/testing'

import { DEFAULTS, FIVE, RESUME_PROMPT, initialState, step } from './core'
import type { State } from './core'

const T = 1_700_000_000_000
const MIN = 60_000
const v = (value: unknown) => ({ value }) as any

const paused = (): State =>
  step(initialState(), { type: 'measure', now: T, usage: { windows: [{ kind: FIVE, percent: 95, resetsAt: T + MIN }], contextPercent: 10 } }, DEFAULTS).state

function world(on: any) {
  const clock = mock.clock(on, { now: T })
  const store = new Map<string, unknown>([['state:s1', paused()]])
  const seen = { submits: [] as string[] }
  on('session.id', () => v('s1'))
  on('store.get', (_$: any, e: any) => v(store.get(e.key)))
  on('store.set', (_$: any, e: any) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), v(undefined)))
  on('store.delete', (_$: any, e: any) => (store.delete(e.key), v(undefined)))
  on('store.keys', () => v([...store.keys()]))
  on('ui.log', () => v(undefined))
  on('ui.toast', () => v(undefined))
  on('ui.status', () => v(undefined))
  on('ui.open', () => v({}))
  on('command.register', (_$: any, e: any) => v({ command: e.name }))
  on('session.surfaces', () => v(['desktop']))
  on('session.usage', () => v({ startedAt: T, context: { window: 1_000_000, tokens: 1000, percent: 0 }, rateLimits: [] }))
  on('prompt.submit', (_$: any, e: any) => (seen.submits.push(e.text), { text: e.text } as any))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  return { clock, seen }
}
const command = ($: any, args: string) => $.command.run({ command: 'quota', args } as any)
const startTurn = ($: any, turnId: string, text: string) => $.turn.start({ turnId, text } as any)
const finishTurn = ($: any, turnId: string, reason = 'answer') =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason } as any)

test('the turn that runs our continuation is recognised by its text, and finishes the resume', async ($, on) => {
  const w = world(on)
  await command($, 'resume')
  await w.clock.advance(10_000)
  expect(w.seen.submits.length).toBe(1)
  // the engine frames a plugin's prompt, so the turn's text contains ours
  await startTurn($, 'probe', 'The quota-guard plugin sent a message: ' + w.seen.submits[0])
  await finishTurn($, 'probe')
  await w.clock.advance(1)
  expect(((await command($, 'status')) as any).text).toContain('State: IDLE')
})

test('another turn, with different text, is not mistaken for the continuation', async ($, on) => {
  const w = world(on)
  await command($, 'resume')
  await w.clock.advance(10_000)
  await startTurn($, 'other', 'something else entirely')
  await finishTurn($, 'other')
  await w.clock.advance(1)
  expect(((await command($, 'status')) as any).text).toContain('State: RESUMING')
  // ...and when the real continuation turn does run, it finishes the resume
  await startTurn($, 'probe', RESUME_PROMPT)
  await finishTurn($, 'probe')
  await w.clock.advance(1)
  expect(((await command($, 'status')) as any).text).toContain('State: IDLE')
})
