# english-coach

A Claude Code plugin for non-native English writers: every English prompt you send gets a corrected version (handed to Claude as a side note, shown to you), and a full feedback record you can review later in a local HTML page. Feedback is written in Chinese.

给中文母语开发者的 Claude Code 插件：你用英文写的每条 prompt，都会得到一个修正版（作为旁注给 Claude，同时显示给你），完整纠错记录随时可在本地 HTML 页里回看。

> **隐私**：每条英文 prompt 会发给你配置的模型 API（默认 Anthropic）。记录只存在本机 `~/.english-coach/`，目录权限 700。

## 一条消息发生什么

```
你发英文 prompt
  → UserPromptSubmit hook 交给本机常驻 daemon（unix socket，毫秒级）
  → 跳过规则：斜杠命令 · 代码块 · 超过 8 行或 1500 字符 · 不到 8 个英文词 · 中文为主 · 非人输入
  → 同步：短改写（只修语法、去冗余，不改句序不删信息），热连接下约 1 秒
      Claude 收到原文 + 修正版旁注（冲突以原文为准）；你在 systemMessage 里看到修正版
  → 脱离：完整反馈（原文中译 · 纠错列表 · 修正版 · 修正版中译）追加到 ~/.english-coach/records/<日期>.jsonl
```

`/english-coach:review` 把全部记录生成一个自包含的 HTML 并在浏览器打开，可按原文 / 纠错搜索。

## 要求

- macOS（key 从 Keychain 读，页面用 `open` 打开）
- Node.js ≥ 24（直接运行 TypeScript，无需安装依赖）
- 一个模型 API key（见下）

## 安装

```bash
claude plugin marketplace add cognirail/english-coach
claude plugin install english-coach@english-coach
```

新开会话即生效：SessionStart hook 会自动拉起 daemon，崩溃后下一条消息会再拉起一次。

## 配 key

默认走 Anthropic Messages API，模型 `claude-haiku-5-5`。注意 Claude Code 的订阅登录（Pro / Max）**不是** API key，需要另在 [Claude Console](https://platform.claude.com/) 创建一个。

存进 Keychain（推荐，key 不落明文文件）：

```bash
security add-generic-password -s english-coach -a anthropic -w
```

或者设环境变量 `ANTHROPIC_API_KEY`（daemon 由 Claude Code 拉起，继承它的环境）。查找顺序：Keychain → 环境变量。

### 改用 OpenAI 或任意 OpenAI 兼容端点

写 `~/.english-coach/config.json`：

```json
{ "provider": "openai", "model": "<模型名>" }
```

key 存 `security add-generic-password -s english-coach -a openai -w`，或设 `OPENAI_API_KEY`。接 OpenRouter、自建网关等兼容端点时再加 `"baseUrl": "https://<host>/v1"`。

全部字段：

| 字段              | 默认                                                      | 说明                        |
| ----------------- | --------------------------------------------------------- | --------------------------- |
| `provider`        | `anthropic`                                               | `anthropic` 或 `openai`     |
| `model`           | `claude-haiku-5-5`                                        | `openai` 时必填             |
| `baseUrl`         | `https://api.anthropic.com` / `https://api.openai.com/v1` | 兼容端点改这里              |
| `keychainService` | `english-coach`                                           | Keychain 条目的 service     |
| `keychainAccount` | 同 `provider`                                             | Keychain 条目的 account     |
| `envKey`          | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`                    | Keychain 没有时读的环境变量 |

改完配置后重启 daemon：`pkill -f english-coach/daemon/daemon.ts`，下一条消息会自动拉起新的。

## 开关

| 方式        | 命令                                                               | 生效       |
| ----------- | ------------------------------------------------------------------ | ---------- |
| 临时关 / 开 | `touch ~/.english-coach/disabled` / `rm ~/.english-coach/disabled` | 下一条消息 |
| 停用插件    | `claude plugin disable english-coach@english-coach`                | 新会话     |

## 失效行为

- daemon 不在：hook 先拉起一次（等约 3 秒）再重试；daemon 在但 9 秒没回应、或重试仍失败：只输出一条提示，prompt 照常发给 Claude。整条 hook 最坏约 13 秒，在 Claude Code 给的 15 秒内。
- key 读不到 / API 出错 / 7 秒超时：只提示失败原因，不附修正版。
- 完整反馈生成失败：记录照写，带 `error` 字段；模型返回的不是合法 JSON：原文存进 `raw` 字段，页面里可展开看。

## 数据

```
~/.english-coach/
├── config.json             # 可选
├── records/<日期>.jsonl    # 每条一行，只追加
├── review.html             # /english-coach:review 生成
├── daemon.sock             # 唯一事实：谁在这个路径上应答谁就是 daemon
└── logs/daemon.log
```

记录格式见 `daemon/daemon.ts` 的 `CoachRecord`。

## 开发

```bash
pnpm install
pnpm test && pnpm lint && pnpm typecheck
claude --plugin-dir .        # 不安装，直接加载本地插件
```

## License

MIT
