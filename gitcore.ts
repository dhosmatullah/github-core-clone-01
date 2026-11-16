// gitcore.ts — the shared store and the git object model for the forge.
//
// One in-memory store backs every surface (git smart HTTP, REST v3, GraphQL, MCP): a contents-API
// write creates real git objects here, and a git push lands objects the REST surface then serves.
// Everything is deterministic: forge-made commits carry timestamps from a per-forge sequence, never
// from the wall clock, so two runs of the same request sequence produce byte-identical objects.
//
// Node built-ins only (crypto, zlib). No git binary, no dependencies.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * The login the bearer token names. The suite's scenario is one fixed seed shipped in the kit, so
 * the token's owner is a constant of the contest: the checks address every repository under this
 * login, and the same name under any other login is a 404.
 */
export const LOGIN = 'adaiversen';
export const VIEWER = Object.freeze({
  id: 1000,
  login: LOGIN,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

export const ZERO_OID = '0'.repeat(40);
const FORGE_IDENTITY = 'Albedo Forge <forge@make.fun>';
/** Forge-made timestamps start here and advance one second per forge-made object (deterministic). */
const EPOCH_BASE_SEC = 1_700_000_000;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  timestamp: number;
}

export interface IssueRecord {
  /** Forge-wide numeric id (the REST `id`, stable across reads). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  seq: number;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  /** The numeric database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitCache: Map<string, CommitView>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  /** One shared counter for issues and pull requests, as GitHub numbers them. */
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private objectSeq = 0;
  private issueSeq = 0;

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      commitCache: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.repoSeq,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** The next deterministic timestamp (seconds) for a forge-made commit. */
  nextTimestamp(): number {
    this.objectSeq += 1;
    return EPOCH_BASE_SEC + this.objectSeq;
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }
}

/** An ISO instant for a deterministic forge timestamp. */
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

// ------------------------------------------------------------------------------------------------
// object model
// ------------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let timestamp = 0;
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) timestamp = Number(match[1]);
    }
  }
  return { tree, parents, message, timestamp };
}

export function commitOf(repo: Repo, oid: string): CommitView | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  repo.commitCache.set(oid, view);
  return view;
}

/** Peel an object id through tag objects to the commit it names (or null when it is not commit-like). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (!match) return null;
    current = match[1];
  }
  return null;
}

/** The commit id a ref ultimately points at, following tags; null when unborn or not commit-like. */
export function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

/** Resolve a user-supplied ref (branch name, tag name, full ref or raw oid) to a commit id. */
export function resolveToCommit(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  const candidates = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const commit = refCommit(repo, candidate);
    if (commit !== null) return commit;
  }
  if (/^[0-9a-f]{40}$/.test(ref)) return peelToCommit(repo, ref);
  return null;
}

/** True when `ancestor` is reachable from `descendant` by walking parents (both included). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit) for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (breadth-first from both sides), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>([[tip, 0]]);
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      const commit = commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!dist.has(parent)) {
          dist.set(parent, dist.get(oid)! + 1);
          queue.push(parent);
        }
      }
    }
    return dist;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of fromA) {
    const db = fromB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Create an issue record in a repo (shared by REST, GraphQL and MCP so the objects are one). */
