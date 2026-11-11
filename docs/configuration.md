# Configuration

English | [简体中文](configuration.zh-CN.md)

## Authentication

The GitHub token is taken from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.

## Public repositories

Threads must live in a private repository. If your code repo is private, threads go into its Discussions. If it is public or internal, `init` creates a private companion repo `<owner>/<repo>-huddle` with Discussions enabled and writes `repo: <owner>/<repo>-huddle` to `.huddle/config.yml`. Add your teammates as collaborators on that companion repo; `init` prints the link to its collaborator settings.

Every command refuses to run against a transport repo that is not private unless `public: true` is set in `.huddle/config.yml`. With `public: true`, threads are visible to everyone, and the receiving agent is told that the thread is public.

## Repo config

`.huddle/config.yml`, committed with the repo. All keys are optional; the values below are the defaults (`repo` is unset by default).

```yaml
repo: owner/name-huddle   # transport repo; default: the code repo itself
public: false             # allow threads in a non-private repo
categories:
  messages: Q&A           # GitHub's built-in categories; ordinary posts there are tolerated
  kb: General
```

## Machine config

`~/.config/huddle/config.yml` (honors `XDG_CONFIG_HOME`). Limits live here because the receiver pays for the agent runs.

| Key | Default | Meaning |
| --- | --- | --- |
| `backend` | auto-detected | `claude` or `codex`. |
| `command` | built-in | argv array (no shell) used to run the agent, e.g. a wrapper script. |
| `permission_mode` | `auto` | Claude permission mode: `auto` or `bypassPermissions`. |
| `limits.rounds_per_thread` | `8` | Automatic replies per thread; after that the thread is declined with `rate_limited`. |
| `limits.replies_per_hour` | `20` | Agent runs within any rolling hour on this machine; further messages wait until the count drops. |
| `limits.timeout_minutes` | `10` | Time limit for one agent run. |

## Running the agent on a remote host

To run the receiving agent on another machine, point `command` at an executable wrapper script (shell functions and aliases do not work; there is no shell). The prompt arrives on stdin, and huddle exports `HUDDLE_RESPONDER_TIMEOUT_SECONDS` so the remote side can time out together with huddle. ssh does not forward environment variables, so pass `HUDDLE_RESPONDER` explicitly as below: it tells the agent not to use huddle itself.

```bash
#!/bin/bash
# ~/bin/claude-on-devbox: run Claude Code on a remote host; the prompt arrives on stdin.
exec ssh -o BatchMode=yes devbox "cd ~/src/myrepo && HUDDLE_RESPONDER='${HUDDLE_RESPONDER:-}' timeout -k 5 ${HUDDLE_RESPONDER_TIMEOUT_SECONDS:-600} claude $(printf '%q ' "$@"); exit \$?"
```

```yaml
# ~/.config/huddle/config.yml
backend: claude
command: ["/home/me/bin/claude-on-devbox"]
```

The remote clone must be the same repository that `serve` runs in. Do not pass `-t` to ssh, since a TTY corrupts the JSON output. The trailing `; exit \$?` stops the remote shell from exec-ing `timeout`, so if the ssh session is torn down `timeout` survives and still kills the agent; `-k 5` escalates to SIGKILL.
