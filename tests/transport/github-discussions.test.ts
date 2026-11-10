import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../../src/config.js";
import { GitHubClient } from "../../src/transport/github-client.js";
import { GitHubDiscussions } from "../../src/transport/github-discussions.js";

function stub(visibility = "PRIVATE") {
  const calls: { kind: string; path?: string }[] = [];
  const gh = {
    graphql: vi.fn(async () => {
      calls.push({ kind: "graphql" });
      return { repository: { id: "R", visibility, hasDiscussionsEnabled: true, discussionCategories: { nodes: [] } } };
    }),
    rest: vi.fn(async (_m: string, path: string) => {
      calls.push({ kind: "rest", path });
      return { status: 200, json: path.includes("/commits") ? [{ author: { login: "zed" } }] : { permission: "write" } };
    }),
  };
  const d = new GitHubDiscussions(gh as unknown as GitHubClient, "own", "threads", DEFAULT_REPO_CONFIG, { owner: "own", repo: "code" });
  return { d, calls };
}

describe("GitHubDiscussions search", () => {
  it("drops results from other repositories", async () => {
    const disc = (n: number, repo: string) => ({
      id: `D${n}`, number: n, url: "u", title: "t", body: "b", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", closed: false,
      author: { login: "x" }, category: { name: DEFAULT_REPO_CONFIG.categories.ask }, answer: null, viewerCanUpdate: false, viewerCanDelete: false,
      repository: { nameWithOwner: repo }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    const gh = { graphql: vi.fn(async () => ({ search: { nodes: [disc(1, "OWN/Threads"), disc(2, "evil/threads"), {}] } })), rest: vi.fn() };
    const d = new GitHubDiscussions(gh as unknown as GitHubClient, "own", "threads", DEFAULT_REPO_CONFIG, { owner: "own", repo: "code" });
    const res = await d.search("q", ["kb", "ask"], false);
    expect(res.map((t) => t.number)).toEqual([1]);
    expect(JSON.stringify(gh.graphql.mock.calls[0])).toContain("nameWithOwner");
  });
});

describe("GitHubDiscussions", () => {
  it("resolves logins from the code repo but checks permissions on the transport repo", async () => {
    const { d, calls } = stub();
    expect(await d.resolveLogin("a@b.c")).toBe("zed");
    await d.hasWriteAccess("zed");
    expect(calls[0].path).toMatch(/^\/repos\/own\/code\/commits\?/);
    expect(calls[1].path).toMatch(/^\/repos\/own\/threads\/collaborators\/zed\/permission/);
  });

  it("caches visibility unless fresh is requested", async () => {
    const { d, calls } = stub();
    expect(await d.isPrivate()).toBe(true);
    await d.isPrivate();
    expect(calls.filter((c) => c.kind === "graphql")).toHaveLength(1);
    await d.isPrivate(true);
    expect(calls.filter((c) => c.kind === "graphql")).toHaveLength(2);
  });

  it("treats INTERNAL and PUBLIC as not private", async () => {
    expect(await stub("INTERNAL").d.isPrivate()).toBe(false);
    expect(await stub("PUBLIC").d.isPrivate()).toBe(false);
  });
});

describe("GitHubClient.rest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards the JSON body and does not retry a POST on 5xx", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubClient({ token: () => "t", sleep: async () => {} });
    await expect(client.rest("POST", "/x", { a: 1 })).rejects.toThrow(/failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"a":1}');
  });
});
