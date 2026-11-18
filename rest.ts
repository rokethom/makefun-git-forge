// The REST v3 surface: repositories, branches, commits, contents, labels, issues and pull requests,
// in the shapes api.github.com answers. Every reply is JSON; the router adds the request id.

import { buildCommit, parseTree, parseCommit } from './gitobj.ts';
import type { Issue, Pull, Repo, Store, User } from './store.ts';

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** A body already rendered to JSON, so a hot read path need not stringify it again. */
  raw?: string;
  /** The byte length of `raw`, computed when it was rendered. */
  rawBytes?: number;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** A GitHub-shaped user object. */
function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
  };
}

/** A GitHub-shaped repository object. */
export function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson({ id: 1000, login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` }),
    html_url: `https://github.com/${full}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${full}`,
    forks_url: `/api/v3/repos/${full}/forks`,
    keys_url: `/api/v3/repos/${full}/keys{/key_id}`,
    collaborators_url: `/api/v3/repos/${full}/collaborators{/collaborator}`,
    branches_url: `/api/v3/repos/${full}/branches{/branch}`,
    tags_url: `/api/v3/repos/${full}/tags`,
    issues_url: `/api/v3/repos/${full}/issues{/number}`,
    pulls_url: `/api/v3/repos/${full}/pulls{/number}`,
    contents_url: `/api/v3/repos/${full}/contents/{+path}`,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
  };
}

/** A GitHub-shaped label object. */
function labelJson(name: string, index: number): Record<string, unknown> {
  return { id: 20000 + index, node_id: `LA_${20000 + index}`, name, color: 'ededed', default: false, description: null, url: `/api/v3/labels/${name}` };
}

/** A GitHub-shaped issue object. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    locked: false,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => labelJson(name, repo.labels.indexOf(name))),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://github.com/${full}/issues/${issue.number}`,
    url: `/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${full}`,
    comments_url: `/api/v3/repos/${full}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${full}/issues/${issue.number}/events`,
    labels_url: `/api/v3/repos/${full}/issues/${issue.number}/labels{/name}`,
  };
}

/** A GitHub-shaped comment object. */
function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; user: User; createdAt: string }): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${full}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${full}/issues/${issue.number}`,
    url: `/api/v3/repos/${full}/issues/comments/${comment.id}`,
  };
}

/** A GitHub-shaped pull-request object. */
export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    labels: [],
    draft: false,
    merged: pull.merged,
    mergeable: mergeable(store, repo, pull),
    mergeable_state: mergeable(store, repo, pull) ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha, user: userJson(pull.user), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha, user: userJson(pull.user), repo: repoJson(repo) },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' && !pull.merged ? pull.updatedAt : null,
    html_url: `https://github.com/${full}/pull/${pull.number}`,
    url: `/api/v3/repos/${full}/pulls/${pull.number}`,
    diff_url: `https://github.com/${full}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${full}/pull/${pull.number}.patch`,
    commits_url: `/api/v3/repos/${full}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${full}/pulls/${pull.number}/comments`,
    comments_url: `/api/v3/repos/${full}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${full}/statuses/${headSha}`,
  };
}

/** The merge base of two commits, or undefined when they share no history. */
function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestors = new Set<string>();
  const walk = (start: string, into: Set<string>): void => {
    const queue = [start];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (into.has(sha)) continue;
      into.add(sha);
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  };
  walk(a, ancestors);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestors.has(sha)) return sha;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return undefined;
}

/** The paths a commit changes against its first parent. */
function changedPaths(store: Store, repo: Repo, sha: string): Map<string, 'added' | 'modified' | 'removed'> {
  const out = new Map<string, 'added' | 'modified' | 'removed'>();
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return out;
  const info = parseCommit(object.data);
  const parent = info.parents[0];
  const before = parent === undefined ? new Map<string, string>() : store.files(repo, parent);
  const after = store.files(repo, sha);
  for (const [path, blob] of after) {
    if (!before.has(path)) out.set(path, 'added');
    else if (before.get(path) !== blob) out.set(path, 'modified');
  }
  for (const path of before.keys()) if (!after.has(path)) out.set(path, 'removed');
  return out;
}

