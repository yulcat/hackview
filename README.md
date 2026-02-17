# hackview

```
 ██╗  ██╗ █████╗  ██████╗██╗  ██╗██╗   ██╗██╗███████╗██╗    ██╗
 ██║  ██║██╔══██╗██╔════╝██║ ██╔╝██║   ██║██║██╔════╝██║    ██║
 ███████║███████║██║     █████╔╝ ██║   ██║██║█████╗  ██║ █╗ ██║
 ██╔══██║██╔══██║██║     ██╔═██╗ ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║
 ██║  ██║██║  ██║╚██████╗██║  ██╗ ╚████╔╝ ██║███████╗╚███╔███╔╝
 ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝
```

> Matrix-style TUI dashboard for Claude Code session logs. Because watching AI work should look as cool as it is.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ██╗  ██╗ █████╗  ██████╗██╗  ██╗██╗   ██╗██╗███████╗...   │
│  ...HACKVIEW ASCII ART...                                    │
│                                                             │
│  ◈ TODAY  182k in / 41k out  cached: 12k  cost: $0.0234    │
│  sonnet ████████████████░░░░ 154k  haiku ████░░░░░░░ 28k   │
├─────────────────────────────────────────────────────────────┤
│  ◉ SESSION 1  [streaming▮]  project-slug/abc123            │
│  ─────────────────────────────────────────────────────────  │
│  22:15:03 ▷ USER: implement the auth flow                  │
│  22:15:04 ◌ thinking...                                     │
│  22:15:06 ⚙ Read(src/auth.ts)                              │
│  22:15:07 ⚙ Write(src/auth.ts)                             │
│  22:15:08 ◎ I've implemented the authentication flow...    │
│  22:15:10 ✓ DONE  in:45k out:2k                           │
├─────────────────────────────────────────────────────────────┤
│  ◉ SESSION 2  [idle]  other-project/def456                 │
│  ─────────────────────────────────────────────────────────  │
│  22:10:01 ▷ USER: fix the bug in parser                    │
│  22:10:03 ◌ thinking...                                     │
│  22:10:05 ◎ The issue is in line 42...                     │
└─────────────────────────────────────────────────────────────┘
```

## Features

- **Real-time streaming** — watches Claude Code `.jsonl` session logs via `chokidar`
- **Usage panel** — today's token counts and cost via `ccusage`, refreshed every 60s
- **Model breakdown** — visual bars showing which models you're burning tokens on
- **Hacker aesthetic** — green-on-black, Matrix/Mr.Robot vibes
- **Auto file detection** — finds the most recently modified `.jsonl` file automatically
- **Session flash** — brief green background flash when a session completes
- **Multi-session** — watch 2+ Claude sessions simultaneously

## Installation

```bash
# Clone and install
git clone https://github.com/yulcat/hackview.git
cd hackview
npm install
npm link   # makes 'hackview' available globally
```

Or use directly with npx (once published):
```bash
npx hackview
```

## Usage

```bash
# Watch default location (~/.claude/projects)
hackview

# Watch specific project directory
hackview --dirs ~/.claude/projects/-Users-yourname

# Watch multiple projects, show 3 sessions
hackview --dirs ~/.claude/projects/-Users-you,-Users-you-work --sessions 3

# Single session mode
hackview --sessions 1
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --dirs` | `~/.claude/projects` | Comma-separated dirs to watch for `.jsonl` files |
| `-s, --sessions` | `2` | Number of session panels |
| `-c, --config` | `~/.hackview.json` | Path to config file |
| `-h, --help` | — | Show help |
| `-v, --version` | — | Show version |

### Config File

Create `~/.hackview.json`:
```json
{
  "dirs": ["~/.claude/projects/-Users-yourname"],
  "sessions": 2
}
```

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+C` | Quit |
| `q` | Quit |

## Event Display

| Symbol | Meaning |
|--------|---------|
| `▷ USER:` | User message sent to Claude |
| `◌ thinking...` | Claude is thinking (extended thinking mode) |
| `⚙ ToolName(...)` | Tool call (Read, Write, Bash, etc.) |
| `◎ text` | Claude text response |
| `✓ DONE` | Session turn complete |
| `▶ SESSION STARTED` | New session detected |

## Requirements

- Node.js >= 16
- `ccusage` (optional — for usage panel): `npm install -g ccusage`
- A terminal that supports Unicode and 256 colors

## How It Works

1. **Directory scanning** — finds `.jsonl` files in your `~/.claude/projects/*` dirs
2. **File watching** — `chokidar` watches for new content appended to the file
3. **Incremental reading** — reads only new bytes since last read (efficient for large files)
4. **Event parsing** — parses each JSON line and extracts meaningful events
5. **Message deduplication** — streaming assistant chunks with the same `message.id` are merged

## Tech Stack

- [`blessed`](https://github.com/chjj/blessed) — TUI framework
- [`chokidar`](https://github.com/paulmillr/chokidar) — file watching
- [`ccusage`](https://github.com/ryoppippi/ccusage) — Claude usage stats
- [`minimist`](https://github.com/minimistjs/minimist) — CLI arg parsing

## License

MIT
