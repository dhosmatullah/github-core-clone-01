// graphql.ts — a small, dependency-free GraphQL executor for the forge's /api/graphql surface.
//
// It implements exactly the slice of GraphQL the suite (and gh / github-mcp-server) speaks:
// operations with variables, aliases, inline and named fragments, input objects, enum and list
// literals, batched operation arrays, the __type introspection probes, and the five mutations.
// Unknown fields are GraphQL errors on a 200, never HTTP errors — as GitHub answers them.

import {
  LOGIN,
  VIEWER,
  type Forge,
  type IssueRecord,
  type PullRecord,
  type Repo,
  createIssueRecord,
  createPullRecord,
  diffCommits,
  globalId,
  mergeBase,
  parseGlobalId,
  performMerge,
  refCommit,
  repoById,
  simulateMerge,
} from './gitcore.ts';

// ------------------------------------------------------------------------------------------------
// lexer
// ------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------------------------------------
// parser
// ------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        this.expectName(); // the type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return;
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return args;
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        if (this.skipPunct(']')) return { kind: 'list', values };
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        if (this.skipPunct('}')) return { kind: 'object', fields };
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      if (this.skipPunct('}')) return selections;
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value !== 'on') {
          selections.push({ kind: 'spread', name: this.expectName() });
          this.skipDirectives();
          continue;
        }
        let typeCondition: string | null = null;
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        this.skipDirectives();
        selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      let alias: string | null = null;
      let name = this.expectName();
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      let args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
      this.skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
  }
}

