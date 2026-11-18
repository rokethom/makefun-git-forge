// git smart HTTP: the v2 upload-pack (ls-refs and fetch) and the v0 receive-pack (push), served from
// the store's own objects. No git binary is involved: the packfiles are written and read here.

import { readPack, writePack, type GitObject } from './gitobj.ts';
import { parseCommit } from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'makefun-forge/1.0';
const ZERO = '0000000000000000000000000000000000000000';

/** One pkt-line carrying `payload`. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Split a pkt-line stream into its packets. */
function parsePackets(body: Buffer): Packet[] {
  const out: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > body.length) break;
    out.push({ kind: 'data', payload: body.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return out;
}

/** The smart-HTTP preamble every info/refs answer starts with. */
function preamble(service: string): Buffer {
  return Buffer.concat([pkt(`# service=${service}\n`), FLUSH]);
}

/** The v2 capability advertisement, built once: it never changes. */
const UPLOAD_PACK_ADVERTISEMENT = Buffer.concat([preamble('git-upload-pack'),
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

/** The v2 capability advertisement: the version line, then one line per capability. */
export function uploadPackAdvertisement(): Buffer {
  return UPLOAD_PACK_ADVERTISEMENT;
}

/** The v0 receive-pack advertisement: every ref with the push capabilities on the first line. */
export function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = `report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta agent=${AGENT}`;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (refs.length === 0) {
    return Buffer.concat([preamble('git-receive-pack'), pkt(`${ZERO} capabilities^{}\u0000${caps}\n`), FLUSH]);
  }
  const parts: Buffer[] = [preamble('git-receive-pack')];
  refs.forEach(([ref, sha], index) => {
    parts.push(pkt(index === 0 ? `${sha} ${ref}\u0000${caps}\n` : `${sha} ${ref}\n`));
  });
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The refs a v2 ls-refs request asks for, filtered by its ref-prefix arguments. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD') && head !== undefined) {
    const suffix = wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pkt(`${head} HEAD${suffix}\n`));
  } else if (matches('HEAD') && head === undefined && wantUnborn) {
    const suffix = wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pkt(`unborn HEAD${suffix}\n`));
  }
  for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    if (wantPeel && ref.startsWith('refs/tags/')) {
      const object = repo.objects.get(sha);
      if (object !== undefined && object.type === 'tag') {
        const text = object.data.toString('utf8');
        const target = /^object ([0-9a-f]{40})$/m.exec(text);
        if (target !== null) line += ` peeled:${target[1]}`;
      }
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/**
 * Every object reachable from a set of commits, commits and their trees and blobs. A commit in
 * `stopParentsAt` is included but its parents are not walked: that is a shallow boundary the client
 * already holds.
 */
function reachable(repo: Repo, tips: readonly string[], stopAt: ReadonlySet<string>, stopParentsAt: ReadonlySet<string> = new Set()): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha) || stopAt.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    out.set(sha, object);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      queue.push(info.tree);
      if (!stopParentsAt.has(sha)) for (const parent of info.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (let i = 0; i < object.data.length; ) {
        const sp = object.data.indexOf(0x20, i);
        const nul = object.data.indexOf(0, sp);
        queue.push(object.data.subarray(nul + 1, nul + 21).toString('hex'));
        i = nul + 21;
      }
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (target !== null) queue.push(target[1]);
    }
  }
  return out;
}

