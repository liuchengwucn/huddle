import type { RepoConfig } from "../config.js";
import { decodeBody, encodeBody } from "../core/meta.js";
import type { Category, Message, Meta, Thread, User } from "../core/types.js";
import { HuddleError } from "../errors.js";
import type { GitHubClient } from "./github-client.js";
import { assertRefRepo } from "./refs.js";
import type { Transport } from "./types.js";

const COMMENT_FIELDS = `id url body createdAt author { login }`;
const DISCUSSION_FIELDS = `
  id number url title body createdAt updatedAt closed
  author { login } category { name } answer { id }
  viewerCanUpdate viewerCanDelete
  repository { nameWithOwner }
  comments(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
`;

interface RawComment { id: string; url: string; body: string; createdAt: string; author: { login: string } | null }
interface RawDiscussion {
  id: string; number: number; url: string; title: string; body: string; createdAt: string; updatedAt: string; closed: boolean;
  author: { login: string } | null; category: { name: string }; answer: { id: string } | null;
  viewerCanUpdate: boolean; viewerCanDelete: boolean;
  repository?: { nameWithOwner: string };
  comments: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawComment[] };
}

const WRITE_ROLES = new Set(["admin", "maintain", "write"]);
const CLOSE_REASON = { resolved: "RESOLVED", outdated: "OUTDATED", duplicate: "DUPLICATE" } as const;

