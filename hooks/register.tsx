import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CtxDetail, QuotaBar } from '../types'

import {
  DEFAULTS,
  FIVE,
  WEEK,
  blocksAutomation,
  describeWindow,
  fmtClock,
  fmtDur,
  initialState,
  needsHeartbeat,
  resumeMarker,
  statusLine,
  step,
} from './core'
import type { Config, Ev, Fx, State, Usage, Win } from './core'
import { IDLE_DEFAULTS, clearOnNotification, freshPending, idleInstructions, pendingFromTool, planIdleCompact } from './idle'
import type { IdleCfg, Pending } from './idle'

const HEARTBEAT_MS = 30_000
const USER_KINDS = ['composer', 'bridge', 'sdk', 'slack-ping']
const PREFIX = 'quota-guard: '
const bar = atom({ plugin: 'quota-guard', key: 'bar' } as const, null)
const detail = atom({ plugin: 'quota-guard', key: 'detail' } as const, null)
const PANE = 'quota-ctx'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const when = (w: Win | undefined, now: number) => {
  if (!w?.resetsAt || w.resetsAt <= now) return undefined
  return w.resetsAt - now > 20 * 3600_000 ? `${DAYS[new Date(w.resetsAt).getDay()]} ${fmtClock(w.resetsAt)}` : fmtClock(w.resetsAt)
}
const tok = (n?: number) => (n === undefined ? '' : n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
const CELLS = 10
const filled = (pct: number) => Math.max(0, Math.min(CELLS, Math.round((pct / 100) * CELLS)))
const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const tail = (path: string) => path.split(/[\\/]/).slice(-2).join('/')

function buildDetail(b: any, api: any): CtxDetail {
  const win = b.rawMaxTokens || b.maxTokens || 1
  const mcp = new Map<string, number>()
  for (const t of b.mcpTools ?? []) mcp.set(t.serverName, (mcp.get(t.serverName) ?? 0) + (t.isLoaded ? t.tokens : 0))
  return {
    model: b.model,
    total: b.totalTokens,
    window: win,
    percent: b.percentage,
    autoAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    categories: (b.categories ?? []).map((c: any) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    memory: (b.memoryFiles ?? []).map((m: any) => ({ path: tail(m.path), tokens: m.tokens })).sort((x: any, y: any) => y.tokens - x.tokens).slice(0, 8),
    mcp: [...mcp.entries()].map(([server, tokens]) => ({ server, tokens })).sort((x, y) => y.tokens - x.tokens).slice(0, 8),
    agents: (b.agents ?? []).map((a: any) => ({ name: a.agentType, tokens: a.tokens })).sort((x: any, y: any) => y.tokens - x.tokens).slice(0, 6),
    skills: b.skills ? { count: b.skills.includedSkills ?? b.skills.totalSkills, total: b.skills.totalSkills, tokens: b.skills.tokens, top: (b.skills.skillFrontmatter ?? []).map((k: any) => ({ name: k.name, tokens: k.tokens })).sort((x: any, y: any) => y.tokens - x.tokens).slice(0, 6) } : undefined,
    api: api ? { input: api.input_tokens, cacheRead: api.cache_read_input_tokens, cacheWrite: api.cache_creation_input_tokens, output: api.output_tokens } : undefined,
  }
}

// one distinct colour per category, assigned by size rank so the bar and the list always agree
const PALETTE = ['green', 'cyan', 'yellow', 'magenta', 'red', 'blue', 'white']
const colorAt = (rank: number) => PALETTE[rank % PALETTE.length] ?? 'white'
// Continuous bar: each segment is as wide as its share of the whole window, so the
// filled part is always exactly the context percentage. Segments are sized in cells
// (fractions allowed; the engine refuses fractional percentages).
// Remote surfaces (desktop, editor, mobile) can draw vectors: a rounded pill with a soft
// track, segments clipped to it, and a hairline where compaction starts to apply.
const HEX = ['#3fb950', '#22b8cf', '#e3b341', '#c678dd', '#f0626b', '#5b8def', '#adb5bd']
const hexAt = (rank: number) => HEX[rank % HEX.length] ?? '#adb5bd'

function ctxPill(Svg: any, segs: { pct: number; hex: string }[], w: number, bh: number, tickPct?: number) {
  const pad = 2
  const H = bh + pad * 2
  let x = 0
  const bars = segs
    .filter(sg => sg.pct > 0)
    .map(sg => {
      const sw = Math.max(0, Math.min(w - x, (sg.pct / 100) * w))
      const out = `<rect x="${x.toFixed(2)}" y="${pad}" width="${sw.toFixed(2)}" height="${bh}" fill="${sg.hex}"/>`
      x += sw
      return out
    })
    .join('')
  const tickMark = tickPct && tickPct > 0 && tickPct < 100 ? `<rect x="${((tickPct / 100) * w - 0.6).toFixed(2)}" y="0" width="1.2" height="${H}" rx="0.6" fill="#8b949e" opacity="0.85"/>` : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">` +
    `<defs><clipPath id="p"><rect x="0" y="${pad}" width="${w}" height="${bh}" rx="${bh / 2}"/></clipPath></defs>` +
    `<rect x="0" y="${pad}" width="${w}" height="${bh}" rx="${bh / 2}" fill="#8b949e" fill-opacity="0.28"/>` +
    `<g clip-path="url(#p)">${bars}</g>${tickMark}</svg>`
  return <Svg source={source} alt="Context window usage" width={w} height={H} />
}

function swatch(Svg: any, hex: string) {
  return (
    <Svg
      source={`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="3" fill="${hex}"/></svg>`}
      alt="category colour"
      width={10}
      height={10}
    />
  )
}

function ctxBar(Box: any, segs: { pct: number; color: string }[], width: number) {
  return (
    <Box width={width} height={1} flexShrink={0} backgroundColor="gray">
      {segs
        .filter(x => x.pct > 0)
        .map(x => (
          <Box width={Math.max(0, Math.min(width, (x.pct / 100) * width))} height={1} flexShrink={0} backgroundColor={x.color} />
        ))}
    </Box>
  )
}

const tone = (pct: number) => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

type Sim = {
  five: { percent: number; resetsAt: number }
  week?: { percent: number; resetsAt: number }
  mode: 'ok' | 'fail' | 'delay'
  failedOnce: boolean
  probeFails: number
  unavailable: boolean
  ctx?: number
}

type Overrides = Partial<Config> & { testMode?: boolean; dryActions?: boolean; legend?: boolean; idle?: Partial<IdleCfg> }

let S: State | null = null
let cfg: Config = { ...DEFAULTS }
let testMode = false
let dryActions = true
let legend = false
let sim: Sim | null = null
let sid = ''
let turnId: string | undefined
let timer: { cancel: () => void } | undefined
let loading: Promise<void> | undefined
let lastText = ''
let idleCfg: IdleCfg = { ...IDLE_DEFAULTS }
let waiting: Pending[] = [] // background work the session is currently waiting on
let lastResponseAt: number | undefined
let lastIdleCompactAt: number | undefined
let idleTimer: { cancel: () => void } | undefined
let idleStats: { at: number; before: number; count: number } | undefined
let warned = false
// bumped when a session ends: everything started before that (loads, effects, retries) belongs to the
// old session and must neither mutate the new one nor reuse its operation numbers
let epoch = 0
let lastTouchAt = 0
let booted = false
const STAGGER_MS = 20_000
const MAX_STAGGER_MS = 120_000

let commandReady = false
async function registerCommand($: any) {
  if (commandReady) return
  const spec = {
    description: 'Quota guard: status, on/off, threshold, pause, cancel, resume, test',
    argumentHint: '[status|on|off|threshold N|weekly N|ctxmin N|idle [on|off|any|waiting|min N|ttl M]|ctx [close]|pause [min]|cancel|resume|test on|off|sim ...]',
    immediate: true as const,
  }
  try {
    await $.command.register({ name: 'quota', ...spec })
    await $.command.register({ name: 'quota-guard', ...spec })
    commandReady = true
  } catch (err) {
    $.ui.log(PREFIX + `could not register /quota: ${String(err)}`)
  }
}

let options: Readonly<Record<string, string | number | boolean | readonly string[]>> = {}
const num = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d)

async function load($: any): Promise<void> {
  const gen = epoch
  await registerCommand($)
  // read and build everything into locals first; publish only when all of it succeeded, so a failure
  // part-way leaves nothing half-initialised for the next hook to mistake for a good start
  const id = await $.session.id()
  const saved = (await $.store.get('state:' + id)) as State | undefined
  const o = ((await $.store.get('cfg')) ?? {}) as Overrides
  const idle = ((await $.store.get('idle:' + id)) as typeof idleStats) ?? undefined
  const simSaved = ((await $.store.get('sim')) as Sim | undefined) ?? null

  const { testMode: tm, dryActions: da, legend: lg, idle: oIdle, ...rest } = o
  const nextCfg: Config = {
    enabled: typeof options.enabled === 'boolean' ? options.enabled : DEFAULTS.enabled,
    threshold: num('threshold', DEFAULTS.threshold),
    weeklyThreshold: num('weeklyThreshold', DEFAULTS.weeklyThreshold),
    abortThreshold: num('abortThreshold', DEFAULTS.abortThreshold),
    ceiling: DEFAULTS.ceiling,
    burnMultiplier: DEFAULTS.burnMultiplier,
    graceSec: num('graceSeconds', DEFAULTS.graceSec),
    maxResumeAttempts: num('maxResumeAttempts', DEFAULTS.maxResumeAttempts),
    weeklyPolicy: options.weeklyPolicy === 'notify' ? 'notify' : 'pause',
    notifyAt: num('notifyAt', DEFAULTS.notifyAt),
    compactMinContext: num('compactMinContext', DEFAULTS.compactMinContext),
    ...rest,
  }
  const nextIdle: IdleCfg = {
    enabled: typeof options.idleCompact === 'boolean' ? options.idleCompact : IDLE_DEFAULTS.enabled,
    minTokens: num('idleCompactMinTokens', IDLE_DEFAULTS.minTokens),
    ttlMs: num('cacheTtlMinutes', IDLE_DEFAULTS.ttlMs / 60_000) * 60_000,
    marginMs: num('idleMarginSeconds', IDLE_DEFAULTS.marginMs / 1000) * 1000,
    requireWaiting: typeof options.idleRequiresBackground === 'boolean' ? options.idleRequiresBackground : IDLE_DEFAULTS.requireWaiting,
    ...(oIdle ?? {}),
  }

  if (gen !== epoch) return // the session ended while this was loading: its state is not ours to publish
  sid = id
  cfg = nextCfg
  idleCfg = nextIdle
  idleStats = idle
  sim = simSaved
  testMode = typeof tm === 'boolean' ? tm : typeof options.testMode === 'boolean' ? options.testMode : false
  if (typeof da === 'boolean') dryActions = da
  if (typeof lg === 'boolean') legend = lg
  const blank = initialState()
  S =
    saved && saved.v === 1
      ? { ...blank, ...saved, rec: { ...blank.rec, ...saved.rec }, known: saved.known ?? [], opSeq: saved.opSeq ?? 0 }
      : blank // last: this is what ensure() takes as "loaded"
  await touchIndex($)
}

// Keep the shared store small. Recent sessions stay; older ones are forgotten, EXCEPT records with
// unresolved recovery (a pause, a resume in flight): those are never discarded. Records written before
// the index existed are adopted (as the oldest) so they too can age out.
const INDEX_CAP = 25

async function recordUnresolved($: any, id: string): Promise<boolean> {
  const st = (await $.store.get('state:' + id)) as State | undefined
  return !!(st?.rec && st.rec.phase !== 'idle')
}

async function touchIndex($: any) {
  try {
    const now = await $.clock.now()
    lastTouchAt = now
    const idx = ((await $.store.get('index')) as { sid: string; at: number }[] | undefined) ?? []
    const indexed = new Set(idx.map(x => x.sid))
    let legacy: string[] = []
    try {
      legacy = ((await $.store.keys()) as string[])
        .filter(k => k.startsWith('state:'))
        .map(k => k.slice('state:'.length))
        .filter(id => !indexed.has(id) && id !== sid)
    } catch {
      /* no key listing available: nothing to migrate */
    }
    const entries = [{ sid, at: now }, ...idx.filter(x => x.sid !== sid), ...legacy.map(id => ({ sid: id, at: 0 }))]
    entries.sort((a, b) => b.at - a.at)
    const keep = entries.slice(0, INDEX_CAP)
    for (const old of entries.slice(INDEX_CAP)) {
      if (await recordUnresolved($, old.sid)) {
        keep.push(old)
        continue
      }
      // another session may have written a pause since that read: look once more right before deleting
      if (await recordUnresolved($, old.sid)) {
        keep.push(old)
        continue
      }
      await $.store.delete('state:' + old.sid)
      await $.store.delete('idle:' + old.sid)
      await $.store.delete('resp:' + old.sid)
    }
    await $.store.set('index', keep)
  } catch (err) {
    logOnce($, err)
  }
}

// A failure in this mod must never stop prompts or tool calls: hooks catch, log once, and pass through.
function logOnce($: any, err: unknown) {
  if (warned) return
  warned = true
  try {
    $.ui.log(PREFIX + `internal error, passing through: ${String(err)}`)
  } catch {
    /* nothing more to do */
  }
}

async function usable($: any, gen: number): Promise<boolean> {
  try {
    await ensure($, gen)
    return true
  } catch (err) {
    if (gen === epoch) logOnce($, err) // a session that has ended is not an internal error
    return false
  }
}

// Headless runs (claude -p, an SDK host with no UI) have no surface attached: never pause those,
// nobody would be there to resume them. Fails open to "watched" when the engine cannot say.
async function watched($: any): Promise<boolean> {
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return true
  }
}

