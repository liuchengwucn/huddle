import { mkdir, rm, writeFile } from "node:fs/promises";
import { askMeta, lastAskerMessage, sameLogin } from "../core/conversation.js";
import { huddleHome, pausedFile } from "../core/paths.js";
import { HuddleError } from "../errors.js";
import { selectBackend, versionCheck } from "../responder/backends/index.js";
import { respondOnce, serve, type RespondDeps } from "../responder/respond.js";
import { killAllActive } from "../responder/runner.js";
import { assertNotResponder, assertVisibility, type Ctx } from "./context.js";

function makeDeps(c: Ctx): RespondDeps {
  const deps: RespondDeps = {
    transport: c.transport, me: c.me, repo: c.repo, machine: c.machine, backend: selectBackend(c.machine), cwd: c.root,
    publicThread: c.publicThreads,
    beforeRound: async () => {
      deps.publicThread = await assertVisibility(c.transport, c.repo, c.slug, true);
    },
  };
  return deps;
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

/** On a termination signal, kill the responder child process group and exit with 128+signo. */
function installSignalHandlers(): void {
  for (const [sig, no] of Object.entries(SIGNALS)) {
    process.on(sig as NodeJS.Signals, () => {
      killAllActive();
      process.exit(128 + no);
    });
  }
}

export async function respondCmd(c: Ctx): Promise<number> {
  assertNotResponder();
  installSignalHandlers();
  await respondOnce(makeDeps(c));
  return 0;
}

export async function serveCmd(c: Ctx): Promise<number> {
  assertNotResponder();
  const deps = makeDeps(c);
  const v = versionCheck(deps.backend);
  if (!v.ok) {
    throw new HuddleError(`Backend command ${deps.backend.command.join(" ")} is unavailable (${v.output.slice(0, 200)}); run huddle doctor.`);
  }
  installSignalHandlers();
  await serve(deps);
  return 0;
}

export async function pause(): Promise<number> {
  await mkdir(huddleHome(), { recursive: true });
  await writeFile(pausedFile(), new Date().toISOString());
  process.stdout.write(`Auto-responding paused (${pausedFile()}). Run huddle resume to resume.\n`);
  return 0;
}

export async function resume(): Promise<number> {
  await rm(pausedFile(), { force: true });
  process.stdout.write("Auto-responding resumed.\n");
  return 0;
}

export async function retract(c: Ctx, ref: string): Promise<number> {
  assertNotResponder();
  const { thread, message } = await c.transport.locateMessage(ref);
  if (message.id === thread.id) throw new HuddleError("Only comments can be retracted, not a whole thread.");
  if (!sameLogin(message.author, c.me)) throw new HuddleError("You can only retract replies you posted yourself.");
  const type = message.meta?.type;
  if (!askMeta(thread) || (type !== "answer" && type !== "clarify" && type !== "decline")) throw new HuddleError(`${ref} is not a huddle reply.`);
  const re = message.meta?.re;
  // Post the replacement decline first, then delete the original reply: if posting fails, the thread does not become eligible for re-answering.
  if ((type === "answer" || type === "clarify") && re && !thread.closed && lastAskerMessage(thread)?.id === re) {
    await c.transport.reply(thread, `@${c.me} retracted the earlier automatic reply. If needed, contact @${c.me} directly.`, {
      type: "decline",
      re,
      reason: "refused",
    });
  }
  await c.transport.deleteMessage(message.id);
  process.stdout.write(`Retracted ${message.url}\n`);
  if (type === "decline") process.stdout.write("Note: this thread will be answered automatically again on the next huddle serve / respond round.\n");
  return 0;
}
