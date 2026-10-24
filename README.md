# pi Web

English | [简体中文](README.zh-CN.md)

pi Web is a browser workspace for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Install it, add one model API key, and chat with an agent that can read and write files, run commands, and stream its thinking and tool calls live.

## What you can do

- Chat with the agent in the browser and watch thinking/tool calls as they happen
- Collapse or expand each reply's thinking and tool calls; finished replies fold automatically
- Jump back to earlier prompts with the timeline on the right
- Read history without being pulled to the bottom; return to the latest output when you are ready
- Manage sessions, switch models, and attach images or files
- See each reply's timestamp, token usage and cost (vendor prices, with an estimated CNY conversion)
- Edit an earlier message and resend it on a new branch, copy replies, retry rejected prompts, and recover after a dropped stream
- Keep a Mac awake during long tasks (optional)

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send the message |
| `Shift+Enter` | Insert a new line in the composer |
| `/` | Open the command palette (commands, models, skills, prompt templates) |
| `↑` / `↓` | Move through palette results |
| `Tab` / `Enter` | Accept the selected palette item |
| `Esc` | Close the command palette or the resume-session dialog |
| `↑` / `↓`, `Home` / `End` | Jump between earlier prompts when the timeline on the right has focus |

## Requirements

- Node.js **22.19+**
- An API key from a supported provider (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Moonshot, MiniMax, xAI, Groq, Mistral, and others)

## Install and run

```bash
git clone https://github.com/sean-cc/pi-web.git
cd pi-web
npm install --ignore-scripts
npm run setup
npm start
```

Open <http://localhost:3000>.

On each start, `npm start` asks npm whether a newer pi SDK is published. In an interactive terminal it asks whether to update; choosing yes installs the new SDK before starting the server. In a non-interactive environment it only prints the available version and starts normally. Set `PI_WEB_SDK_UPDATE=off` to skip the check, or `PI_WEB_SDK_UPDATE=auto` to update without asking.

`npm run setup` asks you to choose a provider and enter its API key. It only needs the dependencies installed with pi Web — **you do not need to install the pi CLI**. The key is saved to `~/.pi/agent/auth.json`.

After starting, choose a model from the model selector in the lower-left corner. If you do not choose one, pi Web uses the first available model.

### Use an environment variable instead

If you prefer not to use the interactive setup:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

`OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` and the other provider environment variables work too. No pi CLI is required.

Custom port:

```bash
PORT=8080 npm start
```

## Notes

- **Prices:** pi Web prices each model by the endpoint it is actually called through. Models on `api.deepseek.com` use DeepSeek's official peak/off-peak page in the matching currency (Chinese page/CNY for a `zh` locale, English page/USD otherwise; override with `PI_WEB_PRICE_CURRENCY=CNY|USD`); models on `openrouter.ai` use OpenRouter's official per-token pricing; models on `open.bigmodel.cn` use Zhipu's GLM pricing docs (CNY); models on `api.anthropic.com`, `api.moonshot.cn`, `dashscope.aliyuncs.com` and `router.huggingface.co` use their official price pages/APIs as well. Every other endpoint uses the `cost` you configured for that provider in `models.json` (proxies and gateways keep their own price), with the SDK's bundled price as the last fallback. Prices keep the vendor's currency (CNY for DeepSeek in a zh locale, GLM, Moonshot and Aliyun; USD for OpenRouter, Anthropic and HuggingFace, and DeepSeek outside a zh locale); the CNY tooltip for USD prices is an estimate at 7.2 USD/CNY (`localStorage.setItem('pi-web-usd-cny', '7.30')`). Checks start as the server boots; failed checks keep the previous cache, models missing from the latest vendor list keep their last official price, and only when neither exists does the SDK price apply. The cache is `~/.pi/agent/pi-web-prices.json`; `PI_WEB_PRICES=off` disables vendor fetching. Status: `GET /api/prices`.
- **No models?** Run `npm run setup` or set a provider environment variable, then restart the server.
- **Remote access:** the server listens on `127.0.0.1` by default and has no built-in authentication. Do not expose it directly to the internet. Use a reverse proxy with authentication and TLS, or a private tunnel. `HOST=0.0.0.0` is only for trusted networks.
- **Mac sleep:** the server can hold a `caffeinate` assertion during active tasks. Closing the lid still sleeps unless the Mac is in clamshell mode; for unattended long tasks, use an always-on machine.
- **Where are keys stored?** `~/.pi/agent/auth.json`. API keys are never written to this repository.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, tests, API endpoints and SDK upgrade notes.

## License

MIT. See [LICENSE](LICENSE).
