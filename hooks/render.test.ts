import { expect, test } from 'claude-code/testing'

const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

const BREAKDOWN = {
  categories: [
    { name: 'Messages', tokens: 181_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 32_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 17_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'Custom agents', tokens: 335, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 720_000, color: 'x', isDeferred: false, kind: 'free' },
    { name: 'MCP tools (deferred)', tokens: 131_000, color: 'x', isDeferred: true, kind: 'deferred' },
  ],
  totalTokens: 247_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 24.7,
  model: 'claude-sonnet-5-5',
  memoryFiles: [{ path: 'C:/proj/CLAUDE.md', type: 'Project', tokens: 900 }],
  mcpTools: [{ name: 'a', serverName: 'terminal', tokens: 552, isLoaded: true }],
  agents: [{ agentType: 'dba', source: 'plugin', tokens: 101 }],
  skills: { totalSkills: 2, includedSkills: 2, tokens: 800, skillFrontmatter: [{ name: 'dataviz', source: 'plugin', tokens: 482 }] },
  isAutoCompactEnabled: true,
  autoCompactThreshold: 967_000,
  apiUsage: { input_tokens: 2, cache_read_input_tokens: 246_000, cache_creation_input_tokens: 321, output_tokens: 634 },
}

test('band and pane draw (no refused tree) on desktop and terminal', async ($, on) => {
  const store = new Map<string, unknown>()
  const v = (value: unknown) => ({ value }) as any
  on('session.id', () => v('test-session'))
  on('store.get', (_$, e: any) => v(store.get(e.key)))
  on('store.set', (_$, e: any) => (store.set(e.key, e.value), v(undefined)))
  on('clock.now', () => v(Date.now()))
  on('ui.log', () => v(undefined))
  on('ui.toast', () => v(undefined))
  on('ui.status', () => v(undefined))
  on('command.register', (_$, e: any) => v({ command: e.name }))
  on('ui.open', () => v({}))
  on('session.usage', (_$, e: any) =>
    v({
      startedAt: 0,
      context: { window: 1_000_000, tokens: 247_000, percent: 25, ...(e?.breakdown ? { breakdown: BREAKDOWN } : {}) },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 47, resetsAt: iso(4 * 3600_000) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: iso(95 * 3600_000) },
      ],
    }),
  )
  on('session.measure', (_$, e: any) => ({ changed: e.changed }) as any)

  await $.session.measure({
    context: { window: 1_000_000, tokens: 247_000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 47, resetsAt: iso(4 * 3600_000) },
      { kind: 'seven_day', percentUsed: 41, resetsAt: iso(95 * 3600_000) },
    ],
    changed: ['rateLimits'],
  } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [50, 80, 130]) {
      const band = await $.ui.mount({ plugin: 'quota-guard', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, bodyColumns } } as any)
      expect(band).toBeDefined()
      await band.unmount()
    }
    const pane = await $.ui.mount({ plugin: 'quota-guard', surface, component: 'Pane', requestId: 'quota-ctx', props: { title: 'Context', isFocused: false, bodyColumns: 60 } } as any)
    expect(pane).toBeDefined()
    await pane.unmount()
  }
})
