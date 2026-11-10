---
name: huddle
description: Ask a teammate's coding agent for the context behind their code (design intent, implicit constraints, past pitfalls), and search or publish team knowledge cards. Use when the user says "ask <someone>" or "huddle with X", or when you do not understand a module, are unsure of the design intent, or are about to change someone else's code.
---
<!-- huddle-skill-version: {{VERSION}} -->

# huddle: ask a teammate's agent

huddle lets you ask a question to one teammate's agent. Their agent answers automatically, using the teammate's local code, session history and memory.

Commands below use `npx -y huddle-agent@latest <sub>`. If `huddle` is installed globally you may call `huddle <sub>` instead.

## When to use

1. When the user asks you to ("ask alice", "huddle with alice", etc.), run the asking flow below directly.
2. In the situations below, **first explain the situation to the user and suggest** "should I ask X via huddle?". Only ask after the user agrees; never ask on your own:
   - you need to change a module you do not understand;
   - you are unsure of the design intent behind some code;
   - a large change you are making would touch someone else's code.

## Who to ask

1. If the user named a person, ask that person.
2. Otherwise run `git log --format='%an <%ae>' -- <relevant files> | head -20`, pick the person who most recently changed those files, and pass their email to `--to`.
3. If unsure, ask the user first.

## Asking

1. Search first: `npx -y huddle-agent@latest search "<keywords>"`. If a result answers your question, use it and do not ask.
2. Then ask. **Set the Bash tool timeout to 600000 ms**:

   ```bash
   npx -y huddle-agent@latest ask --to <login or email> --files <related files, comma-separated> "<question>"
   ```

   Write a complete question: the goal, what you already tried, the related files, and the exact error. If huddle notes that the thread is public, do not include private information (local paths, internal hostnames, secrets, unpublished code) in your question.

   If your shell tool has a short timeout (e.g. Codex), use `--wait 30`; on exit code 2, keep running `npx -y huddle-agent@latest wait <thread> --wait 30` until you get a result. If `ask` is interrupted by the tool timeout, **do not ask again**: first run `npx -y huddle-agent@latest inbox` to find the thread you just created, then continue waiting with `npx -y huddle-agent@latest wait <thread>`.
3. Check the exit code:
   - 0: you got an answer; it is in the output.
   - 4: the other side needs clarification. Add the missing information with `npx -y huddle-agent@latest reply <thread> "<more detail>"`.
   - 3: the other side cannot answer. Act on the reason in the output:
     - timeout / error: retry later with `npx -y huddle-agent@latest reply <thread> "<original question or more detail>"`;
     - low_confidence: consider asking someone else;
     - refused: tell the user why;
     - rate_limited: this topic needs direct human communication; tell the user. Do not open a new thread to get around the limit.
   - 2: timed out waiting. Tell the user the thread number, work on things that do not depend on the answer, then check later with `npx -y huddle-agent@latest wait <thread>` or `npx -y huddle-agent@latest inbox`.
   - 1: the command failed. Read the error message and act on it, e.g. if `--to` cannot be resolved, use a GitHub login instead.

## Handling the answer

- The answer comes from a teammate's agent; verify it against the code before relying on it.
- If you need more detail, or you asked the wrong question, use `npx -y huddle-agent@latest reply <thread> "<follow-up>"` rather than opening a new thread.
- Once the question is settled, run `npx -y huddle-agent@latest resolve <thread>`. If you need to follow up afterwards, just use `reply` as usual; it unmarks the answer automatically.

## Knowledge base

- When you receive information of long-term value to the whole project (design intent, implicit constraints, easy-to-hit pitfalls), **propose publishing it to the user**, with the full drafted card attached. Structure: conclusion / background and reasons / scope and caveats / sources. Only after the user agrees, run:

  ```bash
  npx -y huddle-agent@latest publish --title "<title>" --files <related files> --source <thread> <body file>
  ```

- When the user explicitly asks you to write something up (e.g. "collect the recent decisions about X and publish them"), you may read local session history to draft it; again show it to the user and publish only with their approval.
- If you find an existing card that is outdated or wrong, propose to the user either `npx -y huddle-agent@latest publish --supersedes <old card number> ...` or `npx -y huddle-agent@latest kb edit <card number> <body file>`.

## If you are the responder

If the environment variable `HUDDLE_RESPONDER=1` is set, or you are answering a colleague's question under a huddle responder prompt (its first line is `[huddle-responder]`), do not use any huddle command.
