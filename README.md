# huddle

English | [简体中文](README.zh-CN.md)

Ask a teammate's coding agent a question, and let their agent answer from their local context.

huddle is a small CLI that lets your coding agent (Claude Code, Codex, or anything that can run a shell command) ask one specific teammate's agent a question. The teammate runs `huddle serve` on their machine; it picks up the question, runs their own Claude Code or Codex with their local code, session history and ssh access, and posts the answer back. Everything is asynchronous and travels over GitHub Discussions, so there is no server to run and nobody has to stop what they are doing.

## How it works

- Your agent runs `npx -y huddle-agent@latest ask --to <login|email> "question"`; this opens a Discussion thread addressed to exactly one person.
- On the teammate's machine, `huddle serve` polls every 60 seconds, finds questions addressed to them, and runs their local Claude Code or Codex to answer.
- The reply is posted to the thread (secrets redacted) and your `ask` command exits with a code that says what happened (see [Exit codes](#exit-codes)).
- Follow up with `reply` for multiple rounds; the teammate's agent resumes the same agent session. Use `resolve` to accept the answer.
- Useful answers can be published as knowledge cards (`publish`) and found later with `search`.

## Quick start

Requirements: Node >= 22, a GitHub token (see [Authentication](#authentication)), and the `claude` or `codex` CLI on the answering machine.

In your repository (once):

```sh
npx -y huddle-agent@latest init
```

Then commit the files `init` lists at the end (the skill, `AGENTS.md`, and `.huddle/config.yml` if it was written).

`init` enables Discussions, writes `.claude/skills/huddle/SKILL.md` (for Claude Code) and a block in `AGENTS.md` (for Codex and others) that teach agents how to use huddle, and writes `.huddle/config.yml` when needed. Every command prints a warning on stderr if the repo's skill is older than the installed CLI; rerun `init` to update it.

Anyone who wants to answer questions runs, in a clone of the repo:

```sh
npx -y huddle-agent@latest serve
# or install it globally: npm i -g huddle-agent   (the command is `huddle`)
```

Run `npx -y huddle-agent@latest doctor` at any time to check the environment and get suggested fixes.

## Public repositories

Threads must live in a private repository. If your code repo is private, threads go into its Discussions. If it is public or internal, `init` creates a private companion repo `<owner>/<repo>-huddle` with Discussions enabled and writes `repo: <owner>/<repo>-huddle` to `.huddle/config.yml`. Add your teammates as collaborators on that companion repo.

Every command refuses to run against a transport repo that is not private (public or internal) unless `public: true` is set in `.huddle/config.yml`. With `public: true`, threads are visible to everyone, and the responder is told that the thread is public.

## Who can ask, and the safety model

- Only users with write access to the transport repo can ask. Comments from anyone else are never fed to the agent.
- There is no sandbox. The Claude backend runs with `--permission-mode auto` by default (or `bypassPermissions`, see below); Codex runs with `danger-full-access`. The prompt instructs the agent to be read-only, but that is an instruction, not enforcement. Only add collaborators you trust.
- Secrets are redacted from replies before they are posted.
- Every round is recorded in an audit log under `~/.huddle/log/` (directory 0700, files 0600).
- `huddle pause` stops automatic answering on this machine; `huddle resume` restarts it; `huddle retract <comment>` deletes one of your own replies.
- Limits (configurable): 8 rounds per thread, 20 answers per hour, 10 minutes per responder run.

## Commands

Use `huddle` if installed globally, or `npx -y huddle-agent@latest` otherwise. `--repo <path>` (global option) selects the project repo instead of the current directory.

| Command | What it does |
| --- | --- |
| `ask --to <login\|email> [--files a,b] [--wait <s>] <question>` | Ask one person's agent and wait for the reply (default wait 540 s). |
| `reply <thread> <text> [--wait <s>]` | Follow up, add information or rephrase, and wait. |
| `wait <thread> [--wait <s>]` | Keep waiting on an existing thread. |
| `resolve <thread>` | Mark the latest answer as the accepted answer. |
| `inbox` | Show questions you asked and questions addressed to you. |
| `serve` | Run in the foreground and answer automatically every 60 seconds. |
| `respond` | Run one round: answer pending questions addressed to you, then exit. |
| `pause` / `resume` | Pause or resume automatic answering on this machine. |
| `retract <comment>` | Delete one of your own replies (comment URL or id). |
| `publish --title <t> [--files a,b] [--source <thread>] [--supersedes <card>] [--yes] <body-file\|->` | Publish a knowledge card. Agents must get the user's consent first. |
| `kb edit <card> <body-file\|->` | Revise a card body in place. |
| `kb rm <card> [--yes]` | Delete a card. |
| `search <query>` | Search knowledge cards (first) and past Q&A. Cards are labelled stale when files they reference changed by more than `kb.stale_lines` lines. |
| `init` | Install the skill, AGENTS.md block and repo config, and check the GitHub setup. |
| `doctor` | Check the environment and suggest fixes. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Answered. |
| 1 | Error. |
| 2 | Timed out waiting for a reply (use `wait` to keep waiting). |
| 3 | Declined. The reason is one of `low_confidence`, `refused`, `timeout`, `error`, `rate_limited`. |
| 4 | Clarification requested; answer it with `reply`. |

## Configuration

### Repo config: `.huddle/config.yml`

```yaml
transport: github-discussions
repo: owner/name-huddle   # transport repo; default: the code repo itself
public: false             # allow threads in a non-private repo
categories:
  ask: Q&A                # GitHub's built-in categories; ordinary posts there are tolerated
  kb: General
limits:
  rounds_per_thread: 8
  answers_per_hour: 20
  responder_timeout_minutes: 10
kb:
  stale_lines: 50
```

All keys are optional; the values above are the defaults (except `repo`, which is unset by default).

### Machine config: `~/.config/huddle/config.yml`

(Honors `XDG_CONFIG_HOME`.)

| Key | Default | Meaning |
| --- | --- | --- |
| `backend` | auto-detected | `claude` or `codex`. |
| `command` | built-in | argv array (no shell) used to run the agent, e.g. a wrapper script. |
| `permission_mode` | `auto` | Claude permission mode: `auto` or `bypassPermissions`. |
| `extra_context_dirs` | `[]` | Extra directories the agent may read. |

### Authentication

The GitHub token is taken from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.

## Running the agent in a VM or on a remote host

If your agent lives in a VM while huddle runs on the host, point `command` at an executable wrapper script (shell functions and aliases such as a `cc` alias do not work; there is no shell). The prompt arrives on stdin, and the runner exports `HUDDLE_RESPONDER_TIMEOUT_SECONDS` so the remote side can time out together with huddle.

```bash
#!/bin/bash
# ~/bin/claude-in-vm: run Claude Code inside the VM; the prompt arrives on stdin.
exec ssh -o BatchMode=yes my-vm "cd '/mnt/host$PWD' && timeout -k 5 ${HUDDLE_RESPONDER_TIMEOUT_SECONDS:-600} claude $(printf '%q ' "$@"); exit \$?"
```

```yaml
# ~/.config/huddle/config.yml
backend: claude
command: ["/home/me/bin/claude-in-vm"]
```

Notes: do not pass `-t` to ssh, since a TTY corrupts the JSON output. The trailing `; exit \$?` stops the remote shell from exec-ing `timeout`, so if the ssh session is torn down `timeout` survives and still kills the agent; `-k 5` escalates to SIGKILL.

## Contributing

```sh
npm install
npm test
npm run build
```

For end-to-end testing with a single GitHub account, set `HUDDLE_ALLOW_SELF_ASK=1` to let that account ask itself. This is for testing only.

## License

MIT, see [LICENSE](LICENSE).
