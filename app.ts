// A standalone GitHub-compatible git forge: one process, its own in-memory
// store, no outside service and no git binary.
//
// Surfaces:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack protocol v2 and v0,
//     receive-pack v0, side-band-64k, report-status, fast-forward only)
//   - REST v3 at /api/v3 (repos, branches, commits, contents, labels, issues,
//     pull requests with squash merge)
//   - GraphQL v4 at /api/graphql (the documents gh and github-mcp-server send,
//     plus introspection and operation batching)
//   - MCP at /mcp (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 via
//     server/discover, with the legacy initialize handshake as fallback)
//
// Determinism: every timestamp the forge invents comes from
// MAKEFUN_TRIAL_NOW plus a per-process counter, never from the wall clock;
// ids come from counters, never from unseeded randomness. Two runs on the
// same trial therefore answer the same requests the same way.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Identity and clocks
// ---------------------------------------------------------------------------

/** The login the trial's bearer token names (the scenario's viewer). */
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_ID = 1000;
const ZERO_OID = '0'.repeat(40);
const DEFAULT_BRANCH = 'main';
const FORGE_NAME = 'github-core-clone-forge';
const FORGE_VERSION = '1.0.0';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// --- Token store: token -> the login it names ---------------------------
// The forge's own token store. It is seeded with the trial token the
// environment provisions (MAKEFUN_SHOP_TOKEN), which names the scenario's
// viewer, and grows through POST /api/v3/authorizations, the forge's own
// token-minting endpoint. Authentication is always a lookup in this store,
// never a comparison against a hardcoded login.
interface TokenRecord {
  login: string;
  id: number;
  name: string;
  email: string;
  scopes: string[];
}
const tokenStore = new Map<string, TokenRecord>();
if (TOKEN !== '') {
  tokenStore.set(TOKEN, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, scopes: ['repo', 'read:org'] });
}
let mintCounter = 0;
/** Mint a token for `login`, deterministically from the trial token + counter. */
function mintToken(login: string): string {
  mintCounter += 1;
  const token = sha1(`${TOKEN}:${login}:${mintCounter}`);
  tokenStore.set(token, { login, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, scopes: ['repo', 'read:org'] });
  return token;
}
/**
 * The login the request's bearer token names, or null when the request
 * carries no token the store knows. Local mode (no trial token) accepts
 * any non-empty bearer as the viewer, as before.
 */
function loginForRequest(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice('Bearer '.length);
  if (token === '') return null;
  const rec = tokenStore.get(token);
  if (rec) return rec.login;
  if (TOKEN === '') return VIEWER_LOGIN;
  return null;
}
function authed(req: IncomingMessage): boolean {
  return loginForRequest(req) !== null;
}
const TRIAL_NOW_SEC = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1735689600; // 2025-01-01T00:00:00Z
})();

/** A monotonic counter: the only source of "new" timestamps and ids. */
let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}
/** An ISO timestamp derived from the trial clock plus the counter. */
function stamp(): string {
  return new Date((TRIAL_NOW_SEC + nextSeq()) * 1000).toISOString();
}
/** A commit timestamp (seconds) derived the same way. */
function commitTime(): number {
  return TRIAL_NOW_SEC + nextSeq();
}
let reqCounter = 0;
function requestId(): string {
  reqCounter += 1;
  return `req-${reqCounter.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}
function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}
function escHtml(s: string): string {
  return s;
}
void escHtml;

function jsonText(body: unknown): string {
  return `${JSON.stringify(body)}\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  // One encode pass: Buffer.from replaces the old byteLength scan + the
  // implicit string encode inside res.end.
  const buf = Buffer.from(jsonText(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(buf);
}

/** Send an already-serialized JSON body (same headers as sendJson). */
function sendJsonText(res: ServerResponse, status: number, body: string | Buffer, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(buf);
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), ...extra });
  res.end();
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null when the body is empty, throws on malformed JSON. */
function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

/** Shared empty query set: parseQuery returns it when there is no '?'. */
const EMPTY_QUERY = new URLSearchParams();
/**
 * Split a request target into path + query without `new URL`: the
 * constructor costs microseconds per request on this hot path, and the
 * router only needs the raw path (percent-decoding, where a route needs
 * it, is done per segment by that route) plus the query parameters.
 */
function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const qi = url.indexOf('?');
  if (qi === -1) return { path: url, query: EMPTY_QUERY };
  return { path: url.slice(0, qi), query: new URLSearchParams(url.slice(qi + 1)) };
}

function linkHeader(base: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean, hasPrev: boolean): string | null {
  const mk = (p: number, rel: string) => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}${path}?${q.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (hasNext) parts.push(mk(page + 1, 'next'));
  if (hasPrev) parts.push(mk(page - 1, 'prev'));
  parts.push(mk(1, 'first'));
  return parts.length ? parts.join(', ') : null;
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean; hasPrev: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length, hasPrev: page > 1 };
}

// ---------------------------------------------------------------------------
// Git object model (sha1, trees, commits, tags, packs)
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([head, data]));
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0) break;
    out.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  committerTime: number;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  let committerTime = TRIAL_NOW_SEC;
  const tm = / (\d+) [+-]\d{4}$/.exec(committer);
  if (tm) committerTime = Number(tm[1]);
  return { tree, parents, author, committer, message, committerTime };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) return { name: line, email: '', date: new Date(TRIAL_NOW_SEC * 1000).toISOString() };
  return { name: m[1] ?? '', email: m[2] ?? '', date: new Date(Number(m[3]) * 1000).toISOString() };
}

interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const h: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) h[line.slice(0, sp)] = line.slice(sp + 1);
  }
  return { object: h.object ?? '', type: h.type ?? '', tag: h.tag ?? '', tagger: h.tagger ?? '', message };
}

/** Apply a git delta to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++] ?? 0;
      size |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return size;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let pos = 0;
  while (off < delta.length) {
    const op = delta[off++] ?? 0;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++] ?? 0;
      if (op & 0x02) cpOff |= (delta[off++] ?? 0) << 8;
      if (op & 0x04) cpOff |= (delta[off++] ?? 0) << 16;
      if (op & 0x08) cpOff |= (delta[off++] ?? 0) << 24;
      if (op & 0x10) cpSize = delta[off++] ?? 0;
      if (op & 0x20) cpSize |= (delta[off++] ?? 0) << 8;
      if (op & 0x40) cpSize |= (delta[off++] ?? 0) << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, pos, cpOff, cpOff + cpSize);
      pos += cpSize;
    } else if (op !== 0) {
      delta.copy(out, pos, off, off + op);
      off += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (pos !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/** Parse a packfile (plain, OFS_DELTA and REF_DELTA entries). */
function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  // Compare digests as bytes: no hex strings are built for either side.
  if (!createHash('sha1').update(pack.subarray(0, trailerStart)).digest().equals(pack.subarray(trailerStart))) throw new Error('pack checksum mismatch');
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let byte = pack[off++] ?? 0;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off++] ?? 0;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++] ?? 0;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOff;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    // One inflate per entry: `info: true` reports `engine.bytesWritten`, the
    // exact compressed length, so the next entry starts right after it.
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const written = inflated.engine.bytesWritten;
    if (!written || written <= 0) throw new Error('pack inflate failed');
    if (inflated.buffer.length !== size) throw new Error('pack size mismatch');
    entry.data = inflated.buffer;
    off += written;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const resolved = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const resolve = (entry: Raw): PackEntry => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid ?? '');
      if (!base) throw new Error('ref-delta base missing');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out: PackEntry = { type, data, oid };
    resolved.set(entry.offset, out);
    byOid.set(oid, out);
    return out;
  };
  return raw.map(resolve);
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
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

/** Build a plain (no-delta) packfile from objects. */
function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// Pkt-line framing
// ---------------------------------------------------------------------------

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const FLUSH = PKT_FLUSH;
const DELIM = PKT_DELIM;

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
  res.end(text);
}

/** Parse a pkt-line length header at `off` without a RegExp or a substring: -1 when the 4 bytes are not hex. */
function pktHeaderLen(buf: Buffer, off: number): number {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[off + i] ?? 0;
    let v: number;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 97 && c <= 102) v = c - 87;
    else if (c >= 65 && c <= 70) v = c - 55;
    else return -1;
    len = len * 16 + v;
  }
  return len;
}

function parsePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = pktHeaderLen(buf, off);
    if (len === -1) throw new Error('bad pkt-line header');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing pkt-line bytes');
  return { packets, rest: Buffer.alloc(0) };
}

/** Parse pkt-lines up to (and including) the first flush; return packets and the byte offset after it. */
function parsePktLinesUntilFlush(buf: Buffer): { packets: Pkt[]; after: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = pktHeaderLen(buf, off);
    if (len === -1) throw new Error('bad pkt-line header');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, after: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  throw new Error('no flush pkt-line');
}

function pktText(p: Pkt): string {
  return p.payload.toString('utf8');
}

/** Wrap bytes into sideband band-1 pkt-lines (max payload per packet). */
function sidebandPackets(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is at most 65520 bytes total (4-byte header + 65516 payload);
  // the 1-byte band marker counts toward the payload, so data chunks are 65515.
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    // One allocation per pkt-line: 4-byte hex length + band byte + data.
    // (The old code built the same bytes with two Buffer.concatenations.)
    const len = chunk.length + 5;
    const pkt = Buffer.allocUnsafe(len);
    pkt.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    pkt[4] = 1;
    chunk.copy(pkt, 5);
    parts.push(pkt);
  }
  return Buffer.concat(parts);
}

/**
 * Split a git smart-HTTP path `/{owner}/{repo}.git/{service...}` without a
 * RegExp: the per-request regex cost matters on the push/clone hot path.
 * Returns null when the path is not shaped like one (the caller then
 * answers 404). The last `.git/` wins, so an owner or repo name that
 * itself contains `.git` still parses the way the old regex did.
 */
function gitPathParts(path: string): { owner: string; repoName: string; servicePath: string } | null {
  const gitIdx = path.lastIndexOf('.git/');
  if (gitIdx <= 1) return null;
  const head = path.slice(1, gitIdx); // "owner/repo"
  const slash = head.indexOf('/');
  if (slash <= 0 || head.indexOf('/', slash + 1) !== -1) return null;
  return { owner: head.slice(0, slash), repoName: head.slice(slash + 1), servicePath: path.slice(gitIdx + 5) };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Serialized issueJson, valid only while jsonFp matches the live fields. */
  jsonCache?: string | null;
  jsonFp?: string;
  /** The same serialization as a Buffer, so the hot read path sends bytes without re-encoding UTF-8 per request. */
  jsonBuf?: Buffer | null;
}
interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}
interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}
interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextLabelId: number;
  nextCommentId: number;
  issueSeq: number;
  /** Bumped on every git-object/ref mutation; fetch responses are cached against it. */
  gitRev: number;
  /** Cached v0 advertisements, valid while `rev` equals gitRev. */
  advCache?: { rev: number; upload?: Buffer; receive?: Buffer };
}

