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
| `npm start` | Check for a newer pi SDK, optionally update, then start on `127.0.0.1:3000` |
| `npm run dev` | Same check, then start with `node --watch` |
| `npm run setup` | Interactive provider/API-key setup |
| `npm run start:awake` | macOS: keep the whole server awake |
| `npm run smoke` | Headless Chrome UI smoke test (47 checks) |
| `npm run test:prices` | Unit tests for the official price catalog and re-pricing |
| `npm run test:sdk` | Unit tests for the startup SDK version comparison |

## Project Layout

```text
pi-web/
├── server.js          # HTTP server, pi SDK integration, SSE, sessions
├── prices.js          # Endpoint-based vendor prices, cache and re-pricing
├── scripts/
│   ├── start.mjs      # Startup wrapper: SDK update check, then server.js
│   ├── start-test.mjs # SDK version comparison tests
│   ├── setup.mjs      # Interactive provider/API-key setup
│   ├── prices-test.mjs # Price calculation unit tests
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
- Session messages are formatted with stable session-entry IDs. The frontend uses those IDs to branch from an earlier user message when editing/resending. The branch endpoint opens a separate `SessionManager` from the same file before calling `createBranchedSession`, because that API moves the manager's current leaf.
- `public/sse.js` buffers partial SSE events across network chunks; never parse event lines before the block is complete.
- `public/ruler.js` lays out one tick per user prompt, keeps a minimum visual gap, and switches to a scrolling window when prompts overflow.
- Assistant steps are grouped under one avatar and one copy/usage footer. The grouping key is the first assistant message ID for the group.
- Streaming text is coalesced to at most one render per animation frame. Tool blocks are resolved by `data-tool-id` so they survive innerHTML rebuilds.
- The details toggle adds `details-collapsed` to one `.msg-assistant`; CSS hides its `.thinking-block`, `.tool-block` and details-only steps. A live reply is expanded and collapses when the turn ends. Toggle state is captured/restored across `renderAllMessages`.
- Token usage comes from the provider. Cost is looked up by the model's actual endpoint: vendor prices are re-fetched for endpoints with an adapter (DeepSeek, OpenRouter, GLM, Anthropic, HuggingFace, Moonshot, Aliyun), while proxy/other endpoints use the SDK/model `models.json` cost. Currency is preserved end-to-end; the CNY tooltip is an approximate conversion, configurable with `pi-web-usd-cny` in localStorage.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/prices` | Official price catalog status (last check, model count, errors) |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create a session |
| GET | `/api/sessions/:id` | Session info and messages |
| GET | `/api/commands?sessionId=:id` | Slash commands |
| POST | `/api/sessions/:id/prompt` | Send a prompt (SSE) |
| POST | `/api/sessions/:id/branch` | Branch from a historical user entry |
| POST | `/api/sessions/:id/compact` | Compact context |
| POST | `/api/sessions/:id/abort` | Abort the current run |
| DELETE | `/api/sessions/:id` | Delete a session |

## Official Prices

Every model is priced by the **endpoint it is actually called through**, not by its provider name. `formatUsage` resolves the model's `baseUrl` from `ModelRuntime`, takes its hostname, and checks the cached price table for that hostname. This means two providers can share `api.deepseek.com` prices, while a provider routed to a proxy is priced from its own configured cost.

