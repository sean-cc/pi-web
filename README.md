# pi Web

English | [简体中文](README.zh-CN.md)

A web workspace for [pi coding agent](https://github.com/earendil-works/pi-coding-agent): streaming chat, sessions, tools, a conversation timeline and token accounting.

## Features

- Real-time streaming responses over SSE, including thinking blocks and tool calls
- Conversation timeline on the right: one tick per user prompt, hover previews, click/drag navigation and keyboard support
- Sticky reading: scrolling up stops auto-follow; a jump-to-latest button shows new output and resumes following
- Automatic recovery when a stream disconnects mid-task
- Grouped assistant steps: one avatar and one copy button per reply
- Per-reply timestamps, input/output token counts and estimated CNY cost, plus session totals
- Message copy, code-block copy and retry for rejected prompts
- Markdown rendering with HTML escaping, tables and code blocks
- Session management, slash commands, model picker and attachments
- Optional macOS keep-awake during long agent tasks

## Requirements

- Node.js **22.19+**
- A supported provider API key, or credentials already stored by the pi CLI
- Chrome/Chromium for `npm run smoke` (not required to run the app)

## Quick Start

```bash
# Install dependencies
npm install --ignore-scripts

# Set a provider API key, or run `pi /login` first
export ANTHROPIC_API_KEY=sk-ant-...

# Start the server (binds 127.0.0.1 by default)
npm start

# Open http://localhost:3000
```

Custom port:

```bash
PORT=8080 npm start
```

## Security

The server binds to `127.0.0.1` by default and does not send wildcard CORS
headers. It has **no authentication** and can execute agent tools, so do not
expose it directly to the internet.

For remote access, put it behind a reverse proxy with authentication and TLS, or
use a private tunnel. To listen on all interfaces on a trusted network:

```bash
HOST=0.0.0.0 npm start
```

## Configure API Key

Set one of these environment variables before starting:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

Or authenticate with the pi CLI first:

```bash
pi /login
```

Credentials are read from `~/.pi/agent/auth.json`.

## Project Structure

```text
pi-web/
├── server.js          # Node.js backend (built-in http module)
├── scripts/
│   └── smoke.mjs      # Headless Chrome smoke test (npm run smoke)
├── public/
│   ├── index.html     # HTML shell
│   ├── app.js         # App wiring, sessions, streaming orchestration
│   ├── ruler.js       # Conversation timeline
│   ├── messages.js    # Message/attachment HTML rendering
│   ├── markdown.js    # Markdown renderer
│   ├── sse.js         # SSE event parser
│   ├── util.js        # Small formatting helpers
│   ├── style.css      # Theme and layout
│   └── table-test.html
├── README.md
├── README.zh-CN.md
├── LICENSE
└── package.json
```

## Keep Awake During Long Tasks

On macOS, the server automatically holds a `caffeinate` assertion while a prompt
stream is active, so an idle Mac does not suspend the agent mid-task.

To keep the whole server awake instead:

```bash
npm run start:awake
# equivalent to: caffeinate -ims node server.js
```

Or wrap the CLI directly:

```bash
caffeinate -i pi "long task..."
```

Disable the automatic behavior with `PI_WEB_KEEP_AWAKE=0`.

**Lid closed:** `caffeinate` cannot prevent sleep when the MacBook lid is closed
unless it is in clamshell mode (power connected + external display). For tasks
that must survive a closed lid, run pi on an always-on remote machine.

## Token Usage and Cost

Token usage comes from the provider's reported usage on each assistant message.
Costs are shown in CNY as an estimate using a configurable rate (default 7.2):

```js
// In the browser console, then refresh:
localStorage.setItem('pi-web-usd-cny', '7.30')
```

Providers bill in USD; the CNY amount is an estimate, not an invoice.

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

To roll back:

```bash
npm install --ignore-scripts @earendil-works/pi-coding-agent@0.80.3
```

## Smoke Test

An end-to-end smoke test is included. It starts a temporary stub server and
headless Chrome, then checks SSE chunk parsing, markdown escaping, grouping,
copy, retry, streaming follow, read-history freeze, the jump button and the
conversation ruler.

```bash
npm run smoke
```

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
- **Frontend**: Vanilla HTML/CSS/JS (zero runtime frontend dependencies)
- **Streaming**: Server-Sent Events (SSE)
- **Sessions**: pi's built-in session tree (JSONL files)

## License

MIT. See [LICENSE](LICENSE).