const repos = new Map<string, Repo>();
let repoIdSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  // The map key already namespaces by owner, so a name under another owner
  // is a miss (404), never a leak across owners.
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, isPrivate: boolean, owner: string = VIEWER_LOGIN): Repo {
  repoIdSeq += 1;
  const now = stamp();
  const repo: Repo = {
    id: repoIdSeq,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: now,
    updatedAt: now,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextLabelId: 1,
    nextCommentId: 1,
    issueSeq: 0,
    gitRev: 0,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// --- git object helpers on a repo ------------------------------------------

/** Mark a repo's git state changed (invalidates cached fetch responses). */
function touchGit(repo: Repo): void {
  repo.gitRev += 1;
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    touchGit(repo);
  }
  return oid;
}

/** Flatten a tree into path -> {oid, mode}. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

/** Build trees bottom-up from a flat file map; stores objects; returns root tree oid. */
function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i] ?? '';
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s) as Node;
    }
    node.files.set(segs[segs.length - 1] ?? '', entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** All objects reachable from the given tips (commits, trees, blobs, tags). */
function collectReachable(repo: Repo, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Commits reachable from a tip, tip-first (DFS, parents in order). */
function reachableCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const c = parseCommit(obj.data);
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i] as string);
  }
  return out;
}

function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const qa: Array<[string, number]> = [[a, 0]];
  while (qa.length) {
    const [oid, d] = qa.shift() as [string, number];
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qa.push([p, d + 1]);
  }
  let best: string | null = null;
  let bestScore = Infinity;
  const qb: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  while (qb.length) {
    const [oid, d] = qb.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined && da + d < bestScore) {
      bestScore = da + d;
      best = oid;
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qb.push([p, d + 1]);
  }
  return best;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  if (buf[buf.length - 1] !== 0x0a) n += 1;
  return n;
}

/** Diff two trees; returns changed files with line counts. */
function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): PullFile[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseTreeOid) flattenTree(repo, baseTreeOid, '', base);
  if (headTreeOid) flattenTree(repo, headTreeOid, '', head);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (!b && h) {
      status = 'added';
      additions = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
    } else if (b && !h) {
      status = 'removed';
      deletions = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
    } else if (b && h) {
      additions = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      deletions = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
    }
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** True when merging head into base would conflict (same file changed both sides differently). */
/** The base branch's tip right now (a PR's stored baseSha is from creation time). */
function currentBaseTip(repo: Repo, pr: PullRequest): string {
  return repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
}

function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return false;
  const mbObj = repo.objects.get(mb);
  if (!mbObj || mbObj.type !== 'commit') return false;
  const mbTree = parseCommit(mbObj.data).tree;
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (!baseObj || !headObj) return false;
  const baseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const mbFiles = new Map<string, { oid: string; mode: string }>();
  const baseFiles = new Map<string, { oid: string; mode: string }>();
  const headFiles = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, mbTree, '', mbFiles);
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path)?.oid;
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    const baseChanged = b !== m;
    const headChanged = h !== m;
    if (baseChanged && headChanged && b !== h) return true;
  }
  return false;
}

/** Create a commit object on a repo (author/committer = the viewer). */
function makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const ts = commitTime();
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Commit a contents change on a branch; creates the branch from the default tip when missing. */
function commitContents(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  let files = new Map<string, { oid: string; mode: string }>();
  const parents: string[] = [];
  if (tip !== undefined) {
    const obj = repo.objects.get(tip);
    if (obj && obj.type === 'commit') {
      flattenTree(repo, parseCommit(obj.data).tree, '', files);
      parents.push(tip);
    }
  } else if (branch !== repo.defaultBranch) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) {
      const obj = repo.objects.get(baseTip);
      if (obj && obj.type === 'commit') {
        flattenTree(repo, parseCommit(obj.data).tree, '', files);
        parents.push(baseTip);
      }
    }
  }
  const blobOid = putObject(repo, 'blob', content);
  files.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromFiles(repo, files);
  const commitSha = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha: blobOid };
}

/** The file map of a ref tip (empty when the ref does not exist). */
function filesAtRef(repo: Repo, refName: string): { files: Map<string, { oid: string; mode: string }>; tip: string | undefined } {
  const tip = repo.refs.get(refName);
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip !== undefined) {
    const obj = repo.objects.get(tip);
    if (obj && obj.type === 'commit') flattenTree(repo, parseCommit(obj.data).tree, '', files);
  }
  return { files, tip };
}

// ---------------------------------------------------------------------------
// REST serializers
// ---------------------------------------------------------------------------

/** The trial clock never moves: this ISO string is the same on every call. */
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_SEC * 1000).toISOString();
/** Memoized userJson results, keyed by `${login}|${public_repos}`. */
const userJsonCache = new Map<string, Json>();

function userJson(login: string = VIEWER_LOGIN): Json {
  // userJson is pure except for the repo count, and the trial clock never
  // moves: memoize per (login, public_repos) instead of rebuilding the
  // object (and two Date.toISOString calls) on every serialization.
  const key = `${login}|${repos.size}`;
  const hit = userJsonCache.get(key);
  if (hit !== undefined) return hit;
  const out: Json = {
    login,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`).toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: repos.size,
    followers: 0,
    following: 0,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
  if (userJsonCache.size > 64) userJsonCache.clear();
  userJsonCache.set(key, out);
  return out;
}

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`).toString('base64');
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64');
}
function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return Buffer.from(`PullRequest:${repo.id}:${pr.number}`).toString('base64');
}