export class GitHubDiscussions implements Transport {
  private me: string | null = null;
  private repoInfo: { id: string; visibility: string; categories: { id: string; name: string; isAnswerable: boolean }[]; enabled: boolean } | null = null;
  private writeCache = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly gh: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly cfg: RepoConfig,
    private readonly commitsRepo: { owner: string; repo: string } = { owner, repo },
  ) {}

  private vars(extra: Record<string, unknown> = {}) {
    return { o: this.owner, r: this.repo, ...extra };
  }

  async whoami(): Promise<User> {
    if (!this.me) this.me = (await this.gh.graphql<{ viewer: { login: string } }>(`query { viewer { login } }`)).viewer.login;
    return { login: this.me };
  }

  private async info() {
    if (!this.repoInfo) {
      const d = await this.gh.graphql<{
        repository: { id: string; visibility: string; hasDiscussionsEnabled: boolean; discussionCategories: { nodes: { id: string; name: string; isAnswerable: boolean }[] } } | null;
      }>(
        `query($o: String!, $r: String!) { repository(owner: $o, name: $r) {
          id visibility hasDiscussionsEnabled discussionCategories(first: 50) { nodes { id name isAnswerable } } } }`,
        this.vars(),
      );
      if (!d?.repository) throw new HuddleError(`Repository ${this.owner}/${this.repo} not found, or you do not have access.`);
      this.repoInfo = { id: d.repository.id, visibility: d.repository.visibility, enabled: d.repository.hasDiscussionsEnabled, categories: d.repository.discussionCategories.nodes };
    }
    return this.repoInfo;
  }

  async isPrivate(fresh = false): Promise<boolean> {
    if (fresh) this.repoInfo = null;
    return (await this.info()).visibility === "PRIVATE";
  }

  async checkSetup(): Promise<string[]> {
    const info = await this.info();
    if (!info.enabled) return [
      `Discussions is not enabled on ${this.owner}/${this.repo}: run "npx -y huddle-agent@latest init" (it will enable it), or enable Discussions under Settings → General → Features.`,
    ];
    const problems: string[] = [];
    const ask = info.categories.find((c) => c.name === this.cfg.categories.ask);
    const kb = info.categories.find((c) => c.name === this.cfg.categories.kb);
    const url = `https://github.com/${this.owner}/${this.repo}/discussions/categories/new`;
    if (!ask) problems.push(`Missing Discussion category "${this.cfg.categories.ask}": open ${url}, set the name to ${this.cfg.categories.ask}, and pick the Question / Answer format.`);
    else if (!ask.isAnswerable) problems.push(`Category "${ask.name}" must use the Question / Answer format, otherwise answers cannot be marked.`);
    if (!kb) problems.push(`Missing Discussion category "${this.cfg.categories.kb}": open ${url}, set the name to ${this.cfg.categories.kb}, and pick the Open-ended discussion format.`);
    return problems;
  }

  private async categoryId(cat: Category): Promise<string> {
    const name = this.cfg.categories[cat];
    const c = (await this.info()).categories.find((x) => x.name === name);
    if (!c) throw new HuddleError(`Missing Discussion category "${name}"; run huddle doctor for the steps to create it.`);
    return c.id;
  }

  private categoryOf(name: string): Category | null {
    if (name === this.cfg.categories.ask) return "ask";
    if (name === this.cfg.categories.kb) return "kb";
    return null;
  }

  private toMessage(id: string, author: string | undefined, createdAt: string, rawBody: string, url: string): Message {
    const { meta, text } = decodeBody(rawBody);
    return { id, author: author ?? "ghost", createdAt: new Date(createdAt), body: text, meta, url };
  }

  private async toThread(d: RawDiscussion): Promise<Thread | null> {
    const category = this.categoryOf(d.category.name);
    if (!category) return null;
    const comments = [...d.comments.nodes];
    let page = d.comments.pageInfo;
    // Non-huddle threads (ordinary posts in Q&A / General) are not worth paging through.
    const huddle = decodeBody(d.body).meta !== null;
    while (huddle && page.hasNextPage) {
      const more = await this.gh.graphql<{ node: { comments: RawDiscussion["comments"] } }>(
        `query($id: ID!, $after: String) { node(id: $id) { ... on Discussion {
          comments(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } } } } }`,
        { id: d.id, after: page.endCursor },
      );
      if (!more.node?.comments) throw new HuddleError(`Failed to read comment pages of #${d.number}`);
      comments.push(...more.node.comments.nodes);
      page = more.node.comments.pageInfo;
    }
    return {
      id: d.id, number: d.number, url: d.url, title: d.title, category, author: d.author?.login ?? "ghost",
      closed: d.closed, answerId: d.answer?.id ?? null, updatedAt: new Date(d.updatedAt),
      viewerCanUpdate: d.viewerCanUpdate, viewerCanDelete: d.viewerCanDelete,
      messages: [
        this.toMessage(d.id, d.author?.login, d.createdAt, d.body, d.url),
        ...comments.map((c) => this.toMessage(c.id, c.author?.login, c.createdAt, c.body, c.url)),
      ],
    };
  }

  async getThread(number: number): Promise<Thread> {
    const d = await this.gh.graphql<{ repository: { discussion: RawDiscussion | null } }>(
      `query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { discussion(number: $n) { ${DISCUSSION_FIELDS} } } }`,
      this.vars({ n: number }),
    );
    const raw = d?.repository?.discussion;
    if (!raw) throw new HuddleError(`Thread #${number} not found`);
    const t = await this.toThread(raw);
    if (!t) throw new HuddleError(`#${number} is not in a huddle category`);
    return t;
  }

  async createThread(cat: Category, title: string, text: string, meta: Meta): Promise<Thread> {
    const d = await this.gh.graphql<{ createDiscussion: { discussion: { number: number } } }>(
      `mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
        createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { number } } }`,
      { repo: (await this.info()).id, cat: await this.categoryId(cat), title, body: encodeBody(meta, text) },
    );
    return this.getThread(d.createDiscussion.discussion.number);
  }

  async reply(thread: Thread, text: string, meta: Meta): Promise<Message> {
    const d = await this.gh.graphql<{ addDiscussionComment: { comment: RawComment } }>(
      `mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { ${COMMENT_FIELDS} } } }`,
      { id: thread.id, body: encodeBody(meta, text) },
    );
    const c = d.addDiscussionComment.comment;
    return this.toMessage(c.id, c.author?.login, c.createdAt, c.body, c.url);
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.gh.graphql(`mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }`, { id: messageId });
  }

  async locateMessage(ref: string): Promise<{ thread: Thread; message: Message }> {
    assertRefRepo(ref, `${this.owner}/${this.repo}`);
    const m = /\/discussions\/(\d+)#discussioncomment-(\d+)$/i.exec(ref.trim());
    if (!m && /\/discussions\//i.test(ref)) throw new HuddleError(`${ref} is not a comment URL (expected .../discussions/<n>#discussioncomment-<id>).`);
    let thread: Thread;
    if (m) {
      thread = await this.getThread(Number(m[1]));
      const msg = thread.messages.find((x) => x.url.endsWith(`#discussioncomment-${m[2]}`));
      if (!msg) throw new HuddleError(`Comment ${ref} not found`);
      return { thread, message: msg };
    }
    const d = await this.gh.graphql<{ node: { discussion?: { number: number } } | null }>(
      `query($id: ID!) { node(id: $id) { ... on DiscussionComment { discussion { number } } } }`,
      { id: ref },
    );
    if (!d.node?.discussion) throw new HuddleError(`Comment ${ref} not found`);
    thread = await this.getThread(d.node.discussion.number);
    const msg = thread.messages.find((x) => x.id === ref);
    if (!msg) throw new HuddleError(`Comment ${ref} not found`);
    return { thread, message: msg };
  }

  async listUpdatedThreads(cat: Category, since: Date): Promise<Thread[]> {
    const out: Thread[] = [];
    const catId = await this.categoryId(cat);
    let after: string | null = null;
    for (;;) {
      const d: { repository: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawDiscussion[] } } } =
        await this.gh.graphql(
          `query($o: String!, $r: String!, $cat: ID!, $after: String) { repository(owner: $o, name: $r) {
            discussions(first: 25, after: $after, categoryId: $cat, orderBy: { field: UPDATED_AT, direction: DESC }) {
              pageInfo { hasNextPage endCursor } nodes { ${DISCUSSION_FIELDS} } } } }`,
          this.vars({ cat: catId, after }),
        );
      const conn = d.repository.discussions;
      for (const raw of conn.nodes) {
        if (new Date(raw.updatedAt) < since) return out;
        const t = await this.toThread(raw);
        if (t) out.push(t);
      }
      if (!conn.pageInfo.hasNextPage) return out;
      after = conn.pageInfo.endCursor;
    }
  }

  async markResolved(_thread: Thread, messageId: string): Promise<void> {
    await this.gh.graphql(`mutation($id: ID!) { markDiscussionCommentAsAnswer(input: { id: $id }) { clientMutationId } }`, { id: messageId });
  }

  async unmarkResolved(thread: Thread): Promise<void> {
    if (!thread.answerId) return;
    await this.gh.graphql(`mutation($id: ID!) { unmarkDiscussionCommentAsAnswer(input: { id: $id }) { clientMutationId } }`, { id: thread.answerId });
  }

  async close(thread: Thread, reason: "resolved" | "outdated" | "duplicate"): Promise<void> {
    await this.gh.graphql(
      `mutation($id: ID!, $reason: DiscussionCloseReason!) { closeDiscussion(input: { discussionId: $id, reason: $reason }) { clientMutationId } }`,
      { id: thread.id, reason: CLOSE_REASON[reason] },
    );
  }

  async updateThread(thread: Thread, title: string, text: string, meta: Meta): Promise<void> {
    await this.gh.graphql(
      `mutation($id: ID!, $title: String!, $body: String!) { updateDiscussion(input: { discussionId: $id, title: $title, body: $body }) { clientMutationId } }`,
      { id: thread.id, title, body: encodeBody(meta, text) },
    );
  }

  async deleteThread(thread: Thread): Promise<void> {
    await this.gh.graphql(`mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }`, { id: thread.id });
  }

  async search(query: string, cats: Category[], includeClosed: boolean): Promise<Thread[]> {
    const d = await this.gh.graphql<{ search: { nodes: (RawDiscussion | Record<string, never>)[] } }>(
      `query($q: String!) { search(query: $q, type: DISCUSSION, first: 30) { nodes { ... on Discussion { ${DISCUSSION_FIELDS} } } } }`,
      { q: `repo:${this.owner}/${this.repo} ${query}` },
    );
    const out: Thread[] = [];
    for (const raw of d.search.nodes) {
      if (!("id" in raw)) continue;
      if ((raw as RawDiscussion).repository?.nameWithOwner?.toLowerCase() !== `${this.owner}/${this.repo}`.toLowerCase()) continue;
      const t = await this.toThread(raw as RawDiscussion);
      if (t && cats.includes(t.category) && (includeClosed || !t.closed)) out.push(t);
    }
    return out;
  }

  async hasWriteAccess(login: string): Promise<boolean> {
    const key = login.toLowerCase();
    const hit = this.writeCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok;
    const { status, json } = await this.gh.rest("GET", `/repos/${this.owner}/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    let ok: boolean;
    if (status === 200) {
      const j = json as { permission?: string; role_name?: string };
      ok = WRITE_ROLES.has(j.role_name ?? "") || j.permission === "admin" || j.permission === "write";
    } else if (status === 404) {
      ok = false;
    } else if (status === 403) {
      throw new HuddleError(`Cannot verify ${login}'s repository permission (GitHub returned 403): you may not have write access to the repo yourself.`);
    } else {
      throw new HuddleError(`Failed to query ${login}'s repository permission: HTTP ${status}`);
    }
    this.writeCache.set(key, { ok, at: Date.now() });
    return ok;
  }

  async resolveLogin(email: string): Promise<string | null> {
    const { status, json } = await this.gh.rest(
      "GET",
      `/repos/${this.commitsRepo.owner}/${this.commitsRepo.repo}/commits?author=${encodeURIComponent(email)}&per_page=1`,
    );
    if (status !== 200 || !Array.isArray(json)) return null;
    const first = json[0] as { author?: { login?: string } | null } | undefined;
    return first?.author?.login ?? null;
  }
}