/**
 * Squash-merge a pull request onto its base branch: one commit carrying the head's tree, parented on
 * the base tip. Answers the merge commit's id, or null when the pull cannot be merged.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull): string | null {
  if (pull.merged) return null;
  if (!mergeable(store, repo, pull)) return null;
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const headCommit = repo.objects.get(headSha);
  if (headCommit === undefined || headCommit.type !== 'commit') return null;
  const headInfo = parseCommit(headCommit.data);
  const identity = `${store.viewer.name} <${store.viewer.email}> ${Math.floor(Date.parse(store.clock.now()) / 1000)} +0000`;
  const data = buildCommit(headInfo.tree, [baseSha], identity, identity, `${pull.title} (#${pull.number})`);
  const mergeSha = store.put(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  repo.version += 1;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.clock.now();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  return mergeSha;
}

/** Whether a pull request can be merged without a conflict. */
export function mergeable(store: Store, repo: Repo, pull: Pull): boolean {
  if (pull.merged) return false;
  const head = repo.refs.get(`refs/heads/${pull.head}`);
  const base = repo.refs.get(`refs/heads/${pull.base}`);
  if (head === undefined || base === undefined) return false;
  if (head === base) return false;
  const common = mergeBase(repo, head, base);
  if (common === undefined) return false;
  if (common === base) return true;
  if (common === head) return true;
  const baseChanges = new Set<string>();
  const queue = [base];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha) || sha === common) continue;
    seen.add(sha);
    for (const path of changedPaths(store, repo, sha).keys()) baseChanges.add(path);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const headChanges = new Set<string>();
  const headQueue = [head];
  const headSeen = new Set<string>();
  while (headQueue.length > 0) {
    const sha = headQueue.shift() as string;
    if (headSeen.has(sha) || sha === common) continue;
    headSeen.add(sha);
    for (const path of changedPaths(store, repo, sha).keys()) headChanges.add(path);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) headQueue.push(parent);
  }
  for (const path of headChanges) if (baseChanges.has(path)) return false;
  return true;
}

/** The files a pull request changes, as GitHub's files endpoint lists them. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const head = repo.refs.get(`refs/heads/${pull.head}`);
  const base = repo.refs.get(`refs/heads/${pull.base}`);
  if (head === undefined || base === undefined) return [];
  const common = mergeBase(repo, head, base) ?? base;
  const before = store.files(repo, common);
  const after = store.files(repo, head);
  const out: Record<string, unknown>[] = [];
  const full = `${repo.owner}/${repo.name}`;
  for (const [path, blob] of after) {
    const previous = before.get(path);
    if (previous === blob) continue;
    const status = previous === undefined ? 'added' : 'modified';
    const additions = countLines(repo, blob);
    const deletions = previous === undefined ? 0 : countLines(repo, previous);
    out.push({
      sha: blob,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${full}/blob/${pull.head}/${path}`,
      raw_url: `https://github.com/${full}/raw/${pull.head}/${path}`,
      contents_url: `/api/v3/repos/${full}/contents/${path}?ref=${pull.head}`,
    });
  }
  for (const path of before.keys()) {
    if (after.has(path)) continue;
    const deletions = countLines(repo, before.get(path) as string);
    out.push({
      sha: before.get(path),
      filename: path,
      status: 'removed',
      additions: 0,
      deletions,
      changes: deletions,
      blob_url: `https://github.com/${full}/blob/${pull.base}/${path}`,
      raw_url: `https://github.com/${full}/raw/${pull.base}/${path}`,
      contents_url: `/api/v3/repos/${full}/contents/${path}?ref=${pull.base}`,
    });
  }
  return out;
}

/** The number of lines a blob holds. */
function countLines(repo: Repo, sha: string): number {
  const object = repo.objects.get(sha);
  if (object === undefined) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** A contents entry for a file. */
function fileJson(repo: Repo, path: string, sha: string, data: Buffer): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64').replace(/(.{60})/g, '$1\n'),
    sha,
    url: `/api/v3/repos/${full}/contents/${path}`,
    git_url: `/api/v3/repos/${full}/git/blobs/${sha}`,
    html_url: `https://github.com/${full}/blob/${repo.defaultBranch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${full}/${repo.defaultBranch}/${path}`,
    _links: { self: `/api/v3/repos/${full}/contents/${path}`, git: `/api/v3/repos/${full}/git/blobs/${sha}`, html: `https://github.com/${full}/blob/${repo.defaultBranch}/${path}` },
  };
}