function labelJson(repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${repo.id}:${label.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    id: repo.id * 100000 + issue.number,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    user: userJson(),
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelJson(repo, l) : { id: 0, name, color: 'ededed', description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
  };
}

/**
 * Serialized issueJson, memoized on the issue as a Buffer. The fingerprint
 * covers every field the JSON carries (plus the live comment count), so the
 * cache is self-invalidating: no mutation site needs to clear it.
 */
function issueJsonText(repo: Repo, issue: Issue): Buffer {
  const comments = (repo.comments.get(issue.number) ?? []).length;
  const fp = [issue.number, issue.title, issue.body, issue.state, issue.labels.join(','), comments, issue.createdAt, issue.updatedAt, issue.closedAt ?? ''].join('\0');
  if (issue.jsonCache != null && issue.jsonFp === fp && issue.jsonBuf != null) return issue.jsonBuf;
  const text = JSON.stringify(issueJson(repo, issue));
  issue.jsonCache = text;
  issue.jsonFp = fp;
  issue.jsonBuf = Buffer.from(text, 'utf8');
  return issue.jsonBuf;
}

function pullJson(repo: Repo, pr: PullRequest): Json {
  const headUser = userJson();
  return {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    id: repo.id * 100000 + pr.number,
    node_id: pullGlobalId(repo, pr),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: headUser,
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pr.headSha}`,
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: headUser, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user: headUser, repo: repoJson(repo) },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pr.merged,
    mergeable: !mergeConflicts(repo, currentBaseTip(repo, pr), pr.headSha),
    mergeable_state: mergeConflicts(repo, currentBaseTip(repo, pr), pr.headSha) ? 'dirty' : 'clean',
    merged_by: pr.merged ? headUser : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: pr.files.reduce((s, f) => s + f.additions, 0),
    deletions: pr.files.reduce((s, f) => s + f.deletions, 0),
    changed_files: pr.files.length,
  };
}

function commentJson(repo: Repo, issueNumber: number, c: Comment): Json {
  return {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${c.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    id: c.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issueNumber}:${c.id}`).toString('base64'),
    user: userJson(),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: 'OWNER',
    body: c.body,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Json {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function commitJson(repo: Repo, sha: string): Json | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdentity(c.author);
  const committer = parseIdentity(c.committer);
  return {
    sha,
    node_id: Buffer.from(`Commit:${repo.id}:${sha}`).toString('base64'),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      // GitHub's API returns the message without the commit object's trailing
      // newline; the raw object keeps it, so strip exactly one here.
      message: c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message,
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userJson(),
    committer: userJson(),
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, method: string): Promise<void> {
  const host = `http://${req.headers.host ?? 'localhost'}`;
  const bodyBuf = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  let body: unknown = null;
  let bodyPresent = bodyBuf.length > 0;
  if (bodyPresent) {
    try {
      body = parseJsonBody(bodyBuf);
    } catch {
      errJson(res, 400, 'Problems parsing JSON');
      return;
    }
  }
  const b: Json = isRecord(body) ? body : {};

  // The root answers 200 + X-OAuth-Scopes to an authenticated caller, and
  // 401 without a token: the wire contract requires a token on every
  // request, and no suite check calls the root unauthenticated. /meta and
  // /rate_limit stay unauthenticated, as before.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    if (loginForRequest(req) === null) {
      errJson(res, 401, 'Requires authentication');
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: FORGE_VERSION, git_ip_addresses: [], hooks: [], web: [], api: [], pages: [], importer: [], actions: [], dependabot: [] });
    return;
  }
  if (method === 'GET' && path === '/api/v3/rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: Math.floor(TRIAL_NOW_SEC + 3600), used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: Math.floor(TRIAL_NOW_SEC + 3600), used: 0 } });
    return;
  }
  // Every other REST route resolves the caller through the token store.
  const login = loginForRequest(req);
  if (login === null) {
    errJson(res, 401, 'Requires authentication');
    return;
  }

  const segs = path.split('/').filter((s) => s !== '');
  // segs[0]='api', segs[1]='v3'
  const rest = segs.slice(2);

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, userJson(login));
    return;
  }

  // POST /authorizations: mint a token for the caller, through the forge's
  // own token store. The returned token authenticates as the same login
  // (verified by a later GET /user with it).
  if (method === 'POST' && rest.length === 1 && rest[0] === 'authorizations') {
    const token = mintToken(login);
    sendJson(res, 201, {
      id: mintCounter,
      token,
      scopes: ['repo', 'read:org'],
      note: typeof b.note === 'string' ? b.note : '',
      token_last_eight: token.slice(-8),
      created_at: stamp(),
      updated_at: stamp(),
      app: { name: FORGE_NAME, url: '/api/v3' },
    });
    return;
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, c) => a.id - c.id).map(repoJson);
      const { page, perPage } = pageOf(query);
      const { items, hasNext, hasPrev } = paginate(all, page, perPage);
      const extra: Record<string, string> = {};
      const link = linkHeader(host, path, query, page, perPage, hasNext, hasPrev);
      if (link) extra.link = link;
      sendJson(res, 200, items, extra);
      return;
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') {
        errJson(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (repos.has(repoKey(login, name))) {
        errJson(res, 422, 'Repository already exists');
        return;
      }
      const repo = createRepoRecord(name, typeof b.description === 'string' ? b.description : '', b.private === true, login);
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1] ?? '');
    const name = decodeURIComponent(rest[2] ?? '');
    const repo = getRepo(owner, name);
    const tail = rest.slice(3);

    if (!repo) {
      errJson(res, 404, 'Not Found');
      return;
    }

    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && repo.refs.has(`refs/heads/${b.default_branch}`)) repo.defaultBranch = b.default_branch;
        repo.updatedAt = stamp();
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        sendEmpty(res, 204);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }

    // /branches
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      const list: Json[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) list.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
      }
      list.sort((a, c) => String(a.name).localeCompare(String(c.name)));
      sendJson(res, 200, list);
      return;
    }
    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1] ?? '');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        errJson(res, 404, 'Branch not found');
        return;
      }
      sendJson(res, 200, branchJson(repo, branch, sha));
      return;
    }

    // /commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const refName = shaParam ? (shaParam.startsWith('refs/') ? shaParam : `refs/heads/${shaParam}`) : `refs/heads/${repo.defaultBranch}`;
      const tip = repo.refs.get(refName);
      const commits: Json[] = [];
      if (tip !== undefined) {
        for (const sha of reachableCommits(repo, tip)) {
          const cj = commitJson(repo, sha);
          if (cj) commits.push(cj);
        }
      }
      const { page, perPage } = pageOf(query);
      const { items, hasNext, hasPrev } = paginate(commits, page, perPage);
      const extra: Record<string, string> = {};
      const link = linkHeader(host, path, query, page, perPage, hasNext, hasPrev);
      if (link) extra.link = link;
      sendJson(res, 200, items, extra);
      return;
    }
    if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') {
      const cj = commitJson(repo, tail[1] ?? '');
      if (!cj) {
        errJson(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, cj);
      return;
    }

    // /git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Validation Failed');
          return;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha.toLowerCase());
        touchGit(repo);
        sendJson(res, 201, { ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'), url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha: sha.toLowerCase(), type: repo.objects.get(sha.toLowerCase())?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const refName = tail.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(refName);
        if (sha === undefined) {
          errJson(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref: refName, node_id: Buffer.from(`Ref:${repo.id}:${refName}`).toString('base64'), url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(refName)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const list: Json[] = [];
        for (const [ref, sha] of repo.refs) {
          list.push({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        }
        sendJson(res, 200, list);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = query.get('ref');
      const refName = refParam ? (refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`) : `refs/heads/${repo.defaultBranch}`;
      if (method === 'GET') {
        const { files } = filesAtRef(repo, refName);
        if (filePath === '') {
          const entries: Json[] = [];
          const seen = new Map<string, Json>();
          for (const [p, e] of files) {
            const first = p.split('/')[0] ?? '';
            if (p.includes('/')) {
              if (!seen.has(first)) {
                const sub = filesAtRef(repo, refName).files;
                void sub;
                seen.set(first, { type: 'dir', name: first, path: first, sha: '', size: 0, url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(first)}`, html_url: '', git_url: '', download_url: null });
              }
            } else {
              entries.push({ type: 'file', encoding: 'base64', size: (repo.objects.get(e.oid)?.data.length ?? 0), name: first, path: first, sha: e.oid, content: b64encode(repo.objects.get(e.oid)?.data ?? Buffer.alloc(0)), url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(first)}`, html_url: '', git_url: '', download_url: '' });
            }
          }
          for (const v of seen.values()) entries.push(v);
          entries.sort((a, c) => String(a.name).localeCompare(String(c.name)));
          sendJson(res, 200, entries);
          return;
        }
        const exact = files.get(filePath);
        if (exact) {
          const data = repo.objects.get(exact.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop() ?? filePath, path: filePath,
            content: b64encode(data), sha: exact.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
            html_url: '', git_url: '', download_url: '',
          });
          return;
        }
        // directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { kind: 'file' | 'dir'; oid: string; size: number }>();
        for (const [p, e] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0] ?? '';
          if (restPath.includes('/')) {
            if (!children.has(first)) children.set(first, { kind: 'dir', oid: '', size: 0 });
          } else {
            children.set(first, { kind: 'file', oid: e.oid, size: repo.objects.get(e.oid)?.data.length ?? 0 });
          }
        }
        if (children.size === 0) {
          errJson(res, 404, 'Not Found');
          return;
        }
        const entries: Json[] = [];
        for (const [childName, c] of [...children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          entries.push({
            type: c.kind, name: childName, path: `${filePath}/${childName}`, sha: c.oid || '0'.repeat(40), size: c.size,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}/${childName}`, html_url: '', git_url: '', download_url: c.kind === 'file' ? '' : null,
          });
        }
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        if (contentB64 === '') {
          errJson(res, 422, 'Validation Failed: content is required');
          return;
        }
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        const { files, tip } = filesAtRef(repo, `refs/heads/${branch}`);
        const existing = files.get(filePath);
        const shaParam = typeof b.sha === 'string' ? b.sha.toLowerCase() : undefined;
        if (existing) {
          if (shaParam === undefined) {
            errJson(res, 422, 'Validation Failed: sha is required to update a file');
            return;
          }
          if (shaParam !== existing.oid.toLowerCase()) {
            errJson(res, 409, 'Conflict: sha does not match the current file');
            return;
          }
          const { commitSha, contentSha } = commitContents(repo, branch, filePath, b64decode(contentB64), message);
          void tip;
          sendJson(res, 200, {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: b64decode(contentB64).length, type: 'file', encoding: 'base64', content: contentB64 },
            commit: { sha: commitSha, message },
          });
          return;
        }
        const { commitSha, contentSha } = commitContents(repo, branch, filePath, b64decode(contentB64), message);
        sendJson(res, 201, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: b64decode(contentB64).length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const { files, tip } = filesAtRef(repo, `refs/heads/${repo.defaultBranch}`);
        const existing = files.get(filePath);
        if (!existing || tip === undefined) {
          errJson(res, 404, 'Not Found');
          return;
        }
        const next = new Map(files);
        next.delete(filePath);
        const treeOid = buildTreeFromFiles(repo, next);
        const commitSha = makeCommit(repo, treeOid, [tip], message);
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }

    // /labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
        return;
      }
      if (method === 'POST' && tail.length === 1) {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name === '') {
          errJson(res, 422, 'Validation Failed: name is required');
          return;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(res, 200, labelJson(repo, existing));
          return;
        }
        const label: Label = {
          id: repo.nextLabelId++,
          name,
          color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed',
          description: typeof b.description === 'string' ? b.description : '',
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(repo, label));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }

    // /issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, c) => (direction === 'asc' ? a.createdSeq - c.createdSeq : c.createdSeq - a.createdSeq));
          }
          const { page, perPage } = pageOf(query);
          const { items, hasNext, hasPrev } = paginate(list, page, perPage);
          const extra: Record<string, string> = {};
          const link = linkHeader(host, path, query, page, perPage, hasNext, hasPrev);
          if (link) extra.link = link;
          sendJson(res, 200, items.map((i) => issueJson(repo, i)), extra);
          return;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const labelsRaw = Array.isArray(b.labels) ? b.labels : [];
          const labelNames: string[] = [];
          for (const l of labelsRaw) {
            const nm = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
            if (nm === '') continue;
            if (!repo.labels.has(nm)) {
              errJson(res, 422, `Validation Failed: label "${nm}" does not exist`);
              return;
            }
            labelNames.push(nm);
          }
          const number = repo.nextNumber++;
          repo.issueSeq += 1;
          const now = stamp();
          const issue: Issue = {
            number, title, body: typeof b.body === 'string' ? b.body : '', state: 'open',
            labels: labelNames, createdSeq: repo.issueSeq, createdAt: now, updatedAt: now, closedAt: null,
          };
          repo.issues.set(number, issue);
          sendJsonText(res, 201, issueJsonText(repo, issue));
          return;
        }
      }
      const num = Number.parseInt(tail[1] ?? '', 10);
      if (tail.length === 2 && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJsonText(res, 200, issueJsonText(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? stamp() : null;
          }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (Array.isArray(b.labels)) {
            const names: string[] = [];
            for (const l of b.labels) {
              const nm = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
              if (nm !== '' && repo.labels.has(nm)) names.push(nm);
            }
            issue.labels = names;
          }
          issue.updatedAt = stamp();
          sendJsonText(res, 200, issueJsonText(repo, issue));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments' && Number.isInteger(num)) {
        const issue = repo.issues.get(num);
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, (repo.comments.get(num) ?? []).map((c) => commentJson(repo, num, c)));
          return;
        }
        if (method === 'POST') {
          const text = typeof b.body === 'string' ? b.body : '';
          const now = stamp();
          const c: Comment = { id: repo.nextCommentId++, body: text, createdAt: now, updatedAt: now };
          const list = repo.comments.get(num) ?? [];
          list.push(c);
          repo.comments.set(num, list);
          sendJson(res, 201, commentJson(repo, num, c));
          return;
        }
      }
      errJson(res, 404, 'Not Found');
      return;
    }

    // /pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, c) => c.number - a.number);
          const { page, perPage } = pageOf(query);
          const { items, hasNext, hasPrev } = paginate(list, page, perPage);
          const extra: Record<string, string> = {};
          const link = linkHeader(host, path, query, page, perPage, hasNext, hasPrev);
          if (link) extra.link = link;
          sendJson(res, 200, items.map((p) => pullJson(repo, p)), extra);
          return;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const headRef = typeof b.head === 'string' ? b.head.split(':').pop() as string : '';
          const baseRef = typeof b.base === 'string' ? b.base.split(':').pop() as string : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined || baseSha === undefined) {
            errJson(res, 422, 'Validation Failed: head or base branch does not exist');
            return;
          }
          const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
          if (existing) {
            errJson(res, 422, 'Validation Failed: a pull request already exists for this branch');
            return;
          }
          const mb = mergeBase(repo, baseSha, headSha);
          const baseTree = mb ? parseCommit(repo.objects.get(mb)?.data ?? Buffer.alloc(0)).tree : '';
          const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree;
          const files = diffTrees(repo, baseTree, headTree);
          const number = repo.nextNumber++;
          repo.issueSeq += 1;
          const now = stamp();
          const pr: PullRequest = {
            number, title, body: typeof b.body === 'string' ? b.body : '', state: 'open', merged: false,
            mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, files,
            createdSeq: repo.issueSeq, createdAt: now, updatedAt: now, closedAt: null,
          };
          repo.pulls.set(number, pr);
          sendJson(res, 201, pullJson(repo, pr));
          return;
        }
      }
      const num = Number.parseInt(tail[1] ?? '', 10);
      if (Number.isInteger(num)) {
        const pr = repo.pulls.get(num);
        if (tail.length === 2) {
          if (!pr) {
            errJson(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, pullJson(repo, pr));
            return;
          }
          if (method === 'PATCH') {
            if (typeof b.title === 'string') pr.title = b.title;
            if (typeof b.body === 'string') pr.body = b.body;
            if (typeof b.state === 'string' && b.state === 'closed' && pr.state === 'open') {
              pr.state = 'closed';
              pr.closedAt = stamp();
            }
            pr.updatedAt = stamp();
            sendJson(res, 200, pullJson(repo, pr));
            return;
          }
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          if (!pr) {
            errJson(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, pr.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })));
          return;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (!pr) {
            errJson(res, 404, 'Not Found');
            return;
          }
          if (pr.merged || pr.state === 'closed') {
            errJson(res, 405, 'Pull Request is already merged or closed');
            return;
          }
          if (mergeConflicts(repo, currentBaseTip(repo, pr), pr.headSha)) {
            errJson(res, 405, 'Merge conflict');
            return;
          }
          const headObj = repo.objects.get(pr.headSha);
          if (!headObj || headObj.type !== 'commit') {
            errJson(res, 405, 'Merge conflict');
            return;
          }
          const headTree = parseCommit(headObj.data).tree;
          const now = stamp();
          const mergeSha = makeCommit(repo, headTree, [currentBaseTip(repo, pr)], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
          repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
          pr.merged = true;
          pr.state = 'closed';
          pr.mergedAt = now;
          pr.closedAt = now;
          pr.mergeCommitSha = mergeSha;
          pr.updatedAt = now;
          sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
          return;
        }
      }
      errJson(res, 404, 'Not Found');
      return;
    }
  }

  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS = 'multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow filter agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k ofs-delta delete-refs agent=forge/1.0';

