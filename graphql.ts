// The GraphQL v4 surface: a small parser and executor for the documents gh and github-mcp-server
// send — viewer, repository reads, the __type feature probes, issue and pull-request reads, the
// create/close/merge mutations, node(id:) and cursor pagination.

import { mergePull, pullFiles } from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface GraphQLReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------- ids

/** An opaque global id for a node, stable across reads. */
export function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** The kind and numeric id a global id names, or null when it is not one of ours. */
export function parseGlobalId(value: string): { kind: string; id: number } | null {
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):(\d+)$/.exec(text);
  if (match === null) return null;
  return { kind: match[1], id: Number(match[2]) };
}

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

/** Split a GraphQL document into its tokens. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@|&='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const next = source[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      let float = false;
      while (i < source.length && /[0-9.eE+-]/.test(source[i])) {
        if (source[i] === '.' || source[i] === 'e' || source[i] === 'E') float = true;
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: float ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[];
}

interface InlineFragment {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragment;

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface Operation {
  type: 'query' | 'mutation';
  name: string;
  variables: string[];
  selection: SelectionNode[];
}

/** A recursive-descent parser for the GraphQL subset the suite sends. */
class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private skipPunct(value: string): boolean {
    if (this.peek().kind === 'punct' && this.peek().value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  /** Parse one operation document. */
  parseDocument(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name = '';
    const variables: string[] = [];
    if (this.peek().kind === 'name' && (this.peek().value === 'query' || this.peek().value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          this.expect('$');
          variables.push(this.next().value);
          this.expect(':');
          this.parseType();
          if (this.peek().kind === 'punct' && this.peek().value === '=') {
            this.next();
            this.parseValue();
          }
        }
      }
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'eof') break;
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.next().value;
      return { kind: 'fragment', typeCondition: name, selection: [] };
    }
    let alias = '';
    let name = this.next().value;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.next().value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
    }
    const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias: alias === '' ? name : alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Record<string, ValueNode> = {};
      while (!this.skipPunct('}')) {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.value === 'true' || token.value === 'false') return { kind: 'bool', value: token.value === 'true' };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
}

// ---------------------------------------------------------------- values

/** The plain JavaScript value a parsed value node stands for. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- schema

/** The fields each introspected type reports, for gh's feature probes. */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'stateReason', 'closed', 'closedAt', 'createdAt', 'updatedAt', 'author', 'assignees', 'labels', 'milestone', 'comments', 'projectCards', 'reactionGroups', 'repository', 'url', 'isPinned', 'includesCreatedEdit'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'mergeStateStatus', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'reviews', 'reviewDecision', 'isDraft', 'author', 'labels', 'assignees', 'milestone', 'comments', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'issues', 'pullRequests', 'issue', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo', 'repositoryTopics', 'object', 'ref', 'refs'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'createdAt'],
  SearchType: [],
};

/** The enum values each introspected enum reports. */
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The GraphQL state name of an issue. */
function stateName(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The pull request's GraphQL state, which reports a merged pull as MERGED. */
function pullStateName(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return stateName(pull.state);
}

/** A cursor for the issue at `index` in a repository's list. */
function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

/** The index a cursor names, or 0 when it is not one of ours. */
function indexOfCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 0;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? 0 : Number(match[1]);
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string; path?: string[] }[];
}

/** The repository a global id names, or undefined. */
function repoById(store: Store, id: string): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return undefined;
  return [...store.repos.values()].find((repo) => repo.id === parsed.id);
}