/** The commits a shallow fetch includes, and the boundaries it reports. */
function shallowPlan(repo: Repo, wants: readonly string[], depth: number, clientShallow: ReadonlySet<string>): { include: Set<string>; shallow: string[]; unshallow: string[] } {
  const include = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const queue: { sha: string; distance: number }[] = wants.map((sha) => ({ sha, distance: 1 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { sha, distance } = queue.shift() as { sha: string; distance: number };
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    include.add(sha);
    const info = parseCommit(object.data);
    if (distance >= depth) {
      if (info.parents.length > 0) shallow.push(sha);
      continue;
    }
    for (const parent of info.parents) queue.push({ sha: parent, distance: distance + 1 });
  }
  for (const boundary of clientShallow) {
    if (include.has(boundary)) {
      const object = repo.objects.get(boundary);
      if (object === undefined) continue;
      const info = parseCommit(object.data);
      if (info.parents.some((parent) => include.has(parent))) unshallow.push(boundary);
    }
  }
  return { include, shallow: shallow.filter((sha) => !unshallow.includes(sha)), unshallow };
}

/** The objects of exactly these commits: each commit, its tree and every blob under it, no parents. */
function objectsOfCommits(repo: Repo, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTree = (sha: string): void => {
    if (out.has(sha)) return;
    const object = repo.objects.get(sha);
    if (object === undefined) return;
    out.set(sha, object);
    if (object.type !== 'tree') return;
    for (let i = 0; i < object.data.length; ) {
      const sp = object.data.indexOf(0x20, i);
      const nul = object.data.indexOf(0, sp);
      addTree(object.data.subarray(nul + 1, nul + 21).toString('hex'));
      i = nul + 21;
    }
  };
  for (const sha of commits) {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    out.set(sha, object);
    addTree(parseCommit(object.data).tree);
  }
  return out;
}

/** Answer a v2 upload-pack request: ls-refs, or a fetch with its packfile. */
export function uploadPack(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const args: string[] = [];
  let command = '';
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  if (command === 'ls-refs') {
    const key = `ls:${repo.id}:${repo.version}:${args.join(',')}`;
    const hit = store.packs.get(key);
    if (hit !== undefined) return hit;
    const answer = lsRefs(repo, args);
    if (store.packs.size > 64) store.packs.clear();
    store.packs.set(key, answer);
    return answer;
  }
  if (command !== 'fetch') return Buffer.concat([pkt('ERR unknown command\n'), FLUSH]);

  const wants = args.filter((arg) => arg.startsWith('want ')).map((arg) => arg.slice(5).trim());
  const haves = args.filter((arg) => arg.startsWith('have ')).map((arg) => arg.slice(5).trim());
  const clientShallow = new Set(args.filter((arg) => arg.startsWith('shallow ')).map((arg) => arg.slice(8).trim()));
  const deepen = args.find((arg) => arg.startsWith('deepen '));
  const depth = deepen === undefined ? null : Number.parseInt(deepen.slice(7), 10);

  const haveSet = new Set<string>();
  for (const have of haves) {
    for (const sha of reachable(repo, [have], new Set(), clientShallow).keys()) haveSet.add(sha);
  }

  const parts: Buffer[] = [];
  let tips = wants;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null && Number.isFinite(depth) && depth > 0) {
    const plan = shallowPlan(repo, wants, depth, clientShallow);
    tips = [...plan.include];
    shallow = plan.shallow;
    unshallow = plan.unshallow;
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(DELIM);
  }

  // The clone workload asks for the same shallow fetch fifty times over: build the whole answer once.
  const cacheKey = `${repo.id}:${repo.version}:${depth ?? 'full'}:${wants.join(',')}:${haves.join(',')}`;
  const cached = store.packs.get(cacheKey);
  if (cached !== undefined) return cached;
  const objects = depth !== null && Number.isFinite(depth) && depth > 0 ? objectsOfCommits(repo, new Set(tips)) : reachable(repo, tips, haveSet);
  const list = [...objects.entries()].filter(([sha]) => !haveSet.has(sha)).map(([, object]) => object);
  const pack = writePack(list);
  parts.push(pkt('packfile\n'));
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(offset + 65515, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  const answer = Buffer.concat(parts);
  if (store.packs.size > 64) store.packs.clear();
  store.packs.set(cacheKey, answer);
  return answer;
}

/** Answer a v0 receive-pack request: apply the commands, then report each one. */
export function receivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const commands: { old: string; next: string; ref: string }[] = [];
  let pos = 0;
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      pos += 4;
      break;
    }
    if (packet.kind !== 'data') {
      pos += 4;
      continue;
    }
    pos += packet.payload.length + 4;
    let line = packet.payload.toString('utf8');
    if (commands.length === 0) {
      const nul = line.indexOf('\u0000');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const [old, next, ref] = line.replace(/\n$/, '').split(' ');
    if (ref !== undefined) commands.push({ old, next, ref });
  }
  const packBytes = body.subarray(pos);
  let unpacked: Map<string, GitObject> = new Map();
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      unpacked = readPack(packBytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  for (const [sha, object] of unpacked) repo.objects.set(sha, object);

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (unpackError !== '') {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.next === ZERO) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== undefined && current !== command.old) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    const nextObject = repo.objects.get(command.next);
    const nextParents = nextObject !== undefined && nextObject.type === 'commit' ? parseCommit(nextObject.data).parents : [];
    const fastForward = current === undefined || nextParents.includes(current) || isAncestor(repo, current, command.next);
    if (!fastForward) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!repo.objects.has(command.next)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    repo.refs.set(command.ref, command.next);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (results.some((result) => result.ok)) {
    repo.pushedAt = store.clock.now();
    repo.updatedAt = repo.pushedAt;
  }

  const inner: Buffer[] = [pkt(unpackError === '' ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(FLUSH);
  const report = Buffer.concat(inner);
  if (capabilities.includes('side-band-64k')) {
    return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), FLUSH]);
  }
  return report;
}

/** Whether `ancestor` is reachable from `descendant` in the repository's commits. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === ancestor) return true;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}
