# huddle

[English](README.md) | 简体中文

向队友的编程 agent 提问，由对方的 agent 基于对方本地的上下文作答。

huddle 是一个小巧的命令行工具，让你的编程 agent（Claude Code、Codex，或任何能执行 shell 命令的 agent）向某一位指定队友的 agent 提问。队友在自己的机器上运行 `huddle serve`，它会接收问题，用对方本地的代码、会话历史和 ssh 权限运行对方自己的 Claude Code 或 Codex，再把回答发回来。整个过程是异步的，通过 GitHub Discussions 传递，不需要部署服务器，也没有人需要停下手头的工作。

## 工作原理

![huddle 工作原理：你的 agent 在 GitHub Discussion 里提问；队友的 huddle serve 运行对方的 agent 并把回答发回来](assets/how-it-works.zh-CN.svg)

- 你的 agent 运行 `npx -y huddle-agent@latest ask --to <login|email> "问题"`，开启一个只发给一个人的 Discussion 帖子。
- 在队友的机器上，`huddle serve` 每 60 秒轮询一次，找到发给对方的问题，运行对方本地的 Claude Code 或 Codex 作答。
- 回答发布到帖子里（敏感信息会被脱敏），你的 `ask` 命令以一个表示结果的退出码结束（见[退出码](#退出码)）。
- 用 `reply` 追问，可以进行多轮；队友的 agent 会恢复同一个 agent 会话。用 `resolve` 采纳回答。
- 有价值的回答可以发布为知识卡片（`publish`），之后用 `search` 检索。

## 快速开始

要求：Node >= 22、一个 GitHub token（见[认证](#认证)），以及作答机器上装有 `claude` 或 `codex` CLI。

在你的仓库里运行一次：

```sh
npx -y huddle-agent@latest init
```

然后提交 `init` 最后列出的文件（skill、`AGENTS.md`，以及写入了的话还有 `.huddle/config.yml`）。

`init` 会开启 Discussions，写入 `.claude/skills/huddle/SKILL.md`（供 Claude Code 使用）和 `AGENTS.md` 中的一段说明（供 Codex 等使用），教 agent 如何使用 huddle；需要时还会写入 `.huddle/config.yml`。如果仓库里的 skill 比当前 CLI 旧，每条命令都会在 stderr 打印警告；重新运行 `init` 即可更新。

想回答问题的人，在仓库的克隆里运行：

```sh
npx -y huddle-agent@latest serve
# 或者全局安装：npm i -g huddle-agent   （命令名是 `huddle`）
```

随时可以运行 `npx -y huddle-agent@latest doctor` 检查环境并获得修复建议。

## 公开仓库

帖子必须放在私有仓库里。如果代码仓库是私有的，帖子就放在它的 Discussions 里。如果是公开（public）或企业内部（internal）仓库，`init` 会创建一个开启了 Discussions 的私有伴生仓库 `<owner>/<repo>-huddle`，并把 `repo: <owner>/<repo>-huddle` 写入 `.huddle/config.yml`。请把队友加为这个伴生仓库的协作者。

如果传输仓库不是私有的（公开或企业内部），所有命令都会拒绝运行，除非在 `.huddle/config.yml` 里设置了 `public: true`。设置 `public: true` 后，帖子对所有人可见，回答方 agent 也会被告知这是一个公开帖子。

## 谁能提问，以及安全模型

- 只有对传输仓库有写权限的用户才能提问。其他人的评论永远不会喂给 agent。
- 没有沙箱。Claude 后端默认以 `--permission-mode auto` 运行（或 `bypassPermissions`，见下文）；Codex 以 `danger-full-access` 运行。提示词要求 agent 只读，但这只是指令，不是强制约束。只添加你信任的协作者。
- 回答在发布前会脱敏敏感信息。
- 每一轮都记录在 `~/.huddle/log/` 下的审计日志里（目录权限 0700，文件 0600）。
- `huddle pause` 停止本机的自动作答；`huddle resume` 恢复；`huddle retract <comment>` 删除你自己的一条回复。
- 限额（可配置）：每个帖子 8 轮，每小时 20 次作答，每次回答方运行 10 分钟。

## 命令

全局安装后用 `huddle`，否则用 `npx -y huddle-agent@latest`。全局选项 `--repo <path>` 指定项目仓库，代替当前目录。

| 命令 | 作用 |
| --- | --- |
| `ask --to <login\|email> [--files a,b] [--wait <s>] <question>` | 向某个人的 agent 提问并等待回答（默认等待 540 秒）。 |
| `reply <thread> <text> [--wait <s>]` | 追问、补充信息或换个说法，并等待。 |
| `wait <thread> [--wait <s>]` | 继续等待一个已有帖子。 |
| `resolve <thread>` | 把最新的回答标记为采纳的答案。 |
| `inbox` | 列出你提的问题和发给你的问题。 |
| `serve` | 前台运行，每 60 秒自动作答一次。 |
| `respond` | 运行一轮：回答发给你的待处理问题，然后退出。 |
| `pause` / `resume` | 暂停或恢复本机的自动作答。 |
| `retract <comment>` | 删除你自己的一条回复（评论 URL 或 id）。 |
| `publish --title <t> [--files a,b] [--source <thread>] [--supersedes <card>] [--yes] <body-file\|->` | 发布知识卡片。agent 必须先征得用户同意。 |
| `kb edit <card> <body-file\|->` | 原地修订卡片正文。 |
| `kb rm <card> [--yes]` | 删除卡片。 |
| `search <query>` | 检索知识卡片（优先）和过往问答。如果卡片引用的文件变更超过 `kb.stale_lines` 行，卡片会被标为过时。 |
| `init` | 安装 skill、AGENTS.md 段落和仓库配置，并检查 GitHub 设置。 |
| `doctor` | 检查环境并给出修复建议。 |

## 退出码

| 代码 | 含义 |
| --- | --- |
| 0 | 已回答。 |
| 1 | 出错。 |
| 2 | 等待回答超时（用 `wait` 继续等待）。 |
| 3 | 拒绝回答。原因是 `low_confidence`、`refused`、`timeout`、`error`、`rate_limited` 之一。 |
| 4 | 对方请求澄清；用 `reply` 回复。 |

## 配置

### 仓库配置：`.huddle/config.yml`

```yaml
transport: github-discussions
repo: owner/name-huddle   # 传输仓库；默认是代码仓库本身
public: false             # 允许在非私有仓库中发帖
categories:
  ask: Q&A                # GitHub 自带的分类；其中的普通帖子不受影响
  kb: General
limits:
  rounds_per_thread: 8
  answers_per_hour: 20
  responder_timeout_minutes: 10
kb:
  stale_lines: 50
```

所有键都是可选的；上面的值就是默认值（`repo` 除外，默认不设置）。

### 本机配置：`~/.config/huddle/config.yml`

（遵循 `XDG_CONFIG_HOME`。）

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `backend` | 自动检测 | `claude` 或 `codex`。 |
| `command` | 内置 | 用来运行 agent 的 argv 数组（不经过 shell），例如一个包装脚本。 |
| `permission_mode` | `auto` | Claude 的权限模式：`auto` 或 `bypassPermissions`。 |
| `extra_context_dirs` | `[]` | agent 可以额外读取的目录。 |

### 认证

GitHub token 依次从 `GH_TOKEN`、`GITHUB_TOKEN`、`gh auth token` 获取。

## 在虚拟机或远程主机上运行 agent

如果你的 agent 跑在虚拟机里，而 huddle 跑在宿主机上，把 `command` 指向一个可执行的包装脚本（shell 函数和别名，比如 `cc` 别名，都不起作用，因为不经过 shell）。提示词从 stdin 传入，runner 会导出 `HUDDLE_RESPONDER_TIMEOUT_SECONDS`，让远端和 huddle 一起超时。

```bash
#!/bin/bash
# ~/bin/claude-in-vm：在虚拟机里运行 Claude Code；提示词从 stdin 传入。
exec ssh -o BatchMode=yes my-vm "cd '/mnt/host$PWD' && timeout -k 5 ${HUDDLE_RESPONDER_TIMEOUT_SECONDS:-600} claude $(printf '%q ' "$@"); exit \$?"
```

```yaml
# ~/.config/huddle/config.yml
backend: claude
command: ["/home/me/bin/claude-in-vm"]
```

注意：不要给 ssh 加 `-t`，TTY 会破坏 JSON 输出。末尾的 `; exit \$?` 让远端 shell 不会 exec `timeout`，这样即使 ssh 会话被断开，`timeout` 也能存活并终止 agent；`-k 5` 会升级为 SIGKILL。

## 参与贡献

```sh
npm install
npm test
npm run build
```

如果只用一个 GitHub 账号做端到端测试，设置 `HUDDLE_ALLOW_SELF_ASK=1` 让这个账号可以向自己提问。仅供测试使用。

## 许可证

MIT，见 [LICENSE](LICENSE)。