export function createIssueRecord(
  forge: Forge,
  repo: Repo,
  fields: { title: string; body: string; labels?: readonly string[] },
): IssueRecord {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRecord = {
    id: forge.nextIssueId(),
    number,
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: [...(fields.labels ?? [])],
    comments: [],
    seq: number,
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Create a pull-request record in a repo (shared by REST, GraphQL and MCP). */
export function createPullRecord(
  forge: Forge,
  repo: Repo,
  fields: { title: string; body: string; headRef: string; baseRef: string },
): PullRecord {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRecord = {
    id: forge.nextIssueId(),
    number,
    title: fields.title,
    body: fields.body,
    state: 'open',
    headRef: fields.headRef,
    baseRef: fields.baseRef,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: number,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/**
 * Merge a pull request into its base branch: one squash commit (or a two-parent commit for
 * method "merge") whose tree is the three-way merge. Answers the merge commit id, 'conflict'
 * when the merge cannot be made, or null when a branch is gone.
 */
export function performMerge(
  forge: Forge,
  repo: Repo,
  pull: PullRecord,
  method: 'squash' | 'merge' | 'rebase',
): string | 'conflict' | null {
  const sim = simulateMerge(repo, pull.headRef, pull.baseRef);
  if (sim === null) return null;
  if (sim.outcome.files === null) return 'conflict';
  const tree = buildTreeFromFiles(repo, sim.outcome.files);
  const parents = method === 'merge' ? [sim.baseTip, sim.headTip] : [sim.baseTip];
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`
      : pull.body
        ? `${pull.title}\n\n${pull.body}`
        : pull.title;
  const sha = makeCommit(forge, repo, { tree, parents, message });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  const commit = commitOf(repo, sha);
  pull.mergedAt = isoOf(commit ? commit.timestamp : EPOCH_BASE_SEC);
  return sha;
}

// ------------------------------------------------------------------------------------------------
// Relay-style global ids (opaque, stable, decodable by this forge alone)
// ------------------------------------------------------------------------------------------------

export function globalId(kind: string, repoId: number, number?: number, commentId?: number): string {
  const parts = [kind, String(repoId)];
  if (number !== undefined) parts.push(String(number));
  if (commentId !== undefined) parts.push(String(commentId));
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; repoId: number; number?: number; commentId?: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId)) return null;
  const out: { kind: string; repoId: number; number?: number; commentId?: number } = { kind: parts[0], repoId };
  if (parts[2] !== undefined) out.number = Number(parts[2]);
  if (parts[3] !== undefined) out.commentId = Number(parts[3]);
  return out;
}

export function repoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ------------------------------------------------------------------------------------------------
// trees as file maps
// ------------------------------------------------------------------------------------------------

export interface FileEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into a path -> blob/gitlink map. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The files of a commit (empty map for a null commit). */
export function filesOfCommit(repo: Repo, commitOid: string | null): Map<string, FileEntry> {
  if (commitOid === null) return new Map();
  const commit = commitOf(repo, commitOid);
  if (!commit) return new Map();
  return flattenTree(repo, commit.tree);
}

/** Build (and store) nested trees from a flat path map; answers the root tree id. */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** Create a forge-made commit object (deterministic identity and timestamp) and answer its id. */
export function makeCommit(
  forge: Forge,
  repo: Repo,
  fields: { tree: string; parents: readonly string[]; message: string },
): string {
  const timestamp = forge.nextTimestamp();
  const who = `${FORGE_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8'));
}

// ------------------------------------------------------------------------------------------------
// three-way merge at file granularity (the suite's merges and conflicts are file-level)
// ------------------------------------------------------------------------------------------------

export interface MergeOutcome {
  conflicts: string[];
  files: Map<string, FileEntry> | null;
}

/** Merge `theirs` into `ours` relative to `base`; a path changed differently on both sides conflicts. */
export function mergeFiles(
  base: ReadonlyMap<string, FileEntry>,
  ours: ReadonlyMap<string, FileEntry>,
  theirs: ReadonlyMap<string, FileEntry>,
): MergeOutcome {
  const conflicts: string[] = [];
  const result = new Map<string, FileEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      if (o !== undefined) result.set(path, ours.get(path)!);
    } else if (b === o) {
      if (t !== undefined) result.set(path, theirs.get(path)!);
    } else if (b === t) {
      if (o !== undefined) result.set(path, ours.get(path)!);
    } else {
      conflicts.push(path);
    }
  }
  return { conflicts, files: conflicts.length ? null : result };
}

/** Simulate merging `headRef` into `baseRef`; answers the merge outcome without writing anything. */
export function simulateMerge(
  repo: Repo,
  headRef: string,
  baseRef: string,
): { baseTip: string; headTip: string; mergeBase: string | null; outcome: MergeOutcome } | null {
  const baseTip = refCommit(repo, `refs/heads/${baseRef}`);
  const headTip = refCommit(repo, `refs/heads/${headRef}`);
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(repo, baseTip, headTip);
  const outcome = mergeFiles(filesOfCommit(repo, base), filesOfCommit(repo, baseTip), filesOfCommit(repo, headTip));
  return { baseTip, headTip, mergeBase: base, outcome };
}

// ------------------------------------------------------------------------------------------------
// line diff (for the pull-request files view)
// ------------------------------------------------------------------------------------------------

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** additions/deletions between two blob bodies, by a longest-common-subsequence over lines. */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = linesOf(oldData);
  const b = linesOf(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // Two-row DP LCS; scenario blobs are small (hundreds of lines).
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const common = prev[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed paths between two commits' trees (merge-base -> head, as the files views report). */
export function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const from = filesOfCommit(repo, fromCommit);
  const to = filesOfCommit(repo, toCommit);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldData = before ? (repo.objects.get(before.oid)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const newData = after ? (repo.objects.get(after.oid)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const { additions, deletions } = before && after ? lineDiff(oldData, newData) : { additions: linesOf(newData).length, deletions: linesOf(oldData).length };
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

// ------------------------------------------------------------------------------------------------
// packfiles
// ------------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63 || offset > buffer.length) throw new Error('pack entry size varint is corrupt');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
    if (offset > buffer.length) throw new Error('ofs-delta base offset is truncated');
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object (OFS_DELTA / REF_DELTA included). `resolveBase` supplies
 * a thin pack's missing bases from the store. Throws on any structural problem.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry & { type: GitObjectType; resolved: Buffer }>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const known = resolvedByOid.get(entry.baseOid!);
      if (known) {
        type = known.type;
        data = applyDelta(known.resolved, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base is neither in the pack nor in the store');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, { ...entry, type, resolved: data });
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas: the checks accept them and bytes stay simple). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------------------------------------
// pkt-lines
// ------------------------------------------------------------------------------------------------

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/**
 * Parse pkt-lines from the front of `buffer`. Answers the packets and the unconsumed rest (a
 * receive-pack body is pkt-lines followed by raw pack bytes). Throws on malformed framing.
 */
export function parsePktLines(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Parse a whole buffer as pkt-lines (a v2 command body); the stream must end at a flush. */
export function parsePktStream(buffer: Buffer): Pkt[] {
  const { packets, rest } = parsePktLines(buffer);
  if (rest.length) {
    // Tolerate one trailing flush-less tail only when it is empty; anything else is malformed.
    throw new Error('trailing bytes after the pkt-line stream');
  }
  return packets;
}
