# Prompt Tracker

A GitHub-style graph of the prompts you send Claude Code. It shows one square per day for the last 365 days, shaded by how many prompts you sent that day. It opens in a pane beside the chat, in the terminal, VS Code and the desktop app's Code tab.

## What counts

Every prompt sent to Claude counts, whether you sent it or automation you set up did. That includes:

- prompts you type
- slash commands that reach Claude
- queued prompts
- a prompt re-sent after an interruption
- `claude -p` and other SDK prompts
- scheduled tasks
- `/loop` firings

These don't count: Claude's replies, tool results, your answers to Claude's multiple-choice questions, prompts Claude sends its own subagents, and built-in local commands such as `/clear`. A prompt belongs to the day it was sent in your computer's time zone.

The mod counts each prompt as it's sent. At each session start it also scans your transcripts folder for anything it missed, so the first run fills in the 30 days of transcripts Claude Code keeps. A prompt counted as it was sent stays counted after its transcript is gone, for example when the desktop app deletes a session you discard.

## Install

This is a mod, and the mod API is early access (see [Tested with](#tested-with)). At the prompt of a terminal session:

```
/plugin install prompts-graph --marketplace joshuazesu/prompts-graph
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session). From a shell:

```sh
claude plugin install prompts-graph --marketplace joshuazesu/prompts-graph
```

In the desktop app, where `/plugin` doesn't run, click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace** with `joshuazesu/prompts-graph`, then **Add plugin**.

To run it from a clone instead, start Claude Code with `claude --plugin-dir <clone>`. Or, for sessions the desktop app or VS Code start, add the clone's path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. A clone keeps its record apart from an installed copy, so switching between the two starts a new graph, refilled from the transcripts Claude Code still keeps.


## Use

The graph opens when a session starts, and again after `/clear`. In the terminal, a pane opened this way waits for a window at least 144 columns wide. If you close it, it stays closed until the next session; run `/prompts-graph` to open it again. To open it only with `/prompts-graph`, turn off the `autoOpen` setting.

Above the graph are your total prompts for the last year and your current and longest streaks: runs of days with at least one prompt. A quiet today doesn't end the current streak until the day is over. When the pane is wide enough for all 53 weeks, the graph runs left to right, as on GitHub; narrower, it runs top to bottom with the newest week on top. In the desktop app, hover over a square to enlarge it and see that day's count.

Where the pane sits is up to the app: docked beside the chat, or inline in it. The mod can't choose a side, so there's no setting for it, but you can drag the pane to any size you like.

Between the legend and the graph is a button named for the other palette, **GitHub Green** or **Claude Clay**: press it to switch the graph's colors, or press `p` with the pane focused. VS Code draws buttons in its own theme colors, so there the button is its plain secondary style, with a square of the other palette's color beside it. Your choice is saved to the `palette` setting, so it lasts across sessions. In VS Code, Claude Code doesn't let an installed plugin write its settings, so the mod keeps your choice itself; if you later change the `palette` setting, that change wins.

## Settings

Change these in the `/config` menu, or under `pluginConfigs` in `~/.claude/settings.json`:

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| `autoOpen` | `true`, `false` | `true` | Open the graph when a session starts, and again after `/clear`. Off, it opens only through `/prompts-graph`. |
| `palette` | `clay`, `green` | `clay` | The graph's colors: Claude Clay or GitHub Green. Each palette has a light and a dark version: the terminal follows Claude Code's theme, and VS Code and the desktop app follow your system's appearance. |
| `transcriptsDir` | a folder path | `~/.claude/projects` | Where Claude Code keeps session transcripts. Left at the default, the mod reads `$CLAUDE_CONFIG_DIR/projects` when `CLAUDE_CONFIG_DIR` is set. Change it only if yours are somewhere else. |

## Privacy

The mod stores daily totals and prompt IDs, never prompt text. Its record lives in Claude Code's plugin store, under `plugins/store/` in your Claude Code folder (`~/.claude`, or `CLAUDE_CONFIG_DIR` when that is set), and holds:

- a count per day, for the last 365 days
- the IDs of prompts already counted, for the last 30 days, so no prompt counts twice. Each ID is the last 16 hex digits of the prompt's uuid in its transcript, with the time it was sent, to the second.
- how far each transcript file has been read, so each scan reads only what's new. Files are listed by their full path, which includes each project's folder name.
- the names of the store files already carried over from earlier names, so none is carried over twice.
- in VS Code, your palette choice, when Claude Code doesn't let the mod save it to the `palette` setting.

The mod sends nothing anywhere. It makes no network requests and no HTTP calls, and all it reads and writes stays on your computer.

## What it runs, reads and changes

**Programs.** The mod runs one program: `/bin/sh` with `hooks/user-lines.sh`, a short shell script it ships, as `/bin/sh <plugin folder>/hooks/user-lines.sh <transcript file> <first byte> <byte count>`. Claude Code's file reader refuses files over 4 MiB and can't read part of a file, so the script reads a transcript that is over 4 MiB, or only the part of a transcript added since the last scan. It uses `tail`, `head`, `awk` and `sed` to print just the lines that could be prompts, and then how many bytes it read. It writes nothing and runs nothing else.

**Files it reads.**

- the session transcripts (`*.jsonl`) in your transcripts folder, to count prompts. It keeps no prompt text.
- once, the records its earlier names, `claude-contributions` and `contributions-graph`, left in Claude Code's plugin store, if there are any, to carry their history over.

**Settings and environment.**

- It reads Claude Code's `theme` setting, to draw the terminal graph in light or dark colors.
- It reads the `HOME` and `CLAUDE_CONFIG_DIR` environment variables, to find your Claude Code folder. It sets no environment variables.
- It changes one setting, its own `palette` (under `pluginConfigs` in `~/.claude/settings.json`), and only when you press the palette button, as choosing a palette in `/config` would. It changes no other setting, and never Claude Code's permissions.

**Hooks.** The mod's code hooks these Claude Code events:

- **Session start:** registers `/prompts-graph`, counts prompts in transcripts it hasn't read yet, and opens the pane when `autoOpen` is on.
- **Session end:** after `/clear`, opens the pane again when `autoOpen` is on.
- **Each stored message:** when the message is a prompt, adds it to today's count. It passes every message on unchanged.
- **`/prompts-graph`:** opens the pane.
- **Drawing the pane:** draws the graph, the totals, the legend and the palette button.
- **A change to the `palette` setting:** redraws the pane in the new palette and passes the change on unchanged.

Claude Code deletes transcripts after 30 days by default, but the record keeps the daily totals for the whole 365-day window. If you reinstall, or clear the record, the graph refills only the 30 days that still have transcripts.

## Tested with

Tested with Claude Code 2.1.314 to 2.1.317. The mod API is early access and can change between releases, so a later version may need an update to the mod. Claude Code 2.1.284 and earlier lack the hook it counts prompts with.


## License

MIT. See [LICENSE](LICENSE).
