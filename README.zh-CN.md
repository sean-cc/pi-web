# pi Web

[English](README.md) | 简体中文

pi Web 是 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的浏览器工作台。装好后填一个模型 API Key，就能在浏览器里让 agent 读写文件、执行命令，并实时看到它的思考和工具调用。

## 主要功能

- 在浏览器里和 agent 对话，实时显示思考过程和工具调用
- 右侧对话刻度：点一下就能回到之前的某次输入
- 看历史时页面不会被新输出拉走；想继续看最新内容时再回到最新位置
- 管理会话、切换模型、上传图片和文件
- 查看每条回复的时间、token 用量和人民币估算费用
- 编辑之前发过的消息并在新分支上重新提交；复制回复、重试被拒绝的请求；流中断后自动恢复
- macOS 长任务运行期间可选择阻止空闲休眠

## 环境要求

- Node.js **22.19 或更高版本**
- 一个支持的大模型 API Key（Anthropic、OpenAI、Google、DeepSeek、OpenRouter、Moonshot、MiniMax、xAI、Groq、Mistral 等）

## 安装和启动

```bash
git clone https://github.com/sean-cc/pi-web.git
cd pi-web
npm install --ignore-scripts
npm run setup
npm start
```

然后打开 <http://localhost:3000>。

`npm run setup` 会列出常用模型服务商，选择后输入 API Key 即可。它只依赖安装 pi Web 时一起装好的依赖，**不需要另外安装 pi CLI**。Key 会保存到 `~/.pi/agent/auth.json`。

启动后，在左下角的模型选择器里选一个模型。不选的话，会自动使用当前可用的第一个模型。

### 用环境变量配置（可选）

不想用交互式 setup 的话，也可以直接设置环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY` 等环境变量同样可用，不需要安装 pi CLI。

修改端口：

```bash
PORT=8080 npm start
```

## 常见问题

- **模型列表是空的？** 先运行 `npm run setup`，或者设置一个 provider 的环境变量，然后重启服务。
- **想从别的电脑访问？** 服务默认只监听 `127.0.0.1`，并且没有内置登录。不要直接暴露到公网；请放在带认证和 TLS 的反向代理或私有隧道后面。`HOST=0.0.0.0` 只适合可信局域网。
- **Mac 合盖后任务会停？** 服务在任务运行期间可以阻止空闲休眠，但合盖睡眠无法完全避免，除非使用合盖模式。需要无人值守长任务时，建议放在常开的机器上。
- **Key 存在哪里？** `~/.pi/agent/auth.json`。API Key 不会写进这个仓库。

## 开发

架构、测试、API 端点和 SDK 升级说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
