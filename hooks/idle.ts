// Idle compaction planner: pure logic, no engine imports.
//
// While a session waits on a background job, the prompt cache keeps ticking down. If the cache
// expires, the next request re-sends the whole context at full (cache-write) price. Compacting
// just BEFORE it expires reads the context at the cheap cached rate and leaves a small context
// for whatever wakes the session up. After expiry compacting saves nothing, so we never do it.

export type Pending = {
  id: string
  kind: 'bash' | 'monitor' | 'agent'
  label: string // what it is, in a few words
  command?: string
  at: number // when it was started
}

export type IdleCfg = {
  enabled: boolean
  minTokens: number // only worth it above this many context tokens
  ttlMs: number // prompt-cache lifetime (5 min or 1 h)
  marginMs: number // compact this long before the cache expires
  requireWaiting: boolean // true: only while waiting on background work; false: any idle session
}

export const IDLE_DEFAULTS: IdleCfg = {
  enabled: true,
  minTokens: 200_000,
  ttlMs: 60 * 60_000,
  marginMs: 180_000,
  requireWaiting: false,
}

export type IdleInput = {
  now: number
  lastResponseAt?: number // when the last model response finished (cache last refreshed)
  tokens?: number // context size the next request would re-send
  busy: boolean // a turn is running (compaction is refused while one runs)
  pending: readonly Pending[]
  quotaPhase: string // the quota state machine's phase; only act while it is 'idle'
  lastIdleCompactAt?: number
}

export type IdleDecision = { act: boolean; at?: number; why: string }

const MIN_LEAD_MS = 60_000
const MAX_PENDING_AGE_MS = 6 * 3600_000

export function freshPending(list: readonly Pending[], now: number): Pending[] {
  return list.filter(p => now - p.at < MAX_PENDING_AGE_MS)
}

export function planIdleCompact(cfg: IdleCfg, i: IdleInput): IdleDecision {
  if (!cfg.enabled) return { act: false, why: 'off' }
  if (i.busy) return { act: false, why: 'a turn is running' }
  if (i.quotaPhase !== 'idle') return { act: false, why: `quota state is ${i.quotaPhase}` }
  if (cfg.requireWaiting && freshPending(i.pending, i.now).length === 0) return { act: false, why: 'not waiting on background work' }
  if (i.tokens === undefined) return { act: false, why: 'context size unknown' }
  if (i.tokens < cfg.minTokens) return { act: false, why: 'context below the minimum' }
  if (i.lastResponseAt === undefined) return { act: false, why: 'no response yet' }
  if (i.lastIdleCompactAt !== undefined && i.lastIdleCompactAt >= i.lastResponseAt) {
    return { act: false, why: 'already compacted since the last response' }
  }
  const expires = i.lastResponseAt + cfg.ttlMs
  const trigger = i.lastResponseAt + Math.max(cfg.ttlMs - cfg.marginMs, MIN_LEAD_MS)
  if (i.now >= expires) return { act: false, why: 'cache already cold, compaction would save nothing' }
  if (i.now < trigger) return { act: false, at: trigger, why: 'waiting for the cache to near expiry' }
  return { act: true, why: 'cache about to expire' }
}

// ---------- recognising background work from a tool call ----------

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function pendingFromTool(tool: string, input: Record<string, unknown>, id: string, now: number): Pending | undefined {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (input.run_in_background !== true) return undefined
    const command = str('command')
    return { id, kind: 'bash', label: short(str('description') ?? command ?? tool, 100), command: command ? short(command, 300) : undefined, at: now }
  }
  if (tool === 'Monitor') {
    const command = str('command')
    return { id, kind: 'monitor', label: short(str('description') ?? command ?? 'monitor', 100), command: command ? short(command, 300) : undefined, at: now }
  }
  if (tool === 'Agent') {
    if (input.run_in_background === false) return undefined // agents run in the background unless told not to
    return { id, kind: 'agent', label: short(str('description') ?? 'subagent', 100), at: now }
  }
  return undefined
}

// A background task finished: drop the entry the notification most plausibly names,
// else the oldest one. Imprecise on purpose; being wrong only skips or delays a compaction.
export function clearOnNotification(list: readonly Pending[], text: string): Pending[] {
  if (list.length === 0) return []
  const t = text.toLowerCase()
  const hit = list.findIndex(p => (p.label.length > 3 && t.includes(p.label.toLowerCase())) || (p.command !== undefined && p.command.length > 3 && t.includes(p.command.toLowerCase().slice(0, 60))))
  const drop = hit >= 0 ? hit : 0
  return list.filter((_, idx) => idx !== drop)
}

// ---------- what the summary must keep ----------

export function idleInstructions(pending: readonly Pending[], task: string): string {
  const lines = pending.slice(-6).map(p => `- ${p.kind}: ${p.label}${p.command ? ` (command: ${p.command})` : ''}`)
  const task_ = task ? `Current task: ${task.slice(0, 600)}\n` : ''
  if (lines.length === 0) {
    return (
      'The session has been idle for a while; compacting now to keep the context small before the prompt cache expires. ' +
      'Make the summary lead with the current task and its state, and keep verbatim: the file paths, commands, and decisions that matter, ' +
      'and the exact next step to take when work resumes. Do not restart or redo completed work.\n' +
      task_
    )
  }
  return (
    'The session is idle, waiting on background work that will wake it up later; compacting now to keep the context small. ' +
    'Make the summary lead with what the session is waiting on, and keep verbatim: the task ids, commands, and file paths involved, ' +
    'where the output will appear, how to tell whether it succeeded, and the exact next step to take when it finishes. ' +
    'Do not restart or redo completed work.\n' +
    task_ +
    `Waiting on:\n${lines.join('\n')}`
  )
}
