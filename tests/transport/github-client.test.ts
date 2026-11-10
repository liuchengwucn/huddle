import { afterEach, describe, expect, it, vi } from "vitest";
import { envToken, GitHubClient } from "../../src/transport/github-client.js";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup(responses: (Response | Error)[], token: () => string = () => "tok") {
  const fetchMock = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", fetchMock);
  const sleeps: number[] = [];
  const client = new GitHubClient({ token, sleep: async (ms) => void sleeps.push(ms) });
  return { client, fetchMock, sleeps };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHubClient", () => {
  it("retries 5xx for queries", async () => {
    const { client, fetchMock, sleeps } = setup([res(502), res(200, { data: { ok: 1 } })]);
    expect(await client.graphql("query { x }")).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it("does not retry 5xx for mutations", async () => {
    const { client, fetchMock } = setup([res(502), res(200, { data: {} })]);
    await expect(client.graphql("mutation { x }")).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry network errors for mutations", async () => {
    const { client, fetchMock } = setup([new Error("reset"), res(200, { data: {} })]);
    await expect(client.graphql("  mutation($a: ID!) { x }")).rejects.toThrow(/reset/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for rate limit reset then retries, even for mutations", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    const { client, sleeps } = setup([
      res(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
      res(200, { data: { ok: 1 } }),
    ]);
    expect(await client.graphql("mutation { x }")).toEqual({ ok: 1 });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(20_000);
    expect(sleeps[0]).toBeLessThanOrEqual(30_000);
  });

  it("does not produce a NaN wait for non-numeric Retry-After", async () => {
    const { client, sleeps } = setup([res(429, {}, { "retry-after": "soon" }), res(200, { data: 1 })]);
    await client.graphql("query { x }");
    expect(sleeps).toHaveLength(1);
    expect(Number.isFinite(sleeps[0])).toBe(true);
  });

  it("fails fast when the token cannot be obtained", async () => {
    const { client, fetchMock, sleeps } = setup([res(200, { data: 1 })], () => {
      throw new Error("no gh");
    });
    await expect(client.graphql("query { x }")).rejects.toThrow(/no gh/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("returns null data when all errors are NOT_FOUND", async () => {
    const { client } = setup([res(200, { data: { repository: { discussion: null } }, errors: [{ type: "NOT_FOUND", message: "nope" }] })]);
    expect(await client.graphql("query { x }")).toEqual({ repository: { discussion: null } });
  });

  it("throws on NOT_FOUND for mutations", async () => {
    const { client } = setup([res(200, { data: null, errors: [{ type: "NOT_FOUND", message: "gone" }] })]);
    await expect(client.graphql("mutation { x }")).rejects.toThrow(/gone/);
  });

  it("throws on other GraphQL errors", async () => {
    const { client } = setup([res(200, { data: null, errors: [{ type: "NOT_FOUND", message: "a" }, { message: "boom" }] })]);
    await expect(client.graphql("query { x }")).rejects.toThrow(/boom/);
  });
});

describe("envToken", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers GH_TOKEN over GITHUB_TOKEN", () => {
    vi.stubEnv("GH_TOKEN", " a ");
    vi.stubEnv("GITHUB_TOKEN", "b");
    expect(envToken()).toBe("a");
  });

  it("falls back to GITHUB_TOKEN, and ignores empty values", () => {
    vi.stubEnv("GH_TOKEN", "  ");
    vi.stubEnv("GITHUB_TOKEN", "b");
    expect(envToken()).toBe("b");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(envToken()).toBeUndefined();
  });
});