/** The issue a global id names, with its repository. */
function issueById(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return undefined;
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((candidate) => candidate.id === parsed.id);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

/** The pull request a global id names, with its repository. */
function pullById(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return undefined;
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

/** The fields a selection asks for, flattened through inline fragments of a matching type. */
function fieldsOf(selection: SelectionNode[], typeName: string): FieldNode[] {
  const out: FieldNode[] = [];
  for (const node of selection) {
    if (node.kind === 'field') out.push(node);
    else if (node.typeCondition === typeName || node.typeCondition === 'Node') out.push(...fieldsOf(node.selection, typeName));
  }
  return out;
}

const UNKNOWN = Symbol('unknown');

/** Resolve one selection set against a value, reporting unknown fields as errors. */
function project(context: ExecContext, value: unknown, selection: SelectionNode[], typeName: string, path: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => project(context, item, selection, typeName, [...path, String(index)]));
  const out: Record<string, unknown> = {};
  for (const field of fieldsOf(selection, typeName)) {
    const resolved = resolveField(context, value, field, typeName, [...path, field.alias]);
    if (resolved === UNKNOWN) {
      context.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path: [...path, field.alias] });
      continue;
    }
    out[field.alias] = resolved;
  }
  return out;
}

/** Resolve one field of one object. */
function resolveField(context: ExecContext, parent: unknown, field: FieldNode, typeName: string, path: string[]): unknown {
  const { store, variables } = context;
  const arg = (name: string): unknown => {
    const node = field.args[name];
    return node === undefined ? undefined : valueOf(node, variables);
  };
  const sub = (value: unknown, childType: string): unknown => project(context, value, field.selection, childType, path);

  if (typeName === 'Query') {
    if (field.name === 'viewer') return sub({ login: store.viewer.login, id: globalId('User', store.viewer.id), name: store.viewer.name, email: store.viewer.email }, 'User');
    if (field.name === 'repository') {
      const owner = String(arg('owner') ?? '');
      const name = String(arg('name') ?? '');
      const repo = store.find(owner, name);
      if (repo === undefined || repo.owner.toLowerCase() !== store.viewer.login) return null;
      return sub(repo, 'Repository');
    }
    if (field.name === 'node') {
      const id = String(arg('id') ?? '');
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoById(store, id);
        return repo === undefined ? null : sub(repo, 'Repository');
      }
      if (parsed.kind === 'Issue') {
        const found = issueById(store, id);
        return found === undefined ? null : sub(found.issue, 'Issue');
      }
      if (parsed.kind === 'PullRequest') {
        const found = pullById(store, id);
        return found === undefined ? null : sub(found.pull, 'PullRequest');
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(arg('name') ?? '');
      const fields = TYPE_FIELDS[name];
      const enums = ENUM_VALUES[name];
      if (fields === undefined && enums === undefined) return null;
      return sub({ name, fields: (fields ?? []).map((fieldName) => ({ name: fieldName })), enumValues: (enums ?? []).map((enumName) => ({ name: enumName })) }, '__Type');
    }
    return UNKNOWN;
  }

  if (typeName === '__Type') {
    const value = parent as { name: string; fields: { name: string }[]; enumValues: { name: string }[] };
    if (field.name === 'name') return value.name;
    if (field.name === 'fields') return sub(value.fields, '__Field');
    if (field.name === 'enumValues') return sub(value.enumValues, '__EnumValue');
    if (field.name === 'kind') return 'OBJECT';
    return UNKNOWN;
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    const value = parent as { name: string };
    if (field.name === 'name') return value.name;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
    return UNKNOWN;
  }

  if (typeName === 'User') {
    const value = parent as { login: string; id?: string; name?: string; email?: string };
    if (field.name === 'login') return value.login;
    if (field.name === 'id') return value.id ?? globalId('User', store.viewer.id);
    if (field.name === 'name') return value.name ?? null;
    if (field.name === 'email') return value.email ?? null;
    if (field.name === 'url') return `https://github.com/${value.login}`;
    if (field.name === 'avatarUrl') return `https://avatars.githubusercontent.com/u/${store.viewer.id}?v=4`;
    return UNKNOWN;
  }

  if (typeName === 'Repository') {
    const repo = parent as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return sub({ login: repo.owner }, 'User');
      case 'description':
        return repo.description;
      case 'defaultBranchRef':
        return repo.refs.get(`refs/heads/${repo.defaultBranch}`) === undefined ? null : sub({ name: repo.defaultBranch }, 'Ref');
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'hasProjectsEnabled':
        return false;
      case 'hasWikiEnabled':
        return false;
      case 'isPrivate':
        return repo.private;
      case 'isFork':
        return false;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'pushedAt':
        return repo.pushedAt;
      case 'issue': {
        const number = Number(arg('number') ?? 0);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        return issue === undefined ? null : sub(issue, 'Issue');
      }
      case 'issues': {
        const first = Number(arg('first') ?? 10);
        const states = arg('states');
        const after = arg('after');
        const orderBy = arg('orderBy') as { field?: string; direction?: string } | undefined;
        let list = [...repo.issues];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = states.map((state) => String(state));
          list = list.filter((issue) => wanted.includes(stateName(issue.state)));
        }
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        const key = orderBy?.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
        list.sort((a, b) => {
          const av = (a as unknown as Record<string, string>)[key];
          const bv = (b as unknown as Record<string, string>)[key];
          if (av === bv) return (a.number - b.number) * direction;
          return (av < bv ? -1 : 1) * direction;
        });
        const start = indexOfCursor(after === null || after === undefined ? null : String(after));
        const page = list.slice(start, start + first);
        const end = start + page.length;
        return sub({ nodes: page, pageInfo: { hasNextPage: end < list.length, endCursor: page.length === 0 ? null : cursorFor(end) } }, 'IssueConnection');
      }
      case 'pullRequests': {
        const first = Number(arg('first') ?? 10);
        return sub({ nodes: repo.pulls.slice(0, first) }, 'PullRequestConnection');
      }
      case 'pullRequest': {
        const number = Number(arg('number') ?? 0);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        return pull === undefined ? null : sub(pull, 'PullRequest');
      }
      default:
        return UNKNOWN;
    }
  }

  if (typeName === 'Ref') {
    const value = parent as { name: string };
    if (field.name === 'name') return value.name;
    return UNKNOWN;
  }

  if (typeName === 'IssueConnection') {
    const value = parent as { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return sub(value.nodes, 'Issue');
    if (field.name === 'pageInfo') return sub(value.pageInfo, 'PageInfo');
    if (field.name === 'totalCount') return value.nodes.length;
    return UNKNOWN;
  }

  if (typeName === 'PullRequestConnection') {
    const value = parent as { nodes: Pull[] };
    if (field.name === 'nodes') return sub(value.nodes, 'PullRequest');
    if (field.name === 'totalCount') return value.nodes.length;
    return UNKNOWN;
  }

  if (typeName === 'PageInfo') {
    const value = parent as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return value.hasNextPage;
    if (field.name === 'endCursor') return value.endCursor;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
    return UNKNOWN;
  }

  if (typeName === 'Issue') {
    const issue = parent as Issue;
    switch (field.name) {
      case 'id':
        return globalId('Issue', issue.id);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return stateName(issue.state);
      case 'stateReason':
        return issue.state === 'closed' ? 'COMPLETED' : null;
      case 'closed':
        return issue.state === 'closed';
      case 'closedAt':
        return issue.closedAt;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://github.com/${store.viewer.login}/${store.viewer.login}/issues/${issue.number}`;
      case 'author':
        return sub({ login: issue.user.login }, 'User');
      case 'labels':
        return sub({ nodes: issue.labels.map((name) => ({ name })) }, 'LabelConnection');
      case 'comments':
        return sub({ nodes: issue.comments.map((comment) => ({ id: globalId('Comment', comment.id), body: comment.body })) }, 'CommentConnection');
      case 'assignees':
        return sub({ nodes: [] }, 'UserConnection');
      case 'milestone':
        return null;
      case 'isPinned':
        return false;
      case 'includesCreatedEdit':
        return false;
      default:
        return UNKNOWN;
    }
  }

  if (typeName === 'LabelConnection') {
    const value = parent as { nodes: { name: string }[] };
    if (field.name === 'nodes') return sub(value.nodes, 'Label');
    return UNKNOWN;
  }

  if (typeName === 'Label') {
    const value = parent as { name: string };
    if (field.name === 'name') return value.name;
    return UNKNOWN;
  }

  if (typeName === 'CommentConnection') {
    const value = parent as { nodes: { id: string; body: string }[] };
    if (field.name === 'nodes') return sub(value.nodes, 'Comment');
    return UNKNOWN;
  }

  if (typeName === 'Comment') {
    const value = parent as { id: string; body: string };
    if (field.name === 'id') return value.id;
    if (field.name === 'body') return value.body;
    return UNKNOWN;
  }

  if (typeName === 'UserConnection') {
    const value = parent as { nodes: unknown[] };
    if (field.name === 'nodes') return sub(value.nodes, 'User');
    return UNKNOWN;
  }

  if (typeName === 'PullRequest') {
    const pull = parent as Pull;
    const repo = [...store.repos.values()].find((candidate) => candidate.pulls.includes(pull));
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', pull.id);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullStateName(pull);
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeable':
        return repo === undefined || pull.merged ? 'UNKNOWN' : 'MERGEABLE';
      case 'mergeStateStatus':
        return pull.merged ? 'UNKNOWN' : 'CLEAN';
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'headRefOid':
        return repo?.refs.get(`refs/heads/${pull.head}`) ?? null;
      case 'baseRefOid':
        return repo?.refs.get(`refs/heads/${pull.base}`) ?? null;
      case 'isDraft':
        return false;
      case 'url':
        return `https://github.com/${repo?.owner ?? ''}/${repo?.name ?? ''}/pull/${pull.number}`;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'closedAt':
        return pull.state === 'closed' ? pull.updatedAt : null;
      case 'files': {
        const first = Number(arg('first') ?? 10);
        const files = repo === undefined ? [] : pullFiles(store, repo, pull).slice(0, first);
        return sub({ nodes: files.map((file) => ({ path: String((file as Record<string, unknown>).filename) })) }, 'PullRequestChangedFileConnection');
      }
      case 'author':
        return sub({ login: pull.user.login }, 'User');
      case 'labels':
        return sub({ nodes: [] }, 'LabelConnection');
      case 'assignees':
        return sub({ nodes: [] }, 'UserConnection');
      case 'comments':
        return sub({ nodes: [] }, 'CommentConnection');
      case 'commits':
        return sub({ nodes: [] }, 'PullRequestCommitConnection');
      case 'reviews':
        return sub({ nodes: [] }, 'PullRequestReviewConnection');
      case 'reviewDecision':
        return null;
      case 'milestone':
        return null;
      case 'mergeCommit':
        return pull.mergeCommitSha === null ? null : sub({ oid: pull.mergeCommitSha }, 'Commit');
      default:
        return UNKNOWN;
    }
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    const value = parent as { nodes: { path: string }[] };
    if (field.name === 'nodes') return sub(value.nodes, 'PullRequestChangedFile');
    return UNKNOWN;
  }

  if (typeName === 'PullRequestChangedFile') {
    const value = parent as { path: string };
    if (field.name === 'path') return value.path;
    return UNKNOWN;
  }

  if (typeName === 'Commit') {
    const value = parent as { oid: string };
    if (field.name === 'oid') return value.oid;
    return UNKNOWN;
  }

  // Mutation payloads and the comment edge: the field names the object it carries.
  if (typeName.endsWith('Payload') || typeName === 'CommentEdge') {
    const value = parent as Record<string, unknown>;
    if (field.name in value) {
      const child = value[field.name];
      const childType = field.name === 'issue' ? 'Issue' : field.name === 'pullRequest' ? 'PullRequest' : field.name === 'commentEdge' ? 'CommentEdge' : field.name === 'node' ? 'Comment' : typeName;
      return sub(child, childType);
    }
    return UNKNOWN;
  }

  return UNKNOWN;
}

