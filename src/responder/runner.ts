import { spawn, type ChildProcess } from "node:child_process";

export interface RunSpec {
  argv: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean; // truncated after stdout or stderr reached the cap
  durationMs: number;
  spawnError?: string;
}

const MAX_OUTPUT = 20 * 1024 * 1024;
const active = new Set<number>();

const killGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig);
  } catch {
    // the process group has already exited
  }
};

/** Called when serve receives Ctrl-C; kills the running responder process group. */
export function killAllActive(): void {
  for (const pid of active) killGroup(pid, "SIGKILL");
}

/** Runs in its own process group with the prompt on stdin; on timeout sends SIGTERM to the whole group, then SIGKILL after 5 seconds. */
export function runProcess(spec: RunSpec): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let pid: number | undefined;
    const finish = (r: { exitCode: number | null; spawnError?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (pid) active.delete(pid);
      resolve({ ...r, stdout, stderr, timedOut, truncated, durationMs: Date.now() - start });
    };
    let child: ChildProcess;
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HUDDLE_RESPONDER: "1",
        HUDDLE_RESPONDER_TIMEOUT_SECONDS: String(Math.ceil(spec.timeoutMs / 1000)),
      };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      finish({ exitCode: null, spawnError: (e as Error).message });
      return;
    }
    pid = child.pid;
    if (pid) active.add(pid);
    timer = setTimeout(() => {
      timedOut = true;
      if (pid) {
        killGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(pid!, "SIGKILL"), 5000);
        killTimer.unref();
      }
    }, spec.timeoutMs);
    const collect = (get: () => string, set: (s: string) => void) => (d: string) => {
      const cur = get();
      if (cur.length < MAX_OUTPUT) set(cur + d);
      else truncated = true;
    };
    child.stdout!.setEncoding("utf8").on("data", collect(() => stdout, (s) => (stdout = s)));
    child.stderr!.setEncoding("utf8").on("data", collect(() => stderr, (s) => (stderr = s)));
    child.on("error", (e) => finish({ exitCode: null, spawnError: e.message }));
    child.on("close", (code) => finish({ exitCode: code }));
    child.stdin!.on("error", () => {});
    child.stdin!.end(spec.stdin);
  });
}