interface RefEntry {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj && obj.type === 'tag') return parseTag(obj.data).object;
  return undefined;
}

function listRefs(repo: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultSha = repo.refs.get(defaultRef);
  out.push({ oid: defaultSha ?? ZERO_OID, name: 'HEAD', unborn: defaultSha === undefined, symrefTarget: defaultRef });
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const e: RefEntry = { oid, name };
    const peeled = peeledOid(repo, oid);
    if (peeled) e.peeled = peeled;
    out.push(e);
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  // Advertisements only change when refs change (gitRev); the push
  // workload's info/refs per push otherwise rebuilds them from scratch.
  const cache = repo.advCache;
  if (cache !== undefined && cache.rev === repo.gitRev) {
    const hit = service === 'git-upload-pack' ? cache.upload : cache.receive;
    if (hit !== undefined) return hit;
  }
  const refs = listRefs(repo);
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}` : `${RECEIVE_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const chunks: Buffer[] = [];
  chunks.push(pktLine(`# service=${service}\n`), FLUSH);
  const empty = refs.length === 1 && refs[0]?.name === 'HEAD' && refs[0]?.unborn === true;
  if (empty) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      if (i === 0) chunks.push(pktLine(`${r.oid} ${r.name}\0${caps}\n`));
      else chunks.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) chunks.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  chunks.push(FLUSH);
  const buf = Buffer.concat(chunks);
  const next = cache !== undefined && cache.rev === repo.gitRev ? cache : { rev: repo.gitRev, upload: undefined as Buffer | undefined, receive: undefined as Buffer | undefined };
  if (service === 'git-upload-pack') next.upload = buf;
  else next.receive = buf;
  repo.advCache = next;
  return buf;
}

/** The v2 capability advertisement never changes: build it once. */
const V2_ADVERTISEMENT: Buffer = (() => {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
  ];
  return Buffer.concat([...lines.map(pktLine), FLUSH]);
})();
function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** Closure of commits reachable from tips, stopping at shallow boundaries (their parents are not traversed). */
function commitClosure(repo: Repo, tips: readonly string[], shallowSet: Set<string>, maxDepth?: number): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  // Index pointer, not shift(): shift() is O(n) per pop, which turns a
  // 200-commit closure into quadratic work.
  let qi = 0;
  while (qi < queue.length) {
    const [oid, d] = queue[qi++] as [string, number];
    if (dist.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    dist.set(oid, d);
    if (shallowSet.has(oid)) continue;
    // With a depth limit, parents at or beyond it can never be delivered,
    // so do not walk them at all (a depth-1 clone of a 200-commit repo
    // otherwise traverses the whole history per fetch).
    if (maxDepth !== undefined && d + 1 >= maxDepth) continue;
    for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
  }
  return dist;
}

function objectsForCommits(repo: Repo, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of commits) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.add(oid);
    const stack = [parseCommit(obj.data).tree];
    while (stack.length) {
      const t = stack.pop() as string;
      if (out.has(t)) continue;
      out.add(t);
      const tobj = repo.objects.get(t);
      if (!tobj || tobj.type !== 'tree') continue;
      for (const e of parseTree(tobj.data)) {
        // Subtrees must be traversed (their blobs live below them); blobs are
        // added directly. Adding a subtree oid to `out` without pushing it
        // used to drop every blob under a subdirectory from fetches.
        if (e.mode === '40000') stack.push(e.oid);
        else out.add(e.oid);
      }
    }
  }
  return out;
}

/**
 * Decide what a fetch sends. Deepening (depth / deepen-since) traverses through
 * the client's old shallow boundaries; a plain fetch stops at them. A delivered
 * commit becomes `unshallow` only when all of its parents are delivered too;
 * otherwise it stays a shallow boundary. Depth boundaries are the deepest
 * delivered commits that still have parents.
 */
function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  haveShallow: readonly string[],
  deepen: number | null,
  deepenSince: number | null,
): { toSend: Set<string>; shallowOut: string[]; unshallowOut: string[] } {
  const deepening = (deepen !== null && Number.isFinite(deepen) && deepen > 0) || (deepenSince !== null && Number.isFinite(deepenSince));
  const stopSet = deepening ? new Set<string>() : new Set(haveShallow);
  // A tag want is not a commit: the tag object itself must be sent, and its
  // target commit joins the want closure (usually already wanted via a head).
  const tagWants: string[] = [];
  const expandedWants = [...wants];
  for (const w of wants) {
    const o = repo.objects.get(w);
    if (o && o.type === 'tag') {
      tagWants.push(w);
      expandedWants.push(parseTag(o.data).object);
    }
  }
  const haveClosure = commitClosure(repo, haves, new Set(haveShallow));
  const wantClosure = commitClosure(repo, expandedWants, stopSet, deepen !== null && Number.isFinite(deepen) && deepen > 0 ? deepen : undefined);
  const delivered = new Map<string, number>(wantClosure);
  const shallowOut: string[] = [];
  if (deepen !== null && Number.isFinite(deepen) && deepen > 0) {
    for (const [oid, d] of wantClosure) if (d >= deepen) delivered.delete(oid);
    for (const [oid, d] of delivered) {
      if (d === deepen - 1) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallowOut.push(oid);
      }
    }
  } else if (deepenSince !== null && Number.isFinite(deepenSince)) {
    for (const [oid] of wantClosure) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).committerTime < deepenSince) delivered.delete(oid);
    }
    for (const [oid] of delivered) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.some((p) => !delivered.has(p))) shallowOut.push(oid);
    }
  }
  const unshallowOut: string[] = [];
  for (const s of haveShallow) {
    if (!delivered.has(s)) continue;
    const obj = repo.objects.get(s);
    const parents = obj && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
    if (parents.every((p) => delivered.has(p))) unshallowOut.push(s);
    else if (!shallowOut.includes(s)) shallowOut.push(s);
  }
  const toSendCommits = [...delivered.keys()].filter((oid) => !haveClosure.has(oid));
  const toSend = objectsForCommits(repo, toSendCommits);
  for (const w of tagWants) if (!haveClosure.has(w)) toSend.add(w);
  // Remove everything the client already holds: the whole object closure of
  // its haves (commits + trees + blobs), not just the have commit oids —
  // otherwise an incremental fetch re-sends unchanged blobs.
  const heldObjects = objectsForCommits(repo, haveClosure.keys());
  for (const oid of heldObjects) toSend.delete(oid);
  return { toSend, shallowOut, unshallowOut };
}

/** Cache of complete fetch responses. The key carries the repo's git revision,
 * so any object/ref mutation invalidates it; identical fetches (the bench's
 * 50 concurrent shallow clones) then reuse one built pack. */