/** A commit object as GitHub's REST surface answers it. */
function commitJson(repo: Repo, sha: string, info: ReturnType<typeof parseCommit>): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const identity = (raw: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(raw);
    if (match === null) return { name: raw, email: '', date: repo.createdAt };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z') };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    url: `/api/v3/repos/${full}/commits/${sha}`,
    html_url: `https://github.com/${full}/commit/${sha}`,
    comments_url: `/api/v3/repos/${full}/commits/${sha}/comments`,
    commit: {
      author: identity(info.author),
      committer: identity(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: `/api/v3/repos/${full}/git/trees/${info.tree}` },
      url: `/api/v3/repos/${full}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson({ id: 1000, login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` }),
    committer: userJson({ id: 1000, login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` }),
    parents: info.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${full}/commits/${parent}`, html_url: `https://github.com/${full}/commit/${parent}` })),
  };
}

/** A 404 in GitHub's shape. */
export function notFound(): Reply {
  return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };
}

/** A 422 in GitHub's shape. */
export function unprocessable(message: string): Reply {
  return { status: 422, body: { message, documentation_url: 'https://docs.github.com/rest' } };
}

/** A 400 in GitHub's shape. */
export function badRequest(message: string): Reply {
  return { status: 400, body: { message, documentation_url: 'https://docs.github.com/rest' } };
}

/** A 409 in GitHub's shape. */
export function conflict(message: string): Reply {
  return { status: 409, body: { message, documentation_url: 'https://docs.github.com/rest' } };
}

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  store: Store;
  /** The origin the request arrived on, for the absolute URLs GitHub puts in Link headers. */
  origin: string;
}

/** The issue a path segment names, compared as a number rather than as text. */
function issueOf(repo: Repo, segment: string): Issue | undefined {
  const number = Number(segment);
  if (!Number.isInteger(number)) return undefined;
  return repo.issues.find((candidate) => candidate.number === number);
}

/** The pull request a path segment names, compared as a number rather than as text. */
function pullOf(repo: Repo, segment: string): Pull | undefined {
  const number = Number(segment);
  if (!Number.isInteger(number)) return undefined;
  return repo.pulls.find((candidate) => candidate.number === number);
}

/** The repository a path names, or undefined when it is not the viewer's. */
function repoOf(store: Store, owner: string, name: string): Repo | undefined {
  const repo = store.find(owner, name);
  if (repo === undefined) return undefined;
  if (repo.owner !== store.viewer.login) return undefined;
  return repo;
}

