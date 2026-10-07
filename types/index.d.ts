export type QuotaBar = {
  ctx?: number
  ctxTokens?: number
  ctxWindow?: number
  fiveAt?: string
  weekAt?: string
  threshold?: number
  ctxMin?: number
  legend?: boolean
  parts?: { name: string; pct: number }[]
  five?: number
  fiveReset?: string
  week?: number
  weekReset?: string
  phase: string
  note?: string
}

export type CtxDetail = {
  model: string
  total: number
  window: number
  percent: number
  autoAt?: number
  categories: { name: string; tokens: number; kind: string }[]
  memory: { path: string; tokens: number }[]
  mcp: { server: string; tokens: number }[]
  agents: { name: string; tokens: number }[]
  skills?: { count: number; total: number; tokens: number; top: { name: string; tokens: number }[] }
  api?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }
}

declare module 'claude-code' {
  interface PluginState {
    'quota-guard': { bar: QuotaBar | null; detail: CtxDetail | null }
  }
}
