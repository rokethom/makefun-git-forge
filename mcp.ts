// The Model Context Protocol endpoint at /mcp: the handshake era (initialize, notifications/initialized,
// tools/list, tools/call) over the Streamable HTTP transport, with the six tools the agent arm needs.

import type { IncomingMessage } from 'node:http';
import { mergePull, pullJson, repoJson, issueJson } from './rest.ts';
import type { Repo, Store } from './store.ts';

export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** The revisions this server answers the handshake with. */
const SUPPORTED_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

/** A JSON-schema object with the given properties and required names. */
function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = { type: 'string' };

/** The repository a tool call names, or undefined. */
function repoOf(store: Store, args: Record<string, unknown>): Repo | undefined {
  const owner = String(args.owner ?? store.viewer.login);
  const name = String(args.repo ?? args.name ?? '');
  const repo = store.find(owner, name);
  if (repo === undefined || repo.owner.toLowerCase() !== store.viewer.login) return undefined;
  return repo;
}

/** The tools this server offers, in a fixed order so two listings are byte-identical. */
const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: schema({ name: STRING, description: STRING, private: { type: 'boolean' } }, ['name']),
    run: (store, args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new Error('name is required');
      const existing = store.find(store.viewer.login, name);
      if (existing !== undefined) return repoJson(existing);
      return repoJson(store.createRepo(name, { description: typeof args.description === 'string' ? args.description : null, private: args.private === true }));
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: schema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      return repoJson(repo);
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated user owns.',
    inputSchema: schema({}, []),
    run: (store) => store.owned().map(repoJson),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      const title = String(args.title ?? '');
      if (title === '') throw new Error('title is required');
      return issueJson(repo, store.createIssue(repo, title, String(args.body ?? ''), []));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: schema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      return repo.issues.filter((issue) => state === 'all' || issue.state === state).map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, head: STRING, base: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? repo.defaultBranch);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`the head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`the base branch ${base} does not exist`);
      const pull = store.createPull(repo, String(args.title ?? ''), String(args.body ?? ''), head, base);
      return pullJson(store, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request onto its base branch.',
    inputSchema: schema({ owner: STRING, repo: STRING, pull_number: { type: 'number' } }, ['owner', 'repo', 'pull_number']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      const number = Number(args.pull_number ?? 0);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) throw new Error(`pull request ${number} not found`);
      const sha = mergePull(store, repo, pull);
      if (sha === null) throw new Error('the pull request is not mergeable');
      return { sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    inputSchema: schema({ owner: STRING, repo: STRING, issue_number: { type: 'number' } }, ['owner', 'repo', 'issue_number']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.issue_number ?? 0));
      if (issue === undefined) throw new Error('issue not found');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: schema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === undefined) throw new Error('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      return repo.pulls.filter((pull) => state === 'all' || pull.state === state).map((pull) => pullJson(store, repo, pull));
    },
  },
];

/** The tool listing, built once so two answers are byte-identical. */
const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

/** A JSON-RPC success answer. */
function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value };
}

/** A JSON-RPC error answer. */
function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Answer one MCP request. */
export function handleMcp(store: Store, req: IncomingMessage, raw: Buffer): McpReply {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice('Bearer '.length).trim() === '') {
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } } };
  }

  let message: unknown;
  try {
    message = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof message !== 'object' || message === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    // This server speaks the handshake era: the client falls back to initialize, as the rules allow.
    return { status: 200, body: error(id, -32601, 'Method not found') };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_REVISIONS[0];
    const chosen = SUPPORTED_REVISIONS.includes(offered) ? offered : SUPPORTED_REVISIONS[0];
    return {
      status: 200,
      body: result(id, {
        protocolVersion: chosen,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'ping') return { status: 200, body: result(id, {}) };

  if (method === 'tools/list') return { status: 200, body: result(id, { tools: TOOL_LIST }) };

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return { status: 200, body: error(id, -32602, `Unknown tool: ${name}`) };
    const required = (tool.inputSchema.required as string[] | undefined) ?? [];
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return { status: 200, body: result(id, { content: [{ type: 'text', text: `missing required arguments: ${missing.join(', ')}` }], isError: true }) };
    }
    try {
      const value = tool.run(store, args);
      return { status: 200, body: result(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }) };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return { status: 200, body: result(id, { content: [{ type: 'text', text }], isError: true }) };
    }
  }

  return { status: 200, body: error(id, -32601, `Method not found: ${method}`) };
}
