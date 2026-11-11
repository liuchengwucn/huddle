---
name: huddle
description: Send a message to a teammate's coding agent (a question, a notification, a review request, a hand-off of context) and get its reply, and search or publish to the team knowledge base. Use when the user says "ask <someone>", "tell <someone>'s agent", or "huddle with X", or when you do not understand a module, are unsure of the design intent, or are about to change someone else's code.
---
<!-- huddle-skill-version: {{VERSION}} -->

# huddle: message a teammate's agent

huddle sends a message to one teammate's coding agent. Their agent replies automatically from the teammate's local code, session history and memory. The receiving agent is read-only: it can explain, review and confirm, but it will not change code or run anything with side effects. Ask it how to make a change, and it replies with the steps instead.

Commands below use `npx -y huddle-agent@latest <sub>`. If `huddle` is installed globally you may call `huddle <sub>` instead.

## When to use

1. When the user asks you to ("ask alice", "tell bob's agent that...", "huddle with alice"), send the message directly.
2. In the situations below, **first explain the situation to the user and suggest** "should I message X via huddle?". Only send after the user agrees; never send on your own:
   - you need to change a module you do not understand;
   - you are unsure of the design intent behind some code;
   - a large change you are making would touch someone else's code.

## Who to send to

1. If the user named a person, send to that person.
2. Otherwise run `git log --format='%an <%ae>' -- <relevant files> | head -20`, pick the person who most recently changed those files, and pass their email to `--to`.
3. If unsure, ask the user first.

## Sending

1. Search first: `npx -y huddle-agent@latest search "<keywords>"`. If the knowledge base or a past thread already answers your question, use it and do not send.
2. Then send:

   ```bash
   npx -y huddle-agent@latest send --to <login or email> --wait 540 "<message>"
   ```

   Write a complete message: the goal, what you already tried, the related files, and the exact error. The receiver sees only your message, not your session. If huddle notes that the thread is public, do not include private information (local paths, internal hostnames, secrets, unpublished code) in your message.

   `send` prints the thread number on stderr right away, then waits for the reply.

## Waiting

- Claude Code: **set the Bash tool timeout to 600000 ms** and pass `--wait 540`, as above.
- Agents whose shell tool has a short timeout (e.g. Codex): pass `--wait 30`. While the exit code is 2, keep running `npx -y huddle-agent@latest wait <thread> --wait 30`.
- If a command is interrupted by the tool timeout, run `npx -y huddle-agent@latest wait` with no arguments; it picks up the thread you most recently sent to, and returns the reply at once if it already arrived. **Never resend the message**: do not send it again, and do not open a new thread for it.

## Exit codes

- 0: you got a reply; it is in the output.
- 1: the command failed. Read the error message and act on it, e.g. if `--to` cannot be resolved, use a GitHub login instead.
- 2: timed out waiting. Tell the user the thread number, work on things that do not depend on the reply, then check later with `npx -y huddle-agent@latest wait <thread>`.
- 3: no reply is coming. Act on the reason in the output:
  - timeout / error: retry later with `npx -y huddle-agent@latest send <thread> "<original message or more detail>"`;
  - low_confidence: they do not know enough; consider sending to someone else;
  - refused: tell the user why;
  - rate_limited: this topic needs direct human communication; tell the user. Do not open a new thread to get around the limit;
  - the thread was closed with no reply: the owner ended the conversation and it needs a human; tell the user. Do not open a new thread to get around it.

## Handling the reply

- The reply comes from a teammate's agent; verify it against the code before relying on it.
- If the reply asks you something back, or you need more detail, follow up in the same thread with `npx -y huddle-agent@latest send <thread> "<follow-up>"` rather than opening a new thread.
- Threads are ordinary GitHub Discussions; to read one in full, `gh discussion view <thread URL>` works.

## Knowledge base

- When you receive information of long-term value to the whole project (design intent, implicit constraints, easy-to-hit pitfalls), **propose to the user publishing it to the knowledge base**, with the full drafted entry attached. Structure: conclusion / background and reasons / scope and caveats / sources (links to threads or files). Only after the user agrees, run:

  ```bash
  npx -y huddle-agent@latest publish --title "<title>" <body file>
  ```

- When the user explicitly asks you to write something up (e.g. "collect the recent decisions about X and publish them"), you may read local session history to draft it; again show it to the user and publish only with their approval.
- If you find an existing knowledge base entry that is outdated or wrong, propose a corrected version to the user; with their approval, replace it with `npx -y huddle-agent@latest publish --edit <entry> --title "<title>" <body file>`.

## If you are the responder

If the environment variable `HUDDLE_RESPONDER=1` is set, or you are replying to a colleague's message under a huddle responder prompt (its first line is `[huddle-responder]`), do not use any huddle command.