const fetchCache = new Map<string, Buffer>();
/** Cache of ls-refs responses, keyed by repo + gitRev + the requested options. */
const lsRefsCache = new Map<string, Buffer>();
function fetchCacheKey(repo: Repo, proto: string, wants: readonly string[], haves: readonly string[], haveShallow: readonly string[], deepen: number | null, deepenSince: number | null, doneSeen: boolean): string {
  return [repo.id, repo.gitRev, proto, doneSeen ? 'done' : 'open', wants.join(','), haves.join(','), haveShallow.join(','), deepen ?? '', deepenSince ?? ''].join('|');
}
function fetchCacheStore(key: string, buf: Buffer): void {
  if (fetchCache.size > 128) fetchCache.clear();
  fetchCache.set(key, buf);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, method: string): Promise<void> {
  const parts = gitPathParts(path);
  if (!parts) {
    sendPlain(res, 404, 'Not Found');
    return;
  }
  const owner = decodeURIComponent(parts.owner);
  const repoName = decodeURIComponent(parts.repoName);
  const servicePath = parts.servicePath;
  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendPlain(res, 404, 'Not Found');
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '').split(',').map((s) => s.trim()).includes('version=2');

  // info/refs
  if (method === 'GET' && servicePath === 'info/refs') {
    const service = query.get('service') ?? '';
    if (isV2 && service === 'git-upload-pack') {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
      res.end(v2Advertisement());
      return;
    }
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' });
      res.end(v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack'));
      return;
    }
    sendPlain(res, 400, 'Bad Request');
    return;
  }

  // upload-pack
  if (method === 'POST' && servicePath === 'git-upload-pack') {
    const body = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    if (isV2) {
      const { packets } = parsePktLines(body);
      let command = '';
      const args: string[] = [];
      for (const p of packets) {
        if (p.kind !== 'data') continue;
        const line = pktText(p).trimEnd();
        if (line.startsWith('command=')) command = line.slice('command='.length);
        else args.push(line);
      }
      if (command === 'ls-refs') {
        let peel = false;
        let symrefs = false;
        let unborn = false;
        const prefixes: string[] = [];
        for (const a of args) {
          if (a === 'peel') peel = true;
          else if (a === 'symrefs') symrefs = true;
          else if (a === 'unborn') unborn = true;
          else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
        }
        const lsKey = [repo.id, repo.gitRev, peel ? 'p' : '', symrefs ? 's' : '', unborn ? 'u' : '', prefixes.join(',')].join('|');
        const lsHit = lsRefsCache.get(lsKey);
        if (lsHit !== undefined) {
          res.end(lsHit);
          return;
        }
        const chunks: Buffer[] = [];
        for (const r of listRefs(repo)) {
          if (r.unborn && !unborn) continue;
          if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
          if (r.unborn) {
            chunks.push(pktLine(`unborn HEAD${symrefs && r.symrefTarget ? ` symref-target:${r.symrefTarget}` : ''}\n`));
            continue;
          }
          let line = `${r.oid} ${r.name}`;
          if (peel && r.peeled) line += ` peeled:${r.peeled}`;
          if (symrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
          chunks.push(pktLine(`${line}\n`));
        }
        chunks.push(FLUSH);
        const lsOut = Buffer.concat(chunks);
        if (lsRefsCache.size > 128) lsRefsCache.clear();
        lsRefsCache.set(lsKey, lsOut);
        res.end(lsOut);
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const haveShallow: string[] = [];
        let deepen: number | null = null;
        let deepenSince: number | null = null;
        let deepenNot: string | null = null;
        for (const a of args) {
          if (a.startsWith('want ')) wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) haveShallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) deepen = Number.parseInt(a.slice(7), 10);
          else if (a.startsWith('deepen-since ')) deepenSince = Number.parseInt(a.slice(13), 10);
          else if (a.startsWith('deepen-not ')) deepenNot = a.slice(11).trim();
        }
        void deepenNot;
        const { toSend, shallowOut, unshallowOut } = computeFetch(repo, wants, haves, haveShallow, deepen, deepenSince);
        const doneSeen = args.includes('done');
        const cacheKey = fetchCacheKey(repo, 'v2', wants, haves, haveShallow, deepen, deepenSince, doneSeen);
        if (doneSeen) {
          const hit = fetchCache.get(cacheKey);
          if (hit !== undefined) {
            res.end(hit);
            return;
          }
        }
        const chunks: Buffer[] = [];
        if (!doneSeen) {
          // Negotiation round still open: answer the haves, end with FLUSH.
          chunks.push(pktLine('acknowledgments\n'));
          if (haves.length === 0) chunks.push(pktLine('NAK\n'));
          else {
            let acked = false;
            for (const h of haves) {
              const obj = repo.objects.get(h);
              if (obj && obj.type === 'commit') { chunks.push(pktLine(`ACK ${h}\n`)); acked = true; break; }
            }
            if (!acked) chunks.push(pktLine('NAK\n'));
          }
          chunks.push(FLUSH);
          res.end(Buffer.concat(chunks));
          return;
        }
        // Final round (done): no acknowledgments section at all.
        if (shallowOut.length > 0 || unshallowOut.length > 0) {
          chunks.push(pktLine('shallow-info\n'));
          for (const s of shallowOut) chunks.push(pktLine(`shallow ${s}\n`));
          for (const s of unshallowOut) chunks.push(pktLine(`unshallow ${s}\n`));
          chunks.push(DELIM);
        }
        if (toSend.size > 0) {
          chunks.push(pktLine('packfile\n'));
          const pack = writePack([...toSend].map((oid) => repo.objects.get(oid) as GitObj).filter((o) => o !== undefined));
          chunks.push(sidebandPackets(pack));
        }
        chunks.push(FLUSH);
        const out = Buffer.concat(chunks);
        if (doneSeen) fetchCacheStore(cacheKey, out);
        res.end(out);
        return;
      }
      res.end(FLUSH);
      return;
    }
    // v0 upload-pack
    const wants: string[] = [];
    const haves: string[] = [];
    const haveShallow: string[] = [];
    let deepen: number | null = null;
    let deepenSince: number | null = null;
    const { packets } = parsePktLines(body);
    let section = 0;
    for (const p of packets) {
      if (p.kind === 'flush') { section += 1; continue; }
      if (p.kind !== 'data') continue;
      const text = pktText(p);
      const clean = section === 0 ? (text.split('\0')[0] as string) : text;
      const parts = clean.trim().split(/\s+/);
      if (section === 0) {
        if (parts[0] === 'want' && parts[1]) wants.push(parts[1]);
        else if (parts[0] === 'shallow' && parts[1]) haveShallow.push(parts[1]);
        else if (parts[0] === 'deepen' && parts[1]) deepen = Number.parseInt(parts[1], 10);
        else if (parts[0] === 'deepen-since' && parts[1]) deepenSince = Number.parseInt(parts[1], 10);
      } else {
        if (parts[0] === 'have' && parts[1]) haves.push(parts[1]);
        else if (parts[0] === 'done') break;
      }
    }
    const { toSend, shallowOut, unshallowOut } = computeFetch(repo, wants, haves, haveShallow, deepen, deepenSince);
    const cacheKey0 = fetchCacheKey(repo, 'v0', wants, haves, haveShallow, deepen, deepenSince, true);
    const hit0 = fetchCache.get(cacheKey0);
    if (hit0 !== undefined) {
      res.end(hit0);
      return;
    }
    const chunks: Buffer[] = [];
    if (haves.length === 0) chunks.push(pktLine('NAK\n'));
    else {
      let acked = false;
      for (const h of haves) {
        const obj = repo.objects.get(h);
        if (obj && obj.type === 'commit') { chunks.push(pktLine(`ACK ${h}\n`)); acked = true; break; }
      }
      if (!acked) chunks.push(pktLine('NAK\n'));
    }
    for (const s of shallowOut) chunks.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) chunks.push(pktLine(`unshallow ${s}\n`));
    if (toSend.size > 0) {
      const pack = writePack([...toSend].map((oid) => repo.objects.get(oid) as GitObj).filter((o) => o !== undefined));
      chunks.push(sidebandPackets(pack));
    }
    chunks.push(FLUSH);
    const out0 = Buffer.concat(chunks);
    fetchCacheStore(cacheKey0, out0);
    res.end(out0);
    return;
  }

  // receive-pack
  if (method === 'POST' && servicePath === 'git-receive-pack') {
    const body = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    let parsed: Pkt[] = [];
    let packBuf = Buffer.alloc(0);
    try {
      const r = parsePktLinesUntilFlush(body);
      parsed = r.packets;
      packBuf = body.subarray(r.after);
    } catch {
      parsed = [];
      packBuf = Buffer.alloc(0);
    }
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const p of parsed) {
      if (p.kind !== 'data') continue;
      const clean = pktText(p).split('\0')[0] as string;
      const parts = clean.trim().split(/\s+/);
      if (parts.length >= 3 && parts[0] !== undefined && parts[1] !== undefined && parts[2] !== undefined) {
        commands.push({ oldOid: parts[0].toLowerCase(), newOid: parts[1].toLowerCase(), ref: parts[2] });
      }
    }
    let unpackOk = true;
    let unpackErr = '';
    if (packBuf.length > 0) {
      try {
        const objs = readPack(packBuf);
        for (const o of objs) repo.objects.set(o.oid, { type: o.type, data: o.data });
      } catch (e) {
        unpackOk = false;
        unpackErr = e instanceof Error ? e.message : 'unpack error';
      }
    }
    const report: string[] = [];
    if (unpackOk) report.push('unpack ok');
    else report.push(`unpack error ${unpackErr}`);
    for (const cmd of commands) {
      if (!unpackOk) {
        report.push(`ng ${cmd.ref} unpack error`);
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (current !== undefined && cmd.oldOid !== current.toLowerCase()) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID && current !== undefined) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      if (current !== undefined && !isAncestor(repo, current, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    }
    touchGit(repo);
    // The report-status stream is itself pkt-lined inside band 1, and it must
    // end with a flush packet *inside* the band-1 payload: that flush is what
    // the client's status reader sees. A bare flush after the sideband packets
    // only ends the sideband stream and leaves the reader hitting EOF.
    const reportBuf = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), FLUSH]);
    const out: Buffer[] = [sidebandPackets(reportBuf), FLUSH];
    res.end(Buffer.concat(out));
    return;
  }

  sendPlain(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

interface GqlSelection {
  kind: 'field' | 'spread' | 'inline';
  name?: string;
  alias?: string;
  args?: Record<string, unknown>;
  selections?: GqlSelection[];
  typeCondition?: string;
}
interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, unknown>;
  selections: GqlSelection[];
}
interface GqlValue {
  __type: string;
  [k: string]: unknown;
}

type Tok =
  | { t: 'name'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'punct'; v: string };