| Endpoint | Source | Notes |
|----------|--------|-------|
| `api.deepseek.com` | `https://api-docs.deepseek.com/zh-cn/quick_start/pricing` (zh locale) or `https://api-docs.deepseek.com/quick_start/pricing` | Parses the official table in CNY or USD depending on the process locale; override with `PI_WEB_PRICE_CURRENCY=CNY|USD`. Peak/off-peak rates are selected from each message's UTC timestamp (peak: Mon-Fri 01:00-04:00 and 06:00-10:00; off-peak is half price). Chinese public holidays are not modelled and use the peak rate. |
| `openrouter.ai` | `https://openrouter.ai/api/v1/models` | Uses OpenRouter's own per-token pricing, i.e. what OpenRouter bills. |
| `open.bigmodel.cn` | `https://docs.bigmodel.cn/cn/guide/start/pricing.md` | CNY per million tokens. Input-length and output-length tiers are supported. Cache storage (元/百万 tokens/小时) is not modelled; cache-hit tokens use 缓存命中. |
| `api.anthropic.com` | `https://www.anthropic.com/pricing` | USD. Parses the server-rendered API price blocks, including Haiku 5.5's 100K-token tier; dated model ids fall back to their undated entry. |
| `router.huggingface.co` | `https://router.huggingface.co/v1/models` | USD per million tokens. Uses the first live provider in the router response; the router may actually route to a different provider with a different price. |
| `api.moonshot.cn` | `https://platform.kimi.com/docs/pricing/chat` | CNY. Parses the rendered pricing table; K3's 5-minute cache-write price is used, 1-hour writes are 2x input. |
| `dashscope.aliyuncs.com` | per-model docs page; falls back to `https://help.aliyun.com/zh/model-studio/model-pricing` | CNY, Beijing region. Model pages are read first; models that only link to the consolidated table use that table. Tiered Aliyun prices currently use the first/base tier. |
| any other host | `~/.pi/agent/models.json` / SDK | No vendor adapter: the configured `cost` for that endpoint/provider is used. This is the correct price for proxies and gateways. |

Remaining unpriced by design: `ark.cn-beijing.volces.com` (the configured `doubao-seed-1-6-*` models are not on the current official price page), `127.0.0.1` Ollama (local, no per-token price), `glm-4.5`/`glm-4.6` (not listed on the Zhipu page), and the few HuggingFace model ids that the Router API does not return.

- DeepSeek publishes identical rates in CNY and USD; the server uses the Chinese page for a `zh` locale (CNY) and the English page otherwise (USD). Set `PI_WEB_PRICE_CURRENCY` to force one.
- Only endpoints with a vendor adapter are fetched. pi's catalog is not used to override prices, so a proxy endpoint never gets the public vendor price by accident.
- Checks start before the server accepts requests and never block startup. Each endpoint is persisted as soon as it succeeds, so one slow vendor does not delay the others.
- New prices replace matching models; a model missing from the latest vendor list keeps its previous official price. If the endpoint has no cache either, `models.json`/SDK prices apply.
- The cache is `~/.pi/agent/pi-web-prices.json` (schema 3). Failed checks leave the cached prices untouched.
- Usage is re-priced when a message completes and when a session is reloaded, so history reflects current prices and each message's peak/off-peak period.
- Prices keep the vendor's currency end-to-end. The UI shows the original currency (USD for DeepSeek outside a zh locale, OpenRouter, Anthropic, HuggingFace; CNY for DeepSeek in a zh locale, GLM, Moonshot, Aliyun). The CNY figure in the tooltip for USD prices is a display-only estimate at a fixed 7.2 USD/CNY rate (override with `localStorage.setItem('pi-web-usd-cny', '7.30')`).
- Set `PI_WEB_PRICES=off` to disable vendor fetching and keep the prices shipped with the SDK/model config.
- Check the current state with `curl http://127.0.0.1:3000/api/prices`.

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
- Per-reply details toggle, auto-collapse and empty-step cleanup
- Read-history freeze and jump-to-latest
- Grouping, copy, timestamps and token usage
- Retry after HTTP rejection
- Mid-stream disconnect recovery
- Conversation ruler gaps, clicks and keyboard navigation
- Empty-session welcome restoration

It does not call a real model provider.

## Upgrading the pi SDK

`npm start` checks the npm registry and offers to install a newer pi SDK before the server starts. Interactive terminals get a `y/N` prompt; non-interactive starts only print the available version. Controls: `PI_WEB_SDK_UPDATE=off` (skip), `auto` (update without asking), and `PI_WEB_SDK_UPDATE_DEBUG=1` (show check errors). The wrapper is `scripts/start.mjs`; it starts the server only after the optional install finishes.

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
