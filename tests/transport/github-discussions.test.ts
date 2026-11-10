import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../../src/config.js";
import { GitHubClient } from "../../src/transport/github-client.js";
import { GitHubDiscussions } from "../../src/transport/github-discussions.js";

function stub(visibility = "PRIVATE", categories: { id: string; name: string }[] = []) {
  const calls: { kind: string; path?: string }[] = [];
  const gh = {
    graphql: vi.fn(async () => {
      calls.push({ kind: "graphql" });
      return { repository: { id: "R", visibility, hasDiscussionsEnabled: true, discussionCategories: { nodes: categories } } };
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
      author: { login: "x" }, category: { name: DEFAULT_REPO_CONFIG.categories.messages }, viewerCanUpdate: false,
      repository: { nameWithOwner: repo }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    const gh = { graphql: vi.fn(async () => ({ search: { nodes: [disc(1, "OWN/Threads"), disc(2, "evil/threads"), {}] } })), rest: vi.fn() };
    const d = new GitHubDiscussions(gh as unknown as GitHubClient, "own", "threads", DEFAULT_REPO_CONFIG, { owner: "own", repo: "code" });
    const res = await d.search("q", ["cards", "messages"], false);
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

  it("checks both categories in any format", async () => {
    expect(await stub("PRIVATE", [{ id: "1", name: "Q&A" }, { id: "2", name: "General" }]).d.checkSetup()).toEqual([]);
    const p = await stub("PRIVATE", [{ id: "2", name: "General" }]).d.checkSetup();
    expect(p).toHaveLength(1);
    expect(p[0]).toContain(`Missing Discussion category "Q&A"`);
    expect(p[0]).toContain("any format except Announcement");
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

describe("GitHubDiscussions nested replies", () => {
  const cm = (n: number, at: string, replies: unknown[] = []) => ({
    id: `C${n}`, url: `https://github.com/own/threads/discussions/1#discussioncomment-${n}`, body: `c${n}`, createdAt: at, author: { login: "x" }, replies: { nodes: replies },
  });
  const raw = {
    id: "D1", number: 1, url: "https://github.com/own/threads/discussions/1", title: "t", body: "b", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", closed: false,
    author: { login: "x" }, category: { name: DEFAULT_REPO_CONFIG.categories.messages }, viewerCanUpdate: false,
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [cm(2, "2026-01-01T00:01:00Z", [cm(3, "2026-01-01T00:02:00Z")]), cm(4, "2026-01-01T00:03:00Z")],
    },
  };
  const make = () => {
    const gh = { graphql: vi.fn(async () => ({ repository: { discussion: raw } })), rest: vi.fn() };
    return { gh, d: new GitHubDiscussions(gh as unknown as GitHubClient, "own", "threads", DEFAULT_REPO_CONFIG, { owner: "own", repo: "code" }) };
  };

  it("flattens replies in chronological order and requests them", async () => {
    const { gh, d } = make();
    const t = await d.getThread(1);
    expect(t.messages.map((m) => m.body)).toEqual(["b", "c2", "c3", "c4"]);
    expect(JSON.stringify(gh.graphql.mock.calls[0])).toContain("replies(first: 20)");
  });
});
