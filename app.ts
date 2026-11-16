// app.ts — the forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP over one store.
//
// main.ts owns the entry <-> env lifecycle; this file is the server it registers. Every surface
// checks the same bearer token (MAKEFUN_SHOP_TOKEN). A repository belongs to the login the token
// names (gitcore.LOGIN); the same name under any other owner is a 404, never a 403. Nothing here
// may throw out of a request: bad input is an answer, never a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  LOGIN,
  VIEWER,
  ZERO_OID,
  type FileEntry,
  type GitObject,
  type IssueRecord,
  type PullRecord,
  type Repo,
  buildTreeFromFiles,
  commitOf,
  createIssueRecord,
  createPullRecord,
  diffCommits,
  encodePkt,
  filesOfCommit,
  flattenTree,
  hashObject,
  isoOf,
  makeCommit,
  mergeBase,
  parsePktLines,
  parseTree,
  performMerge,
  readPack,
  refCommit,
  resolveToCommit,
  simulateMerge,
  storeObject,
  writePack,
  PKT_FLUSH,
  isAncestor,
} from './gitcore.ts';
import { executeGraphQL } from './graphql.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const AGENT = 'albedo-forge/1.0';

let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36)}`;
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; answers {ok:false} after sending the 400 when it is malformed. */
function parseJsonBody(res: ServerResponse, body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    sendError(res, 400, 'Invalid JSON in the request body');
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ------------------------------------------------------------------------------------------------
// shared JSON views
// ------------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: LOGIN, id: VIEWER.id, type: 'User' },
    html_url: `/${LOGIN}/${repo.name}`,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  return { name, color: repo.labels.get(name)?.color ?? 'ededed' };
}

function issueJson(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: LOGIN, id: VIEWER.id, type: 'User' },
    created_at: isoOf(1_700_000_000 + issue.id * 60),
    updated_at: isoOf(1_700_000_000 + issue.id * 60),
  };
}

function pullJson(repo: Repo, pull: PullRecord): Record<string, unknown> {
  const headSha = refCommit(repo, `refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = refCommit(repo, `refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: LOGIN, id: VIEWER.id, type: 'User' },
    created_at: isoOf(1_700_000_000 + pull.id * 60),
    updated_at: isoOf(1_700_000_000 + pull.id * 60),
  };
}

// ------------------------------------------------------------------------------------------------
// git smart HTTP
// ------------------------------------------------------------------------------------------------

const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent=${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The peeled commit for a ref target, when the target is a tag object. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const entry = repo.objects.get(current);
    if (!entry) return null;
    if (entry.type === 'commit') return current;
    if (entry.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(entry.data.toString('utf8'));
    if (!match) return null;
    current = match[1];
  }
  return null;
}

function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) {
    return Buffer.concat([
      encodePkt('version 2\n'),
      encodePkt(`agent=${AGENT}\n`),
      encodePkt('ls-refs=unborn\n'),
      encodePkt('fetch=shallow\n'),
      encodePkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`)];
  const lines: string[] = [];
  if (service === 'git-upload-pack') {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headOid !== undefined) lines.push(`${headOid} HEAD`);
    else if (sortedRefs(repo).length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${ref}`);
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
  }
  if (service === 'git-receive-pack' && lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, index) => {
    parts.push(encodePkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PktAll {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload?: Buffer;
}

/** Parse a whole pkt-line stream (flush packets are data here, not terminators). */
function parseAllPktLines(buffer: Buffer): PktAll[] {
  const packets: PktAll[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else {
      if (length === 3 || length > 65520 || offset + length > buffer.length) throw new Error('invalid pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

function textLines(packets: PktAll[]): string[] {
  return packets
    .filter((packet) => packet.kind === 'data')
    .map((packet) => packet.payload!.toString('utf8').replace(/\n$/, ''));
}

function handleLsRefs(repo: Repo, packets: PktAll[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload!.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}`);
    else lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowClient: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
  wantRefs: string[];
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Compute the object set a fetch sends: closure(wants, depth) minus closure(haves, shallow-aware). */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const shallowClient = new Set(request.shallowClient);
  const tagTarget = (oid: string): string | null => {
    const match = /^object ([0-9a-f]{40})$/m.exec(repo.objects.get(oid)?.data.toString('utf8') ?? '');
    return match ? match[1] : null;
  };

  // What the client already holds: full closure of its haves, except that a commit it holds only
  // shallowly contributes itself and its tree, never its parents.
  const haveSet = new Set<string>();
  {
    const queue = [...request.haves];
    while (queue.length) {
      const oid = queue.pop()!;
      if (haveSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      haveSet.add(oid);
      if (object.type === 'commit') {
        const commit = commitOf(repo, oid);
        if (commit) {
          queue.push(commit.tree);
          if (!shallowClient.has(oid)) queue.push(...commit.parents);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = tagTarget(oid);
        if (target) queue.push(target);
      }
    }
  }

  // Commits the deepen-not refs exclude: their whole ancestry is off limits.
  const excluded = new Set<string>();
  for (const ref of request.deepenNot) {
    const tip = resolveToCommit(repo, ref);
    if (tip === null) continue;
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      const commit = commitOf(repo, oid);
      if (commit) queue.push(...commit.parents);
    }
  }

  // The wants' closure, generation by generation, honouring the depth budget.
  const sendSet = new Set<string>();
  const sendOrder: string[] = [];
  const include = (oid: string): void => {
    if (!sendSet.has(oid)) {
      sendSet.add(oid);
      sendOrder.push(oid);
    }
  };
  const includeTreeClosure = (treeOid: string): void => {
    const queue = [treeOid];
    while (queue.length) {
      const oid = queue.pop()!;
      if (sendSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      include(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  };
  const depthLimit = request.depth ?? Number.POSITIVE_INFINITY;
  const generation = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of request.wants) {
    let oid = want;
    // A wanted tag is sent itself; its commit is generation 0.
    for (let guard = 0; guard < 16; guard += 1) {
      const object = repo.objects.get(oid);
      if (!object) break;
      if (object.type === 'tag') {
        include(oid);
        const target = tagTarget(oid);
        if (!target) break;
        oid = target;
        continue;
      }
      break;
    }
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') {
      if (!generation.has(oid)) {
        generation.set(oid, 0);
        frontier.push(oid);
      }
    } else if (object?.type === 'tree') {
      includeTreeClosure(oid);
    } else if (object) {
      include(oid);
    }
  }
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (excluded.has(oid)) continue;
      const commit = commitOf(repo, oid);
      if (!commit) continue;
      include(oid);
      includeTreeClosure(commit.tree);
      const gen = generation.get(oid)!;
      // Depth counts the generations sent: depth 1 is the tip alone, so parents join only when
      // their own generation stays below the limit.
      const expand =
        gen + 1 < depthLimit &&
        (request.deepenSince === null || request.depth !== null || commit.timestamp >= request.deepenSince);
      if (!expand) continue;
      for (const parent of commit.parents) {
        if (!generation.has(parent)) {
          generation.set(parent, gen + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  for (const oid of haveSet) sendSet.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of sendOrder) {
    if (!sendSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }

  // The shallow boundary after this fetch: a sent commit whose parent stayed behind.
  const shallow: string[] = [];
  for (const oid of sendSet) {
    const commit = commitOf(repo, oid);
    if (!commit) continue;
    if (commit.parents.some((parent) => !sendSet.has(parent) && !haveSet.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of shallowClient) {
    const commit = commitOf(repo, oid);
    if (!commit) continue;
    if (!sendSet.has(oid) && !haveSet.has(oid)) continue;
    if (commit.parents.every((parent) => sendSet.has(parent) || haveSet.has(parent))) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

/** Chunk a pack into sideband band-1 packets (payload at most 65516 bytes including the band). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(encodePkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (packets.length === 0) packets.push(encodePkt(Buffer.concat([Buffer.from([1]), pack])));
  return packets;
}

function handleFetchV2(repo: Repo, packets: PktAll[]): Buffer {
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallowClient: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    done: false,
    wantRefs: [],
  };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload!.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('want-ref ')) request.wantRefs.push(line.slice(9).trim());
    else if (line === 'done') request.done = true;
  }
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [encodePkt('acknowledgments\n')];
  const acks = request.haves.filter((have) => repo.objects.has(have));
  if (request.done) {
    for (const ack of acks) parts.push(encodePkt(`ACK ${ack}\n`));
    parts.push(encodePkt('ready\n'));
  } else if (acks.length) {
    for (const ack of acks) parts.push(encodePkt(`ACK ${ack}\n`));
  } else {
    parts.push(encodePkt('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (request.wantRefs.length) {
    parts.push(encodePkt('wanted-refs\n'));
    for (const ref of request.wantRefs) {
      const oid = repo.refs.get(ref);
      if (oid !== undefined) parts.push(encodePkt(`${oid} ${ref}\n`));
    }
    parts.push(PKT_FLUSH);
  }
  parts.push(encodePkt('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: PktAll[]): Buffer {
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallowClient: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    done: false,
    wantRefs: [],
  };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload!.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) request.shallowClient.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') request.done = true;
  }
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  const ack = request.haves.find((have) => repo.objects.has(have));
  parts.push(encodePkt(ack !== undefined ? `ACK ${ack}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePktLines(body);
  const commands: PushCommand[] = [];
  let caps = '';
  packets.forEach((packet, index) => {
    if (packet.kind !== 'data') return;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  });

  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackOk = false;
  }

  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push('unpack error');
  } else {
    reportLines.push('unpack ok');
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          reportLines.push(`ng ${command.ref} reference not found`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      const object = repo.objects.get(command.newOid);
      if (!object) {
        reportLines.push(`ng ${command.ref} missing object`);
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
        reportLines.push(`ng ${command.ref} bad object`);
        continue;
      }
      if (current !== ZERO_OID && !isAncestor(repo, current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (current === ZERO_OID && command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} reference not found`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
  if (caps.split(' ').includes('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      packets.push(encodePkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, offset + CHUNK)])));
    }
    packets.push(PKT_FLUSH);
    return Buffer.concat(packets);
  }
  return reportStream;
}

function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], url: URL, body: Buffer): void {
  const [owner, repoGit, ...rest] = segments;
  const name = repoGit.endsWith('.git') ? repoGit.slice(0, -4) : '';
  const repo = owner === LOGIN && name !== '' ? forge.repos.get(name) : undefined;
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Missing or unknown service');
      return;
    }
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    sendBuffer(res, 200, advertisement(repo, service, v2), `application/x-${service}-advertisement`);
    return;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    let packets: PktAll[];
    try {
      packets = parseAllPktLines(body);
    } catch {
      sendBuffer(res, 400, Buffer.from('invalid pkt-line request\n'), 'text/plain');
      return;
    }
    const firstData = packets.find((packet) => packet.kind === 'data');
    const firstLine = firstData?.payload?.toString('utf8') ?? '';
    try {
      if (firstLine.startsWith('command=ls-refs')) {
        sendBuffer(res, 200, handleLsRefs(repo, packets), 'application/x-git-upload-pack-result');
      } else if (firstLine.startsWith('command=fetch')) {
        sendBuffer(res, 200, handleFetchV2(repo, packets), 'application/x-git-upload-pack-result');
      } else if (firstLine.startsWith('want ')) {
        sendBuffer(res, 200, handleFetchV0(repo, packets), 'application/x-git-upload-pack-result');
      } else {
        sendBuffer(res, 400, Buffer.from('unsupported upload-pack request\n'), 'text/plain');
      }
    } catch {
      sendBuffer(res, 400, Buffer.from('upload-pack failed\n'), 'text/plain');
    }
    return;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    try {
      sendBuffer(res, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result');
    } catch {
      sendBuffer(res, 400, Buffer.from('invalid receive-pack request\n'), 'text/plain');
    }
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------------------------------------
// REST v3
// ------------------------------------------------------------------------------------------------

interface Page {
  slice: unknown[];
  headers: Record<string, string>;
}

function paginate(req: IncomingMessage, url: URL, items: unknown[]): Page {
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(100, perRaw) : 30;
  const total = items.length;
  const start = (page - 1) * perPage;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const headers: Record<string, string> = {};
  if (total > 0) {
    const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
    const mk = (p: number): string => {
      const query = new URLSearchParams(url.searchParams);
      query.set('page', String(p));
      query.set('per_page', String(perPage));
      return `${base}?${query.toString()}`;
    };
    const links: string[] = [];
    if (page < lastPage) links.push(`<${mk(page + 1)}>; rel="next"`, `<${mk(lastPage)}>; rel="last"`);
    if (page > 1) links.push(`<${mk(page - 1)}>; rel="prev"`, `<${mk(1)}>; rel="first"`);
    if (links.length) headers.link = links.join(', ');
  }
  return { slice: items.slice(start, start + perPage), headers };
}

function branchTip(repo: Repo, branch: string): string | null {
  return refCommit(repo, `refs/heads/${branch}`);
}

/** Commit a file map onto a branch (or create the branch's first commit); answers the commit id. */
function commitFiles(forge: Forge, repo: Repo, branch: string, files: Map<string, FileEntry>, message: string): string {
  const tree = buildTreeFromFiles(repo, files);
  const parent = branchTip(repo, branch);
  const sha = makeCommit(forge, repo, { tree, parents: parent ? [parent] : [], message });
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}

function listCommits(repo: Repo, startOid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [startOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (!commit) continue;
    out.push({
      sha: oid,
      commit: {
        message: commit.message,
        author: { name: 'Albedo Forge', email: 'forge@make.fun', date: isoOf(commit.timestamp || 1_700_000_000) },
        committer: { name: 'Albedo Forge', email: 'forge@make.fun', date: isoOf(commit.timestamp || 1_700_000_000) },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
  }
  return out;
}

function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pathParts: string[],
  url: URL,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';
  const path = pathParts.join('/');
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const commit = resolveToCommit(repo, ref);
    if (commit === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const files = filesOfCommit(repo, commit);
    const entry = files.get(path);
    if (entry && entry.mode !== '40000') {
      const object = repo.objects.get(entry.oid);
      if (!object) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: entry.oid,
        size: object.data.length,
        encoding: 'base64',
        content: object.data.toString('base64'),
      });
      return;
    }
    // A directory: the entries directly under `path` (or the root for '').
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
    for (const [filePath, fileEntry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'file', sha: fileEntry.oid });
      else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), { type: 'dir', sha: '' });
    }
    if (path !== '' && children.size === 0) {
      sendError(res, 404, 'Not Found');
      return;
    }
    // Directory shas: recompute subtree tree ids so listings carry real object ids.
    const treeOf = (dirPath: string): string => {
      const sub = new Map<string, FileEntry>();
      const subPrefix = dirPath === '' ? '' : `${dirPath}/`;
      for (const [filePath, fileEntry] of files) {
        if (filePath.startsWith(subPrefix)) sub.set(filePath.slice(subPrefix.length), fileEntry);
      }
      return buildTreeFromFiles(repo, sub);
    };
    const listing = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, child]) => ({
        type: child.type,
        name,
        path: prefix + name,
        sha: child.type === 'dir' ? treeOf(prefix + name) : child.sha,
      }));
    sendJson(res, 200, listing);
    return;
  }
  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseJsonBody(res, body);
    if (!parsed.ok) return;
    const data = parsed.value;
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const message = typeof data.message === 'string' ? data.message : '';
    // A write may create the default branch's first commit, but no other unborn branch.
    if (!repo.refs.has(`refs/heads/${branch}`) && branch !== repo.defaultBranch) {
      sendError(res, 404, 'Branch not found');
      return;
    }
    const tip = branchTip(repo, branch);
    const files = filesOfCommit(repo, tip);
    const existing = files.get(path);
    if (method === 'DELETE') {
      if (!existing) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (typeof data.sha === 'string' && data.sha !== existing.oid) {
        sendError(res, 409, 'The sha does not match the current blob');
        return;
      }
      files.delete(path);
      const sha = commitFiles(forge, repo, branch, files, message || `Delete ${path}`);
      sendJson(res, 200, { content: null, commit: { sha, message } });
      return;
    }
    // PUT
    if (existing && typeof data.sha === 'string' && data.sha !== existing.oid) {
      sendError(res, 409, 'The sha does not match the current blob');
      return;
    }
    if (typeof data.content !== 'string') {
      sendError(res, 422, 'content is required');
      return;
    }
    const dataBuffer = Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
    const blobOid = storeObject(repo, 'blob', dataBuffer);
    files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const sha = commitFiles(forge, repo, branch, files, message);
    sendJson(res, existing ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: dataBuffer.length, encoding: 'base64' },
      commit: { sha, message },
    });
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleRepoScoped(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  url: URL,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';
  const [head, ...tail] = rest;

  if (head === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== repo.name) {
        forge.repos.delete(repo.name);
        repo.name = parsed.value.name;
        forge.repos.set(repo.name, repo);
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'contents') {
    handleContents(forge, req, res, repo, tail, url, body);
    return;
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = paginate(req, url, branches);
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'GET' && tail.length >= 1) {
      const branch = tail.join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const start = shaParam ? resolveToCommit(repo, shaParam) : branchTip(repo, repo.defaultBranch);
    if (start === null) {
      sendJson(res, 200, []);
      return;
    }
    const page = paginate(req, url, listCommits(repo, start));
    sendJson(res, 200, page.slice, page.headers);
    return;
  }

  if (head === 'labels' && tail.length === 0 && method === 'POST') {
    const parsed = parseJsonBody(res, body);
    if (!parsed.ok) return;
    const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: a label needs a name');
      return;
    }
    if (repo.labels.has(name)) {
      sendError(res, 422, 'Validation Failed: the label already exists');
      return;
    }
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color });
    return;
  }

  if (head === 'issues') {
    handleIssues(forge, req, res, repo, tail, url, body);
    return;
  }

  if (head === 'pulls') {
    handlePulls(forge, req, res, repo, tail, url, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function validateLabels(res: ServerResponse, repo: Repo, labels: unknown): string[] | null {
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : typeof (label as { name?: unknown })?.name === 'string' ? (label as { name: string }).name : '';
    if (name === '' || !repo.labels.has(name)) {
      sendError(res, 422, `Validation Failed: the label '${name}' does not exist`);
      return null;
    }
    names.push(name);
  }
  return names;
}

function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  url: URL,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(req, url, issues.map((issue) => issueJson(repo, issue)));
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      const labels = validateLabels(res, repo, parsed.value.labels);
      if (labels === null) return;
      const issue = createIssueRecord(forge, repo, {
        title: typeof parsed.value.title === 'string' ? parsed.value.title : '',
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        labels,
      });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const number = Number.parseInt(tail[0], 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.labels !== undefined) {
        const labels = validateLabels(res, repo, parsed.value.labels);
        if (labels === null) return;
        issue.labels = labels;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      const page = paginate(
        req,
        url,
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: LOGIN, id: VIEWER.id, type: 'User' },
          created_at: isoOf(1_700_000_000 + comment.id * 60),
        })),
      );
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      const comment = {
        id: repo.nextCommentId,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
      };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: comment.id,
        body: comment.body,
        user: { login: LOGIN, id: VIEWER.id, type: 'User' },
        created_at: isoOf(1_700_000_000 + comment.id * 60),
      });
      return;
    }
  }
  sendError(res, 404, 'Not Found');
}