/** Run one mutation field. */
function runMutation(context: ExecContext, field: FieldNode): unknown {
  const { store, variables } = context;
  const input = (valueOf(field.args.input ?? { kind: 'null' }, variables) ?? {}) as Record<string, unknown>;
  const sub = (value: unknown, typeName: string): unknown => project(context, value, field.selection, typeName, [field.alias]);

  if (field.name === 'createIssue') {
    const repo = repoById(store, String(input.repositoryId ?? ''));
    if (repo === undefined) return UNKNOWN;
    const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return sub({ issue }, 'CreateIssuePayload');
  }
  if (field.name === 'closeIssue') {
    const found = issueById(store, String(input.issueId ?? ''));
    if (found === undefined) return UNKNOWN;
    found.issue.state = 'closed';
    found.issue.closedAt = store.clock.now();
    found.issue.updatedAt = found.issue.closedAt;
    return sub({ issue: found.issue }, 'CloseIssuePayload');
  }
  if (field.name === 'createPullRequest') {
    const repo = repoById(store, String(input.repositoryId ?? ''));
    if (repo === undefined) return UNKNOWN;
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.defaultBranch);
    if (repo.refs.get(`refs/heads/${head}`) === undefined) return UNKNOWN;
    const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
    return sub({ pullRequest: pull }, 'CreatePullRequestPayload');
  }
  if (field.name === 'mergePullRequest') {
    const found = pullById(store, String(input.pullRequestId ?? ''));
    if (found === undefined) return UNKNOWN;
    mergePull(store, found.repo, found.pull);
    return sub({ pullRequest: found.pull }, 'MergePullRequestPayload');
  }
  if (field.name === 'addComment') {
    const found = issueById(store, String(input.subjectId ?? ''));
    if (found === undefined) return UNKNOWN;
    const comment = store.addComment(found.repo, found.issue, String(input.body ?? ''));
    return sub({ commentEdge: { node: { id: globalId('Comment', comment.id), body: comment.body } } }, 'AddCommentPayload');
  }
  return UNKNOWN;
}

