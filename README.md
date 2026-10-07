# quota-guard

A [Claude Code](https://claude.com/claude-code) mod (plugin of function hooks) that handles usage limits for you:

- watches the **5-hour** and **weekly** usage windows, kept separate from **context-window** pressure
- at a threshold (default **94%**, lowered automatically when recent turns jump a lot) it finishes the current turn, then **compacts** (only if context is above 30%) and **pauses**
- waits until the reported reset time, re-checks, and **resumes the task automatically**
- survives restarts and reloads: pause state is persisted, and a 30-second heartbeat compares the wall clock, so sleep or a late timer only delays the resume
- shows a usage bar above the prompt (5h, 7d, context breakdown) and a full context pane on wide windows

> Early-access API: written against Claude Code 2.1.289+ Mods (`claude-code` hooks API). It may need updates as that API changes.

## Install

Load the folder for one CLI session:

```bash
claude --plugin-dir /path/to/quota-guard
```

Or for every Desktop / SDK session, in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/quota-guard" } }
```

Or copy the folder to `~/.claude/skills/quota-guard` to auto-load it.

Then run `/quota status`.

## Commands

| Command | What it does |
| --- | --- |
| `/quota status` | usage windows, thresholds, state, task on record |
| `/quota on` / `off` | enable / disable automatic management |
| `/quota threshold N` | 5-hour threshold (50-100) |
| `/quota weekly N` | weekly threshold |
| `/quota ctxmin N` | compact before pausing only if context is above N% (default 30) |
| `/quota pause [min]` | force a pause (compacts per the context rule) for testing |
| `/quota cancel` | cancel the pending auto-resume (holds until you act) |
| `/quota resume` | resume now |
| `/quota ctx [close]` | open / close the full context pane |

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

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