// Every open session shares the same account windows, so they all pause and wake together.
// Resume prompts are staggered through the shared store so they do not land in one burst.
async function claimSlot($: any) {
  try {
    const now = await $.clock.now()
    const last = Number(await $.store.get('lastResume')) || 0
    let h = 0
    for (const ch of sid) h = (h * 31 + ch.charCodeAt(0)) % 10
    const at = Math.min(Math.max(now + h * 1000, last + STAGGER_MS), now + MAX_STAGGER_MS)
    await $.store.set('lastResume', at)
    if (at > now) await $.clock.sleep(at - now)
  } catch {
    /* staggering is best effort */
  }
}


// `gen` is the session generation the CALLER started in, captured before its first wait. A caller that
// was overtaken by a session change must stop, even when another load has since filled S for the new one.
async function ensure($: any, gen: number): Promise<void> {
  if (gen !== epoch) throw new Error('the session changed')
  if (!commandReady) void registerCommand($)
  if (S) return
  loading ??= load($).catch(err => {
    loading = undefined
    throw err
  })
  await loading
  if (gen !== epoch || S === null) throw new Error('the session changed while its state was loading')
}

async function persist($: any) {
  try {
    await $.store.set('state:' + sid, S)
    if ((await $.clock.now()) - lastTouchAt > 10 * 60_000) await touchIndex($)
  } catch (err) {
    logOnce($, err)
  }
}
const saveCfg = ($: any) =>
  $.store.set('cfg', { ...cfg, testMode, dryActions, legend, idle: idleCfg }).catch(() => {})
