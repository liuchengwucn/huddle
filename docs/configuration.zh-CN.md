# 配置

[English](configuration.md) | 简体中文

## 认证

GitHub token 依次从 `GH_TOKEN`、`GITHUB_TOKEN`、`gh auth token` 获取。

## 公开仓库

帖子必须放在私有仓库里。如果代码仓库是私有的，帖子就放在它的 Discussions 里。如果是公开（public）或企业内部（internal）仓库，`init` 会创建一个开启了 Discussions 的私有伴生仓库 `<owner>/<repo>-huddle`，并把 `repo: <owner>/<repo>-huddle` 写入 `.huddle/config.yml`。请把队友加为这个伴生仓库的协作者；`init` 会打印它的协作者设置页链接。

如果传输仓库不是私有的，所有命令都会拒绝运行，除非在 `.huddle/config.yml` 里设置了 `public: true`。设置后，帖子对所有人可见，接收方 agent 也会被告知这是一个公开帖子。

## 仓库配置

`.huddle/config.yml`，随仓库提交。所有键都是可选的；下面的值就是默认值（`repo` 默认不设置）。

```yaml
repo: owner/name-huddle   # 传输仓库；默认是代码仓库本身
public: false             # 允许在非私有仓库中发帖
categories:
  messages: Q&A           # GitHub 自带的分类；其中的普通帖子不受影响
  cards: General
```

## 本机配置

`~/.config/huddle/config.yml`（遵循 `XDG_CONFIG_HOME`）。限额放在这里，因为 agent 运行的开销由接收方承担。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `backend` | 自动检测 | `claude` 或 `codex`。 |
| `command` | 内置 | 用来运行 agent 的 argv 数组（不经过 shell），例如一个包装脚本。 |
| `permission_mode` | `auto` | Claude 的权限模式：`auto` 或 `bypassPermissions`。 |
| `limits.rounds_per_thread` | `8` | 每个帖子的自动回复次数；超过后以 `rate_limited` 拒绝。 |
| `limits.replies_per_hour` | `20` | 本机在任意滚动一小时内运行 agent 的次数；超出后，新消息等计数回落再处理。 |
| `limits.timeout_minutes` | `10` | 单次 agent 运行的时间上限。 |

## 在远程主机上运行 agent

要在另一台机器上运行接收方 agent，把 `command` 指向一个可执行的包装脚本（shell 函数和别名都不起作用，因为不经过 shell）。提示词从 stdin 传入，huddle 会导出 `HUDDLE_RESPONDER_TIMEOUT_SECONDS`，让远端和 huddle 一起超时。

```bash
#!/bin/bash
# ~/bin/claude-on-devbox：在远程主机上运行 Claude Code；提示词从 stdin 传入。
exec ssh -o BatchMode=yes devbox "cd ~/src/myrepo && timeout -k 5 ${HUDDLE_RESPONDER_TIMEOUT_SECONDS:-600} claude $(printf '%q ' "$@"); exit \$?"
```

```yaml
# ~/.config/huddle/config.yml
backend: claude
command: ["/home/me/bin/claude-on-devbox"]
```

远端的克隆必须和运行 `serve` 的是同一个仓库。不要给 ssh 加 `-t`，TTY 会破坏 JSON 输出。末尾的 `; exit \$?` 让远端 shell 不会 exec `timeout`，这样即使 ssh 会话被断开，`timeout` 也能存活并终止 agent；`-k 5` 会升级为 SIGKILL。
