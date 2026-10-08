// Pure quota state machine. No engine imports: the adapter (register.ts) feeds
// it events and executes the effects it returns, so everything here is
// unit-testable with plain values.

export type Phase = 'idle' | 'armed' | 'compacting' | 'paused' | 'resuming' | 'stopped'

export const FIVE = 'five_hour'
export const WEEK = 'seven_day'

export type Win = { kind: string; percent: number; resetsAt?: number }
export type Usage = { windows: Win[]; contextPercent?: number }

export type Config = {
  enabled: boolean
  threshold: number // 5-hour compaction/pause threshold, %
  weeklyThreshold: number // weekly threshold, %
  abortThreshold: number // abort the running turn at/above this, %
  ceiling: number // burn-rate ceiling: pause if pct + predicted next jump >= this
  burnMultiplier: number
  graceSec: number // wait this long after the reported reset before re-checking
  maxResumeAttempts: number
  weeklyPolicy: 'pause' | 'notify'
  notifyAt: number // one-off heads-up toast at this %, 0 = off
  compactMinContext: number // compact before pausing only if context is above this %
}

export const DEFAULTS: Config = {
  enabled: true,
  threshold: 94,
  weeklyThreshold: 97,
  abortThreshold: 98,
  ceiling: 99,
  burnMultiplier: 1.5,
  graceSec: 30,
  maxResumeAttempts: 5,
  weeklyPolicy: 'pause',
  notifyAt: 80,
  compactMinContext: 30,
}

export type Rec = {
  phase: Phase
  reason?: string
  kinds: string[]
  expectedReset?: number
  wakeAt?: number
  task: string
  pausedAt?: number
  compactedAt?: number
  compactFailed?: boolean
  usage: Win[]
  resumeAttempts: number
  delayCount: number
  lastResumeAt?: number
  abortRequested?: boolean
  op?: number // identity of the compaction / resume in flight; a completion for any other op is stale
  delivered?: boolean // the session accepted this resume's prompt
  verified?: boolean // quota was seen to have reset (it can be seen before the prompt is delivered)
  predictive?: boolean // paused on the burn-rate prediction, not on a static limit
}

export type State = {
  v: 1
  rec: Rec
  busy: boolean
  deltas: number[] // recent 5-hour jumps per measurement, for burn-rate
  last?: { pct: number; resetsAt?: number }
  notified: string[]
  ctx?: number // last known context-window fill, %
  opSeq: number // source of operation identities
  known: string[] // managed windows ever seen: a resume is only verified if all of them read healthy
}

export type Ev =
  | { type: 'measure'; now: number; usage: Usage }
  | { type: 'turnStart' }
  | { type: 'turnComplete'; now: number; reason: string }
  | { type: 'userPrompt'; now: number; text: string; isUser: boolean }
  | { type: 'compactDone'; now: number; ok: boolean; op?: number; external?: boolean }
  | { type: 'tick'; now: number; usage: Usage | null }
  | { type: 'boot'; now: number; usage: Usage | null }
  | { type: 'submitFailed'; now: number; text: string; op: number }
  | { type: 'resumeDelivered'; now: number; op: number }
  | { type: 'forcePause'; now: number; minutes: number }
  | { type: 'cancel'; now: number }
  | { type: 'resume'; now: number }

export type Fx =
  | { t: 'toast'; text: string }
  | { t: 'abort' }
  | { t: 'compact'; instructions: string; op: number }
  | { t: 'submit'; text: string; op: number }
  | { t: 'fill'; text: string }

export type Result = { state: State; fx: Fx[] }

export const RESUME_PROMPT =
  'Usage window has reset. Continue the previous task from the compacted context and persisted recovery state. Do not restart completed work.'

const BACKOFF_SEC = [60, 120, 300, 600, 900]
const RESUME_WATCHDOG_MS = 180_000

export function emptyRec(task = ''): Rec {
  return { phase: 'idle', kinds: [], task, usage: [], resumeAttempts: 0, delayCount: 0 }
}

export function initialState(): State {
  return { v: 1, rec: emptyRec(), busy: false, deltas: [], notified: [], opSeq: 0, known: [] }
}

// ---------- formatting ----------

const pad = (n: number) => (n < 10 ? '0' + n : String(n))

