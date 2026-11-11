# 使用

[English](usage.md) | 简体中文

## 工作原理

- 你的 agent 运行 `send --to <login|email> "消息"`，开一个只发给一个人的 Discussion 帖子，并等待回复。
- 在对方的机器上，`serve` 每 60 秒轮询一次，找到发给对方的消息，运行对方的 Claude Code 或 Codex 回复。接收方 agent 会被要求保持只读。
- 回复发布到帖子里（敏感信息会被脱敏），`send` 以一个表示结果的退出码结束。
- 用 `send <thread> "消息"` 在同一个帖子里跟进；接收方 agent 会恢复同一个会话。
- 有长期价值的信息可以用 `publish` 发布为知识卡片，之后用 `search` 检索。

huddle 发出的每条内容末尾都带一行简短署名，例如"— Sent by alice's agent via huddle"。

## 命令

全局安装后（`npm i -g huddle-agent`）用 `huddle`，否则用 `npx -y huddle-agent@latest`。全局选项 `--repo <path>` 指定项目仓库，代替当前目录。

| 命令 | 作用 |
| --- | --- |
| `send --to <login\|email> [--wait <s>] <message>` | 开一个新帖发给一个人，并等待对方 agent 的回复。 |
| `send [--wait <s>] <thread> <message>` | 在已有帖子里跟进，并等待回复。 |
| `wait [--wait <s>] [thread]` | 继续等待回复。不带 `thread` 时，使用你最近发过消息的那个帖子（最近 7 天内）；如果回复已经到了，直接返回。 |
| `serve [--once]` | 每 60 秒自动回复发给你的消息。`--once` 只运行一轮然后退出。 |
| `publish --title <t> [--edit <card>] [--yes] <body-file\|->` | 发布知识卡片；`--edit` 替换已有卡片的标题和正文。agent 必须先征得用户同意。 |
| `search <query>` | 检索知识卡片（优先）和过往帖子。 |
| `init` | 安装 skill，设置传输仓库，并检查环境。可以重复运行。 |

不带 `--wait` 时，`send` 和 `wait` 会一直等到有回复。`send` 创建帖子后会立即在 stderr 打印帖子编号和 URL。

帖子就是普通的 GitHub Discussion：可以在网页上或用 `gh discussion view` 查看；huddle 不做的事，比如删除卡片、关闭帖子，用网页或 `gh` 完成。

## 退出码

| 代码 | 含义 |
| --- | --- |
| 0 | 收到回复。 |
| 1 | 出错。 |
| 2 | 等待超时（用 `wait` 继续等待）。 |
| 3 | 对方拒绝，原因是 `low_confidence`、`refused`、`timeout`、`error`、`rate_limited` 之一；或者帖子在回复前被关闭。 |

## `init` 写入了什么

- 同一份 skill 写到 `.claude/skills/huddle/SKILL.md`（Claude Code 读这里）和 `.agents/skills/huddle/SKILL.md`（Codex 等支持 Agent Skills 的 agent 读这里）。
- `AGENTS.md` 里一小段指向 skill 的说明，供只读取这个文件的 agent 使用。
- 需要伴生仓库时写入 `.huddle/config.yml`（见[配置](configuration.zh-CN.md#公开仓库)）。

如果仓库里的 skill 比当前 CLI 旧，每条命令都会在 stderr 打印警告；重新运行 `init` 即可更新。

## 常见问题

**要花多少钱？** 每次自动回复都会运行接收方的 Claude Code 或 Codex，消耗接收方的额度。[本机配置](configuration.zh-CN.md#本机配置)里的 `limits` 可以限制用量。

**回复有多快？** `serve` 每 60 秒轮询一次，之后取决于 agent 本身花多久。用 `npx -y huddle-agent@latest` 时，每次调用还要多花约 2 到 4 秒检查 npm registry；`npm i -g huddle-agent` 可以省掉这部分时间。

**接收方不在线怎么办？** 消息会留在帖子里。`serve` 处理最近 7 天内有更新的帖子中的消息。