const saveSim = ($: any) => $.store.set('sim', sim).catch(() => {})

// ---------- usage ----------

function simUsage(now: number, probing: boolean): Usage | null {
  if (!sim || sim.unavailable) return null
  const f = sim.five
  if (sim.mode === 'delay' && probing && sim.probeFails > 0) {
    sim.probeFails--
    f.percent = 100
    f.resetsAt = now + 120_000
  } else if (f.resetsAt <= now && !(sim.mode === 'delay' && sim.probeFails > 0)) {
    if (sim.mode === 'fail' && !sim.failedOnce) {
      sim.failedOnce = true
      f.resetsAt = now + 120_000
    } else if (sim.mode !== 'fail' || sim.failedOnce) {
      f.percent = 3
      f.resetsAt = now + 5 * 3600_000
    }
  }
  const windows: Win[] = [{ kind: FIVE, percent: f.percent, resetsAt: f.resetsAt }]
  if (sim.week) windows.push({ kind: WEEK, percent: sim.week.percent, resetsAt: sim.week.resetsAt })
  return { windows, contextPercent: sim.ctx }
}

function mapUsage(u: any): Usage {
  const windows: Win[] = (u.rateLimits ?? []).map((r: any) => ({
    kind: r.kind,
    percent: r.percentUsed,
    resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : undefined,
  }))
  return { windows, contextPercent: u.context?.percent }
}

async function readUsage($: any): Promise<Usage | null> {
  try {
    if (testMode) {
      const u = simUsage(await $.clock.now(), S?.rec.phase === 'resuming')
      if (u && u.contextPercent === undefined) {
        try {
          u.contextPercent = (await $.session.usage()).context?.percent
        } catch {
          /* none */
        }
      }
      return u
    }
    const u = mapUsage(await $.session.usage())
    return u.windows.length ? u : null
  } catch {
    return null
  }
}

async function publish($: any, usage: Usage | null, now: number, gen: number) {
  if (gen !== epoch || S === null) return
  const st = S as State
  const five = usage?.windows.find(w => w.kind === FIVE)
  const week = usage?.windows.find(w => w.kind === WEEK)
  const rst = (w?: Win) => (w?.resetsAt && w.resetsAt > now ? fmtDur(w.resetsAt - now) : undefined)
  let ctx = usage?.contextPercent
  let ctxTokens: number | undefined
  let ctxWindow: number | undefined
  let parts: QuotaBar['parts'] = []
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context
    ctx ??= b.percent ?? b.breakdown?.percentage
    ctxTokens = b.tokens ?? b.breakdown?.totalTokens
    ctxWindow = b.breakdown?.rawMaxTokens ?? b.window
    const bd = b.breakdown
    if (bd && gen === epoch) await update($, detail, () => buildDetail(bd, bd.apiUsage))
    if (bd && bd.rawMaxTokens > 0) {
      parts = bd.categories
        .filter((c: any) => c.kind === 'used' && c.tokens > 0)
        .map((c: any) => ({ name: c.name, pct: (c.tokens / bd.rawMaxTokens) * 100 }))
        .sort((a: { pct: number }, c: { pct: number }) => c.pct - a.pct)
    }
  } catch {
    /* breakdown is cosmetic */
  }
  const v: QuotaBar = {
    ctx,
    parts,
    legend,
    ctxTokens,
    ctxWindow,
    five: five?.percent,
    fiveReset: rst(five),
    fiveAt: when(five, now),
    week: week?.percent,
    weekReset: rst(week),
    weekAt: when(week, now),
    threshold: cfg.threshold,
    ctxMin: cfg.compactMinContext,
    phase: st.rec.phase,
    note:
      st.rec.phase === 'paused' && st.rec.wakeAt
        ? `paused until ${fmtClock(st.rec.wakeAt)}`
        : usage ? undefined : 'waiting for first usage reading',
  }
  if (gen !== epoch) return
  await update($, bar, () => v)
}

