# pi Web UI

A web interface for [pi coding agent](https://github.com/earendil-works/pi-coding-agent), inspired by OpenAI's design.

## Features

- 🎨 OpenAI-style dark theme
- 💬 Real-time streaming responses via SSE
- 🔧 Tool call visualization (read, write, edit, bash, etc.)
- 💭 Thinking block display
- 📁 Session management (create, switch, delete)
- ⚡ Slash-command palette — type `/` for commands, models, skills and prompt templates
- 📝 Markdown rendering with code blocks
- 📱 Responsive layout
- 🚫 Zero external frontend dependencies

## Quick Start

```bash
# Install dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start the server
npm start

# Open http://localhost:3000
```

Or use a custom port:

```bash
PORT=8080 npm start
```

## Configure API Key

Set one of these environment variables before starting:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

Or authenticate via pi CLI first:

```bash
pi /login
```

This stores credentials in `~/.pi/agent/auth.json` which pi Web UI will use automatically.

## Project Structure

```
piWeb/
├── server.js          # Node.js backend (pure http module)
├── scripts/
│   └── smoke.mjs      # Headless Chrome smoke test (npm run smoke)
├── public/
│   ├── index.html     # HTML shell
│   ├── style.css      # OpenAI-inspired dark theme
│   └── app.js         # Frontend logic (vanilla JS)
└── package.json
```

## Keep Awake During Long Tasks

On macOS, the server automatically holds a `caffeinate` assertion while a prompt
stream is active, so an idle Mac does not suspend the agent mid-task:

```bash
npm start
```

To keep the whole server awake instead (not just active prompts):

```bash
npm run start:awake
# equivalent to: caffeinate -ims node server.js
```

Or wrap the CLI agent directly:

```bash
caffeinate -i pi "long task..."
```

Disable the automatic behavior with `PI_WEB_KEEP_AWAKE=0`.

**Lid closed:** `caffeinate` cannot prevent sleep when the MacBook lid is closed
unless it is in clamshell mode (power connected + external display, depending on
the model). For tasks that must survive a closed lid or travel, run pi on an
always-on remote machine.

## Upgrading the pi SDK

The server supports both the 0.x `AuthStorage` API and the 1.x `ModelRuntime` API,
so the package can be upgraded or rolled back without code changes.

```bash
# Stop running pi Web servers first.
cp package-lock.json /tmp/pi-web-package-lock-backup.json
cp -R ~/.pi/agent ~/.pi/agent.bak-$(date +%Y%m%d-%H%M%S)

npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@latest
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"
./node_modules/.bin/pi --version

npm start
```

On macOS, use `npm run start:awake` if you want the server to stay awake.
The current 1.x line requires Node.js 22.19 or newer.

To roll back:

```bash
npm install --ignore-scripts @earendil-works/pi-coding-agent@0.80.3
```

## Smoke Test

A small end-to-end UI smoke test is included (requires Chrome/Chromium and Node 22+):

```bash
npm run smoke
```

It starts a temporary stub server and headless Chrome, then checks SSE chunk parsing, markdown escaping, thinking/tool streaming follow, read-history freeze, jump-to-latest, and the conversation ruler.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create new session |
| GET | `/api/sessions/:id` | Get session info & messages |
| GET | `/api/commands?sessionId=:id` | List slash commands (built-ins, skills, prompts, extensions) |
| POST | `/api/sessions/:id/prompt` | Send prompt (SSE stream) |
| POST | `/api/sessions/:id/compact` | Compact the session context |
| POST | `/api/sessions/:id/abort` | Abort current operation |
| DELETE | `/api/sessions/:id` | Delete session |

## Tech Stack

- **Backend**: Node.js built-in `http` module + `@earendil-works/pi-coding-agent` SDK
- **Frontend**: Vanilla HTML/CSS/JS (zero dependencies)
- **Streaming**: Server-Sent Events (SSE)
- **Sessions**: pi's built-in session tree (JSONL files)
