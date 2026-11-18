// The forge's own store: users, repositories, their git objects and refs, and the issue and
// pull-request records the REST, GraphQL and MCP surfaces all read. Everything lives in memory and
// every value is derived from a counter, never from the wall clock, so two runs of the same requests
// leave the same state.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, type GitObject, type ObjType, type TreeEntry } from './gitobj.ts';

/** The login the trial's token names: the seeded scenario's viewer, the same in every trial. */
export const VIEWER_LOGIN = 'adaiversen';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  user: User;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: string[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

/** A deterministic clock: a fixed epoch advanced one second per event. */
class Clock {
  private tick = 0;
  private readonly base = Date.UTC(2026, 0, 1, 0, 0, 0);

  now(): string {
    const value = new Date(this.base + this.tick * 1000).toISOString();
    this.tick += 1;
    return value.replace('.000Z', 'Z');
  }
}

export class Store {
  readonly clock = new Clock();
  readonly viewer: User = { id: 1000, login: VIEWER_LOGIN, name: 'ada iversen', email: 'adaiversen@example.invalid' };
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 90000;
  private nextPullId = 80000;
  private nextCommentId = 70000;

  /** The key a repository is stored under: its owner and name, compared without regard to case. */
  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  find(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  /** The repositories the viewer owns, in creation order. */
  owned(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === this.viewer.login);
  }

  createRepo(name: string, options: { description?: string | null; private?: boolean; defaultBranch?: string } = {}): Repo {
    const now = this.clock.now();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewer.login,
      name,
      description: options.description ?? null,
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(Store.key(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Store.key(repo.owner, repo.name));
  }

  /** Store an object and answer its id. */
  put(repo: Repo, type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  /** The object a ref points at, or undefined. */
  objectAt(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  /** The commit a ref names, or undefined when the ref is missing or not a commit. */
  commitOf(repo: Repo, ref: string): { sha: string; info: ReturnType<typeof parseCommit> } | undefined {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return undefined;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return undefined;
    return { sha, info: parseCommit(object.data) };
  }

  /** Every commit reachable from a ref, newest first, with its id. */
  history(repo: Repo, ref: string): { sha: string; info: ReturnType<typeof parseCommit> }[] {
    const out: { sha: string; info: ReturnType<typeof parseCommit> }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [];
    const tip = repo.refs.get(ref);
    if (tip !== undefined) queue.push(tip);
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      const info = parseCommit(object.data);
      out.push({ sha, info });
      for (const parent of info.parents) queue.push(parent);
    }
    return out;
  }

  /** The tree entries of a commit's root tree. */
  rootTree(repo: Repo, commitSha: string): TreeEntry[] {
    const commit = repo.objects.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return [];
    const info = parseCommit(commit.data);
    const tree = repo.objects.get(info.tree);
    if (tree === undefined || tree.type !== 'tree') return [];
    return parseTree(tree.data);
  }

  /** Resolve a path inside a commit to its entry, walking trees. */
  entryAt(repo: Repo, commitSha: string, path: string): { entry: TreeEntry; object: GitObject } | undefined {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) return undefined;
    const commit = repo.objects.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    let treeSha = parseCommit(commit.data).tree;
    for (let index = 0; index < parts.length; index += 1) {
      const tree = repo.objects.get(treeSha);
      if (tree === undefined || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[index]);
      if (entry === undefined) return undefined;
      const object = repo.objects.get(entry.sha);
      if (object === undefined) return undefined;
      if (index === parts.length - 1) return { entry, object };
      if (entry.mode !== '40000') return undefined;
      treeSha = entry.sha;
    }
    return undefined;
  }

  /** Every file in a commit, as path -> blob id. */
  files(repo: Repo, commitSha: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (treeSha: string, prefix: string): void => {
      const tree = repo.objects.get(treeSha);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, entry.sha);
      }
    };
    const commit = repo.objects.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return out;
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Write a file into a commit's tree, answering the new tree id. */
  writePath(repo: Repo, treeSha: string, parts: readonly string[], blobSha: string): string {
    const tree = repo.objects.get(treeSha);
    const entries = tree === undefined ? [] : parseTree(tree.data);
    const [head, ...rest] = parts;
    const existing = entries.find((entry) => entry.name === head);
    let replacement: TreeEntry;
    if (rest.length === 0) {
      replacement = { mode: '100644', name: head, sha: blobSha };
    } else {
      const childSha = existing !== undefined && existing.mode === '40000' ? existing.sha : this.put(repo, 'tree', Buffer.alloc(0));
      replacement = { mode: '40000', name: head, sha: this.writePath(repo, childSha, rest, blobSha) };
    }
    const next = entries.filter((entry) => entry.name !== head);
    next.push(replacement);
    return this.put(repo, 'tree', buildTree(next));
  }

  /** Remove a path from a commit's tree, answering the new tree id. */
  removePath(repo: Repo, treeSha: string, parts: readonly string[]): string {
    const tree = repo.objects.get(treeSha);
    const entries = tree === undefined ? [] : parseTree(tree.data);
    const [head, ...rest] = parts;
    if (rest.length === 0) {
      return this.put(repo, 'tree', buildTree(entries.filter((entry) => entry.name !== head)));
    }
    const existing = entries.find((entry) => entry.name === head);
    if (existing === undefined || existing.mode !== '40000') return treeSha;
    const childSha = this.removePath(repo, existing.sha, rest);
    const next = entries.filter((entry) => entry.name !== head);
    next.push({ mode: '40000', name: head, sha: childSha });
    return this.put(repo, 'tree', buildTree(next));
  }

  /** Commit a set of path writes and removals on top of a branch, answering the new commit id. */
  commitPaths(repo: Repo, branch: string, writes: ReadonlyMap<string, string>, removals: readonly string[], message: string): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    let treeSha: string;
    if (parent === undefined) {
      treeSha = this.put(repo, 'tree', Buffer.alloc(0));
    } else {
      const commit = repo.objects.get(parent);
      treeSha = commit === undefined ? this.put(repo, 'tree', Buffer.alloc(0)) : parseCommit(commit.data).tree;
    }
    for (const [path, blobSha] of writes) treeSha = this.writePath(repo, treeSha, path.split('/'), blobSha);
    for (const path of removals) treeSha = this.removePath(repo, treeSha, path.split('/'));
    const identity = `${this.viewer.name} <${this.viewer.email}> ${Math.floor(Date.parse(this.clock.now()) / 1000)} +0000`;
    const data = buildCommit(treeSha, parent === undefined ? [] : [parent], identity, identity, message);
    const sha = this.put(repo, 'commit', data);
    repo.refs.set(ref, sha);
    repo.pushedAt = this.clock.now();
    repo.updatedAt = repo.pushedAt;
    return sha;
  }

  /** The blob id of a path at a branch's tip, or undefined. */
  blobAt(repo: Repo, branch: string, path: string): { sha: string; data: Buffer } | undefined {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return undefined;
    const found = this.entryAt(repo, tip, path);
    if (found === undefined || found.object.type !== 'blob') return undefined;
    return { sha: found.entry.sha, data: found.object.data };
  }

  /** The branches a repository holds, sorted by name. */
  branches(repo: Repo): string[] {
    return [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
  }

  /** The tags a repository holds, sorted by name. */
  tags(repo: Repo): string[] {
    return [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/tags/'))
      .map((ref) => ref.slice('refs/tags/'.length))
      .sort();
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    const now = this.clock.now();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const now = this.clock.now();
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPull++,
      title,
      body,
      state: 'open',
      head,
      base,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, user: this.viewer, createdAt: this.clock.now() };
    issue.comments.push(comment);
    return comment;
  }
}
