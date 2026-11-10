import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";

const fullwidth = (s: string) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");

describe("redact", () => {
  it("redacts common token formats", () => {
    const gh = `ghp_${"A".repeat(36)}`;
    const cases: [string, string][] = [
      [`token ${gh} end`, "github-token"],
      [`key sk-ant-${"b".repeat(30)} end`, "anthropic-key"],
      [`key sk-proj-${"c".repeat(30)} end`, "openai-key"],
      ["id AKIAABCDEFGHIJKLMNOP end", "aws-access-key"],
      [`github_pat_${"d".repeat(30)}`, "github-pat"],
    ];
    for (const [input, kind] of cases) {
      const r = redact(input);
      expect(r.text).toContain(`[REDACTED:${kind}]`);
      expect(r.hits[0].kind).toBe(kind);
    }
  });

  it("redacts only the secret part of URL passwords and env values", () => {
    expect(redact("db postgres://user:hunter22@db:5432/x").text).toBe("db postgres://user:[REDACTED:url-password]@db:5432/x");
    expect(redact("API_TOKEN=abcdef123456\nNAME=ok").text).toBe("API_TOKEN=[REDACTED:env-secret]\nNAME=ok");
  });

  it("redacts private keys", () => {
    const pk = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redact(`x\n${pk}\ny`).text).toBe("x\n[REDACTED:private-key]\ny");
  });

  it("sees through fullwidth characters and zero-width spaces", () => {
    const fw = fullwidth(`ghp_${"A".repeat(36)}`);
    expect(redact(`a ${fw} b`).text).toBe("a [REDACTED:github-token] b");
    const zw = `ghp_${"A".repeat(18)}\u200B${"A".repeat(18)}`;
    expect(redact(`a ${zw} b`).text).toBe("a [REDACTED:github-token] b");
  });

  it("decodes one layer of base64", () => {
    const b64 = Buffer.from("aws AKIAABCDEFGHIJKLMNOP").toString("base64");
    expect(redact(`blob ${b64} end`).text).toBe("blob [REDACTED:aws-access-key(base64)] end");
  });

  it("keeps normal Chinese text untouched", () => {
    const s = "说明：这里没有密钥，代码见 src/cache.ts:40。（全角括号）ｘ";
    expect(redact(s)).toEqual({ text: s, hits: [] });
  });

  it("redacts long tokens fully and maps offsets across surrogate pairs", () => {
    const gh = `ghp_${"A".repeat(36)}`;
    expect(redact(gh).text).toBe("[REDACTED:github-token]");
    const ant = `sk-ant-api03-${"x".repeat(40)}-_${"Y".repeat(10)}`;
    expect(redact(`k ${ant} e`).text).toBe("k [REDACTED:anthropic-key] e");
    expect(redact(`k sk-ant-${"z".repeat(300)} e`).text).toBe("k [REDACTED:anthropic-key] e");
    const r = redact(`😀 ${gh}`);
    expect(r.text).toBe("😀 [REDACTED:github-token]");
    expect(r.hits).toEqual([{ kind: "github-token", index: 3 }]);
  });

  it("runs in linear time on adversarial input", () => {
    const inputs = ["A".repeat(200_000), "KEY=".repeat(50_000), "ghp_".repeat(50_000), "a:".repeat(100_000) + "@"];
    for (const s of inputs) {
      const t0 = Date.now();
      redact(s);
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });
});

describe("redact env-secret numeric values", () => {
  it("keeps purely numeric values but still redacts real secrets", () => {
    expect(redact("TOKEN_TTL = 3600000").text).toBe("TOKEN_TTL = 3600000");
    expect(redact("API_KEY=abc123def456").text).toContain("[REDACTED:env-secret]");
  });
});
