// The git object model: hashing, tree and commit encoding, and the packfile format in both
// directions. Nothing here touches HTTP or the store; it is pure bytes in, bytes out.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The hex sha1 of a buffer. */
export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** The bytes git hashes and stores for an object: `<type> <size>\0<data>`. */
export function encodeObject(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]);
}

/** The object id of an object's content. */
export function hashObject(type: ObjType, data: Buffer): string {
  return sha1(encodeObject(type, data));
}

/** Split a stored object back into its type and payload. */
export function decodeObject(raw: Buffer): GitObject {
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('utf8');
  const sp = header.indexOf(' ');
  return { type: header.slice(0, sp) as ObjType, data: raw.subarray(nul + 1) };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object's payload into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

/** git's tree ordering: byte order of the name, a directory sorting as its name plus '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree payload from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[];
}

/** Parse a commit payload: its tree, parents, identities, message and any extra headers. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message: split === -1 ? '' : text.slice(split + 2), extra: [] };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
    else if (line !== '') info.extra.push(line);
  }
  return info;
}

/** Build a commit payload from its parts. */
export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** A packfile holding every object undeltified, with its trailing sha1. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const size = object.data.length;
    const bytes: number[] = [];
    let byte = (TYPE_NUM[object.type] << 4) | (size & 0x0f);
    let rest = size >>> 4;
    while (rest > 0) {
      bytes.push(byte | 0x80);
      byte = rest & 0x7f;
      rest >>>= 7;
    }
    bytes.push(byte);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `pos`, reporting how many input bytes it consumed. */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; consumed: number } {
  const result = inflateSync(buf.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Apply a git delta to its base, as the packfile format defines it. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = delta[p++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  varint();
  const resultSize = varint();
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size |= delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op !== 0) {
      delta.copy(out, o, p, p + op);
      o += op;
      p += op;
    } else {
      throw new Error('a delta instruction of zero length');
    }
  }
  return out;
}

interface RawEntry {
  offset: number;
  typeNum: number;
  data: Buffer;
  baseOffset: number;
  baseSha: string;
}

/** Read a packfile into its objects, resolving ofs-delta and ref-delta chains. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('the body is not a packfile');
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  for (let index = 0; index < count; index += 1) {
    const offset = pos;
    let byte = buf[pos++];
    const typeNum = (byte >> 4) & 7;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      shift += 7;
    }
    const entry: RawEntry = { offset, typeNum, data: Buffer.alloc(0), baseOffset: -1, baseSha: '' };
    if (typeNum === 6) {
      let c = buf[pos++];
      let distance = c & 0x7f;
      while (c & 0x80) {
        c = buf[pos++];
        distance = ((distance + 1) << 7) | (c & 0x7f);
      }
      entry.baseOffset = offset - distance;
    } else if (typeNum === 7) {
      entry.baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateAt(buf, pos);
    entry.data = inflated.data;
    pos += inflated.consumed;
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  const resolved = new Map<number, GitObject>();
  const bySha = new Map<string, GitObject>();
  const resolve = (entry: RawEntry, depth: number): GitObject => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    if (depth > 64) throw new Error('a delta chain deeper than 64');
    let object: GitObject;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base: GitObject | undefined;
      if (entry.typeNum === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('an ofs-delta names no object in the pack');
        base = resolve(baseEntry, depth + 1);
      } else {
        base = bySha.get(entry.baseSha);
        if (base === undefined) throw new Error('a ref-delta names no object in the pack');
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = NUM_TYPE[entry.typeNum];
      if (type === undefined) throw new Error(`a pack object of unknown type ${entry.typeNum}`);
      object = { type, data: entry.data };
    }
    resolved.set(entry.offset, object);
    bySha.set(hashObject(object.type, object.data), object);
    return object;
  };
  const out = new Map<string, GitObject>();
  for (const entry of entries) {
    const object = resolve(entry, 0);
    out.set(hashObject(object.type, object.data), object);
  }
  return out;
}