// ---------- dispatch / effects ----------

async function dispatch($: any, ev: Ev, gen: number): Promise<void> {
  await ensure($, gen)
  if ((ev.type === 'measure' || ev.type === 'tick' || ev.type === 'forcePause') && !(await watched($))) return
  if (gen !== epoch || S === null) return
  const { state, fx } = step(S as State, ev, cfg)
  S = state
  await persist($)
  if (gen !== epoch) return // the session ended while persisting: nothing this produced applies any more
  sync($, gen)
  for (const f of fx) if (f.t === 'toast') say($, f.text)
  const rest = fx.filter(f => f.t !== 'toast')
  if (rest.length) void runEffects($, rest, gen).catch((err: unknown) => logOnce($, err))
}

function say($: any, text: string) {
  const t = (testMode ? '[test] ' : '') + text
  $.ui.toast(t, { timeoutMs: 9000 })
  $.ui.log(PREFIX + t)
}

function sync($: any, gen: number) {
  if (needsHeartbeat(S as State)) {
    timer ??= $.clock.every(HEARTBEAT_MS, () => void tick($, gen).catch((err: unknown) => logOnce($, err)))
  } else if (timer) {
    timer.cancel()
    timer = undefined
  }
}

async function tick($: any, gen: number) {
  await ensure($, gen)
  const now = await $.clock.now()
  const usage = await readUsage($)
  if (gen !== epoch) return
  $.ui.status(statusLine(S as State, usage, now))
  await dispatch($, { type: 'tick', now, usage }, gen)
  await publish($, usage, now, gen)
}

async function runEffects($: any, list: Fx[], gen: number) {
  for (const f of list) {
    if (gen !== epoch) return
    try {
      if (f.t === 'abort') {
        // only the turn this pause was armed against, and only while that pause still stands
        const live = S !== null && S.rec.phase === 'armed' && S.rec.op === f.op
        if (live && turnId && (f.turnId === undefined || f.turnId === turnId)) await $.turn.abort({ turnId })
      } else if (f.t === 'compact') {
        await doCompact($, f.instructions, f.op, gen)
      } else if (f.t === 'submit') {
        await doSubmit($, f.text, f.op, gen)
      } else if (f.t === 'fill') {
        if (gen === epoch) await $.prompt.fill({ text: f.text })
      }
    } catch (err) {
      $.ui.log(PREFIX + `${f.t} failed: ${String(err)}`)
    }
  }
}

async function doCompact($: any, instructions: string, op: number, gen: number) {
  // this operation of this session, and only this one: a cancel, a takeover, a replacement or the end
  // of the session makes it stale
  const wanted = () => gen === epoch && S !== null && S.rec.phase === 'compacting' && S.rec.op === op
  let ok = false
  if (testMode && dryActions) {
    $.ui.log(PREFIX + '[dry-run] would compact the conversation now')
    ok = true
  } else {
    // compact rejects while a turn runs; the turn.complete hook that got us
    // here has not returned yet, so retry until the session is idle.
    for (let i = 0; i < 15 && !ok; i++) {
      if (!wanted()) return
      try {
        const r = await $.session.compact({ instructions })
        ok = !r || !('skip' in r) || r.skip === undefined
        break
      } catch {
        await $.clock.sleep(1000)
      }
    }
  }
  if (gen !== epoch) return
  await dispatch($, { type: 'compactDone', now: await $.clock.now(), ok, op }, gen)
}

async function doSubmit($: any, text: string, op: number, gen: number) {
  const wanted = () => gen === epoch && S !== null && S.rec.phase === 'resuming' && S.rec.op === op
  if (testMode && dryActions) {
    $.ui.log(PREFIX + `[dry-run] would submit: ${text.split('\n')[0]}`)
    await dispatch($, { type: 'resumeDelivered', now: await $.clock.now(), op }, gen)
    $.clock.after(1500, () => void syntheticMeasure($, gen).catch((err: unknown) => logOnce($, err)))
    return
  }
  await claimSlot($)
  for (let tries = 0; tries < 2; tries++) {
    if (!wanted()) return // cancelled, taken over, replaced, or the session ended while we waited
    try {
      const r = await $.prompt.submit({ text })
      if (!r || r.drop === undefined) {
        if (gen === epoch) await dispatch($, { type: 'resumeDelivered', now: await $.clock.now(), op }, gen)
        return
      }
    } catch {
      /* retry */
    }
    await $.clock.sleep(5000)
  }
  if (!wanted()) return
  await dispatch($, { type: 'submitFailed', now: await $.clock.now(), text, op }, gen)
}

async function syntheticMeasure($: any, gen: number) {
  if (gen !== epoch) return
  const now = await $.clock.now()
  const usage = await readUsage($)
  if (gen !== epoch) return
  if (usage) await dispatch($, { type: 'measure', now, usage }, gen)
  if (gen === epoch) await saveSim($)
}

async function boot($: any, gen: number) {
  await ensure($, gen)
  if (booted || !(await watched($))) return
  if (gen !== epoch) return
  booted = true
  const now = await $.clock.now()
  const usage = await readUsage($)
  if (gen !== epoch) return // the session changed while the usage was being read
  await dispatch($, { type: 'boot', now, usage }, gen)
  if (gen !== epoch) return
  $.ui.status(statusLine(S as State, usage, now))
  await publish($, usage, now, gen)
  // A reload or restart forgets when the last response was. Recover it from the store; with no record, assume
  // the cache is warm as of now (if it is not, compacting costs about what the next request would have).
  if (lastResponseAt === undefined) {
    let saved: unknown
    try {
      saved = await $.store.get('resp:' + sid)
    } catch {
      /* no record */
    }
    if (gen !== epoch) return
    lastResponseAt = typeof saved === 'number' && saved <= now ? saved : now
    await scheduleIdle($, gen)
  }
}

// ---------- /quota ----------