/** Answer one REST v3 request, or null when the path is not a REST route. */
export function handleRest(request: RestRequest): Reply | null {
  const { method, path, query, body, store, origin } = request;
  const segments: string[] = [];
  let start = 1;
  for (let i = 1; i <= path.length; i += 1) {
    if (i === path.length || path.charCodeAt(i) === 47) {
      if (i > start) segments.push(path.slice(start, i));
      start = i + 1;
    }
  }
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

  if (rest.length === 0) {
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys{/key_id}',
        notifications_url: '/api/v3/notifications',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        team_url: '/api/v3/teams',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    return { status: 200, body: { verifiable_password_authentication: true, installed_version: '3.12.0', ssh_key_fingerprints: {}, hooks: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [], domains: { website: [], codespaces: [], copilot: [], packages: [] } } };
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    return { status: 200, body: { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } } };
  }

  if (rest[0] === 'user' && rest.length === 1) {
    return { status: 200, body: { ...userJson(store.viewer), name: store.viewer.name, email: store.viewer.email, public_repos: store.owned().length, total_private_repos: 0, owned_private_repos: 0, followers: 0, following: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } };
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.owned();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const links: string[] = [];
      if (page * perPage < all.length) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`);
      if (page > 1) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
      links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=1>; rel="first"`);
      if (links.length > 0) headers.link = links.join(', ');
      return { status: 200, body: slice.map(repoJson), headers };
    }
    if (method === 'POST') {
      const input = asObject(body);
      const name = asString(input.name);
      if (name === '') return unprocessable('Repository creation failed.');
      const existing = store.find(store.viewer.login, name);
      if (existing !== undefined) {
        // Creating a repository that is already there answers it, so a client that seeds a fixture
        // twice is not refused: the suite's git fixture creates its repository before every push.
        if (typeof input.description === 'string') existing.description = input.description;
        if (typeof input.private === 'boolean') existing.private = input.private;
        return { status: 200, body: repoJson(existing) };
      }
      const repo = store.createRepo(name, {
        description: typeof input.description === 'string' ? input.description : null,
        private: input.private === true,
        defaultBranch: asString(input.default_branch) || 'main',
      });
      return { status: 201, body: repoJson(repo), headers: { location: `/api/v3/repos/${repo.owner}/${repo.name}` } };
    }
    return null;
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const repo = repoOf(store, rest[1], rest[2]);
    if (repo === undefined) return notFound();
    const tail = rest.slice(3);
    const full = `${repo.owner}/${repo.name}`;

    if (tail.length === 0) {
      if (method === 'GET') {
        const rendered = store.render(`${repo.id}:${repo.version}:repo`, () => JSON.stringify(repoJson(repo)));
        return { status: 200, body: null, raw: rendered.text, rawBytes: rendered.bytes };
      }
      if (method === 'PATCH') {
        const input = asObject(body);
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.name === 'string' && input.name !== '') {
          store.deleteRepo(repo);
          repo.name = input.name;
          store.reindex(repo);
        }
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
        repo.updatedAt = store.clock.now();
        repo.version += 1;
        return { status: 200, body: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, body: null };
      }
      return null;
    }

    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      return {
        status: 200,
        body: store.branches(repo).map((name) => {
          const sha = repo.refs.get(`refs/heads/${name}`) as string;
          return { name, commit: { sha, url: `/api/v3/repos/${full}/commits/${sha}` }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } }, protection_url: `/api/v3/repos/${full}/branches/${name}/protection` };
        }),
      };
    }

    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (sha === undefined) return notFound();
      return { status: 200, body: { name: tail[1], commit: { sha, url: `/api/v3/repos/${full}/commits/${sha}` }, protected: false } };
    }

    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? query.get('ref') ?? repo.defaultBranch;
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      const list = store.history(repo, `refs/heads/${branch}`);
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      return { status: 200, body: list.slice(0, perPage).map((entry) => commitJson(repo, entry.sha, entry.info)) };
    }

    if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') {
      const object = repo.objects.get(tail[1]);
      if (object === undefined || object.type !== 'commit') return notFound();
      return { status: 200, body: commitJson(repo, tail[1], parseCommit(object.data)) };
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST') {
        const input = asObject(body);
        const ref = asString(input.ref);
        const sha = asString(input.sha);
        if (ref === '' || sha === '') return unprocessable('Reference update failed');
        if (!repo.objects.has(sha)) return unprocessable('Object does not exist');
        repo.refs.set(ref, sha);
        repo.version += 1;
        return { status: 201, body: { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${full}/git/refs/${ref.replace('refs/', '')}`, object: { sha, type: 'commit', url: `/api/v3/repos/${full}/git/commits/${sha}` } } };
      }
      if (method === 'GET') {
        return { status: 200, body: [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${full}/git/refs/${ref.replace('refs/', '')}`, object: { sha, type: 'commit', url: `/api/v3/repos/${full}/git/commits/${sha}` } })) };
      }
    }

    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length >= 4 && method === 'PATCH') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const input = asObject(body);
      const sha = asString(input.sha);
      if (!repo.objects.has(sha)) return unprocessable('Object does not exist');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return { status: 200, body: { ref, object: { sha, type: 'commit' } } };
    }

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      const ref = query.get('ref') ?? repo.defaultBranch;
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      if (method === 'GET') {
        if (path === '') {
          const tip = repo.refs.get(`refs/heads/${branch}`);
          if (tip === undefined) return notFound();
          const entries = store.rootTree(repo, tip);
          return {
            status: 200,
            body: entries.map((entry) => {
              const object = repo.objects.get(entry.sha);
              if (entry.mode === '40000') {
                return { type: 'dir', size: 0, name: entry.name, path: entry.name, sha: entry.sha, url: `/api/v3/repos/${full}/contents/${entry.name}?ref=${branch}`, git_url: `/api/v3/repos/${full}/git/trees/${entry.sha}`, html_url: `https://github.com/${full}/tree/${branch}/${entry.name}`, download_url: null, _links: { self: `/api/v3/repos/${full}/contents/${entry.name}?ref=${branch}`, git: `/api/v3/repos/${full}/git/trees/${entry.sha}`, html: `https://github.com/${full}/tree/${branch}/${entry.name}` } };
              }
              return fileJson(repo, entry.name, entry.sha, object?.data ?? Buffer.alloc(0));
            }),
          };
        }
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return notFound();
        const found = store.entryAt(repo, tip, path);
        if (found === undefined) return notFound();
        if (found.object.type === 'tree') {
          return { status: 200, body: dirJson(store, repo, found.entry.sha, path, branch, full) };
        }
        return { status: 200, body: fileJson(repo, path, found.entry.sha, found.object.data) };
      }
      if (method === 'PUT') {
        const input = asObject(body);
        const content = asString(input.content);
        const message = asString(input.message) || 'Create file';
        const targetBranch = asString(input.branch) || repo.defaultBranch;
        const existing = store.blobAt(repo, targetBranch, path);
        const givenSha = typeof input.sha === 'string' ? input.sha : null;
        if (existing !== undefined && givenSha === null) return unprocessable('Invalid request.\n\n"sha" wasn\'t supplied.');
        if (existing !== undefined && givenSha !== null && givenSha !== existing.sha) return conflict(`${path} does not match ${givenSha}`);
        if (existing === undefined && givenSha !== null) return conflict(`${path} does not match ${givenSha}`);
        const data = Buffer.from(content.replace(/\n/g, ''), 'base64');
        const blobSha = store.put(repo, 'blob', data);
        const commitSha = store.commitPaths(repo, targetBranch, new Map([[path, blobSha]]), [], message);
        return {
          status: existing === undefined ? 201 : 200,
          body: {
            content: fileJson(repo, path, blobSha, data),
            commit: commitJson(repo, commitSha, parseCommit(repo.objects.get(commitSha)?.data ?? Buffer.alloc(0))),
          },
        };
      }
      if (method === 'DELETE') {
        const input = asObject(body);
        const message = asString(input.message) || 'Delete file';
        const targetBranch = asString(input.branch) || repo.defaultBranch;
        const existing = store.blobAt(repo, targetBranch, path);
        if (existing === undefined) return notFound();
        const givenSha = typeof input.sha === 'string' ? input.sha : null;
        if (givenSha !== null && givenSha !== existing.sha) return conflict(`${path} does not match ${givenSha}`);
        const commitSha = store.commitPaths(repo, targetBranch, new Map(), [path], message);
        return { status: 200, body: { content: null, commit: commitJson(repo, commitSha, parseCommit(repo.objects.get(commitSha)?.data ?? Buffer.alloc(0))) } };
      }
    }

    if (tail[0] === 'labels') {
      if (method === 'POST') {
        const input = asObject(body);
        const name = asString(input.name);
        if (name === '') return unprocessable('Validation Failed');
        if (!repo.labels.includes(name)) {
          repo.labels.push(name);
          repo.version += 1;
        }
        return { status: 201, body: labelJson(name, repo.labels.indexOf(name)) };
      }
      if (method === 'GET') return { status: 200, body: repo.labels.map((name, index) => labelJson(name, index)) };
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        const input = asObject(body);
        const title = asString(input.title);
        if (title === '') return unprocessable('Validation Failed');
        const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [];
        for (const label of labels) if (!repo.labels.includes(label)) return unprocessable(`Validation Failed: {"resource":"Issue","field":"labels","code":"invalid"}`);
        const issue = store.createIssue(repo, title, asString(input.body), labels);
        return { status: 201, body: issueJson(repo, issue), headers: { location: `/api/v3/repos/${full}/issues/${issue.number}` } };
      }
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        list = [...list].sort((a, b) => {
          const key = sort === 'updated' ? 'updatedAt' : sort === 'comments' ? 'comments' : 'createdAt';
          const av = key === 'comments' ? a.comments.length : (a as unknown as Record<string, string>)[key];
          const bv = key === 'comments' ? b.comments.length : (b as unknown as Record<string, string>)[key];
          if (av === bv) return a.number - b.number;
          return av < bv ? -1 : 1;
        });
        if (direction === 'desc') list = list.reverse();
        const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
        return { status: 200, body: list.slice(0, perPage).map((issue) => issueJson(repo, issue)) };
      }
      if (tail.length === 2) {
        const issue = issueOf(repo, tail[1]);
        if (issue === undefined) return notFound();
        if (method === 'GET') {
          const rendered = store.render(`${repo.id}:${repo.version}:issue:${issue.number}`, () => JSON.stringify(issueJson(repo, issue)));
          return { status: 200, body: null, raw: rendered.text, rawBytes: rendered.bytes };
        }
        if (method === 'PATCH') {
          const input = asObject(body);
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'closed' && issue.state !== 'closed') {
            issue.state = 'closed';
            issue.closedAt = store.clock.now();
          } else if (input.state === 'open' && issue.state !== 'open') {
            issue.state = 'open';
            issue.closedAt = null;
          }
          if (Array.isArray(input.labels)) {
            const labels = input.labels.filter((label): label is string => typeof label === 'string');
            for (const label of labels) if (!repo.labels.includes(label)) return unprocessable('Validation Failed');
            issue.labels = labels;
          }
          issue.updatedAt = store.clock.now();
          repo.version += 1;
          return { status: 200, body: issueJson(repo, issue) };
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const issue = issueOf(repo, tail[1]);
        if (issue === undefined) return notFound();
        if (method === 'POST') {
          const input = asObject(body);
          const text = asString(input.body);
          if (text === '') return unprocessable('Validation Failed');
          const comment = store.addComment(repo, issue, text);
          return { status: 201, body: commentJson(repo, issue, comment) };
        }
        if (method === 'GET') return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
      }
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        const input = asObject(body);
        const title = asString(input.title);
        const head = asString(input.head).replace(`${repo.owner}:`, '');
        const base = asString(input.base) || repo.defaultBranch;
        if (title === '' || head === '') return unprocessable('Validation Failed');
        if (repo.refs.get(`refs/heads/${head}`) === undefined) return unprocessable(`Validation Failed: {"resource":"PullRequest","field":"head","code":"invalid"}`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return unprocessable(`Validation Failed: {"resource":"PullRequest","field":"base","code":"invalid"}`);
        const pull = store.createPull(repo, title, asString(input.body), head, base);
        return { status: 201, body: pullJson(store, repo, pull), headers: { location: `/api/v3/repos/${full}/pulls/${pull.number}` } };
      }
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const list = repo.pulls.filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
        return { status: 200, body: list.map((pull) => pullJson(store, repo, pull)) };
      }
      if (tail.length === 2) {
        const pull = pullOf(repo, tail[1]);
        if (pull === undefined) return notFound();
        if (method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
        if (method === 'PATCH') {
          const input = asObject(body);
          if (typeof input.title === 'string') pull.title = input.title;
          if (typeof input.body === 'string') pull.body = input.body;
          if (input.state === 'closed') {
            pull.state = 'closed';
            pull.updatedAt = store.clock.now();
          }
          repo.version += 1;
          return { status: 200, body: pullJson(store, repo, pull) };
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const pull = pullOf(repo, tail[1]);
        if (pull === undefined) return notFound();
        return { status: 200, body: pullFiles(store, repo, pull) };
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const pull = pullOf(repo, tail[1]);
        if (pull === undefined) return notFound();
        const merged = mergePull(store, repo, pull);
        if (merged === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
        return { status: 200, body: { sha: merged, merged: true, message: 'Pull Request successfully merged' } };
      }
    }
  }

  return null;
}

/** The entries of a directory tree, as the contents API lists them. */
function dirJson(store: Store, repo: Repo, treeSha: string, prefix: string, branch: string, full: string): Record<string, unknown>[] {
  const tree = repo.objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of parseTree(tree.data)) {
    const path = `${prefix}/${entry.name}`;
    const object = repo.objects.get(entry.sha);
    if (entry.mode === '40000') {
      out.push({
        type: 'dir',
        size: 0,
        name: entry.name,
        path,
        sha: entry.sha,
        url: `/api/v3/repos/${full}/contents/${path}?ref=${branch}`,
        git_url: `/api/v3/repos/${full}/git/trees/${entry.sha}`,
        html_url: `https://github.com/${full}/tree/${branch}/${path}`,
        download_url: null,
        _links: { self: `/api/v3/repos/${full}/contents/${path}?ref=${branch}`, git: `/api/v3/repos/${full}/git/trees/${entry.sha}`, html: `https://github.com/${full}/tree/${branch}/${path}` },
      });
    } else {
      out.push(fileJson(repo, path, entry.sha, object?.data ?? Buffer.alloc(0)));
    }
  }
  return out;
}

export { JSON_TYPE };