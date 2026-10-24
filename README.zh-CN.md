# pi Web

[English](README.md) | 简体中文

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的 Web 工作台：流式对话、会话管理、工具调用、对话刻度和 token 统计。

## 功能

- 通过 SSE 实时流式输出，支持 thinking 块和工具调用
- 右侧对话刻度：每个用户输入一个刻度，支持悬停预览、点击/拖动跳转和键盘操作
- 阅读历史时不会被新输出拉走；回到最新位置后自动恢复跟随，右下角按钮会提示新输出
- 流式连接中断后自动恢复，重新对齐服务端会话
- 合并连续的助手步骤：一轮回复只显示一个头像和一个复制按钮
- 每条回复显示时间、输入/输出 token 数和人民币估算费用，侧边栏显示会话总计
- 支持复制整条消息、复制代码块，以及请求被拒绝后的重试
- Markdown 渲染（HTML 转义、表格、代码块）
- 会话管理、斜杠命令、模型选择和附件上传
- macOS 下长任务运行期间可自动阻止空闲休眠

## 环境要求

- Node.js **22.19+**
- 受支持的 provider API key，或已经通过 pi CLI 登录
- 运行 `npm run smoke` 需要 Chrome/Chromium（仅测试需要）

## 快速开始

```bash
# 安装依赖
npm install --ignore-scripts

# 设置 provider API key，或先执行 `pi /login`
export ANTHROPIC_API_KEY=sk-ant-...

# 启动服务（默认只监听 127.0.0.1）
npm start

# 打开 http://localhost:3000
```

自定义端口：

```bash
PORT=8080 npm start
```

## 安全说明

服务默认监听 `127.0.0.1`，并且不会发送通配符 CORS 响应头。它**没有内置认证**，并且可以执行 agent 工具，所以不要把服务直接暴露到公网。

远程使用时，请放在带认证和 TLS 的反向代理后面，或者使用私有隧道。在可信局域网内需要监听所有网卡时：

```bash
HOST=0.0.0.0 npm start
```

## 配置 API Key

启动前设置以下任一环境变量：

| Provider | 环境变量 |
|----------|----------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

或者先通过 pi CLI 登录：

```bash
pi /login
```

凭据会从 `~/.pi/agent/auth.json` 读取。

## 项目结构

```text
pi-web/
├── server.js          # Node.js 后端（内置 http 模块）
├── scripts/
│   └── smoke.mjs      # 无头 Chrome 冒烟测试（npm run smoke）
├── public/
│   ├── index.html     # HTML 外壳
│   ├── app.js         # 应用组装、会话和流式编排
│   ├── ruler.js       # 右侧对话刻度
│   ├── messages.js    # 消息/附件 HTML 渲染
│   ├── markdown.js    # Markdown 渲染器
│   ├── sse.js         # SSE 事件解析
│   ├── util.js        # 小型格式化工具
│   ├── style.css      # 主题和布局
│   └── table-test.html
├── README.md
├── README.zh-CN.md
├── LICENSE
└── package.json
```

## 长任务防休眠

在 macOS 上，只要当前有 prompt 流在运行，服务会自动持有 `caffeinate` 断言，避免空闲休眠导致任务中断。

如果希望整个服务运行期间都保持唤醒：

```bash
npm run start:awake
# 等价于：caffeinate -ims node server.js
```

也可以直接包裹 CLI：

```bash
caffeinate -i pi "long task..."
```

通过 `PI_WEB_KEEP_AWAKE=0` 可以关闭自动防休眠。

**合盖提醒：** 合上 MacBook 盖子时，`caffeinate` 无法阻止睡眠，除非处于合盖模式（连接电源和外接显示器）。必须在合盖状态下运行的任务，建议放在常开的远程机器上。

## Token 用量和费用

Token 用量来自 provider 在每条助手消息中返回的 usage。费用按可配置汇率换算成人民币估算值（默认 7.2）：

```js
// 在浏览器控制台执行后刷新：
localStorage.setItem('pi-web-usd-cny', '7.30')
```

Provider 实际按美元计费，人民币金额只是估算，不是账单。

## 升级 pi SDK

服务端同时支持 0.x 的 `AuthStorage` API 和 1.x 的 `ModelRuntime` API，所以可以直接升级或回滚，不需要改代码。

```bash
# 先停止正在运行的 pi Web 服务
cp package-lock.json /tmp/pi-web-package-lock-backup.json
cp -R ~/.pi/agent ~/.pi/agent.bak-$(date +%Y%m%d-%H%M%S)

npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@latest
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"
./node_modules/.bin/pi --version

npm start
```

回滚：

```bash
npm install --ignore-scripts @earendil-works/pi-coding-agent@0.80.3
```

## 冒烟测试

包含一个端到端冒烟测试。它会启动临时 stub 服务和 headless Chrome，检查 SSE 分片解析、Markdown 转义、助手步骤合并、复制、重试、流式跟随、阅读时保持位置、回到最新按钮和对话刻度。

```bash
npm run smoke
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/:id` | 获取会话信息和消息 |
| GET | `/api/commands?sessionId=:id` | 获取斜杠命令（内置、skills、prompts、扩展） |
| POST | `/api/sessions/:id/prompt` | 发送 prompt（SSE 流） |
| POST | `/api/sessions/:id/compact` | 压缩会话上下文 |
| POST | `/api/sessions/:id/abort` | 中止当前操作 |
| DELETE | `/api/sessions/:id` | 删除会话 |

## 技术栈

- **后端**：Node.js 内置 `http` 模块 + `@earendil-works/pi-coding-agent` SDK
- **前端**：原生 HTML/CSS/JS（无运行时前端依赖）
- **流式传输**：Server-Sent Events（SSE）
- **会话**：pi 内置的会话树（JSONL 文件）

## 许可证

MIT，详见 [LICENSE](LICENSE)。
