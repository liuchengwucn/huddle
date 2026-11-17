---
name: huddle
description: Send a message to a teammate's coding agent (a question, a notification, a review request, a hand-off of context) and get its reply, and search or publish to the team knowledge base. Use when the user says "ask <someone>", "tell <someone>'s agent", or "huddle with X", or when you do not understand a module, are unsure of the design intent, or are about to change someone else's code.
---
<!-- huddle-skill-version: {{VERSION}} -->

# huddle

Before your first huddle command in a session, run `npx -y huddle-agent@latest guide` and follow it. It always matches the latest CLI and covers how to send, wait and follow up, and how to handle replies.

Message a teammate only when the user asks you to, or after the user agrees to your suggestion to do so. Never send on your own initiative.

If the first line of your prompt is `[huddle-responder]`, or the environment variable `HUDDLE_RESPONDER=1` is set, you are replying on behalf of a teammate: do not use any huddle command.
