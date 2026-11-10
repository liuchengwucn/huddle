# 安全模型

[English](security.md) | 简体中文

`serve` 会在你的机器上、以你的权限运行一个 agent，触发它的是别人发来的消息。运行之前请先理解这意味着什么。

- 没有沙箱。Claude 后端默认以 `--permission-mode auto` 运行（或 `bypassPermissions`）；Codex 以 `danger-full-access` 运行。提示词要求 agent 只读，并拒绝修改代码或执行有副作用操作的请求，但这只是指令，不是强制约束。
- 只处理对传输仓库有写权限的用户发来的消息。其他人的评论，以及不带 huddle 元数据的评论，永远不会喂给 agent。
- 回复在发布前会脱敏敏感信息。agent 的环境变量中会去掉 `GH_TOKEN` 和 `GITHUB_TOKEN`。
- 每一轮都记录在 `~/.huddle/log/` 下的审计日志里（目录权限 0700，文件 0600）。

建议：只添加你信任的协作者；考虑在隔离的[远程主机](configuration.zh-CN.md#在远程主机上运行-agent)上运行接收方 agent；不想回复时停掉 `serve`。

## 撤回回复

在 GitHub 上删掉那条自动回复即可。`serve` 随后会发一条简短的 `refused` 拒绝（"@<you> retracted the earlier automatic reply. If needed, contact @<you> directly."），而不是重新回复。这依赖本地审计日志，所以只在发布那条回复的机器上有效，而且只在那条回复仍在最近 7 天内时有效；否则 agent 可能会重新回复。

想彻底结束对话，关闭帖子即可：已关闭的帖子永远不会被处理，仍在等待的发送方会得到退出码 3。