// ------------------------------------------------------------------------------------------------
// schema surface (introspection data)
// ------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closed', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'mergeCommit', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'messageHeadline', 'committedDate'],
  Label: ['id', 'name', 'color'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ------------------------------------------------------------------------------------------------
// executor
// ------------------------------------------------------------------------------------------------

/** A value tagged with the GraphQL type it is read through. */
interface TV {
  __type: string;
  value: unknown;
}
const tv = (type: string, value: unknown): TV => ({ __type: type, value });
const isTV = (value: unknown): value is TV =>
  typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of node.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

const encodeCursor = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface Connection {
  nodes: TV[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

function paginate(items: TV[], args: Record<string, unknown>): Connection {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = decodeCursor(args.after);
    if (index !== null) start = index + 1;
  }
  const page = items.slice(start, start + first);
  return {
    nodes: page,
    totalCount: items.length,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length ? encodeCursor(start + page.length - 1) : null,
  };
}

type Resolver = (source: TV, args: Record<string, unknown>, ctx: Ctx) => unknown;

const repoOf = (source: TV): Repo => source.value as Repo;
const issueOf = (source: TV): { repo: Repo; issue: IssueRecord } => source.value as { repo: Repo; issue: IssueRecord };
const pullOf = (source: TV): { repo: Repo; pull: PullRecord } => source.value as { repo: Repo; pull: PullRecord };

function issueConnection(repo: Repo, args: Record<string, unknown>): Connection {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states && states.length) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const ascending = orderBy?.direction === 'ASC';
  issues.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
  return paginate(issues.map((issue) => tv('Issue', { repo, issue })), args);
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Connection {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states && states.length) {
    pulls = pulls.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  }
  pulls.sort((a, b) => b.number - a.number);
  return paginate(pulls.map((pull) => tv('PullRequest', { repo, pull })), args);
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => tv('User', VIEWER),
    repository: (_s, args, ctx) => {
      if (args.owner !== LOGIN || typeof args.name !== 'string') return null;
      const repo = ctx.forge.repos.get(args.name);
      return repo ? tv('Repository', repo) : null;
    },
    node: (_s, args, ctx) => {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGlobalId(args.id);
      if (!parsed) return null;
      const repo = repoById(ctx.forge, parsed.repoId);
      if (!repo) return null;
      if (parsed.kind === 'Repository') return tv('Repository', repo);
      if (parsed.kind === 'Issue' && parsed.number !== undefined) {
        const issue = repo.issues.get(parsed.number);
        return issue ? tv('Issue', { repo, issue }) : null;
      }
      if (parsed.kind === 'PullRequest' && parsed.number !== undefined) {
        const pull = repo.pulls.get(parsed.number);
        return pull ? tv('PullRequest', { repo, pull }) : null;
      }
      return null;
    },
    __type: (_s, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name in TYPE_FIELDS || name in ENUM_VALUES) return tv('__Type', { name });
      if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) return tv('__Type', { name });
      return null;
    },
    __schema: () => tv('__Schema', {}),
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed ? repoById(ctx.forge, parsed.repoId) : undefined;
      if (!repo) throw new Error('createIssue: the repository id does not resolve');
      const issue = createIssueRecord(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return tv('CreateIssuePayload', { issue: tv('Issue', { repo, issue }) });
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed ? repoById(ctx.forge, parsed.repoId) : undefined;
      const issue = repo && parsed?.number !== undefined ? repo.issues.get(parsed.number) : undefined;
      if (!repo || !issue) throw new Error('closeIssue: the issue id does not resolve');
      issue.state = 'closed';
      return tv('CloseIssuePayload', { issue: tv('Issue', { repo, issue }) });
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed ? repoById(ctx.forge, parsed.repoId) : undefined;
      if (!repo) throw new Error('createPullRequest: the repository id does not resolve');
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (refCommit(repo, `refs/heads/${headRef}`) === null) throw new Error(`createPullRequest: head ref ${headRef} does not exist`);
      if (refCommit(repo, `refs/heads/${baseRef}`) === null) throw new Error(`createPullRequest: base ref ${baseRef} does not exist`);
      const pull = createPullRecord(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
      });
      return tv('CreatePullRequestPayload', { pullRequest: tv('PullRequest', { repo, pull }) });
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed ? repoById(ctx.forge, parsed.repoId) : undefined;
      const pull = repo && parsed?.number !== undefined ? repo.pulls.get(parsed.number) : undefined;
      if (!repo || !pull) throw new Error('mergePullRequest: the pull request id does not resolve');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const result = performMerge(ctx.forge, repo, pull, method === 'merge' ? 'merge' : method === 'rebase' ? 'rebase' : 'squash');
      if (result === 'conflict' || result === null) throw new Error('mergePullRequest: the pull request is not mergeable');
      return tv('MergePullRequestPayload', { pullRequest: tv('PullRequest', { repo, pull }) });
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed ? repoById(ctx.forge, parsed.repoId) : undefined;
      const issue = repo && parsed?.number !== undefined ? repo.issues.get(parsed.number) : undefined;
      if (!repo || !issue) throw new Error('addComment: the subject id does not resolve to an issue');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: repo.nextCommentId, body };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return tv('AddCommentPayload', {
        commentEdge: tv('IssueCommentEdge', {
          node: tv('IssueComment', { repo, issue, comment }),
          cursor: encodeCursor(issue.comments.length - 1),
        }),
      });
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    databaseId: () => VIEWER.id,
  },
  Repository: {
    id: (s) => globalId('Repository', repoOf(s).id),
    databaseId: (s) => repoOf(s).id,
    name: (s) => repoOf(s).name,
    nameWithOwner: (s) => `${LOGIN}/${repoOf(s).name}`,
    owner: () => tv('User', VIEWER),
    defaultBranchRef: (s) => tv('Ref', { name: repoOf(s).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (s) => repoOf(s).description,
    isPrivate: (s) => repoOf(s).isPrivate,
    createdAt: (s) => '2023-11-14T22:13:20Z',
    updatedAt: (s) => '2023-11-14T22:13:20Z',
    url: (s) => `/${LOGIN}/${repoOf(s).name}`,
    issue: (s, args) => {
      const repo = repoOf(s);
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? tv('Issue', { repo, issue }) : null;
    },
    issues: (s, args) => tv('IssueConnection', issueConnection(repoOf(s), args)),
    pullRequest: (s, args) => {
      const repo = repoOf(s);
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? tv('PullRequest', { repo, pull }) : null;
    },
    pullRequests: (s, args) => tv('PullRequestConnection', pullConnection(repoOf(s), args)),
  },
  Issue: {
    id: (s) => globalId('Issue', issueOf(s).repo.id, issueOf(s).issue.number),
    number: (s) => issueOf(s).issue.number,
    title: (s) => issueOf(s).issue.title,
    body: (s) => issueOf(s).issue.body,
    state: (s) => (issueOf(s).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (s) => issueOf(s).issue.state === 'closed',
    author: () => tv('User', VIEWER),
    repository: (s) => tv('Repository', issueOf(s).repo),
    labels: (s) =>
      tv('LabelConnection', {
        nodes: issueOf(s).issue.labels.map((name) => tv('Label', { name, color: issueOf(s).repo.labels.get(name)?.color ?? 'ededed' })),
        totalCount: issueOf(s).issue.labels.length,
        hasNextPage: false,
        endCursor: null,
      }),
    comments: (s, args) => {
      const { repo, issue } = issueOf(s);
      const nodes = issue.comments.map((comment) => tv('IssueComment', { repo, issue, comment }));
      return tv('IssueConnection', paginate(nodes, args));
    },
    createdAt: (s) => '2023-11-14T22:13:20Z',
    updatedAt: (s) => '2023-11-14T22:13:20Z',
    url: (s) => `/${LOGIN}/${issueOf(s).repo.name}/issues/${issueOf(s).issue.number}`,
  },
  PullRequest: {
    id: (s) => globalId('PullRequest', pullOf(s).repo.id, pullOf(s).pull.number),
    number: (s) => pullOf(s).pull.number,
    title: (s) => pullOf(s).pull.title,
    body: (s) => pullOf(s).pull.body,
    state: (s) => {
      const pull = pullOf(s).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (s) => pullOf(s).pull.merged,
    headRefName: (s) => pullOf(s).pull.headRef,
    baseRefName: (s) => pullOf(s).pull.baseRef,
    mergeable: (s, _args, ctx) => {
      const { repo, pull } = pullOf(s);
      if (pull.merged) return 'UNKNOWN';
      const sim = simulateMerge(repo, pull.headRef, pull.baseRef);
      if (sim === null) return 'UNKNOWN';
      return sim.outcome.files === null ? 'CONFLICTING' : 'MERGEABLE';
      void ctx;
    },
    files: (s, args) => {
      const { repo, pull } = pullOf(s);
      const headTip = refCommit(repo, `refs/heads/${pull.headRef}`);
      const baseTip = refCommit(repo, `refs/heads/${pull.baseRef}`);
      const base = headTip && baseTip ? mergeBase(repo, baseTip, headTip) : null;
      const changes = diffCommits(repo, base, headTip);
      const nodes = changes.map((change) =>
        tv('PullRequestChangedFile', { path: change.filename, additions: change.additions, deletions: change.deletions }),
      );
      return tv('PullRequestChangedFileConnection', paginate(nodes, args));
    },
    author: () => tv('User', VIEWER),
    mergeCommit: (s) => {
      const pull = pullOf(s).pull;
      return pull.mergeCommitSha ? tv('Commit', { oid: pull.mergeCommitSha }) : null;
    },
    createdAt: () => '2023-11-14T22:13:20Z',
    updatedAt: () => '2023-11-14T22:13:20Z',
    url: (s) => `/${LOGIN}/${pullOf(s).repo.name}/pull/${pullOf(s).pull.number}`,
  },
  Ref: {
    name: (s) => (s.value as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: () => null,
  },
  Commit: {
    id: (s) => globalId('Commit', 0),
    oid: (s) => (s.value as { oid: string }).oid,
    messageHeadline: () => '',
    committedDate: () => '2023-11-14T22:13:20Z',
  },
  Label: {
    id: (s) => globalId('Label', 0),
    name: (s) => (s.value as { name: string }).name,
    color: (s) => (s.value as { color: string }).color,
  },
  IssueComment: {
    id: (s) => {
      const { repo, issue, comment } = s.value as { repo: Repo; issue: IssueRecord; comment: { id: number; body: string } };
      return globalId('IssueComment', repo.id, issue.number, comment.id);
    },
    body: (s) => (s.value as { comment: { body: string } }).comment.body,
    author: () => tv('User', VIEWER),
    createdAt: () => '2023-11-14T22:13:20Z',
  },
  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  PullRequestChangedFileConnection: connectionResolvers(),
  LabelConnection: connectionResolvers(),
  PageInfo: {
    hasNextPage: (s) => (s.value as Connection).hasNextPage,
    hasPreviousPage: () => false,
    startCursor: (s) => (s.value as Connection).endCursor,
    endCursor: (s) => (s.value as Connection).endCursor,
  },
  PullRequestChangedFile: {
    path: (s) => (s.value as { path: string }).path,
    additions: (s) => (s.value as { additions: number }).additions,
    deletions: (s) => (s.value as { deletions: number }).deletions,
    changeType: () => 'ADDED',
  },
  CreateIssuePayload: { issue: (s) => (s.value as { issue: TV }).issue, clientMutationId: () => null },
  CloseIssuePayload: { issue: (s) => (s.value as { issue: TV }).issue, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (s) => (s.value as { pullRequest: TV }).pullRequest, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (s) => (s.value as { pullRequest: TV }).pullRequest, clientMutationId: () => null },
  AddCommentPayload: {
    commentEdge: (s) => (s.value as { commentEdge: TV }).commentEdge,
    subject: () => null,
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (s) => (s.value as { node: TV }).node,
    cursor: (s) => (s.value as { cursor: string }).cursor,
  },
  __Type: {
    name: (s) => (s.value as { name: string }).name,
    kind: (s) => {
      const name = (s.value as { name: string }).name;
      if (name in ENUM_VALUES) return 'ENUM';
      if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) return 'SCALAR';
      return 'OBJECT';
    },
    description: () => null,
    fields: (s) => {
      const name = (s.value as { name: string }).name;
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return fields.map((field) => tv('__Field', { name: field }));
    },
    enumValues: (s) => {
      const name = (s.value as { name: string }).name;
      const values = ENUM_VALUES[name];
      if (!values) return null;
      return values.map((value) => tv('__EnumValue', { name: value }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
  },
  __Field: {
    name: (s) => (s.value as { name: string }).name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (s) => (s.value as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => [],
    queryType: () => tv('__Type', { name: 'Query' }),
    mutationType: () => tv('__Type', { name: 'Mutation' }),
    subscriptionType: () => null,
  },
};

function connectionResolvers(): Record<string, Resolver> {
  return {
    nodes: (s) => (s.value as Connection).nodes,
    edges: (s) =>
      (s.value as Connection).nodes.map((node, index) => tv('IssueCommentEdge', { node, cursor: encodeCursor(index) })),
    pageInfo: (s) => tv('PageInfo', s.value as Connection),
    totalCount: (s) => (s.value as Connection).totalCount,
  };
}

/** The type a value of a union/interface position claims (only Repository occurs, via node()). */
function typeMatches(actual: string, condition: string | null): boolean {
  if (condition === null) return true;
  if (actual === condition) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'IssueComment'].includes(actual);
  return false;
}

function executeSelectionSet(source: TV | null, typeName: string, selections: SelectionNode[], ctx: Ctx): unknown {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  const visit = (set: SelectionNode[], currentType: string): void => {
    for (const selection of set) {
      if (selection.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment) visit(fragment, currentType);
        continue;
      }
      if (selection.kind === 'inline') {
        if (typeMatches(typeName, selection.typeCondition)) visit(selection.selectionSet, selection.typeCondition ?? currentType);
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const resolver = RESOLVERS[currentType]?.[selection.name] ?? RESOLVERS[typeName]?.[selection.name];
      if (!resolver) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${currentType}'` });
        out[key] = null;
        continue;
      }
      let resolved: unknown;
      try {
        resolved = resolver(source, argsOf(selection, ctx), ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(resolved, selection, ctx);
    }
  };
  visit(selections, typeName);
  return out;
}

function completeValue(resolved: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) return resolved.map((item) => completeValue(item, field, ctx));
  if (isTV(resolved)) {
    if (!field.selectionSet) return null;
    return executeSelectionSet(resolved, resolved.__type, field.selectionSet, ctx);
  }
  return resolved;
}

/** Execute one operation document (a {query, variables, operationName} body entry). */
export function executeGraphQL(
  forge: Forge,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = {
    forge,
    variables: (body.variables ?? {}) as Record<string, unknown>,
    fragments: new Map(),
    errors: [],
  };
  try {
    if (typeof body.query !== 'string') throw new Error('the request carries no query string');
    const document = new Parser(lex(body.query)).parseDocument();
    ctx.fragments = document.fragments;
    let operation: OperationNode | undefined;
    if (typeof body.operationName === 'string' && body.operationName !== '') {
      operation = document.operations.find((op) => op.name === body.operationName) ?? document.operations[0];
    } else {
      operation = document.operations[0];
    }
    if (!operation) throw new Error('the document carries no operation');
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(tv(rootType, null), rootType, operation.selectionSet, ctx);
    const envelope: { data: unknown; errors?: Array<{ message: string }> } = { data };
    if (ctx.errors.length) envelope.errors = ctx.errors;
    return envelope;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
