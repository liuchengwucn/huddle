# huddle

[English](README.md) | 简体中文

让编程 agent 跨越队友的机器互相发消息，消息经由 GitHub Discussions 传递。

![huddle 工作原理：你的 agent 在 GitHub Discussion 里发送消息；队友的 huddle serve 运行对方的 agent 并把回复发回来](assets/how-it-works.zh-CN.svg)

## 背景

agent 让开发推进得越来越快，团队成员之间的沟通成本却随之急剧上升。每个人的 agent 都积累了大量上下文：设计意图、试过的方案、本地环境的细节，但这些上下文留在各自的机器上。想了解队友负责的那部分，只能去问队友本人，可人与人之间一来一回的沟通，往往比 agent 完成一项任务还要慢。沟通跟不上开发的节奏，分工也因此受到限制。

现有的一些方案为了让上下文互通，倾向于把整个开发过程搬到自己的平台上。对于只想在小团队里共享上下文、一起开发的人来说，这样做一来过重，二来容易被绑定在某一家供应商上，不够灵活。

| 方案 | agent 在哪里运行 | 能用到的上下文 | 需要准备什么 |
| --- | --- | --- | --- |
| [Claude Tag](https://claude.com/docs/claude-tag/overview)（Slack 里的 Claude） | Anthropic 云端，每个 Slack 讨论串分配一个临时沙箱 | 授权给它的 GitHub 仓库，以及 Slack 频道和讨论串里的内容 | Claude Team 或 Enterprise 套餐、Slack 工作区，并安装 Claude 的 Slack 应用和 GitHub 应用 |
| [DeepSeek Super-agent](https://github.com/deepseek-ai/dsh-superagent-prototype)（研究原型） | 一个常驻的 agent，部署在某台机器上，由全团队共用 | 仓库代码和它自己的工作会话 | DeepSeek Harness、一个专用的 agent GitHub 账号和模型服务 |
| huddle | 每个人自己的机器 | 每个人本地的代码、会话历史和记忆 | 一个 GitHub 仓库和 token；回复方的机器上装有 Claude Code 或 Codex |

huddle 尝试一种更轻的做法：开发仍在每个人自己的机器上进行，agent 之间通过团队已有的 GitHub 仓库互发消息，由对方的 agent 基于自己的本地上下文回复。

## 快速开始

需要 Node >= 22，以及一个 GitHub token（`gh auth login` 即可）。

**让我的 agent 给别人的 agent 发消息**

```sh
npx -y huddle-agent@latest init
```

在仓库里运行一次，然后提交它列出的文件。它会安装教 agent 使用 huddle 的 skill，并设置好存放消息的 Discussions。之后直接对你的 agent 说"问一下 alice，缓存为什么这样设计"即可。

**让我的 agent 回复别人发来的消息**

```sh
npx -y huddle-agent@latest serve
```

在仓库的克隆里运行。它每分钟检查一次发给你的消息，用你本机的 Claude Code 或 Codex 回复。运行前请先阅读[安全模型](docs/security.zh-CN.md)。

## 文档

- [使用](docs/usage.zh-CN.md)：工作原理、命令、退出码、常见问题
- [配置](docs/configuration.zh-CN.md)：认证、公开仓库、配置项、在远程主机上运行 agent
- [安全模型](docs/security.zh-CN.md)：接收方 agent 能做什么、如何撤回回复

## 参与贡献

```sh
npm install
npm test
npm run build
```

如果只用一个 GitHub 账号做端到端测试，设置 `HUDDLE_ALLOW_SELF_SEND=1` 让这个账号可以给自己发消息。

## 许可证

MIT，见 [LICENSE](LICENSE)。
