#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { HuddleError } from "../errors.js";
import { VERSION } from "../version.js";
import * as sender from "./send.js";
import * as kb from "./kb.js";
import * as responder from "./responder.js";
import * as setup from "./setup.js";
import { assertNotResponder, createContext } from "./context.js";
import { preActionWarning } from "./skill-version.js";

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

const EXIT_CODES = "exit 0 reply / 2 timed out / 3 declined";

program
  .command("send")
  .description(`Send a message to a teammate's agent (--to: new thread; <thread>: follow-up) and wait for the reply (${EXIT_CODES})`)
  .usage('[--to <who>] [--wait <seconds>] [thread] <message>')
  .option("--to <who>", "GitHub login or email; starts a new thread")
  .option("--wait <seconds>", "maximum seconds to wait (default: until a reply arrives)", seconds)
  .argument("<thread|message>", "with --to: the message; without: the thread to follow up")
  .argument("[message]", "the follow-up message (without --to)")
  .action(action(async (first: string, second: string | undefined, o: { to?: string; wait?: number }) => {
    assertNotResponder();
    const a = sender.parseSendArgs(first, second, o.to);
    const c = await ctx();
    return a.ref === undefined ? sender.send(c, a.message, { to: o.to!, wait: o.wait }) : sender.followUp(c, a.ref, a.message, o);
  }));

program
  .command("wait")
  .description(`Keep waiting for a reply; without a thread, uses the thread you most recently sent to (${EXIT_CODES})`)
  .argument("[thread]")
  .option("--wait <seconds>", "maximum seconds to wait (default: until a reply arrives)", seconds)
  .action(action(async (ref: string | undefined, o: { wait?: number }) => sender.waitCmd(await ctx(), ref, o)));

program
  .command("serve")
  .description("Run in the foreground and reply automatically to messages addressed to you, every 60 seconds")
  .option("--once", "run one round, then exit")
  .action(action(async (o: { once?: boolean }) => { assertNotResponder(); return responder.serveCmd(await ctx(), o); }));

program
  .command("publish")
  .description("Publish to the knowledge base, or replace an existing entry with --edit (the agent must get the user's consent first)")
  .requiredOption("--title <title>", "entry title")
  .option("--edit <entry>", "replace the title and body of an existing entry")
  .option("--yes", "skip confirmation")
  .argument("<body>", "body file, or - to read from stdin")
  .action(action(async (src: string, o: { title: string; edit?: string; yes?: boolean }) => { assertNotResponder(); return kb.publish(await ctx(), src, o); }));

program
  .command("search")
  .description("Search the knowledge base and past threads")
  .argument("<query>")
  .action(action(async (q: string) => kb.search(await ctx(), q)));

program
  .command("init")
  .description("Set up this repo (skill, AGENTS.md block, repo config, Discussions) and check the environment")
  .action(action(() => setup.init({ repo: program.opts().repo })));

export { program };

program.parseAsync(process.argv).catch(handleError);
