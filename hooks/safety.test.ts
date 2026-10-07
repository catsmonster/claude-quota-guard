import { expect, test } from 'claude-code/testing'

const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const v = (value: unknown) => ({ value }) as any

const USAGE = (percent: number) => ({
  startedAt: 0,
  context: { window: 1_000_000, tokens: 100_000, percent: 10 },
  rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: iso(2 * 3600_000) }],
})

// the engine beneath the plugin: everything the mod touches, except what a test deliberately leaves out
function engine(on: any, opts: { sessionId?: boolean; surfaces?: string[]; percent?: number; onCompact?: () => void } = {}) {
  const store = new Map<string, unknown>()
  if (opts.sessionId !== false) on('session.id', () => v('s1'))
  on('store.get', (_$: any, e: any) => v(store.get(e.key)))
  on('store.set', (_$: any, e: any) => (store.set(e.key, e.value), v(undefined)))
  on('clock.now', () => v(Date.now()))
  on('clock.sleep', () => v(undefined))
  on('ui.log', () => v(undefined))
  on('ui.toast', () => v(undefined))
  on('ui.status', () => v(undefined))
  on('ui.open', () => v({}))
  on('command.register', (_$: any, e: any) => v({ command: e.name }))
  on('session.surfaces', () => v(opts.surfaces ?? ['desktop']))
  on('session.usage', () => v(USAGE(opts.percent ?? 40)))
  on('session.compact', () => {
    opts.onCompact?.()
    return { messages: [] } as any
  })
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as any)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }) as any)
}

test('a mod that cannot load its state lets prompts through', async ($, on) => {
  engine(on, { sessionId: false }) // $.session.id() has no implementation, so loading throws
  const r: any = await $.prompt.submit({ text: 'hello there world' } as any)
  expect(r.text).toBe('hello there world')
  expect(r.drop).toBe(undefined)
})

test('a mod that cannot load its state lets tool calls through', async ($, on) => {
  engine(on, { sessionId: false })
  on('tool.call', (_$: any, e: any) => ({ result: { text: 'ran ' + e.tool, isError: false, isReadOnly: true } }) as any)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
  expect(r.deny).toBe(undefined)
  expect(r.result.text).toContain('ran Bash')
})

test('a headless session (no surface attached) never arms or pauses', async ($, on) => {
  let compacted = 0
  engine(on, { surfaces: [], percent: 99, onCompact: () => compacted++ })
  await $.session.measure({
    context: { window: 1_000_000, tokens: 100_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 99, resetsAt: iso(2 * 3600_000) }],
    changed: ['rateLimits'],
  } as any)
  expect(compacted).toBe(0)
  const out: any = await $.command.run({ command: 'quota', args: 'status' } as any)
  expect(out.text).toContain('State: IDLE')
})

test('a watched session at 99% does start the quota flow', async ($, on) => {
  engine(on, { surfaces: ['desktop'], percent: 99 })
  await $.session.measure({
    context: { window: 1_000_000, tokens: 100_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 99, resetsAt: iso(2 * 3600_000) }],
    changed: ['rateLimits'],
  } as any)
  const out: any = await $.command.run({ command: 'quota', args: 'status' } as any)
  expect(out.text).not.toContain('State: IDLE')
})

test('/quota-guard is an alias of /quota', async ($, on) => {
  engine(on)
  const a: any = await $.command.run({ command: 'quota', args: 'status' } as any)
  const b: any = await $.command.run({ command: 'quota-guard', args: 'status' } as any)
  expect(a.text).toContain('Auto quota management')
  expect(b.text).toContain('Auto quota management')
})