function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  url: URL,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const page = paginate(req, url, pulls.map((pull) => pullJson(repo, pull)));
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      const cleanRef = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        const colon = value.indexOf(':');
        return colon >= 0 ? value.slice(colon + 1) : value;
      };
      const headRef = cleanRef(parsed.value.head);
      const baseRef = cleanRef(parsed.value.base);
      if (headRef === '' || baseRef === '' || branchTip(repo, headRef) === null || branchTip(repo, baseRef) === null) {
        sendError(res, 422, 'Validation Failed: the head or base branch does not exist');
        return;
      }
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef,
      );
      if (existing) {
        sendError(res, 422, 'Validation Failed: a pull request already exists for this head and base');
        return;
      }
      const pull = createPullRecord(forge, repo, {
        title: typeof parsed.value.title === 'string' ? parsed.value.title : '',
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        headRef,
        baseRef,
      });
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const number = Number.parseInt(tail[0], 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1 && method === 'GET') {
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    const base = headTip && baseTip ? mergeBase(repo, baseTip, headTip) : null;
    const page = paginate(req, url, diffCommits(repo, base, headTip));
    sendJson(res, 200, page.slice, page.headers);
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const parsed = parseJsonBody(res, body);
    if (!parsed.ok) return;
    if (pull.state !== 'open') {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    const methodName = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'merge';
    const result = performMerge(forge, repo, pull, methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge');
    if (result === 'conflict' || result === null) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], url: URL, body: Buffer): void {
  const method = req.method ?? 'GET';
  const [head, ...rest] = segments;

  if (head === undefined) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org, user' },
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'meta' && rest.length === 0 && method === 'GET') {
    sendJson(res, 200, { installed_version: 'albedo-forge 1.0.0', services: {} });
    return;
  }

  if (head === 'user' && rest.length === 0 && method === 'GET') {
    sendJson(res, 200, { login: LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }

  if (head === 'user' && rest[0] === 'repos' && rest.length === 1) {
    if (method === 'GET') {
      const repos = [...forge.repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
      const page = paginate(req, url, repos);
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(res, body);
      if (!parsed.ok) return;
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendError(res, 422, 'Validation Failed: a repository name is required');
        return;
      }
      if (forge.repos.has(name)) {
        sendError(res, 422, 'Repository creation failed: the name already exists on this account');
        return;
      }
      const repo = forge.createRepo(
        name,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
        typeof parsed.value.private === 'boolean' ? parsed.value.private : false,
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'repos' && rest.length >= 2) {
    const [owner, name, ...repoRest] = rest;
    const repo = owner === LOGIN ? forge.repos.get(name) : undefined;
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleRepoScoped(forge, req, res, repo, repoRest, url, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0, Streamable HTTP; the 2026-07-28 discover era, initialize accepted too)
// ------------------------------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== LOGIN || name === '') return null;
  return forge.repos.get(name) ?? null;
}

function callMcpTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | 'unknown' {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return mcpToolError('create_repo requires a name');
      const existing = forge.repos.get(repoName);
      if (existing) return mcpToolResult(repoJson(existing));
      const repo = forge.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpRepo(forge, args);
      if (!repo) return mcpToolError('repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpRepo(forge, args);
      if (!repo) return mcpToolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return mcpToolError('create_issue requires a title');
      const issue = createIssueRecord(forge, repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpRepo(forge, args);
      if (!repo) return mcpToolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return mcpToolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = mcpRepo(forge, args);
      if (!repo) return mcpToolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const headRef = typeof args.head === 'string' ? args.head : '';
      const baseRef = typeof args.base === 'string' ? args.base : '';
      if (title === '' || headRef === '' || baseRef === '') return mcpToolError('create_pull_request requires title, head and base');
      if (branchTip(repo, headRef) === null || branchTip(repo, baseRef) === null) {
        return mcpToolError('the head or base branch does not exist');
      }
      const pull = createPullRecord(forge, repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        headRef,
        baseRef,
      });
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpRepo(forge, args);
      if (!repo) return mcpToolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.NaN;
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return mcpToolError('pull request not found');
      if (pull.state !== 'open') return mcpToolError('pull request is not open');
      const result = performMerge(forge, repo, pull, 'squash');
      if (result === 'conflict' || result === null) return mcpToolError('pull request is not mergeable');
      return mcpToolResult({ sha: result, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return 'unknown';
  }
}

function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const answerOne = (entry: Record<string, unknown>): Record<string, unknown> | null => {
    const id = entry.id as string | number | undefined;
    const rpcMethod = typeof entry.method === 'string' ? entry.method : '';
    if (id === undefined) return null; // a notification: accepted, never answered
    switch (rpcMethod) {
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
            capabilities: { tools: {} },
            serverInfo: { name: 'albedo-forge', version: '1.0.0' },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'albedo-forge', version: '1.0.0' } },
          },
        };
      case 'initialize': {
        const params = (entry.params ?? {}) as Record<string, unknown>;
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: { name: 'albedo-forge', version: '1.0.0' },
          },
        };
      }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        const params = (entry.params ?? {}) as Record<string, unknown>;
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = callMcpTool(forge, toolName, args);
        if (result === 'unknown') {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${toolName}` } };
        }
        return { jsonrpc: '2.0', id, result };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${rpcMethod}` } };
    }
  };
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => answerOne(entry as Record<string, unknown>))
      .filter((entry) => entry !== null);
    sendJson(res, 200, answers);
    return;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const answer = answerOne(parsed as Record<string, unknown>);
    if (answer === null) {
      res.writeHead(202, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 200, answer);
    return;
  }
  res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
  res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })}\n`);
}

// ------------------------------------------------------------------------------------------------
// the server
// ------------------------------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
        const method = req.method ?? 'GET';

        // The env's boot probe: no auth, always the same answer.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (!authed(req)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          handleRest(forge, req, res, segments.slice(2), url, body);
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 200, { data: null, errors: [{ message: 'the request body is not JSON' }] });
            return;
          }
          if (Array.isArray(parsedBody)) {
            sendJson(res, 200, parsedBody.map((entry) => executeGraphQL(forge, entry as Record<string, unknown>)));
            return;
          }
          sendJson(res, 200, executeGraphQL(forge, (parsedBody ?? {}) as Record<string, unknown>));
          return;
        }
        if (segments[0] === 'mcp' && segments.length === 1) {
          handleMcp(forge, req, res, body);
          return;
        }
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          handleGit(forge, req, res, segments, url, body);
          return;
        }
        sendError(res, 404, 'Not Found');
      } catch {
        try {
          if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
          else res.end();
        } catch {
          // the socket is already gone; nothing more to do
        }
      }
    })();
  });
}
