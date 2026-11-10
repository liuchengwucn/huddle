#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { HuddleError } from "../errors.js";
import { VERSION } from "../version.js";
import * as asker from "./asker.js";
import * as kb from "./kb.js";
import * as responder from "./responder.js";
import * as setup from "./setup.js";
import { assertNotResponder, createContext } from "./context.js";
import { preActionWarning } from "./skill-version.js";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const seconds = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError(`Invalid number of seconds: ${v}`);
  return n;
};

const program = new Command("huddle").version(VERSION).option("--repo <path>", "project repo path (default: current directory)");
export const ctx = () => createContext({ repo: program.opts().repo });

program.hook("preAction", (_this, actionCmd) => {
  const w = preActionWarning(actionCmd.name(), program.opts().repo);
  if (w) process.stderr.write(`${w}\n`);
});

export function handleError(e: unknown): void {
  if (e instanceof HuddleError) {
    process.stderr.write(`huddle: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else {
    const err = e as Error;
    process.stderr.write(`huddle: ${process.env.HUDDLE_DEBUG === "1" ? (err?.stack ?? String(e)) : (err?.message ?? String(e))}\n`);
    process.exitCode = 1;
  }
}

export function action<A extends unknown[]>(fn: (...args: A) => Promise<number | void>) {
  return async (...args: A) => {
    try {
      process.exitCode = (await fn(...args)) ?? 0;
    } catch (e) {
      handleError(e);
    }
  };
}

program
  .command("ask")
  .description("Ask a teammate's agent a question and wait for the reply (exit 0 answered / 2 timed out / 3 cannot answer / 4 clarification requested)")
  .requiredOption("--to <who>", "GitHub login or email")
  .option("--files <list>", "related files, comma-separated", list, [] as string[])
  .option("--wait <seconds>", "maximum seconds to wait", seconds, 540)
  .argument("<question>")
  .action(action(async (q: string, o: { to: string; files: string[]; wait: number }) => { assertNotResponder(); return asker.ask(await ctx(), q, o); }));

program
  .command("wait")
  .description("Keep waiting for a reply on an existing thread")
  .argument("<thread>")
  .option("--wait <seconds>", "maximum seconds to wait", seconds, 540)
  .action(action(async (ref: string, o: { wait: number }) => asker.waitCmd(await ctx(), ref, o)));

program
  .command("reply")
  .description("Follow up, add information or rephrase, and wait for the reply")
  .argument("<thread>")
  .argument("<text>")
  .option("--wait <seconds>", "maximum seconds to wait", seconds, 540)
  .action(action(async (ref: string, text: string, o: { wait: number }) => { assertNotResponder(); return asker.reply(await ctx(), ref, text, o); }));

program
  .command("resolve")
  .description("Mark the latest answer as the accepted answer")
  .argument("<thread>")
  .action(action(async (ref: string) => { assertNotResponder(); return asker.resolve(await ctx(), ref); }));

program
  .command("inbox")
  .description("Show questions I asked and questions addressed to me")
  .action(action(async () => asker.inbox(await ctx())));

program
  .command("respond")
  .description("Run one round: fetch questions addressed to me, answer each automatically, then exit")
  .action(action(async () => { assertNotResponder(); return responder.respondCmd(await ctx()); }));

program
  .command("serve")
  .description("Run in the foreground and answer automatically every 60 seconds")
  .action(action(async () => { assertNotResponder(); return responder.serveCmd(await ctx()); }));

program.command("pause").description("Pause automatic answering on this machine").action(action(() => responder.pause()));
program.command("resume").description("Resume automatic answering on this machine").action(action(() => responder.resume()));

program
  .command("retract")
  .description("Delete one of your own replies")
  .argument("<comment>", "comment URL or comment id")
  .action(action(async (ref: string) => { assertNotResponder(); return responder.retract(await ctx(), ref); }));

program
  .command("publish")
  .description("Publish a knowledge card (the agent must get the user's consent first)")
  .requiredOption("--title <title>", "card title")
  .option("--files <list>", "related files, comma-separated", list, [] as string[])
  .option("--source <thread>", "source thread")
  .option("--supersedes <card>", "old card being superseded")
  .option("--yes", "skip confirmation")
  .argument("<body>", "body file, or - to read from stdin")
  .action(action(async (src: string, o: { title: string; files: string[]; source?: string; supersedes?: string; yes?: boolean }) => { assertNotResponder(); return kb.publish(await ctx(), src, o); }));

const kbCmd = program.command("kb").description("Manage knowledge cards");
kbCmd
  .command("edit")
  .description("Revise a card body in place")
  .argument("<card>")
  .argument("<body>", "body file, or - to read from stdin")
  .action(action(async (ref: string, src: string) => kb.kbEdit(await ctx(), ref, src)));
kbCmd
  .command("rm")
  .description("Delete a card")
  .argument("<card>")
  .option("--yes", "skip confirmation")
  .action(action(async (ref: string, o: { yes?: boolean }) => kb.kbRm(await ctx(), ref, o)));

program
  .command("search")
  .description("Search knowledge cards and past Q&A")
  .argument("<query>")
  .action(action(async (q: string) => kb.search(await ctx(), q)));

program
  .command("init")
  .description("Install the skill, AGENTS.md block and repo config in this repo, and check the GitHub setup")
  .action(action(() => setup.init({ repo: program.opts().repo })));

program
  .command("doctor")
  .description("Check the environment and suggest fixes")
  .action(action(() => setup.doctor({ repo: program.opts().repo })));

export { program };

// later tasks register more commands before this point
program.parseAsync(process.argv).catch(handleError);
