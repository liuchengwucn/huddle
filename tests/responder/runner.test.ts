import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/responder/runner.js";

const node = process.execPath;

describe("runProcess", () => {
  it("passes stdin and sets HUDDLE_RESPONDER", async () => {
    const r = await runProcess({
      argv: [node, "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s+'|'+process.env.HUDDLE_RESPONDER))"],
      stdin: "hello 你好",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(r).toMatchObject({ exitCode: 0, stdout: "hello 你好|1", timedOut: false });
  });

  it("strips GitHub tokens from the child environment but keeps the rest", async () => {
    process.env.GH_TOKEN = "secret1";
    process.env.GITHUB_TOKEN = "secret2";
    process.env.HUDDLE_TEST_KEEP = "keep";
    try {
      const r = await runProcess({
        argv: [node, "-e", "const e=process.env;process.stdout.write([e.GH_TOKEN,e.GITHUB_TOKEN,e.HUDDLE_TEST_KEEP,e.HUDDLE_RESPONDER].join('|'))"],
        stdin: "",
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      expect(r.stdout).toBe("||keep|1");
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.HUDDLE_TEST_KEEP;
    }
  });

  it("exposes the timeout in seconds to the child", async () => {
    const r = await runProcess({
      argv: [node, "-e", "process.stdout.write(process.env.HUDDLE_RESPONDER_TIMEOUT_SECONDS)"],
      stdin: "",
      cwd: process.cwd(),
      timeoutMs: 90_500,
    });
    expect(r.stdout).toBe("91");
  });

  it("kills the whole process group on timeout", async () => {
    const script =
      "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
      "process.stdout.write(String(c.pid));setTimeout(()=>{},60000)";
    const r = await runProcess({ argv: [node, "-e", script], stdin: "", cwd: process.cwd(), timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toMatch(/^\d+$/);
    const alive = () => {
      try {
        process.kill(Number(r.stdout), 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });

  it("flags truncation as false for small output", async () => {
    const r = await runProcess({ argv: [node, "-e", "process.stdout.write('x')"], stdin: "", cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.truncated).toBe(false);
  });

  it("reports spawn errors", async () => {
    const r = await runProcess({ argv: ["/nonexistent/huddle-agent"], stdin: "", cwd: process.cwd(), timeoutMs: 1000 });
    expect(r.spawnError).toBeTruthy();
  });
});
