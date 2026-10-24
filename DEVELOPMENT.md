# Development

Developer notes for pi Web. User-facing setup lives in [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md).

## Requirements

- Node.js 22.19+
- Chrome/Chromium for the smoke test
- Provider credentials, or a dummy key for the isolated smoke test

## Install

```bash
npm install --ignore-scripts
```

`npm run setup` configures a provider API key through the bundled SDK. It is also useful when testing first-run onboarding.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Start the server on `127.0.0.1:3000` |
| `npm run dev` | Start with `node --watch` |
| `npm run setup` | Interactive provider/API-key setup |
| `npm run start:awake` | macOS: keep the whole server awake |
| `npm run smoke` | Headless Chrome UI smoke test (35 checks) |

## Project Layout

```text
pi-web/
├── server.js          # HTTP server, pi SDK integration, SSE, sessions
├── scripts/
│   ├── setup.mjs      # Interactive provider/API-key setup
│   └── smoke.mjs      # Headless Chrome smoke test
├── public/
│   ├── index.html     # HTML shell
│   ├── app.js         # App wiring, sessions, streaming orchestration
│   ├── ruler.js       # Conversation timeline
│   ├── messages.js    # Message/attachment HTML rendering
│   ├── markdown.js    # Markdown renderer
│   ├── sse.js         # SSE event parser
│   ├── util.js        # Formatting helpers
│   ├── style.css      # Theme and layout
│   └── table-test.html
├── LICENSE
└── package.json
```

## Architecture Notes

- `server.js` wraps the pi SDK and exposes a small JSON/SSE API. It supports both the 0.x `AuthStorage` API and the 1.x `ModelRuntime` API.
- Session messages are formatted with stable session-entry IDs. The frontend uses those IDs to branch from an earlier user message when editing/resending.
- `public/sse.js` buffers partial SSE events across network chunks; never parse event lines before the block is complete.
- `public/ruler.js` lays out one tick per user prompt, keeps a minimum visual gap, and switches to a scrolling window when prompts overflow.
- Assistant steps are grouped under one avatar and one copy/usage footer. The grouping key is the first assistant message ID for the group.
- Streaming text is coalesced to at most one render per animation frame. Tool blocks are resolved by `data-tool-id` so they survive innerHTML rebuilds.
- Token usage and cost are normalized from provider usage objects. CNY values are an approximate conversion; the rate is configurable with `pi-web-usd-cny` in localStorage.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create a session |
| GET | `/api/sessions/:id` | Session info and messages |
| GET | `/api/commands?sessionId=:id` | Slash commands |
| POST | `/api/sessions/:id/prompt` | Send a prompt (SSE) |
| POST | `/api/sessions/:id/branch` | Branch from a historical user entry |
| POST | `/api/sessions/:id/compact` | Compact context |
| POST | `/api/sessions/:id/abort` | Abort the current run |
| DELETE | `/api/sessions/:id` | Delete a session |

## Security Defaults

- The server binds `127.0.0.1` unless `HOST` is set.
- No wildcard CORS headers are sent; the UI and API are same-origin.
- There is no built-in authentication. For remote use, put pi Web behind a reverse proxy with auth and TLS, or use a private tunnel.
- `HOST=0.0.0.0` starts a warning; only use it on a trusted network.

## Smoke Test

```bash
npm run smoke
```

The test starts a temporary stub server and headless Chrome. It covers:

- SSE parsing across split chunks
- Markdown HTML escaping and lists
- Thinking/tool streaming follow
- Read-history freeze and jump-to-latest
- Grouping, copy, timestamps and token usage
- Retry after HTTP rejection
- Mid-stream disconnect recovery
- Conversation ruler gaps, clicks and keyboard navigation
- Empty-session welcome restoration

It does not call a real model provider.

## Upgrading the pi SDK

The server tolerates both API shapes:

- 0.x: `AuthStorage` + `ModelRegistry.create()`
- 1.x: `ModelRuntime.create()` + `new ModelRegistry(runtime)`

```bash
# Stop running servers first.
cp package-lock.json /tmp/pi-web-package-lock-backup.json
cp -R ~/.pi/agent ~/.pi/agent.bak-$(date +%Y%m%d-%H%M%S)

npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@latest
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"
./node_modules/.bin/pi --version

npm start
```

Rollback:

```bash
npm install --ignore-scripts @earendil-works/pi-coding-agent@0.80.3
```

## License

MIT. See [LICENSE](LICENSE).