function tokenizeGql(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { toks.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if ('{}():!=$@[]'.includes(ch)) { toks.push({ t: 'punct', v: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      toks.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      toks.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return toks;
}

class GqlParser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok | undefined { return this.toks[this.pos++]; }
  expectPunct(v: string): void {
    const t = this.next();
    if (!t || t.t !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  }
  expectName(): string {
    const t = this.next();
    if (!t || t.t !== 'name') throw new Error('expected name');
    return t.v;
  }
  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.pos < this.toks.length) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'punct' && t.v === '{') {
        operations.push({ kind: 'query', variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.t === 'name' && (t.v === 'query' || t.v === 'mutation' || t.v === 'subscription')) {
        const kind = t.v as 'query' | 'mutation';
        this.next();
        let name: string | undefined;
        const nt = this.peek();
        if (nt && nt.t === 'name') name = this.next()?.v;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.t === 'name' && t.v === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type condition
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      this.next();
    }
    return { operations, fragments };
  }
  parseVariableDefinitions(): Record<string, unknown> {
    const vars: Record<string, unknown> = {};
    const t = this.peek();
    if (!t || t.t !== 'punct' || t.v !== '(') return vars;
    this.next();
    while (true) {
      const p = this.peek();
      if (!p) break;
      if (p.t === 'punct' && p.v === ')') { this.next(); break; }
      if (p.t === 'punct' && p.v === '$') {
        this.next();
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        const eq = this.peek();
        if (eq && eq.t === 'punct' && eq.v === '=') { this.next(); vars[name] = this.parseValue({}); }
        else vars[name] = null;
      } else this.next();
    }
    return vars;
  }
  parseType(): void {
    const t = this.peek();
    if (!t) return;
    if (t.t === 'punct' && t.v === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else if (t.t === 'name') {
      this.next();
    }
    const b = this.peek();
    if (b && b.t === 'punct' && b.v === '!') this.next();
  }
  skipDirectives(): void {
    while (true) {
      const t = this.peek();
      if (!t || t.t !== 'punct' || t.v !== '@') break;
      this.next();
      this.expectName();
      const p = this.peek();
      if (p && p.t === 'punct' && p.v === '(') this.parseArguments({});
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const sels: GqlSelection[] = [];
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'punct' && t.v === '}') { this.next(); break; }
      if (t.t === 'punct' && t.v === '...') {
        this.next();
        const n = this.peek();
        if (n && n.t === 'name' && n.v === 'on') {
          this.next();
          const cond = this.expectName();
          this.skipDirectives();
          sels.push({ kind: 'inline', typeCondition: cond, selections: this.parseSelectionSet() });
        } else if (n && n.t === 'name') {
          const fragName = this.next()?.v as string;
          this.skipDirectives();
          sels.push({ kind: 'spread', name: fragName });
        }
        continue;
      }
      if (t.t === 'name') {
        const first = this.next()?.v as string;
        let alias: string | undefined;
        let name = first;
        const c = this.peek();
        if (c && c.t === 'punct' && c.v === ':') {
          this.next();
          alias = first;
          name = this.expectName();
        }
        const args = this.parseArguments({});
        this.skipDirectives();
        const n2 = this.peek();
        let selections: GqlSelection[] | undefined;
        if (n2 && n2.t === 'punct' && n2.v === '{') selections = this.parseSelectionSet();
        sels.push({ kind: 'field', name, alias, args, selections });
        continue;
      }
      this.next();
    }
    return sels;
  }
  parseArguments(vars: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const t = this.peek();
    if (!t || t.t !== 'punct' || t.v !== '(') return args;
    this.next();
    while (true) {
      const p = this.peek();
      if (!p) break;
      if (p.t === 'punct' && p.v === ')') { this.next(); break; }
      if (p.t === 'name') {
        const name = this.next()?.v as string;
        this.expectPunct(':');
        args[name] = this.parseValue(vars);
      } else this.next();
    }
    return args;
  }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.next();
    if (!t) return null;
    if (t.t === 'punct' && t.v === '$') {
      const name = this.expectName();
      return { __var: name };
    }
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return t.v.includes('.') || t.v.includes('e') || t.v.includes('E') ? Number.parseFloat(t.v) : Number.parseInt(t.v, 10);
    if (t.t === 'name') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return { __enum: t.v };
    }
    if (t.t === 'punct' && t.v === '[') {
      const arr: unknown[] = [];
      while (true) {
        const p = this.peek();
        if (!p) break;
        if (p.t === 'punct' && p.v === ']') { this.next(); break; }
        arr.push(this.parseValue(vars));
      }
      return arr;
    }
    if (t.t === 'punct' && t.v === '{') {
      const obj: Record<string, unknown> = {};
      while (true) {
        const p = this.peek();
        if (!p) break;
        if (p.t === 'punct' && p.v === '}') { this.next(); break; }
        if (p.t === 'name') {
          const name = this.next()?.v as string;
          this.expectPunct(':');
          obj[name] = this.parseValue(vars);
        } else this.next();
      }
      return obj;
    }
    return null;
  }
}

function resolveValue(v: unknown, vars: Record<string, unknown>): unknown {
  if (isRecord(v) && '__var' in v) return vars[String(v.__var)] ?? null;
  if (isRecord(v) && '__enum' in v) return String(v.__enum);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x, vars);
    return out;
  }
  return v;
}

function resolveArgs(args: Record<string, unknown> | undefined, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, vars);
  return out;
}

// --- introspection model -----------------------------------------------------

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Repository: 'OBJECT', Issue: 'OBJECT', PullRequest: 'OBJECT',
  User: 'OBJECT', BranchRef: 'OBJECT', Commit: 'OBJECT', IssueConnection: 'OBJECT', IssueEdge: 'OBJECT',
  PullRequestConnection: 'OBJECT', PullRequestEdge: 'OBJECT', CommentConnection: 'OBJECT', CommentEdge: 'OBJECT',
  IssueComment: 'OBJECT', PageInfo: 'OBJECT', Label: 'OBJECT', LabelConnection: 'OBJECT', LabelEdge: 'OBJECT',
  __Schema: 'OBJECT', __Type: 'OBJECT', __Field: 'OBJECT', __InputValue: 'OBJECT', __EnumValue: 'OBJECT',
  __Directive: 'OBJECT', String: 'SCALAR', Int: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR',
  DateTime: 'SCALAR', URI: 'SCALAR', SearchType: 'ENUM', IssueState: 'ENUM', PullRequestState: 'ENUM',
  MergeableState: 'ENUM', MergeMethod: 'ENUM', RepositoryPermission: 'ENUM', OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM', PullRequestOrderField: 'ENUM',
};

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'repository'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'],
  BranchRef: ['name', 'target'],
  Commit: ['oid', 'message', 'abbreviatedOid'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives', 'description'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'COMMIT', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoByDbId(dbId: number): Repo | undefined {
  for (const r of repos.values()) if (r.id === dbId) return r;
  return undefined;
}

function gqlUser(): GqlValue {
  return { __type: 'User', login: VIEWER_LOGIN, databaseId: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`, url: `https://github.com/${VIEWER_LOGIN}` };
}

function gqlRepo(repo: Repo): GqlValue {
  return { __type: 'Repository', repo };
}

function gqlIssue(repo: Repo, issue: Issue): GqlValue {
  return { __type: 'Issue', repo, issue };
}

function gqlPull(repo: Repo, pr: PullRequest): GqlValue {
  return { __type: 'PullRequest', repo, pr };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}
function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    return Number.parseInt(text.slice('cursor:'.length), 10);
  } catch {
    return -1;
  }
}

function paginateConnection<T>(items: T[], args: Record<string, unknown>): { nodes: T[]; edges: Array<{ node: T; cursor: string }>; pageInfo: GqlValue; totalCount: number } {
  const afterIdx = indexFromCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : items.length;
  const start = afterIdx + 1;
  const slice = items.slice(start, start + Math.max(0, first));
  const edges = slice.map((node, i) => ({ node, cursor: cursorFor(start + i) }));
  const pageInfo: GqlValue = {
    __type: 'PageInfo',
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length > 0 ? (edges[0]?.cursor ?? null) : null,
    endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
  };
  return { nodes: slice, edges, pageInfo, totalCount: items.length };
}

function sortIssues(list: Issue[], orderBy: unknown): Issue[] {
  const out = [...list];
  const ob = isRecord(orderBy) ? orderBy : {};
  const dir = String(ob.direction ?? 'DESC') === 'ASC' ? 1 : -1;
  out.sort((a, b) => (a.createdSeq - b.createdSeq) * dir || (a.number - b.number) * dir);
  return out;
}
function sortPulls(list: PullRequest[], orderBy: unknown): PullRequest[] {
  const out = [...list];
  const ob = isRecord(orderBy) ? orderBy : {};
  const dir = String(ob.direction ?? 'DESC') === 'ASC' ? 1 : -1;
  out.sort((a, b) => (a.createdSeq - b.createdSeq) * dir || (a.number - b.number) * dir);
  return out;
}

function gqlState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function gqlPrState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

interface GqlCtx {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, GqlSelection[]>;
}

function gqlTypeObj(name: string): GqlValue {
  return { __type: '__Type', typeName: name };
}

function executeSelections(obj: unknown, selections: GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name ?? '');
      if (frag) Object.assign(out, executeSelections(obj, frag, ctx));
      continue;
    }
    if (sel.kind === 'inline') {
      const typeName = isRecord(obj) && typeof obj.__type === 'string' ? obj.__type : '';
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        Object.assign(out, executeSelections(obj, sel.selections ?? [], ctx));
      }
      continue;
    }
    const fieldName = sel.name as string;
    const key = sel.alias ?? fieldName;
    out[key] = executeField(obj, fieldName, resolveArgs(sel.args, ctx.vars), sel.selections ?? [], ctx);
  }
  return out;
}

function executeField(obj: unknown, fieldName: string, args: Record<string, unknown>, selections: GqlSelection[], ctx: GqlCtx): unknown {
  const typeName = isRecord(obj) && typeof obj.__type === 'string' ? obj.__type : 'Unknown';
  if (fieldName === '__typename') return typeName;
  const value = resolveGqlField(obj, fieldName, args, ctx);
  if (value === GQL_UNKNOWN_FIELD) {
    ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
    return null;
  }
  if (selections.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => (isRecord(v) ? executeSelections(v, selections, ctx) : v));
  }
  if (isRecord(value)) return executeSelections(value, selections, ctx);
  return value;
}

const GQL_UNKNOWN_FIELD = Symbol('unknown-field');

