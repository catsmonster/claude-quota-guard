import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const v = (value: unknown) => ({ value }) as any

// The engine beneath the plugin, with a clock the test moves and a context of 300k tokens.
function world(on: any, tokens = 300_000) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>()
  const seen = { compactions: [] as string[] }
  on('session.id', () => v('s1'))
  on('store.get', (_$: any, e: any) => v(store.get(e.key)))
  on('store.set', (_$: any, e: any) => (store.set(e.key, e.value), v(undefined)))
  on('ui.log', () => v(undefined))
  on('ui.toast', () => v(undefined))
  on('ui.status', () => v(undefined))
  on('ui.open', () => v({}))
  on('command.register', (_$: any, e: any) => v({ command: e.name }))
  on('session.surfaces', () => v(['desktop']))
  on('session.usage', () =>
    v({ startedAt: 0, context: { window: 1_000_000, tokens, percent: Math.round(tokens / 10_000) }, rateLimits: [] }),
  )
  on('session.compact', (_$: any, e: any) => {
    seen.compactions.push(String(e.instructions ?? ''))
    return { messages: [{ role: 'user', text: 'summary of the conversation so far', toolUses: [] }] } as any
  })
  on('tool.call', () => ({ result: { text: 'started', isError: false, isReadOnly: false } }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as any)
  return { clock, seen }
}

const done = (turnId = 't1') => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as any

test('waiting on a background command: compacts just before the cache expires, once', async ($, on) => {
  const { clock, seen } = world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the full test suite', run_in_background: true } as any)
  await $.turn.complete(done())

  await clock.advance(30 * MIN)
  expect(seen.compactions.length).toBe(0) // the cache is still warm for a long while
  await clock.advance(28 * MIN) // 58 minutes after the last response, 2 minutes before expiry
  expect(seen.compactions.length).toBe(1)
  expect(seen.compactions[0]).toContain('Run the full test suite') // the summary is told what it waits on
  await clock.advance(30 * MIN)
  expect(seen.compactions.length).toBe(1) // never twice for one response
})

test('by default it also compacts an idle session that is not waiting on anything', async ($, on) => {
  const { clock, seen } = world(on)
  await $.turn.complete(done())
  await clock.advance(58 * MIN)
  expect(seen.compactions.length).toBe(1)
  expect(seen.compactions[0]).not.toContain('Waiting on:')
})

test('"idle waiting" restricts it to sessions waiting on background work', async ($, on) => {
  const { clock, seen } = world(on)
  await $.command.run({ command: 'quota', args: 'idle waiting' } as any)
  await $.turn.complete(done())
  await clock.advance(70 * MIN)
  expect(seen.compactions.length).toBe(0)
})

test('a small context is left alone', async ($, on) => {
  const { clock, seen } = world(on, 80_000)
  await $.turn.complete(done())
  await clock.advance(70 * MIN)
  expect(seen.compactions.length).toBe(0)
})

test('a new turn before the deadline cancels it', async ($, on) => {
  const { clock, seen } = world(on)
  await $.turn.complete(done())
  await clock.advance(20 * MIN)
  await $.turn.start({ text: 'ping', turnId: 't2' } as any) // the session woke up: the cache is fresh again
  await clock.advance(60 * MIN)
  expect(seen.compactions.length).toBe(0)
})

test('/quota idle reports and changes the settings', async ($, on) => {
  world(on)
  await $.tool.call({ tool: 'Bash', command: 'sleep 999', run_in_background: true } as any)
  const a: any = await $.command.run({ command: 'quota', args: 'idle' } as any)
  expect(a.text).toContain('Idle compaction: ON')
  expect(a.text).toContain('waiting on 1 background task')
  const b: any = await $.command.run({ command: 'quota', args: 'idle off' } as any)
  expect(b.text).toContain('Idle compaction: OFF')
  const c: any = await $.command.run({ command: 'quota', args: 'idle min 150k' } as any)
  expect(c.text).toContain('above 150k tokens')
})
