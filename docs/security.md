# Security model

English | [简体中文](security.zh-CN.md)

`serve` runs an agent on your machine with your permissions, triggered by messages from other people. Understand what that means before you run it.

- There is no sandbox. The Claude backend runs with `--permission-mode auto` by default (or `bypassPermissions`); Codex runs with `danger-full-access`. The prompt tells the agent to be read-only: asked to change code or perform an action with side effects, it replies with how to do it instead of doing it. That is an instruction, not enforcement.
- Only messages from users with write access to the transport repo are processed. Comments from anyone else, and comments without huddle metadata, are never fed to the agent.
- Secrets are redacted from replies before they are posted. `GH_TOKEN` and `GITHUB_TOKEN` are removed from the agent's environment.
- Every round is recorded in an audit log under `~/.huddle/log/` (directory 0700, files 0600).

Recommendations: only add collaborators you trust; consider running the receiving agent on an isolated [remote host](configuration.md#running-the-agent-on-a-remote-host); stop `serve` when you do not want to reply.

## Retracting a reply

Delete the automatic reply on GitHub. `serve` then posts a short `refused` decline ("@<you> retracted the earlier automatic reply. If needed, contact @<you> directly.") instead of replying again. This relies on the local audit log, so it works only on the machine that posted the reply, and only while that reply is within the last 7 days; otherwise the agent may reply again.

To end a conversation entirely, close the thread: closed threads are never processed, and a sender still waiting gets exit code 3.
