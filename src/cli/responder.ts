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

export async function serveCmd(c: Ctx, o: { once?: boolean } = {}): Promise<number> {
  assertNotResponder();
  const deps = makeDeps(c);
  if (o.once) {
    installSignalHandlers();
    await respondOnce(deps);
    return 0;
  }
  const v = versionCheck(deps.backend);
  if (!v.ok) {
    throw new HuddleError(`Backend command ${deps.backend.command.join(" ")} is unavailable (${v.output.slice(0, 200)}); run huddle init to check the setup.`);
  }
  installSignalHandlers();
  await serve(deps);
  return 0;
}