/** Run one operation document against the store. */
function execute(store: Store, document: string, variables: Record<string, unknown>): { data: unknown; errors?: { message: string; path?: string[] }[] } {
  const operation = new Parser(document).parseDocument();
  const context: ExecContext = { store, variables, errors: [] };
  const root: Record<string, unknown> = {};
  for (const node of operation.selection) {
    if (node.kind !== 'field') continue;
    if (operation.type === 'mutation') {
      const result = runMutation(context, node);
      if (result === UNKNOWN) {
        context.errors.push({ message: `Field '${node.name}' doesn't exist on type 'Mutation'`, path: [node.alias] });
        continue;
      }
      root[node.alias] = result;
      continue;
    }
    const resolved = resolveField(context, null, node, 'Query', [node.alias]);
    if (resolved === UNKNOWN) {
      context.errors.push({ message: `Field '${node.name}' doesn't exist on type 'Query'`, path: [node.alias] });
      continue;
    }
    root[node.alias] = resolved;
  }
  return context.errors.length > 0 ? { data: root, errors: context.errors } : { data: root };
}

/** Answer one GraphQL request, including a batched array of documents. */
export function handleGraphQL(store: Store, body: unknown): GraphQLReply {
  const run = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'a GraphQL request needs a query' }] };
    const request = entry as { query?: unknown; variables?: unknown };
    if (typeof request.query !== 'string') return { data: null, errors: [{ message: 'a GraphQL request needs a query' }] };
    const variables = typeof request.variables === 'object' && request.variables !== null ? (request.variables as Record<string, unknown>) : {};
    try {
      return execute(store, request.query, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(run) };
  return { status: 200, body: run(body) };
}
