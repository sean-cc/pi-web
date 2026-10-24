# pi Web

English | [简体中文](README.zh-CN.md)

pi Web is a browser workspace for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Install it, add one model API key, and chat with an agent that can read and write files, run commands, and stream its thinking and tool calls live.

## What you can do

- Chat with the agent in the browser and watch thinking/tool calls as they happen
- Jump back to earlier prompts with the timeline on the right
- Read history without being pulled to the bottom; return to the latest output when you are ready
- Manage sessions, switch models, and attach images or files
- See each reply's timestamp, token usage and estimated CNY cost
- Edit an earlier message and resend it on a new branch, copy replies, retry rejected prompts, and recover after a dropped stream
- Keep a Mac awake during long tasks (optional)

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

- **No models?** Run `npm run setup` or set a provider environment variable, then restart the server.
- **Remote access:** the server listens on `127.0.0.1` by default and has no built-in authentication. Do not expose it directly to the internet. Use a reverse proxy with authentication and TLS, or a private tunnel. `HOST=0.0.0.0` is only for trusted networks.
- **Mac sleep:** the server can hold a `caffeinate` assertion during active tasks. Closing the lid still sleeps unless the Mac is in clamshell mode; for unattended long tasks, use an always-on machine.
- **Where are keys stored?** `~/.pi/agent/auth.json`. API keys are never written to this repository.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, tests, API endpoints and SDK upgrade notes.

## License

MIT. See [LICENSE](LICENSE).
