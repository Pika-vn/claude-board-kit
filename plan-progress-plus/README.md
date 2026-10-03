# plan-progress-plus

Progress bars above the Claude Code prompt, plus how much of your usage is left.

- **Task bars:** when Claude starts a task with several steps, a bar shows its progress, the current step ("› 5/8 Backfill") and the % done.
- **Context window bar:** how full this chat's context is.
- **5-hour and weekly limit bars:** % used and when each resets. They turn amber at 75% used and red at 90%.
- **"This chat" row:** tokens in ↑, tokens out ↓, tokens read from cache ≋, cost at API prices ($), total compute time ◷, and time on the current task ▸.

Added in the board edition (`0.4.0-board`):

- **Git row:** repository, branch and the lines changed since the last commit (`+62,181 -959`).
- **Burn rate on the limit bars:** 🔥 burning fast, ⚡ on pace or 🍃 relaxed, and "runs out in …" in red when this pace would empty the window before it resets. A toast warns once when a window drops under 20% left.
- **Compact button** on the context row once it is 85% full.
- **More chips:** how long the prompt cache stays warm (⏳ ≈4m, an estimate), output speed (⚡ tok/s), the last tool and its time, skills loaded.
- **Error button:** "1 error · PowerShell" when a tool call failed this turn (amber when only shell commands failed, often deliberate checks; red otherwise). Press it for the reason, or type `/progress-errors` for all of them.
- **Claude's own task list as a bar:** TaskCreate / TaskUpdate / TodoWrite items appear as a "Tasks" bar; titles like "Build: Run tests" group into stages.
- **Always visible:** the usage rows have no close button, the context row shows from the start of a session ("waiting for first reply"), and a drawing error leaves a one-line notice instead of hiding the board.

Works in the Claude desktop app (Code tab) and in the terminal, where it draws text bars.

## Install

You need a recent Claude Code with plugin hooks support. It was built and tested on 2.1.286.

1. **Unzip** this folder somewhere permanent, for example:
   - Windows: `C:\Users\<you>\.claude\mods\plan-progress-plus`
   - macOS/Linux: `~/.claude/mods/plan-progress-plus`

2. **Open** `~/.claude/settings.json` (on Windows: `C:\Users\<you>\.claude\settings.json`) and add an `env` entry pointing at the folder. If the file already has an `env` block, add the line inside it.

   Windows (double backslashes):
   ```json
   "env": {
     "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\.claude\\mods\\plan-progress-plus"
   }
   ```
   macOS/Linux:
   ```json
   "env": {
     "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/plan-progress-plus"
   }
   ```

3. **If you have the original plan-progress plugin**, turn it off in the same file so you don't get two sets of bars:
   ```json
   "enabledPlugins": {
     "plan-progress@zycck-mods": false
   }
   ```

4. **Restart.** In the desktop app, quit fully (on Windows, right-click the tray icon and choose Quit), then reopen. In the terminal, start a new `claude` session.

5. **Check it works:** type `/progress-demo`. A sample bar should appear above the prompt. The usage bars appear after Claude's first reply in a chat.

## Commands

| Command | What it does |
| --- | --- |
| `/progress` | Show or hide all the bars (same as the **Progress** button in the footer) |
| `/progress-usage` | Show or hide the context, limit and "This chat" rows |
| `/progress-demo` | Show a sample task bar |
| `/progress-clear` | Remove all task bars |
| `/progress-sounds` | Play the decision, error and done sounds |
| `/progress-errors` | List the tool calls that failed this turn and why |

The ✕ on a task bar closes it. The usage rows have no ✕; `/progress-usage` hides them if you really want to.

## Good to know

- The token counts and the two time chips start from zero each time the app restarts. The $ figure covers the whole chat.
- On a 5-hour/weekly plan, the $ figure is what the chat would cost at API prices. You aren't actually charged it.
- Time spent waiting for your reply isn't counted. Background helper agents run during Claude's own working time, so their time isn't added on top.

## Uninstall

Remove the `CLAUDE_CODE_PLUGIN_DIRS` line from `settings.json`, set `plan-progress@zycck-mods` back to `true` if you use the original, restart, and delete the folder.

## Credits

A fork of [plan-progress](https://github.com/zycck/claude-mods) by Kirill Serditov, under the MIT License (see `LICENSE`). Added: current step, context and limit bars, the "This chat" token, cost and time row, and terminal text bars. The board edition merges in PikaChu's usage board (git row, burn rate, compact button, extra chips, error button, task-list bar).
