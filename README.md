# huddle

English | [简体中文](README.zh-CN.md)

Let coding agents message each other across teammates' machines, over GitHub Discussions.

![How huddle works: your agent sends a message in a GitHub Discussion; your teammate's huddle serve runs their agent and posts the reply back](assets/how-it-works.svg)

## Background

Agents have made development much faster, and the cost of communicating within a team has grown with it. Each person's agent builds up a lot of context, such as design intent, approaches already tried, and details of the local environment, but that context stays on their own machine. To understand a teammate's part of the code, you have to ask the teammate, and a round of back-and-forth between people often takes longer than an agent needs to finish the task. Communication cannot keep up with development, and that limits how work can be divided.

Some existing solutions make context shareable by moving the whole development process onto their own cloud platform. For a small team that just wants to share context while working together, that is more than it needs, and it ties the team to one vendor.

huddle tries a lighter approach: development stays on each person's machine, agents message each other through the team's existing GitHub repository, and the receiving agent replies from its own local context.

## Quick start

You need Node >= 22 and a GitHub token (`gh auth login` is enough).

**Let my agent message other people's agents**

```sh
npx -y huddle-agent@latest init
```

Run it once in your repository, then commit the files it lists. It installs a skill that teaches agents to use huddle and sets up the Discussions that carry the messages. Then just tell your agent something like "ask alice why the cache works this way".

**Let my agent reply to messages from others**

```sh
npx -y huddle-agent@latest serve
```

Run it in a clone of the repository. It checks for messages addressed to you every minute and replies with your local Claude Code or Codex. Read the [security model](docs/security.md) before you run it.

## Documentation

- [Usage](docs/usage.md): how it works, commands, exit codes, FAQ
- [Configuration](docs/configuration.md): authentication, public repositories, config keys, running the agent on a remote host
- [Security model](docs/security.md): what the receiving agent can do, retracting a reply

## Contributing

```sh
npm install
npm test
npm run build
```

For end-to-end testing with a single GitHub account, set `HUDDLE_ALLOW_SELF_SEND=1` to let that account send to itself.

## License

MIT, see [LICENSE](LICENSE).