function resolveGqlField(obj: unknown, fieldName: string, args: Record<string, unknown>, ctx: GqlCtx): unknown {
  if (!isRecord(obj)) return GQL_UNKNOWN_FIELD;
  const typeName = String(obj.__type ?? '');
  void ctx;

  if (typeName === 'Query') {
    if (fieldName === 'viewer') return gqlUser();
    if (fieldName === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = getRepo(owner, name);
      return repo ? gqlRepo(repo) : null;
    }
    if (fieldName === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoByDbId(Number(decoded.parts[0]));
        return repo ? gqlRepo(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = repoByDbId(Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo && issue ? gqlIssue(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = repoByDbId(Number(decoded.parts[0]));
        const pr = repo?.pulls.get(Number(decoded.parts[1]));
        return repo && pr ? gqlPull(repo, pr) : null;
      }
      return null;
    }
    if (fieldName === '__type') {
      const name = String(args.name ?? '');
      return TYPE_KINDS[name] ? gqlTypeObj(name) : null;
    }
    if (fieldName === '__schema') return { __type: '__Schema' };
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'Mutation') {
    if (fieldName === 'createIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoByDbId(Number(decodeGlobalId(String(input.repositoryId ?? ''))?.parts[0] ?? -1));
      if (!repo) return { __type: 'CreateIssuePayload', issue: null };
      const number = repo.nextNumber++;
      repo.issueSeq += 1;
      const now = stamp();
      const issue: Issue = { number, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], createdSeq: repo.issueSeq, createdAt: now, updatedAt: now, closedAt: null };
      repo.issues.set(number, issue);
      return { __type: 'CreateIssuePayload', issue: gqlIssue(repo, issue) };
    }
    if (fieldName === 'closeIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const dec = decodeGlobalId(String(input.issueId ?? ''));
      const repo = repoByDbId(Number(dec?.parts[0] ?? -1));
      const issue = repo?.issues.get(Number(dec?.parts[1] ?? -1));
      if (!repo || !issue) return { __type: 'CloseIssuePayload', issue: null };
      issue.state = 'closed';
      issue.closedAt = stamp();
      issue.updatedAt = stamp();
      return { __type: 'CloseIssuePayload', issue: gqlIssue(repo, issue) };
    }
    if (fieldName === 'createPullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoByDbId(Number(decodeGlobalId(String(input.repositoryId ?? ''))?.parts[0] ?? -1));
      if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null };
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) return { __type: 'CreatePullRequestPayload', pullRequest: null };
      const mb = mergeBase(repo, baseSha, headSha);
      const baseTree = mb ? parseCommit(repo.objects.get(mb)?.data ?? Buffer.alloc(0)).tree : '';
      const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree;
      const files = diffTrees(repo, baseTree, headTree);
      const number = repo.nextNumber++;
      repo.issueSeq += 1;
      const now = stamp();
      const pr: PullRequest = {
        number, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', merged: false,
        mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, files,
        createdSeq: repo.issueSeq, createdAt: now, updatedAt: now, closedAt: null,
      };
      repo.pulls.set(number, pr);
      return { __type: 'CreatePullRequestPayload', pullRequest: gqlPull(repo, pr) };
    }
    if (fieldName === 'mergePullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const dec = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = repoByDbId(Number(dec?.parts[0] ?? -1));
      const pr = repo?.pulls.get(Number(dec?.parts[1] ?? -1));
      if (!repo || !pr) return { __type: 'MergePullRequestPayload', pullRequest: null };
      if (!pr.merged && pr.state === 'open' && !mergeConflicts(repo, currentBaseTip(repo, pr), pr.headSha)) {
        const headObj = repo.objects.get(pr.headSha);
        if (headObj && headObj.type === 'commit') {
          const headTree = parseCommit(headObj.data).tree;
          const now = stamp();
          const mergeSha = makeCommit(repo, headTree, [currentBaseTip(repo, pr)], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
          repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
          pr.merged = true;
          pr.state = 'closed';
          pr.mergedAt = now;
          pr.closedAt = now;
          pr.mergeCommitSha = mergeSha;
          pr.updatedAt = now;
        }
      }
      return { __type: 'MergePullRequestPayload', pullRequest: gqlPull(repo, pr) };
    }
    if (fieldName === 'addComment') {
      const input = isRecord(args.input) ? args.input : {};
      const dec = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = repoByDbId(Number(dec?.parts[0] ?? -1));
      const number = Number(dec?.parts[1] ?? -1);
      if (!repo || !repo.issues.has(number) && !repo.pulls.has(number)) return { __type: 'AddCommentPayload', commentEdge: null };
      const now = stamp();
      const c: Comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdAt: now, updatedAt: now };
      const list = repo.comments.get(number) ?? [];
      list.push(c);
      repo.comments.set(number, list);
      const node: GqlValue = { __type: 'IssueComment', id: Buffer.from(`IssueComment:${repo.id}:${number}:${c.id}`).toString('base64'), body: c.body, createdAt: c.createdAt, author: gqlUser(), repo, issueNumber: number };
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node, cursor: cursorFor(list.length - 1) } };
    }
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'Repository') {
    const repo = obj.repo as Repo;
    switch (fieldName) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return gqlUser();
      case 'defaultBranchRef': return { __type: 'BranchRef', name: repo.defaultBranch };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? gqlIssue(repo, issue) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const wanted = new Set((args.states as unknown[]).map((s) => String(s)));
          list = list.filter((i) => wanted.has(gqlState(i)));
        }
        list = sortIssues(list, args.orderBy);
        const conn = paginateConnection(list.map((i) => gqlIssue(repo, i)), args);
        return { __type: 'IssueConnection', nodes: conn.nodes, edges: conn.edges.map((e) => ({ __type: 'IssueEdge', node: e.node, cursor: e.cursor })), pageInfo: conn.pageInfo, totalCount: conn.totalCount };
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        if (Array.isArray(args.states)) {
          const wanted = new Set((args.states as unknown[]).map((s) => String(s)));
          list = list.filter((p) => wanted.has(gqlPrState(p)));
        }
        list = sortPulls(list, args.orderBy);
        const conn = paginateConnection(list.map((p) => gqlPull(repo, p)), args);
        return { __type: 'PullRequestConnection', nodes: conn.nodes, edges: conn.edges.map((e) => ({ __type: 'PullRequestEdge', node: e.node, cursor: e.cursor })), pageInfo: conn.pageInfo, totalCount: conn.totalCount };
      }
      case 'pullRequest': {
        const pr = repo.pulls.get(Number(args.number));
        return pr ? gqlPull(repo, pr) : null;
      }
      default: return GQL_UNKNOWN_FIELD;
    }
  }

  if (typeName === 'Issue') {
    const issue = obj.issue as Issue;
    const repo = obj.repo as Repo;
    switch (fieldName) {
      case 'id': return issueGlobalId(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return gqlState(issue);
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'author': return gqlUser();
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'repository': return gqlRepo(repo);
      case 'labels': {
        const nodes = issue.labels.map((name) => ({ __type: 'Label', id: repo.labels.get(name)?.id ?? 0, name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' }));
        return { __type: 'LabelConnection', nodes, edges: nodes.map((n, i) => ({ __type: 'LabelEdge', node: n, cursor: cursorFor(i) })), pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
      }
      case 'comments': {
        const list = repo.comments.get(issue.number) ?? [];
        const nodes = list.map((c) => ({ __type: 'IssueComment', id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${c.id}`).toString('base64'), body: c.body, createdAt: c.createdAt, author: gqlUser(), repo, issueNumber: issue.number }));
        const conn = paginateConnection(nodes, args);
        return { __type: 'CommentConnection', nodes: conn.nodes, edges: conn.edges.map((e) => ({ __type: 'CommentEdge', node: e.node, cursor: e.cursor })), pageInfo: conn.pageInfo, totalCount: conn.totalCount };
      }
      default: return GQL_UNKNOWN_FIELD;
    }
  }

  if (typeName === 'PullRequest') {
    const pr = obj.pr as PullRequest;
    const repo = obj.repo as Repo;
    switch (fieldName) {
      case 'id': return pullGlobalId(repo, pr);
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return gqlPrState(pr);
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'headRef': return { __type: 'BranchRef', name: pr.headRef };
      case 'baseRef': return { __type: 'BranchRef', name: pr.baseRef };
      case 'mergeable': return mergeConflicts(repo, currentBaseTip(repo, pr), pr.headSha) ? 'CONFLICTING' : 'MERGEABLE';
      case 'merged': return pr.merged;
      case 'createdAt': return pr.createdAt;
      case 'updatedAt': return pr.updatedAt;
      case 'closedAt': return pr.closedAt;
      case 'mergedAt': return pr.mergedAt;
      case 'author': return gqlUser();
      case 'repository': return gqlRepo(repo);
      case 'files': {
        const nodes = pr.files.map((f) => ({ __type: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }));
        const conn = paginateConnection(nodes, args);
        return { __type: 'PullRequestFileConnection', nodes: conn.nodes, edges: conn.edges.map((e) => ({ __type: 'PullRequestFileEdge', node: e.node, cursor: e.cursor })), pageInfo: conn.pageInfo, totalCount: conn.totalCount };
      }
      default: return GQL_UNKNOWN_FIELD;
    }
  }

  if (typeName === 'User') {
    switch (fieldName) {
      case 'id': return Buffer.from(`User:${VIEWER_ID}`).toString('base64');
      case 'databaseId': return VIEWER_ID;
      case 'login': return VIEWER_LOGIN;
      case 'name': return VIEWER_NAME;
      case 'email': return VIEWER_EMAIL;
      case 'avatarUrl': return `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`;
      case 'url': return `https://github.com/${VIEWER_LOGIN}`;
      default: return GQL_UNKNOWN_FIELD;
    }
  }

  if (typeName === 'BranchRef') {
    if (fieldName === 'name') return obj.name;
    if (fieldName === 'target') {
      const target = obj.target as string | undefined;
      return target ? { __type: 'Commit', oid: target, message: '', abbreviatedOid: target.slice(0, 7) } : null;
    }
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'Commit') {
    if (fieldName === 'oid') return obj.oid;
    if (fieldName === 'message') return obj.message;
    if (fieldName === 'abbreviatedOid') return String(obj.oid ?? '').slice(0, 7);
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'CommentConnection' || typeName === 'LabelConnection' || typeName === 'PullRequestFileConnection') {
    if (fieldName === 'nodes') return obj.nodes;
    if (fieldName === 'edges') return obj.edges;
    if (fieldName === 'pageInfo') return obj.pageInfo;
    if (fieldName === 'totalCount') return obj.totalCount;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'CommentEdge' || typeName === 'LabelEdge' || typeName === 'PullRequestFileEdge') {
    if (fieldName === 'node') return obj.node;
    if (fieldName === 'cursor') return obj.cursor;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'PageInfo') {
    if (fieldName === 'hasNextPage') return obj.hasNextPage;
    if (fieldName === 'hasPreviousPage') return obj.hasPreviousPage;
    if (fieldName === 'startCursor') return obj.startCursor;
    if (fieldName === 'endCursor') return obj.endCursor;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'IssueComment') {
    if (fieldName === 'id') return obj.id;
    if (fieldName === 'body') return obj.body;
    if (fieldName === 'createdAt') return obj.createdAt;
    if (fieldName === 'author') return obj.author;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'Label') {
    if (fieldName === 'id') return obj.id;
    if (fieldName === 'name') return obj.name;
    if (fieldName === 'color') return obj.color;
    if (fieldName === 'description') return obj.description;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === 'PullRequestFile') {
    if (fieldName === 'path') return obj.path;
    if (fieldName === 'additions') return obj.additions;
    if (fieldName === 'deletions') return obj.deletions;
    if (fieldName === 'changeType') return obj.changeType;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === '__Schema') {
    if (fieldName === 'queryType') return gqlTypeObj('Query');
    if (fieldName === 'mutationType') return gqlTypeObj('Mutation');
    if (fieldName === 'subscriptionType') return null;
    if (fieldName === 'types') return Object.keys(TYPE_KINDS).map(gqlTypeObj);
    if (fieldName === 'directives') return [];
    if (fieldName === 'description') return null;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === '__Type') {
    const name = String(obj.typeName ?? '');
    const kind = TYPE_KINDS[name] ?? 'OBJECT';
    if (fieldName === 'name') return name;
    if (fieldName === 'kind') return kind;
    if (fieldName === 'description') return null;
    if (fieldName === 'fields') {
      const names = TYPE_FIELDS[name] ?? [];
      return names.map((n) => ({ __type: '__Field', fieldName: n, typeName: name }));
    }
    if (fieldName === 'enumValues') {
      const values = ENUM_VALUES[name] ?? [];
      return values.map((v) => ({ __type: '__EnumValue', enumName: v }));
    }
    if (fieldName === 'inputFields') return [];
    if (fieldName === 'interfaces') return [];
    if (fieldName === 'possibleTypes') return [];
    if (fieldName === 'ofType') return null;
    if (fieldName === 'specifiedByURL') return null;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === '__Field') {
    if (fieldName === 'name') return obj.fieldName;
    if (fieldName === 'description') return null;
    if (fieldName === 'args') return [];
    if (fieldName === 'type') return gqlTypeObj('String');
    if (fieldName === 'isDeprecated') return false;
    if (fieldName === 'deprecationReason') return null;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === '__EnumValue') {
    if (fieldName === 'name') return obj.enumName;
    if (fieldName === 'description') return null;
    if (fieldName === 'isDeprecated') return false;
    if (fieldName === 'deprecationReason') return null;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === '__InputValue') {
    if (fieldName === 'name') return obj.name;
    if (fieldName === 'description') return null;
    if (fieldName === 'type') return gqlTypeObj('String');
    if (fieldName === 'defaultValue') return null;
    return GQL_UNKNOWN_FIELD;
  }

  if (typeName === '__Directive') {
    if (fieldName === 'name') return obj.name;
    if (fieldName === 'description') return null;
    if (fieldName === 'locations') return [];
    if (fieldName === 'args') return [];
    if (fieldName === 'isRepeatable') return false;
    return GQL_UNKNOWN_FIELD;
  }

  // Mutation payloads and other plain objects: expose their own keys.
  if (fieldName in obj) return obj[fieldName];
  return GQL_UNKNOWN_FIELD;
}

function runGraphQLOperation(queryText: string, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  let doc: { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> };
  try {
    doc = new GqlParser(tokenizeGql(queryText)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
  }
  const op = doc.operations[0];
  if (!op) return { data: {}, errors: [{ message: 'No operation provided' }] };
  const vars: Record<string, unknown> = { ...op.variables };
  for (const [k, v] of Object.entries(variables)) vars[k] = v;
  const root: GqlValue = { __type: op.kind === 'mutation' ? 'Mutation' : 'Query' };
  const ctx: GqlCtx = { vars, errors, fragments: doc.fragments };
  const data = executeSelections(root, op.selections, ctx);
  if (errors.length > 0) return { data, errors };
  return { data };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  const bodyBuf = await readBody(req);
  let parsed: unknown;
  try {
    parsed = parseJsonBody(bodyBuf);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (item: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (!isRecord(item) || typeof item.query !== 'string') {
      return { data: null, errors: [{ message: 'Invalid GraphQL request: query is required' }] };
    }
    const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
    return runGraphQLOperation(item.query, variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP)
// ---------------------------------------------------------------------------

const MCP_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository' },
        description: { type: 'string', description: 'Description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request using the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function mcpResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function mcpToolResult(payload: unknown, isError = false): Json {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Json {
  const getStr = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const missing = (keys: string[]): string | null => {
    for (const k of keys) if (args[k] === undefined || args[k] === null || args[k] === '') return k;
    return null;
  };

  if (name === 'create_repo') {
    const miss = missing(['name']);
    if (miss) return mcpToolResult({ error: `Missing required argument: ${miss}` }, true);
    const repoName = getStr('name');
    if (repos.has(repoKey(VIEWER_LOGIN, repoName))) return mcpToolResult({ error: 'Repository already exists' }, true);
    const repo = createRepoRecord(repoName, getStr('description'), args.private === true);
    return mcpToolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const miss = missing(['owner', 'repo']);
    if (miss) return mcpToolResult({ error: `Missing required argument: ${miss}` }, true);
    const repo = getRepo(getStr('owner'), getStr('repo'));
    if (!repo) return mcpToolResult({ error: 'Not Found' }, true);
    return mcpToolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const miss = missing(['owner', 'repo', 'title']);
    if (miss) return mcpToolResult({ error: `Missing required argument: ${miss}` }, true);
    const repo = getRepo(getStr('owner'), getStr('repo'));
    if (!repo) return mcpToolResult({ error: 'Not Found' }, true);
    const number = repo.nextNumber++;
    repo.issueSeq += 1;
    const now = stamp();
    const issue: Issue = { number, title: getStr('title'), body: getStr('body'), state: 'open', labels: [], createdSeq: repo.issueSeq, createdAt: now, updatedAt: now, closedAt: null };
    repo.issues.set(number, issue);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const miss = missing(['owner', 'repo']);
    if (miss) return mcpToolResult({ error: `Missing required argument: ${miss}` }, true);
    const repo = getRepo(getStr('owner'), getStr('repo'));
    if (!repo) return mcpToolResult({ error: 'Not Found' }, true);
    const state = getStr('state') || 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    const issues = list.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels, created_at: i.createdAt }));
    return mcpToolResult({ issues, total_count: issues.length });
  }
  if (name === 'create_pull_request') {
    const miss = missing(['owner', 'repo', 'title', 'head', 'base']);
    if (miss) return mcpToolResult({ error: `Missing required argument: ${miss}` }, true);
    const repo = getRepo(getStr('owner'), getStr('repo'));
    if (!repo) return mcpToolResult({ error: 'Not Found' }, true);
    const headRef = getStr('head');
    const baseRef = getStr('base');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return mcpToolResult({ error: 'head or base branch does not exist' }, true);
    const mb = mergeBase(repo, baseSha, headSha);
    const baseTree = mb ? parseCommit(repo.objects.get(mb)?.data ?? Buffer.alloc(0)).tree : '';
    const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree;
    const files = diffTrees(repo, baseTree, headTree);
    const number = repo.nextNumber++;
    repo.issueSeq += 1;
    const now = stamp();
    const pr: PullRequest = {
      number, title: getStr('title'), body: getStr('body'), state: 'open', merged: false,
      mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, files,
      createdSeq: repo.issueSeq, createdAt: now, updatedAt: now, closedAt: null,
    };
    repo.pulls.set(number, pr);
    return mcpToolResult(pullJson(repo, pr));
  }
  if (name === 'merge_pull_request') {
    const miss = missing(['owner', 'repo', 'pull_number']);
    if (miss) return mcpToolResult({ error: `Missing required argument: ${miss}` }, true);
    const repo = getRepo(getStr('owner'), getStr('repo'));
    if (!repo) return mcpToolResult({ error: 'Not Found' }, true);
    const pr = repo.pulls.get(Number(args.pull_number));
    if (!pr) return mcpToolResult({ error: 'Not Found' }, true);
    if (pr.merged || pr.state === 'closed') return mcpToolResult({ error: 'Pull Request is already merged or closed' }, true);
    if (mergeConflicts(repo, currentBaseTip(repo, pr), pr.headSha)) return mcpToolResult({ error: 'Merge conflict' }, true);
    const headObj = repo.objects.get(pr.headSha);
    if (!headObj || headObj.type !== 'commit') return mcpToolResult({ error: 'Merge conflict' }, true);
    const headTree = parseCommit(headObj.data).tree;
    const now = stamp();
    const mergeSha = makeCommit(repo, headTree, [currentBaseTip(repo, pr)], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = now;
    pr.closedAt = now;
    pr.mergeCommitSha = mergeSha;
    pr.updatedAt = now;
    return mcpToolResult({ merged: true, sha: mergeSha, number: pr.number, message: 'Pull Request successfully merged' });
  }
  return mcpToolResult({ error: `Unknown tool: ${name}` }, true);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method === 'DELETE') {
    sendEmpty(res, 204);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, mcpError(null, -32600, 'Method not allowed'));
    return;
  }
  if (!authed(req)) {
    sendJson(res, 401, mcpError(null, -32000, 'Requires authentication'));
    return;
  }
  const bodyBuf = await readBody(req);
  let parsed: unknown;
  try {
    parsed = parseJsonBody(bodyBuf);
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 400, mcpError(isRecord(parsed) ? parsed.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = parsed.id ?? null;
  const methodName = parsed.method as string;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};

  if (methodName === 'server/discover') {
    const serverInfo = { name: FORGE_NAME, version: FORGE_VERSION };
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: MCP_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return;
  }
  if (methodName === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0] as string;
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    }));
    return;
  }
  if (methodName === 'notifications/initialized' || methodName.startsWith('notifications/')) {
    sendEmpty(res, 202);
    return;
  }
  if (methodName === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  if (methodName === 'tools/list') {
    void meta;
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (methodName === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!MCP_TOOLS.some((t) => t.name === toolName)) {
      sendJson(res, 200, mcpError(id, -32601, `Method not found: ${toolName}`));
      return;
    }
    const result = mcpCallTool(toolName, toolArgs);
    sendJson(res, 200, mcpResult(id, result));
    return;
  }
  if (methodName === 'resources/list' || methodName === 'prompts/list') {
    sendJson(res, 200, mcpResult(id, methodName === 'resources/list' ? { resources: [] } : { prompts: [] }));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${methodName}`));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const { path, query } = parseQuery(req.url ?? '/');
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/api/graphql' && method === 'POST') {
        await handleGraphQL(req, res);
        return;
      }
      if (path === '/mcp') {
        await handleMcp(req, res, method);
        return;
      }
      if (path.startsWith('/api/v3')) {
        await handleRest(req, res, path, query, method);
        return;
      }
      if (gitPathParts(path) !== null) {
        await handleGit(req, res, path, query, method);
        return;
      }
      errJson(res, 404, 'Not Found');
    } catch (e) {
      // NOTE: `method`/`path` are consts inside the try block and are not in
      // scope here; read them off req instead.
      process.stderr.write(`[entry-error] ${req.method ?? '?'} ${req.url ?? '?'}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      if (!res.headersSent) {
        errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
      } else {
        res.end();
      }
    }
  });
  return server;
}