export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 1) return '<1m'
  const h = Math.floor(m / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h ${pad(m % 60)}m`.replace(/ 0(\d)m/, ' $1m') : `${m}m`
}

const label = (kind: string) => (kind === FIVE ? '5-hour' : kind === WEEK ? 'Weekly' : kind)

export function describeWindow(w: Win, now: number): string {
  const reset = w.resetsAt === undefined ? '' : w.resetsAt <= now ? ', reset time passed' : `, resets in ${fmtDur(w.resetsAt - now)}`
  return `${label(w.kind)} usage: ${Math.round(w.percent)}%${reset}`
}

// ---------- helpers ----------

const clone = (s: State): State => JSON.parse(JSON.stringify(s))

function limitFor(kind: string, cfg: Config): number | undefined {
  if (kind === FIVE) return cfg.threshold
  if (kind === WEEK) return cfg.weeklyPolicy === 'pause' ? cfg.weeklyThreshold : undefined
  return undefined
}

export function predictedJump(s: State, cfg: Config): number {
  const m = s.deltas.length ? Math.max(...s.deltas) : 0
  return Math.min(25, m * cfg.burnMultiplier)
}

function breaches(u: Usage, s: State, cfg: Config): Win[] {
  const out: Win[] = []
  for (const w of u.windows) {
    const lim = limitFor(w.kind, cfg)
    if (lim === undefined) continue
    if (w.percent >= lim || (w.kind === FIVE && w.percent + predictedJump(s, cfg) >= cfg.ceiling)) out.push(w)
  }
  return out
}

const backoffMs = (n: number) => (BACKOFF_SEC[Math.min(n, BACKOFF_SEC.length - 1)] ?? 900) * 1000

export function blocksAutomation(s: State): boolean {
  return s.rec.phase === 'paused' || s.rec.phase === 'stopped' || s.rec.phase === 'compacting'
}

export function compactInstructions(task: string): string {
  return (
    'A usage-limit pause is about to start and work will resume automatically afterwards. ' +
    'In the summary, state verbatim the current task' +
    (task ? ` ("${task.slice(0, 600)}")` : '') +
    ', what is already done, what remains, and the exact next step. Do not restart completed work.'
  )
}

export function resumePrompt(r: Rec): string {
  const bits = [RESUME_PROMPT]
  if (r.task) bits.push(`Task before the pause: ${r.task.slice(0, 1500)}`)
  return bits.join('\n\n')
}

// ---------- the machine ----------

export function step(s0: State, ev: Ev, cfg: Config): Result {
  const s = clone(s0)
  const fx: Fx[] = []
  const toast = (text: string) => fx.push({ t: 'toast', text })
  const r = s.rec
  if (!s.known) s.known = []
  const newOp = () => (s.opSeq = (s.opSeq ?? 0) + 1)

  const settle = (task = r.task) => {
    s.rec = emptyRec(task)
  }

  const shouldCompact = () => s.ctx === undefined || s.ctx > cfg.compactMinContext

  const compactOrPause = (now: number) => {
    if (shouldCompact()) startCompact()
    else {
      r.compactedAt = undefined
      enterPause(now)
    }
  }

  const startCompact = () => {
    r.phase = 'compacting'
    r.op = newOp()
    fx.push({ t: 'compact', op: r.op, instructions: compactInstructions(r.task) })
  }

  const enterPause = (now: number) => {
    r.phase = 'paused'
    r.op = undefined
    r.pausedAt = now
    const grace = cfg.graceSec * 1000
    r.wakeAt = r.expectedReset === undefined ? now + backoffMs(r.delayCount) : Math.max(r.expectedReset + grace, now + 5000)
    if (r.compactFailed) toast('Compaction failed; pausing anyway.')
    toast(`Paused until approximately ${fmtClock(r.wakeAt)}.`)
  }

  const arm = (now: number, wins: Win[], all: Usage | null, reasonOverride?: string) => {
    const resets = wins.map(w => w.resetsAt).filter((x): x is number => typeof x === 'number')
    const task = r.task
    const fresh: Rec = {
      ...emptyRec(task),
      phase: 'armed',
      kinds: wins.map(w => w.kind),
      reason: reasonOverride ?? wins.map(w => describeWindow(w, now)).join('; '),
      expectedReset: resets.length ? Math.max(...resets) : undefined,
      usage: all ? all.windows.map(w => ({ ...w })) : wins.map(w => ({ ...w })),
      predictive: wins.every(w => w.percent < (limitFor(w.kind, cfg) ?? Infinity)),
    }
    for (const k of Object.keys(r)) delete (r as Record<string, unknown>)[k]
    Object.assign(r, fresh)
    // the worst breached window drives the message and the decision to abort a running turn
    const top = wins.reduce<Win | undefined>((m, w) => (m === undefined || w.percent > m.percent ? w : m), undefined)
    if (top) {
      const pct = Math.round(top.percent)
      toast(
        shouldCompact()
          ? `${label(top.kind)} usage reached ${pct}%. Compacting before quota exhaustion.`
          : `${label(top.kind)} usage reached ${pct}%. Context is only ${Math.round(s.ctx ?? 0)}%, so no compaction needed; waiting for the reset.`,
      )
    }
    if (s.busy) {
      if (top && top.percent >= cfg.abortThreshold) {
        r.abortRequested = true
        fx.push({ t: 'abort' })
      }
    } else compactOrPause(now)
  }

  const resumeNow = (now: number, mode: 'confirmed' | 'assumed' | 'forced') => {
    if (r.resumeAttempts >= cfg.maxResumeAttempts) {
      r.phase = 'stopped'
      r.wakeAt = undefined
      toast(`Auto-resume gave up after ${r.resumeAttempts} attempts. Use /quota resume or send a prompt.`)
      return
    }
    r.phase = 'resuming'
    r.op = newOp()
    r.delivered = false
    r.verified = false
    r.resumeAttempts++
    r.lastResumeAt = now
    toast(
      mode === 'confirmed'
        ? 'Usage reset confirmed. Resuming task.'
        : mode === 'assumed'
          ? 'Reset time passed (usage not re-measured yet). Resuming task to verify.'
          : 'Resuming task.',
    )
    fx.push({ t: 'submit', op: r.op, text: resumePrompt(r) })
  }

  const resumeFailed = (now: number, why: string, nextReset?: number) => {
    r.op = undefined
    r.delivered = false
    r.verified = false
    r.delayCount++
    if (r.resumeAttempts >= cfg.maxResumeAttempts) {
      r.phase = 'stopped'
      r.wakeAt = undefined
      toast(`Auto-resume gave up (${why}). Use /quota resume when the limit has reset.`)
      return
    }
    r.phase = 'paused'
    if (nextReset !== undefined) r.expectedReset = nextReset
    r.wakeAt = Math.max(nextReset !== undefined ? nextReset + cfg.graceSec * 1000 : 0, now + backoffMs(r.delayCount))
    toast(`Resume did not take (${why}). Trying again around ${fmtClock(r.wakeAt)}.`)
  }

  const wake = (now: number, usage: Usage | null) => {
    if (!usage || usage.windows.length === 0) {
      r.delayCount++
      const lateAndBlind = r.delayCount >= 3 && (r.expectedReset === undefined || r.expectedReset <= now)
      if (lateAndBlind) return resumeNow(now, 'assumed')
      r.wakeAt = now + backoffMs(r.delayCount)
      if (r.delayCount === 1) toast('Usage data unavailable; will retry shortly.')
      return
    }
    // every managed window counts, not only the ones that caused the pause: another one may have
    // been exhausted since (or the pause started on a different window)
    const limited: number[] = []
    let stale = false
    const kinds = new Set(r.kinds.filter(k => limitFor(k, cfg) !== undefined))
    for (const w of usage.windows) if (limitFor(w.kind, cfg) !== undefined) kinds.add(w.kind)
    for (const k of s.known) if (limitFor(k, cfg) !== undefined) kinds.add(k)
    for (const k of kinds) {
      const w = usage.windows.find(x => x.kind === k)
      const lim = limitFor(k, cfg) ?? cfg.threshold
      if (!w) {
        stale = true
        continue
      }
      if (w.percent >= lim) {
        if (!r.kinds.includes(k)) r.kinds.push(k)
        if (w.resetsAt !== undefined && w.resetsAt > now) limited.push(w.resetsAt)
        else stale = true // reading predates the reset; only a fresh response can tell
      }
    }
    if (limited.length) {
      const next = Math.max(...limited)
      const moved = r.expectedReset === undefined || Math.abs(next - r.expectedReset) > 60_000
      r.expectedReset = next
      r.wakeAt = next + cfg.graceSec * 1000
      r.delayCount++
      toast(
        moved
          ? `Quota not reset yet; reset time moved to about ${fmtClock(next)}.`
          : `Quota not reset yet; rechecking around ${fmtClock(r.wakeAt)}.`,
      )
      return
    }
    resumeNow(now, stale ? 'assumed' : 'confirmed')
  }

  const tickLike = (now: number, usage: Usage | null) => {
    if (r.phase === 'paused' && cfg.enabled && !s.busy && r.wakeAt !== undefined && now >= r.wakeAt) wake(now, usage)
    // a turn that is running is the resume prompt being answered, however slowly: never time it out
    // (and never queue a second probe behind it); only a prompt that never started is a failure
    else if (r.phase === 'resuming' && !s.busy && r.lastResumeAt !== undefined && now - r.lastResumeAt > RESUME_WATCHDOG_MS) {
      resumeFailed(now, 'no response to the resume prompt')
    }
  }

  const evaluate = (now: number, usage: Usage) => {
    const hit = breaches(usage, s, cfg)
    if (hit.length) arm(now, hit, usage)
  }

  switch (ev.type) {
    case 'measure': {
      if (typeof ev.usage.contextPercent === 'number') s.ctx = ev.usage.contextPercent
      for (const w of ev.usage.windows) if (limitFor(w.kind, cfg) !== undefined && !s.known.includes(w.kind)) s.known.push(w.kind)
      if (!cfg.enabled) break
      const u = ev.usage
      const five = u.windows.find(w => w.kind === FIVE)
      if (five) {
        // burn-rate history is the growth over the last few measurements of THIS window: a new
        // window starts it over, and flat measurements age an old spike out
        const sameWindow = s.last !== undefined && Math.abs((s.last.resetsAt ?? 0) - (five.resetsAt ?? 0)) < 120_000
        if (!sameWindow) s.deltas = []
        else if (s.last) {
          s.deltas.push(Math.max(0, five.percent - s.last.pct))
          s.deltas = s.deltas.slice(-5)
        }
        s.last = { pct: five.percent, resetsAt: five.resetsAt }
      }
      const hit = breaches(u, s, cfg)

      if (r.phase === 'resuming') {
        // Only a reading that is evidence counts. Under the limit in EVERY managed window we have ever
        // seen: the reset happened. Over it with a reset still ahead: it did not. Over it with a reset
        // already past, a window missing, or an unchanged snapshot of a burn-rate pause: the old
        // reading again, no evidence either way, so keep waiting for the turn's own outcome.
        const managed = new Set(r.kinds.filter(k => limitFor(k, cfg) !== undefined))
        for (const k of s.known) if (limitFor(k, cfg) !== undefined) managed.add(k)
        const limitedResets: number[] = []
        let allLow = managed.size > 0
        let newWindow = false
        for (const k of managed) {
          const w = u.windows.find(x => x.kind === k)
          const lim = limitFor(k, cfg) ?? cfg.threshold
          if (!w) {
            allLow = false
            continue
          }
          if (w.resetsAt !== undefined && w.resetsAt > (r.expectedReset ?? 0) + 120_000) newWindow = true
          if (w.percent >= lim) {
            allLow = false
            if (w.resetsAt !== undefined && w.resetsAt > ev.now) limitedResets.push(w.resetsAt)
          }
        }
        // a window that was fine when the pause began but is exhausted now blocks the resume too
        for (const w of hit) {
          if (r.kinds.includes(w.kind) || w.resetsAt === undefined || w.resetsAt <= ev.now) continue
          r.kinds.push(w.kind)
          limitedResets.push(w.resetsAt)
          allLow = false
        }
        if (limitedResets.length) {
          resumeFailed(ev.now, 'quota still exhausted', Math.max(...limitedResets))
        } else if (allLow && (!r.predictive || newWindow)) {
          // quota is verified; the task is only done once its continuation was actually delivered
          if (r.delivered) {
            const task = r.task
            settle(task)
            toast('Quota reset verified.')
          } else r.verified = true
        }
        break
      }
      if (r.phase === 'idle') {
        if (hit.length) {
          arm(ev.now, hit, u)
          break
        }
        if (cfg.notifyAt > 0) {
          for (const w of u.windows) {
            if (limitFor(w.kind, cfg) === undefined && w.kind !== WEEK) continue
            const key = `${w.kind}@${Math.round((w.resetsAt ?? 0) / 60000)}`
            if (w.percent >= cfg.notifyAt && !s.notified.includes(key)) {
              s.notified = [...s.notified, key].slice(-10)
              toast(describeWindow(w, ev.now))
            }
          }
        }
        break
      }
      if (r.phase === 'armed') {
        r.usage = u.windows.map(w => ({ ...w }))
        // a window that is exhausted after arming joins the pause and sets how long it lasts
        for (const w of hit) {
          if (!r.kinds.includes(w.kind)) r.kinds.push(w.kind)
          if (w.resetsAt !== undefined) r.expectedReset = Math.max(r.expectedReset ?? 0, w.resetsAt)
        }
        const worst = hit.reduce((m, w) => Math.max(m, w.percent), 0)
        if (s.busy && !r.abortRequested && worst >= cfg.abortThreshold) {
          r.abortRequested = true
          fx.push({ t: 'abort' })
        }
        break
      }
      if (r.phase === 'paused') {
        for (const w of hit) if (!r.kinds.includes(w.kind)) r.kinds.push(w.kind)
        const managed = new Set(r.kinds.filter(k => limitFor(k, cfg) !== undefined))
        for (const k of s.known) if (limitFor(k, cfg) !== undefined) managed.add(k)
        const blocking: number[] = []
        let allLow = managed.size > 0
        let newWindow = false
        for (const k of managed) {
          const w = u.windows.find(x => x.kind === k)
          const lim = limitFor(k, cfg) ?? cfg.threshold
          if (!w || w.percent >= lim) allLow = false
          if (w && w.resetsAt !== undefined && w.resetsAt > (r.expectedReset ?? 0) + 120_000) newWindow = true
          if (w && w.percent >= lim && w.resetsAt !== undefined && w.resetsAt > ev.now) blocking.push(w.resetsAt)
        }
        if (blocking.length) {
          // only a reading that is still over the limit can move the wake time
          const next = Math.max(...blocking)
          if (r.expectedReset === undefined || Math.abs(next - r.expectedReset) > 60_000) {
            r.expectedReset = next
            r.wakeAt = next + cfg.graceSec * 1000
            toast(`Reset time changed; now paused until approximately ${fmtClock(r.wakeAt)}.`)
          }
        } else if (allLow && (!r.predictive || newWindow) && r.wakeAt !== undefined && r.wakeAt > ev.now) {
          // a fresh reading under the limit means the reset already happened. A burn-rate pause is not
          // over when the very reading that caused it comes in again: it needs a new window.
          r.wakeAt = ev.now
        }
      }
      break
    }

    case 'turnStart':
      s.busy = true
      break

    case 'turnComplete': {
      s.busy = false
      if (r.phase === 'armed') {
        if (r.compactedAt !== undefined) enterPause(ev.now)
        else compactOrPause(ev.now)
      } else if (r.phase === 'resuming') {
        if (ev.reason === 'error') resumeFailed(ev.now, 'API error')
        else if (ev.reason === 'aborted') {
          settle()
          toast('Resume turn was interrupted; auto-resume finished.')
        } else {
          settle()
          toast('Quota reset verified.')
        }
      }
      break
    }

    case 'userPrompt': {
      if (!ev.isUser) break
      if (r.phase === 'paused' || r.phase === 'stopped') {
        settle(r.task)
        toast('Auto-resume cancelled: you resumed manually.')
      } else if (r.phase === 'resuming') {
        settle(r.task)
      } else if (r.phase === 'armed' || r.phase === 'compacting') {
        settle(r.task)
        toast('Quota pause cancelled: you sent a new prompt.')
      }
      const t = ev.text.trim()
      if (t && !t.startsWith('/') && (t.length >= 12 || !s.rec.task)) s.rec.task = t.slice(0, 4000)
      break
    }

    case 'compactDone': {
      if (ev.external) {
        if (r.phase === 'armed' || r.phase === 'compacting') {
          r.compactedAt = ev.now
          if (!s.busy) enterPause(ev.now)
        }
        break
      }
      if (r.phase === 'compacting' && ev.op === r.op) {
        r.compactedAt = ev.ok ? ev.now : undefined
        r.compactFailed = !ev.ok
        enterPause(ev.now)
      }
      break
    }

    case 'tick':
      tickLike(ev.now, ev.usage)
      break

    case 'boot': {
      s.busy = false
      if (ev.usage && typeof ev.usage.contextPercent === 'number') s.ctx = ev.usage.contextPercent
      if (r.phase === 'compacting' || r.phase === 'armed') {
        if (r.compactedAt !== undefined) {
          enterPause(ev.now)
        } else {
          settle(r.task)
          if (cfg.enabled && ev.usage) evaluate(ev.now, ev.usage)
        }
      } else if (r.phase === 'paused') {
        toast(
          r.wakeAt !== undefined && ev.now < r.wakeAt
            ? `Restored quota pause; checking again around ${fmtClock(r.wakeAt)}.`
            : 'Restored quota pause; reset time has passed, checking now.',
        )
        tickLike(ev.now, ev.usage)
      } else if (r.phase === 'resuming') {
        tickLike(ev.now, ev.usage)
      } else if (r.phase === 'idle' && cfg.enabled && ev.usage) {
        evaluate(ev.now, ev.usage)
      }
      break
    }

    case 'resumeDelivered': {
      if (r.phase !== 'resuming' || ev.op !== r.op) break
      r.delivered = true
      if (r.verified) {
        const task = r.task
        settle(task)
        toast('Quota reset verified.')
      }
      break
    }

    case 'submitFailed': {
      if (r.phase !== 'resuming' || ev.op !== r.op) break
      r.op = undefined
      r.phase = 'stopped'
      r.wakeAt = undefined
      fx.push({ t: 'fill', text: ev.text })
      toast('Could not submit the resume prompt automatically. It is in the prompt box: press Enter to continue.')
      break
    }

    case 'forcePause': {
      if (r.phase !== 'idle' && r.phase !== 'stopped') {
        toast(`Already ${r.phase}.`)
        break
      }
      const reset = ev.now + ev.minutes * 60_000
      const task = r.task
      for (const k of Object.keys(r)) delete (r as Record<string, unknown>)[k]
      Object.assign(r, {
        ...emptyRec(task),
        phase: 'armed',
        kinds: ['forced'],
        reason: `forced pause for ${ev.minutes}m (testing)`,
        expectedReset: reset,
      })
      toast(`Forced pause: compacting, then waiting until about ${fmtClock(reset)}.`)
      if (!s.busy) compactOrPause(ev.now)
      break
    }

    case 'cancel': {
      if (r.phase === 'idle') {
        toast('Nothing pending to cancel.')
        break
      }
      r.phase = 'stopped'
      r.op = undefined
      r.wakeAt = undefined
      toast('Auto-resume cancelled. Use /quota resume or send a prompt to continue.')
      break
    }

    case 'resume': {
      if (r.phase === 'paused' || r.phase === 'stopped') {
        r.resumeAttempts = 0
        resumeNow(ev.now, 'forced')
      } else toast('Nothing to resume.')
      break
    }
  }

  return { state: s, fx }
}

export function needsHeartbeat(s: State): boolean {
  return s.rec.phase === 'paused' || s.rec.phase === 'resuming'
}

export function statusLine(s: State, u: Usage | null, now: number): string | undefined {
  const r = s.rec
  if (r.phase === 'paused' && r.wakeAt !== undefined) return `quota pause until ${fmtClock(r.wakeAt)}`
  if (r.phase === 'resuming') return 'quota: resuming'
  if (r.phase === 'stopped') return 'quota: auto-resume held'
  if (r.phase === 'compacting' || r.phase === 'armed') return 'quota: compacting'
  const five = u?.windows.find(w => w.kind === FIVE)
  if (!five) return undefined
  return `5h ${Math.round(five.percent)}%${five.resetsAt && five.resetsAt > now ? ` · ${fmtDur(five.resetsAt - now)}` : ''}`
}
