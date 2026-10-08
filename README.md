# quota-guard

A [Claude Code](https://claude.com/claude-code) mod (plugin of function hooks) that handles usage limits for you:

- watches the **5-hour** and **weekly** usage windows, kept separate from **context-window** pressure
- at a threshold (default **94%**, lowered automatically when recent turns jump a lot) it finishes the current turn, then **compacts** (only if context is above 30%) and **pauses**
- waits until the reported reset time, re-checks, and **resumes the task automatically**
- survives restarts and reloads: pause state is persisted, and a 30-second heartbeat compares the wall clock, so sleep or a late timer only delays the resume
- **idle compaction**: when a session sits idle (or waits on a background command), it compacts shortly before the prompt cache expires, so the next request does not re-send a huge context at full price
- shows a usage bar above the prompt (5h, 7d, context breakdown) and a full context pane on wide windows

> Early-access API: written against Claude Code 2.1.289+ Mods (`claude-code` hooks API). It may need updates as that API changes.

## Install

Clone the repo, then use **one** of these. Use only one: two routes load two plugins both named `quota-guard`.

### Every session (Desktop Code tab and terminal)

Add `CLAUDE_CODE_PLUGIN_DIRS` to the `env` block of your **user** settings file, `~/.claude/settings.json` (on Windows `C:\Users\<you>\.claude\settings.json`), keeping your other keys:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:/Users/you/code/claude-quota-guard"
  }
}
```

- Use an absolute path. Forward slashes work on Windows. For several folders, separate them with `;` on Windows (`:` on macOS/Linux).
- The variable is read **only** from the process environment or the `env` block of the user settings file. It is **never** read from project settings (`.claude/settings.json` or `.claude/settings.local.json` in a repo); putting it there does nothing.
- The folder is loaded in place, so it runs the working copy of the repo: `git pull` to update. A terminal session reloads it when a file is saved. The Desktop Code tab does **not** watch the folder unless you also set `CLAUDE_CODE_PLUGIN_DIR_WATCH` to `1` in the same `env` block; without it, restart the session after updating the mod.
- Sessions that are already open keep what they started with. The Desktop app picks the change up in **new** sessions, or after you restart the app. If `CLAUDE_CODE_PLUGIN_DIRS` is already set in the environment a session is launched with, that value wins over the settings file.

### One terminal session

```bash
claude --plugin-dir /path/to/claude-quota-guard
```

### A copy in `~/.claude/skills/quota-guard`

This also auto-loads, but it is a **copy**: it does not follow the repo, so it drifts. Prefer the folder route above.

### Verify

1. Start a **new** session and run `/quota status` (`/quota-guard status` is an alias). It prints the thresholds and `State: IDLE`.
2. You should also see the usage bar above the prompt. Before the first usage reading it says `quota-guard · waiting for first usage reading`.

### Troubleshooting

- **`/quota` is an unknown command:** the plugin is not loaded. Run `claude --debug` and look for `quota-guard:` lines. A healthy start has `hooks module quota-guard@inline loaded` and `$.command.register (quota-guard): /quota listed`.
- **Nothing loads:** check the variable is in the **user** settings `env` block (not a project file), that the path exists, and that you started a new session.
- **`reload failed, the previous version stays loaded`** (while editing): the message names the offending function or line.
- **Two copies loading:** remove the duplicate route (a stale `~/.claude/skills/quota-guard`, a hot-reload copy, plus the settings entry).

### Several sessions, and headless runs

- The 5-hour and weekly windows belong to your account, so every open session pauses and wakes at the same reset. Resume prompts are staggered about 20 seconds apart through the plugin's shared store, so they do not all land at once.
- Sessions with no UI attached (`claude -p`, an SDK run with no surface) are never paused: nobody would be there to resume them, so the mod stays out of the way.
- If any part of the mod fails to start (for example unreadable saved state), prompts and tool calls pass through untouched and the error is logged once.

## Commands

| Command | What it does |
| --- | --- |
| `/quota status` (alias `/quota-guard`) | usage windows, thresholds, state, task on record |
| `/quota on` / `off` | enable / disable automatic management |
| `/quota threshold N` | 5-hour threshold (50-100) |
| `/quota weekly N` | weekly threshold |
| `/quota ctxmin N` | compact before pausing only if context is above N% (default 30) |
| `/quota pause [min]` | force a pause (compacts per the context rule) for testing |
| `/quota cancel` | cancel the pending auto-resume (holds until you act) |
| `/quota resume` | resume now |
| `/quota idle [on\|off\|any\|waiting\|min N\|ttl M\|margin S]` | idle compaction: status and settings |
| `/quota ctx [close]` | open / close the full context pane |

## Idle compaction

Prompt-cache reads are about a tenth of the price of fresh input. If a session sits idle longer than the cache lifetime, the next request re-sends the whole context at full price. Compacting just *before* the cache expires reads the context at the cheap cached rate and leaves a small context behind.

- Fires once per response, `idleMarginSeconds` (default 180) before the cache would expire, when no turn is running and the context is at least `idleCompactMinTokens` (default 200,000).
- Never fires after the cache has already gone cold, since it would save nothing.
- By default any idle session qualifies. `/quota idle waiting` (or the `idleRequiresBackground` setting) restricts it to sessions waiting on a background command, monitor or agent; then the summary is told what it is waiting on.
- Assumes a 1-hour cache (`cacheTtlMinutes`, default 60). If your sessions use the 5-minute cache, run `/quota idle ttl 5`.
- Silent: no toast. `/quota status` shows the last idle compaction.
- It is skipped while a quota pause is in progress, and a compaction cannot run while a turn is running (a long foreground command blocks it).

## Dry-run / test mode

No need to burn real quota:

```
/quota test on            simulated usage, dry-run actions
/quota sim 80             heads-up only
/quota sim 94             compact, then pause
/quota sim exhausted
/quota sim reset60        100% used, resets in 60 s
/quota sim reset-ok       usage drops after the reset (default)
/quota sim reset-fail     reset time slips by 2 minutes once
/quota sim reset-delay    first resume attempt fails, second works
/quota sim weekly
/quota sim ctx N          simulate context fill (try 20 vs 50 around the 30% rule)
/quota sim unavailable    toggle usage data off/on
/quota sim restart        drop memory and reload from the store while paused
/quota test actions real  do real compaction/prompts under simulated usage
/quota test off
```

## How it works

- `hooks/core.ts` is a pure state machine (`idle -> armed -> compacting -> paused -> resuming -> idle`, plus a manual `stopped` hold). No engine imports; unit-tested.
- `hooks/register.tsx` is the adapter: `session.measure` for usage, `$.session.compact`, `$.turn.abort`, `$.prompt.submit`, `$.store` for persistence, `$.clock` for the heartbeat, `ui.render` for the bar and pane.
- Usage readings only update after an API response, so after a reset the old reading is stale. The mod resumes with the continuation prompt as the probe and confirms (or rolls back to paused with backoff) from the next real measurement. It gives up after 5 attempts per pause rather than looping.

## Limitations

- A mod only runs while its session is loaded; nothing resumes a session that is not reopened.
- Pause records are keyed by session id.
- Weekly pauses can last days and only resume while the session stays loaded.
- Compaction needs an API call, so at 100% it can fail; the mod then pauses anyway.
- Automatic prompts (scheduled tasks, background-task notifications, other plugins) arriving during a pause are **dropped**, not queued, so a completion notice that lands while paused is lost. Your own prompts are never held, and sending one cancels the pause.
- Resume slots across several sessions are claimed through a shared store without an atomic reservation, so two sessions waking in the same instant can still land close together; the 20-second spacing is best effort.
- Saved state is kept per session in the plugin's store: the 25 most recently active sessions are retained and older ones are forgotten, except a record with an unresolved pause or resume, which is never discarded. Records written before this existed are adopted on first load.
- A session with no UI attached never pauses, and a pause restored into one does not block tools; it resumes when a UI attaches.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