function parseTokens(raw: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i.exec((raw ?? '').trim())
  if (!m) return undefined
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

async function contextTokens($: any): Promise<number | undefined> {
  try {
    return (await $.session.usage()).context?.tokens
  } catch {
    return undefined
  }
}

// Idle compaction: while the session waits on background work, compact shortly before the prompt
// cache expires so the next request does not re-send a huge context at full price. Silent by design.
async function scheduleIdle($: any, gen: number) {
  if (gen !== epoch) return // overtaken: the timer now belongs to another session, so do not touch it
  idleTimer?.cancel()
  idleTimer = undefined
  if (!idleCfg.enabled || lastResponseAt === undefined || (testMode && dryActions)) return
  const now = await $.clock.now()
  const tokens0 = await contextTokens($)
  if (gen !== epoch || S === null) return
  const plan = planIdleCompact(idleCfg, {
    now,
    lastResponseAt,
    tokens: tokens0,
    busy: (S as State).busy,
    pending: waiting,
    quotaPhase: (S as State).rec.phase,
    lastIdleCompactAt,
  })
  if (plan.act) void runIdle($, gen).catch((err: unknown) => logOnce($, err))
  else if (plan.at !== undefined) {
    idleTimer = $.clock.after(Math.max(1000, plan.at - now), () => void runIdle($, gen).catch((err: unknown) => logOnce($, err)))
  }
}

async function runIdle($: any, gen: number) {
  idleTimer = undefined
  await ensure($, gen)
  if (testMode && dryActions) return // dry-run: never touch the real conversation
  const now = await $.clock.now()
  const tokens = await contextTokens($)
  if (gen !== epoch || S === null) return
  const plan = planIdleCompact(idleCfg, {
    now,
    lastResponseAt,
    tokens,
    busy: (S as State).busy,
    pending: waiting,
    quotaPhase: (S as State).rec.phase,
    lastIdleCompactAt,
  })
  if (!plan.act) {
    if (plan.at !== undefined) await scheduleIdle($, gen)
    return
  }
  lastIdleCompactAt = now // once per response, whatever happens next
  try {
    const r = await $.session.compact({ instructions: idleInstructions(freshPending(waiting, now), (S as State).rec.task) })
    if (gen !== epoch) return // this compaction belonged to a session that has since ended
    if (r && r.skip === undefined) {
      idleStats = { at: now, before: tokens ?? 0, count: (idleStats?.count ?? 0) + 1 }
      await $.store.set('idle:' + sid, idleStats)
    }
  } catch {
    /* refused while a turn runs, or the engine vetoed it: nothing to do, the next response re-arms */
  }
}

function idleLine(now: number, tokens?: number): string {
  const c = idleCfg
  const n = freshPending(waiting, now).length
  const bits = [`Idle compaction: ${c.enabled ? 'ON' : 'OFF'} (${c.requireWaiting ? 'only while waiting on background work' : 'any idle session'}, above ${Math.round(c.minTokens / 1000)}k tokens, cache ${Math.round(c.ttlMs / 60_000)}m, ${Math.round(c.marginMs / 1000)}s early)`]
  bits.push(n ? `waiting on ${n} background task${n > 1 ? 's' : ''}` : 'not waiting on anything')
  // why the timer is or is not going to fire: the first thing to check when nothing seems to happen
  if (lastResponseAt === undefined) bits.push('timer not armed: no response has completed in this session since the mod loaded (reload or restart clears it; the next response arms it)')
  else {
    const plan = planIdleCompact(idleCfg, { now, lastResponseAt, tokens, busy: !!S?.busy, pending: waiting, quotaPhase: S?.rec.phase ?? 'idle', lastIdleCompactAt })
    bits.push(plan.act ? 'compacting now' : plan.at !== undefined ? `armed for ${fmtClock(plan.at)}` : `not firing: ${plan.why}`)
  }
  if (idleStats) bits.push(`last at ${fmtClock(idleStats.at)} from ${Math.round(idleStats.before / 1000)}k tokens (${idleStats.count} total)`)
  return bits.join('; ')
}

async function describe($: any): Promise<string> {
  const now = await $.clock.now()
  const usage = await readUsage($)
  const st = S as State
  const r = st.rec
  const lines: string[] = []
  lines.push(`Auto quota management: ${cfg.enabled ? 'ON' : 'OFF'}${testMode ? `  (TEST MODE, ${dryActions ? 'dry-run actions' : 'real actions'})` : ''}`)
  lines.push(`Thresholds: 5-hour ${cfg.threshold}%, weekly ${cfg.weeklyThreshold}% (${cfg.weeklyPolicy}), compact only if context > ${cfg.compactMinContext}%, abort turn at ${cfg.abortThreshold}%, burn-rate ceiling ${cfg.ceiling}%`)
  if (!usage) lines.push('Usage: unavailable right now (no rate-limit reading yet; subscriptions report it after the first response).')
  else {
    for (const w of usage.windows) lines.push(describeWindow(w, now))
    if (usage.contextPercent !== undefined) lines.push(`Context window: ${usage.contextPercent}% (handled by normal compaction, never a quota pause)`)
  }
  const jump = st.deltas.length ? Math.max(...st.deltas) : 0
  lines.push(`Recent largest jump: ${jump.toFixed(1)} pts`)
  lines.push(`State: ${r.phase.toUpperCase()}${r.reason ? ` - ${r.reason}` : ''}`)
  if (r.phase === 'paused' && r.wakeAt) lines.push(`Paused until approximately ${fmtClock(r.wakeAt)} (in ${fmtDur(r.wakeAt - now)}); resume attempts used: ${r.resumeAttempts}/${cfg.maxResumeAttempts}`)
  if (r.compactedAt) lines.push(`Compacted at ${fmtClock(r.compactedAt)}${r.compactFailed ? ' (failed)' : ''}`)
  lines.push(idleLine(now, await contextTokens($)))
  if (r.task) lines.push(`Task on record: ${r.task.slice(0, 160)}${r.task.length > 160 ? '...' : ''}`)
  return lines.join('\n')
}

async function startSim($: any, what: string, arg: string | undefined, gen: number): Promise<string> {
  const now = await $.clock.now()
  sim ??= { five: { percent: 10, resetsAt: now + 5 * 3600_000 }, mode: 'ok', failedOnce: false, probeFails: 0, unavailable: false }
  const set = (p: number, ms: number) => {
    sim!.five = { percent: p, resetsAt: now + ms }
    sim!.failedOnce = false
  }
  switch (what) {
    case '80': set(80, 94 * 60_000); break
    case '94': set(94, 94 * 60_000); break
    case 'exhausted': set(100, 90 * 60_000); break
    case 'reset60': set(100, 60_000); break
    case 'clear': set(10, 5 * 3600_000); sim.week = undefined; break
    case 'weekly': sim.week = { percent: 100, resetsAt: now + 3 * 60_000 }; break
    case 'reset-ok': sim.mode = 'ok'; sim.probeFails = 0; break
    case 'reset-fail': sim.mode = 'fail'; sim.failedOnce = false; break
    case 'reset-delay': sim.mode = 'delay'; sim.probeFails = 1; break
case 'ctx': {
      const n = Number(arg)
      sim.ctx = Number.isFinite(n) ? n : undefined
      await saveSim($)
      return sim.ctx === undefined ? 'Simulated context cleared (real value used).' : `Simulated context set to ${sim.ctx}%.`
    }
    case 'unavailable': sim.unavailable = !sim.unavailable; break
    case 'restart': {
      timer?.cancel()
      timer = undefined
      epoch++ // a restart ends everything that was in flight
      S = null
      loading = undefined
      booted = false
      turnId = undefined
      await boot($, epoch)
      return 'Simulated restart: in-memory state dropped and reloaded from the store.'
    }
    default:
      return 'sim: ctx N | 80 | 94 | exhausted | reset60 | weekly | reset-ok | reset-fail | reset-delay | unavailable | clear | restart'
  }
  await saveSim($)
  if (['80', '94', 'exhausted', 'reset60', 'weekly', 'clear'].includes(what)) await syntheticMeasure($, gen)
  return `sim ${what} applied. Five-hour: ${sim.five.percent}% (resets ${fmtClock(sim.five.resetsAt)}), mode ${sim.mode}${sim.unavailable ? ', usage unavailable' : ''}.`
}

async function command($: any, args: string, gen: number): Promise<string> {
  const [cmd = 'status', a, b] = args.split(/\s+/)
  const now = await $.clock.now()
  if (gen !== epoch) return 'Session changed while this command was waiting; it was ignored.'
  switch (cmd.toLowerCase()) {
    case '':
    case 'status': return describe($)
    case 'on':
    case 'off':
      cfg.enabled = cmd === 'on'
      if (!cfg.enabled) await dispatch($, { type: 'cancel', now }, gen)
      await saveCfg($)
      return `Automatic quota management ${cfg.enabled ? 'enabled' : 'disabled'}.`
    case 'threshold':
    case 'weekly': {
      const n = Number(a)
      if (!Number.isFinite(n) || n < 50 || n > 100) return `Usage: /quota ${cmd} <50-100>`
      if (cmd === 'threshold') cfg.threshold = n
      else cfg.weeklyThreshold = n
      await saveCfg($)
      return `${cmd === 'threshold' ? '5-hour' : 'Weekly'} threshold set to ${n}%.`
    }
    case 'pause': {
      const m = a ? Number(a) : 2
      if (!Number.isFinite(m) || m < 0.1) return 'Usage: /quota pause [minutes]'
      await dispatch($, { type: 'forcePause', now, minutes: m }, gen)
      return `Forced pause requested for ${m} minute(s)${testMode && dryActions ? ' (dry-run: no real compaction)' : ' (real compaction will run)'}.`
    }
    case 'cancel':
      await dispatch($, { type: 'cancel', now }, gen)
      return 'Cancel processed.'
    case 'resume':
      await dispatch($, { type: 'resume', now }, gen)
      return 'Resume processed.'
    case 'test': {
      if (a === 'on' || a === 'off') {
        testMode = a === 'on'
        await saveCfg($)
        return `Test mode ${testMode ? 'ON: usage is simulated (/quota sim ...)' : 'OFF: real usage'}.`
      }
      if (a === 'actions' && (b === 'real' || b === 'dry')) {
        dryActions = b === 'dry'
        await saveCfg($)
        return `Test-mode actions: ${b}.`
      }
      return 'Usage: /quota test on|off  or  /quota test actions real|dry'
    }
    case 'ctx':
    case 'legend':
      if (a === 'close') {
        await $.ui.close({ id: PANE })
        return 'Context pane closed.'
      }
      await publish($, await readUsage($), now, gen)
      await $.ui.open({ id: PANE, title: 'Context' })
      return 'Context pane opened (each category has its own colour, largest first).'
    case 'idle': {
      if (a === 'on' || a === 'off') idleCfg = { ...idleCfg, enabled: a === 'on' }
      else if (a === 'any' || a === 'waiting') idleCfg = { ...idleCfg, requireWaiting: a === 'waiting' }
      else if (a === 'min') {
        const n = parseTokens(b)
        if (n === undefined) return 'Usage: /quota idle min <tokens>  (for example 200k)'
        idleCfg = { ...idleCfg, minTokens: n }
      } else if (a === 'ttl') {
        const m = Number(b)
        if (!Number.isFinite(m) || m < 1 || m > 120) return 'Usage: /quota idle ttl <minutes 1-120>  (5 or 60 are the cache lifetimes)'
        idleCfg = { ...idleCfg, ttlMs: m * 60_000 }
      } else if (a === 'margin') {
        const sec = Number(b)
        if (!Number.isFinite(sec) || sec < 0 || sec > 1800) return 'Usage: /quota idle margin <seconds 0-1800>'
        idleCfg = { ...idleCfg, marginMs: sec * 1000 }
      } else if (a !== undefined && a !== '' && a !== 'status') return 'Usage: /quota idle [on|off|any|waiting|min N|ttl M|margin S]'
      await saveCfg($)
      await scheduleIdle($, gen)
      return idleLine(now, await contextTokens($))
    }
    case 'ctxmin': {
      const n = Number(a)
      if (!Number.isFinite(n) || n < 0 || n > 100) return 'Usage: /quota ctxmin <0-100>'
      cfg.compactMinContext = n
      await saveCfg($)
      return `At the quota threshold, compaction now happens only when context is above ${n}%; otherwise it just waits for the reset.`
    }
    case 'sim':
      if (!testMode) return 'Turn on test mode first: /quota test on'
return startSim($, a ?? '', b, gen)
    default:
      return 'Commands: status | on | off | threshold N | weekly N | pause [min] | cancel | resume | test on|off | test actions real|dry | sim <scenario>'
  }
}

async function runQuota($: any, e: { args: string }) {
  const gen = epoch
  if (!(await usable($, gen))) return { text: PREFIX + 'not available (could not load saved state).' }
  return { text: await command($, e.args.trim(), gen) }
}

export const register: Register = (on, opts) => {
  options = opts

  // ---------- hooks (every one fails open) ----------

  on('session.start', async ($, e, next) => {
    const gen = epoch
    try {
      await registerCommand($)
      await boot($, gen)
      void $.ui.open({ id: PANE, title: 'Context' })
    } catch (err) {
      logOnce($, err)
    }
    return next(e)
  })

  // a UI attaching after start (Desktop attaches late): run the startup check then
  on('session.attach', async ($, e, next) => {
    const gen = epoch
    try {
      await boot($, gen)
    } catch (err) {
      logOnce($, err)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const gen = epoch
    if (await usable($, gen)) {
      try {
        const now = await $.clock.now()
        const usage = testMode ? await readUsage($) : mapUsage(e)
        if (usage && gen === epoch) {
          await dispatch($, { type: 'measure', now, usage }, gen)
          if (gen === epoch) {
            $.ui.status(statusLine(S as State, usage, now))
            await publish($, usage, now, gen)
          }
        }
      } catch (err) {
        logOnce($, err)
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const gen = epoch
    turnId = e.turnId
    idleTimer?.cancel()
    idleTimer = undefined
    try {
      // our own continuation is recognised by its text; anything else that starts is another turn
      const owns = typeof e.text === 'string' ? e.text.includes(resumeMarker(S?.rec.phase === 'resuming' ? S.rec.op : undefined)) : undefined
      await dispatch($, { type: 'turnStart', turnId: e.turnId, owns }, gen)
    } catch (err) {
      logOnce($, err)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const gen = epoch
    const r = await next(e)
    if (e.agentId === undefined) {
      if (turnId === e.turnId) turnId = undefined // a late completion of an older turn must not erase the current one
      try {
        // detached: this hook must return before a compaction can run
        const at = await $.clock.now()
        if (gen !== epoch) return r
        if (e.reason === 'answer' || e.reason === 'refusal') {
          lastResponseAt = at // an errored or interrupted turn refreshed nothing
          void Promise.resolve($.store.set('resp:' + sid, at)).catch(() => undefined)
        }
        void dispatch($, { type: 'turnComplete', now: at, reason: e.reason, turnId: e.turnId }, gen)
          .then(() => scheduleIdle($, gen))
          .catch((err: unknown) => logOnce($, err))
      } catch (err) {
        logOnce($, err)
      }
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const gen = epoch
    const kind = e.origin?.kind
    if ((kind === 'plugin' && e.origin?.name === $.plugin.name) || !(await usable($, gen))) return next(e)
    try {
      idleTimer?.cancel()
      idleTimer = undefined
      const isUser = kind !== undefined && USER_KINDS.includes(kind)
      if (!isUser && cfg.enabled && blocksAutomation(S as State)) {
        return { drop: PREFIX + 'paused for a usage limit; automatic prompts are held.' }
      }
      if (kind === 'task-notification') waiting = clearOnNotification(waiting, e.text)
      lastText = e.text
      await dispatch($, { type: 'userPrompt', now: await $.clock.now(), text: e.text, isUser }, gen)
    } catch (err) {
      logOnce($, err)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const gen = epoch
    const r = await next(e)
    try {
      if (gen === epoch && e.agentId === undefined && e.trigger !== 'precompute' && r && r.skip === undefined && (await usable($, gen))) {
        // our own compaction is reported by doCompact; this catches everyone else's
        if (gen === epoch && S !== null && S.rec.phase !== 'compacting') {
          await dispatch($, { type: 'compactDone', now: await $.clock.now(), ok: true, external: true }, gen)
        }
      }
    } catch (err) {
      logOnce($, err)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const gen = epoch
    try {
      if ((await usable($, gen)) && cfg.enabled && S !== null && S.rec.phase === 'paused' && (await watched($))) {
        return { deny: PREFIX + 'paused until the usage limit resets.' }
      }
      if (e.agentId === undefined) {
        const w = pendingFromTool(e.tool, e as unknown as Record<string, unknown>, String(e.tool_use_id ?? ''), await $.clock.now())
        if (w && gen === epoch) waiting = [...freshPending(waiting, w.at), w].slice(-20)
      }
    } catch (err) {
      logOnce($, err)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await usable($, epoch))) return next(e)
    if (e.props.hasSurvey) return next(e)
    const v = await read($, bar)
    const { Box, Text } = $.ui.resolve(e)
    const Svg = (e.surface !== 'terminal' ? ($.ui.resolve(e) as any).Svg : undefined) as any
    if (!v) {
      return (
        <Box>
          <Text dimColor>quota-guard · waiting for first usage reading</Text>
        </Box>
      )
    }
    const cols = e.props.bodyColumns
    const tier = cols >= 100 ? 'full' : cols >= 64 ? 'mid' : 'min'
    const T = ({ children, ...rest }: any) => (
      <Text wrap="truncate" {...rest}>
        {children}
      </Text>
    )
    const meter = (pct: number, n: number) => {
      const f = Math.max(0, Math.min(n, Math.round((pct / 100) * n)))
      return (
        <T>
          <Text color={tone(pct)}>{'▰'.repeat(f)}</Text>
          <Text dimColor>{'▱'.repeat(n - f)}</Text>
        </T>
      )
    }
    const n = tier === 'min' ? 5 : 10
    const seg = (name: string, long: string, pct?: number, left?: string, at?: string) => {
      if (pct === undefined) return null
      return (
        <Box gap={1} flexShrink={0}>
          <T dimColor>{tier === 'full' ? long : name}</T>
          {meter(pct, n)}
          <T bold>{Math.round(pct)}%</T>
          {left ? <T dimColor>{tier === 'full' && at ? `${at} · ${left.replace(/ /g, '')}` : left.replace(/ /g, '')}</T> : null}
        </Box>
      )
    }
    const parts = [...(v.parts ?? [])].filter(x => x.pct > 0).sort((x, y) => y.pct - x.pct)
    const segs = parts.length
      ? parts.map((x, i) => ({ pct: x.pct, color: colorAt(i) }))
      : v.ctx !== undefined
        ? [{ pct: v.ctx, color: tone(v.ctx) }]
        : []
    const ctx =
      v.ctx === undefined ? null : (
        <Box gap={1} flexShrink={0}>
          <T dimColor>ctx</T>
          {Svg
            ? ctxPill(Svg, segs.map((sg, i) => ({ pct: sg.pct, hex: parts.length ? hexAt(i) : sg.color === 'red' ? hexAt(4) : sg.color === 'yellow' ? hexAt(2) : hexAt(0) })), tier === 'min' ? 70 : tier === 'mid' ? 110 : 150, 8, v.ctxMin)
            : ctxBar(Box, segs, tier === 'min' ? 8 : tier === 'mid' ? 14 : 20)}
          <T bold>{Math.round(v.ctx)}%</T>
        </Box>
      )
    const alert = !!v.note || v.phase !== 'idle' || testMode
    const state = v.note ?? (v.phase === 'idle' ? undefined : v.phase)
    return (
      <Box gap={3}>
        {seg('5h', '5h session', v.five, v.fiveReset, v.fiveAt)}
        {seg('7d', '7d week', v.week, v.weekReset, v.weekAt)}
        {ctx}
        {alert ? (
          <T color="yellow">
            {testMode ? '[test] ' : ''}
            {state ?? ''}
          </T>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!(await usable($, epoch))) return next(e)
    const d = await read($, detail)
    const { Box, Text } = $.ui.resolve(e)
    const Svg = (e.surface !== 'terminal' ? ($.ui.resolve(e) as any).Svg : undefined) as any
    const barState = await read($, bar)
    const w = Math.max(10, Math.min(36, e.props.bodyColumns - 4))
    if (!d) return <Text dimColor>Waiting for a context reading…</Text>
    const T = ({ children, ...rest }: any) => (
      <Text wrap="truncate" {...rest}>
        {children}
      </Text>
    )
    const win = d.window || 1
    const ranked = d.categories.filter(c => c.kind === 'used' && c.tokens > 0).sort((x, y) => y.tokens - x.tokens)
    const row = (color: string | undefined, name: string, tokens: number, rank?: number) => (
      <Box gap={1}>
        {Svg && rank !== undefined ? swatch(Svg, hexAt(rank)) : <T color={color} dimColor={!color}>■</T>}
        <Box flexGrow={1}>
          <T>{name}</T>
        </Box>
        <T>{fmtTok(tokens)}</T>
        <T dimColor>{((tokens / win) * 100).toFixed(1)}%</T>
      </Box>
    )
    const heading = (t: string) => (
      <Box marginTop={1}>
        <T bold>{t}</T>
      </Box>
    )
    const sub = (items: { name: string; tokens: number }[]) =>
      items.map(i => (
        <Box gap={1} paddingLeft={2}>
          <Box flexGrow={1}>
            <T dimColor>{i.name}</T>
          </Box>
          <T dimColor>{fmtTok(i.tokens)}</T>
        </Box>
      ))
    const free = d.categories.find(c => c.kind === 'free')
    const buffer = d.categories.find(c => c.kind === 'buffer')
    const deferred = d.categories.filter(c => c.kind === 'deferred')
    return (
      <Box flexDirection="column" paddingX={1}>
        <T bold>
          Context · {fmtTok(d.total)} / {fmtTok(win)} · {Math.round(d.percent)}%
        </T>
        <T dimColor>{d.model}</T>
        <Box marginTop={1}>
          {Svg
            ? ctxPill(Svg, ranked.map((c, i) => ({ pct: (c.tokens / win) * 100, hex: hexAt(i) })), Math.max(120, Math.min(320, e.props.bodyColumns * 7)), 10, barState?.ctxMin)
            : ctxBar(Box, ranked.map((c, i) => ({ pct: (c.tokens / win) * 100, color: colorAt(i) })), w)}
        </Box>
        {heading('Where it goes')}
        {ranked.map((c, i) => row(colorAt(i), c.name, c.tokens, i))}
        {free ? row(undefined, 'Free space', free.tokens) : null}
        {buffer ? row(undefined, 'Autocompact buffer', buffer.tokens) : null}
        {d.autoAt ? (
          <T dimColor>
            Auto-compact at {fmtTok(d.autoAt)} ({fmtTok(Math.max(0, d.autoAt - d.total))} to go)
          </T>
        ) : (
          <T dimColor>Auto-compact is off</T>
        )}
        {d.memory.length ? heading('Memory files') : null}
        {sub(d.memory.map(m => ({ name: m.path, tokens: m.tokens })))}
        {d.mcp.length ? heading('MCP servers') : null}
        {sub(d.mcp.map(m => ({ name: m.server, tokens: m.tokens })))}
        {d.agents.length ? heading('Agents') : null}
        {sub(d.agents)}
        {d.skills ? heading(`Skills · ${d.skills.count}/${d.skills.total} listed · ${fmtTok(d.skills.tokens)}`) : null}
        {d.skills ? sub(d.skills.top) : null}
        {deferred.length ? heading('Loaded on demand (not in window)') : null}
        {sub(deferred.map(c => ({ name: c.name, tokens: c.tokens })))}
        {d.api ? heading('Last response') : null}
        {d.api ? (
          <T dimColor>
            in {fmtTok(d.api.input ?? 0)} · cache read {fmtTok(d.api.cacheRead ?? 0)} · cache write {fmtTok(d.api.cacheWrite ?? 0)} · out {fmtTok(d.api.output ?? 0)}
          </T>
        ) : null}
      </Box>
    )
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = undefined
    idleTimer?.cancel()
    idleTimer = undefined
    // Everything in flight belonged to this session: dropping S makes every pending effect stale (they
    // all check S), and the next hook reloads state for whichever session id is current. /clear changes
    // the id without a session.start, so this is the only place that can reset it.
    epoch++
    S = null
    loading = undefined
    booted = false
    turnId = undefined
    waiting = []
    lastResponseAt = undefined
    lastIdleCompactAt = undefined
    idleStats = undefined
    lastTouchAt = 0
    return next(e)
  })

  on('command.run', { command: 'quota' }, runQuota).catch(() => ({ text: PREFIX + 'internal error; see the debug log.' }))
  on('command.run', { command: 'quota-guard' }, runQuota).catch(() => ({ text: PREFIX + 'internal error; see the debug log.' }))
}
